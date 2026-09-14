#!/usr/bin/env node
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServiceManager, deploymentInstructions, runProcess } from "./services.mjs";
import { initializeServiceEnvironment } from "./service-environment.mjs";

const KINDS = ["doc", "mem"];
const ACTIONS = ["init", "config", "doctor", "up", "stop", "status", "logs"];
const DEFAULT_ROOT = path.join(os.homedir(), ".roleweave", "services");
const BINDING_SCHEMA = "roleweave-local-deployment.v1";
const SHA = /^[a-f0-9]{40}$/;
const ERROR_HINT = "Check Docker Desktop/Engine and WSL integration, then retry. Service data has not been deleted.";

export function parseLocalArguments(argv) {
  if (!argv.length || ["help", "--help"].includes(argv[0])) return { action: "help" };
  const [action, ...rest] = argv;
  if (!ACTIONS.includes(action)) throw new Error("Use init, config, doctor, up, stop, status or logs");
  let kind = "all"; let root;
  if (rest[0] && !rest[0].startsWith("--")) kind = rest.shift();
  if (!["all", ...KINDS].includes(kind)) throw new Error("Service must be doc, mem or all");
  for (let index = 0; index < rest.length; index += 2) {
    if (rest[index] !== "--root" || !rest[index + 1] || rest[index + 1].startsWith("--") || root !== undefined) throw new Error("Only --root <directory> is supported; data-removal options are not accepted");
    root = rest[index + 1];
  }
  return { action, kind, root };
}

async function regularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error(`Expected an ordinary private file: ${file}`);
}

export function createLocalStack({ root = DEFAULT_ROOT, run = runProcess, sourceManagerFactory = createServiceManager,
  initialize = initializeServiceEnvironment, environment = process.env, now = () => new Date() } = {}) {
  root = path.resolve(root);
  const kinds = (kind) => kind === "all" ? KINDS : KINDS.includes(kind) ? [kind] : (() => { throw new Error("Invalid service"); })();
  const sources = () => sourceManagerFactory({ root });

  async function execute(args, options = {}, label = "Docker operation") {
    try { return await run("docker", args, { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024, mergeStderr: false, ...options }); }
    catch { throw new Error(`${label} failed. ${ERROR_HINT}`); }
  }
  async function composeVersion() {
    const value = await execute(["compose", "version", "--short"], {}, "Docker Compose check");
    const match = value.trim().match(/^v?(\d+)\.(\d+)\./);
    if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 20)) throw new Error("Docker Compose 2.20 or newer is required");
    return value.trim();
  }
  async function doctor() {
    try {
      const compose = await composeVersion();
      const contextHost = JSON.parse(await execute(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], {}, "Docker context check"));
      const host = !environment.DOCKER_CONTEXT && environment.DOCKER_HOST ? environment.DOCKER_HOST : contextHost;
      if (typeof host !== "string" || !(/^unix:\/\/\/[^?#]+$/.test(host) || /^npipe:\/{4}\.\/pipe\/[^/\\?#]+$/i.test(host))) return { available: false, compose, message: "Local services require a local Unix socket or Windows pipe Docker context. Select a local context first." };
      const engine = await execute(["info", "--format", "{{.ServerVersion}}"], {}, "Docker Engine check");
      if (!/^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9_.+-]+)?$/.test(engine.trim())) throw new Error(`Docker Engine did not report a valid version. ${ERROR_HINT}`);
      return { available: true, compose, engine: engine.trim() };
    } catch (error) { return { available: false, message: error.message }; }
  }
  async function canonicalRoot() {
    try { root = await fs.realpath(root); }
    catch { throw new Error("Prepare doc and mem sources first with npm run services; the services root does not exist"); }
  }
  async function guardServiceDirectory(kind) {
    for (const segment of [path.join(root, kind), path.join(root, kind, "runtime")]) {
      const stat = await fs.lstat(segment);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Managed service directory must not be a link: ${segment}`);
    }
  }
  function bindingPath(kind) { return path.join(root, kind, "runtime", "deployment.json"); }
  async function readBinding(kind) {
    await guardServiceDirectory(kind);
    try {
      const file = bindingPath(kind);
      await regularFile(file);
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (value.schemaVersion !== BINDING_SCHEMA || value.kind !== kind || !SHA.test(value.sha || "") || (value.appliedSha != null && !SHA.test(value.appliedSha)) || (value.attemptedSha != null && !SHA.test(value.attemptedSha)) || !["starting", "started", "failed", "stopped"].includes(value.state)) throw new Error("Invalid local deployment record");
      return value;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async function writeBinding(kind, value) {
    await guardServiceDirectory(kind);
    const target = bindingPath(kind);
    try { await regularFile(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await fs.rename(temp, target);
    } finally { await fs.unlink(temp).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  }
  async function withLock(action) {
    await canonicalRoot();
    const lock = path.join(root, ".local-stack-operation.lock");
    async function acquire() {
      await fs.mkdir(lock, { mode: 0o700 });
      // A marker makes an active lock distinguishable from the empty directory
      // written by the first implementation before an interrupted command.
      await fs.writeFile(path.join(lock, "owner"), `${process.pid}:${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
    }
    try { await acquire(); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fs.lstat(lock);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Local stack lock is not a safe directory");
      const entries = await fs.readdir(lock);
      if (entries.length === 1 && entries[0] === "owner") {
        const owner = path.join(lock, "owner");
        let ownerHandle;
        try {
          ownerHandle = await fs.open(owner, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
        } catch {
          throw new Error("Local stack lock owner is not a safe file");
        }
        let marker;
        try {
          const ownerStat = await ownerHandle.stat();
          if (!ownerStat.isFile()) throw new Error("Local stack lock owner is not a safe file");
          marker = (await ownerHandle.readFile("utf8")).trim();
        } finally {
          await ownerHandle.close();
        }
        const match = marker.match(/^([1-9][0-9]*):[0-9a-f-]{36}$/i);
        if (!match) throw new Error("Local stack lock owner is invalid");
        let active = true;
        try { process.kill(Number(match[1]), 0); }
        catch (ownerError) { if (ownerError.code === "ESRCH") active = false; else throw ownerError; }
        if (active) throw new Error("Another local stack operation is active. Wait for it to finish.");
        await fs.unlink(owner);
        await fs.rmdir(lock);
        await acquire();
      } else if (entries.length !== 0) throw new Error("Another local stack operation is active. Wait for it to finish.");
      // Only a marker-less empty directory from the interrupted pre-marker
      // implementation is reclaimed. Active locks always contain owner.
      if (entries.length === 0) {
        await fs.rmdir(lock);
        await acquire();
      }
    }
    try { return await action(); }
    finally {
      await fs.unlink(path.join(lock, "owner")).catch((error) => { if (error.code !== "ENOENT") throw error; });
      await fs.rmdir(lock);
    }
  }
  async function selected(kind, useDeployment = false) {
    const binding = await readBinding(kind);
    const snapshot = await sources().verify(kind, useDeployment ? binding?.sha : undefined);
    const sha = snapshot.verifiedSource.sha;
    const instructions = deploymentInstructions(kind, root, sha);
    return { kind, sha, binding, ...instructions };
  }
  async function composeEnvironment(service) {
    await regularFile(service.envFile);
    const content = await fs.readFile(service.envFile, "utf8");
    if (content.length > 1024 * 1024) throw new Error("Service environment file is too large");
    const values = {};
    const env = { COMPOSE_FILE: undefined, COMPOSE_PROJECT_NAME: undefined, COMPOSE_PROFILES: undefined };
    // The selected file owns its values. Unrelated shell variables cannot replace saved secrets.
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match) { env[match[1]] = undefined; values[match[1]] = line.slice(match[0].length).trim(); }
    }
    if (service.kind === "mem") {
      env.MEM_IMAGE_TAG = service.sha;
      for (const role of ["SERVER", "WORKER", "WEB"]) {
        const key = `MEM_${role}_IMAGE`;
        if (!values[key] || ['""', "''"].includes(values[key])) env[key] = `${service.projectName}-${role.toLowerCase()}:${service.sha}`;
      }
    }
    return env;
  }
  function composeArguments(service, operation) {
    return ["compose", "--project-name", service.projectName, "--env-file", service.envFile,
      "--file", path.join(service.source, service.kind === "doc" ? "docker-compose.yml" : "deploy/compose/compose.yaml"), ...operation];
  }
  async function compose(service, operation, options = {}) {
    return execute(composeArguments(service, operation), { env: await composeEnvironment(service), ...options }, `${service.kind} Compose ${operation[0]}`);
  }
  async function managementTarget(kind) {
    const binding = await readBinding(kind);
    const snapshot = await sources().status(kind);
    const sha = binding?.appliedSha ?? binding?.sha ?? snapshot.preparedSource?.sha;
    if (!sha) throw new Error(`No local source or deployment record for ${kind}`);
    return { kind, sha, binding, ...deploymentInstructions(kind, root, sha) };
  }
  async function projectContainers(service) {
    const output = await execute(["ps", "--all", "--filter", `label=com.docker.compose.project=${service.projectName}`, "--format", "{{.ID}}"], {}, `${service.kind} container lookup`);
    const ids = output.split(/\r?\n/).filter(Boolean);
    if (ids.length > 100 || ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error("Docker returned an invalid container identity");
    return ids;
  }
  async function initializeSelected(kind) {
    const service = await selected(kind);
    const config = await initialize({ kind, sourcePath: service.source, envFile: service.envFile });
    return { service, config };
  }
  async function status(kind) {
    const engine = await doctor();
    const entries = [];
    for (const name of kinds(kind)) {
      const snapshot = await sources().status(name);
      const project = snapshot.preparedSource ? deploymentInstructions(name, snapshot.root, snapshot.preparedSource.sha).projectName : null;
      let binding = null;
      if (snapshot.preparedSource) { root = snapshot.root; binding = await readBinding(name); }
      const entry = { kind: name, project, preparedSha: snapshot.preparedSource?.sha ?? null, deployment: binding, containers: [], state: engine.available ? "stopped" : "unknown" };
      if (engine.available && project) {
        const output = await execute(["ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{json .}}"], {}, `${name} container status`);
        entry.containers = output.split(/\r?\n/).filter(Boolean).map((line) => {
          const item = JSON.parse(line);
          return { name: item.Names, state: item.State, status: item.Status, ports: item.Ports };
        });
        entry.state = entry.containers.length ? "containers-present" : "stopped";
      }
      entries.push(entry);
    }
    return { action: "status", root, engine, services: entries };
  }
  return {
    doctor, status,
    async perform(action, kind = "all") {
      kinds(kind);
      if (!ACTIONS.includes(action)) throw new Error("Unknown local stack action");
      if (action === "doctor") return doctor();
      if (action === "status") return status(kind);
      return withLock(async () => {
        if (action !== "init") await composeVersion();
        if (["up", "stop", "logs"].includes(action)) {
          const engine = await doctor();
          if (!engine.available) throw new Error(engine.message);
        }
        const entries = [];
        // Validate every selected service before starting either project.
        for (const name of kinds(kind)) {
          if (["init", "config", "up"].includes(action)) {
            const { service, config } = await initializeSelected(name);
            if (action !== "init") {
              const model = await compose(service, ["config", "--format", "json"]);
              let valid = false;
              try { const parsed = JSON.parse(model); valid = parsed.name === service.projectName && parsed.services && Object.keys(parsed.services).length > 0; } catch { /* never echo rendered configuration or credentials */ }
              if (!valid) throw new Error(`${name} Compose config did not return a valid service model`);
            }
            entries.push({ service, config });
          } else entries.push({ service: await managementTarget(name) });
        }
        const results = [];
        for (const { service, config } of entries) {
          const result = { kind: service.kind, sha: service.sha, project: service.projectName, envFile: service.envFile, ...(config ? { environmentCreated: config.created } : {}) };
          if (["init", "config"].includes(action)) { results.push({ ...result, state: action === "init" ? "initialized" : "validated" }); continue; }
          if (action === "logs") {
            const logs = [];
            for (const id of await projectContainers(service)) logs.push({ container: id, output: await execute(["logs", "--tail", "100", "--timestamps", id], { mergeStderr: true }, `${service.kind} logs`) });
            results.push({ ...result, logs }); continue;
          }
          const binding = { schemaVersion: BINDING_SCHEMA, kind: service.kind, sha: service.binding?.sha ?? service.sha,
            appliedSha: service.binding?.appliedSha ?? null,
            ...(action === "up" ? { attemptedSha: service.sha } : { attemptedSha: service.binding?.attemptedSha ?? service.sha }),
            state: action === "up" ? "starting" : service.binding?.state ?? "stopped", attemptedAt: now().toISOString() };
          if (action === "up") await writeBinding(service.kind, binding);
          try {
            if (action === "up") {
              await compose(service, ["up", "--detach", "--build", "--wait", "--wait-timeout", "180"],
                { timeoutMs: 30 * 60_000, maxOutputBytes: 8 * 1024 * 1024 });
              binding.sha = service.sha;
              binding.appliedSha = service.sha;
            } else {
              // Stable project labels include old/renamed services after a partial upgrade.
              const ids = await projectContainers(service);
              if (ids.length) await execute(["stop", "--time", "30", ...ids], { timeoutMs: 120_000 }, `${service.kind} stop`);
            }
            binding.state = action === "up" ? "started" : "stopped";
            binding.completedAt = now().toISOString();
            await writeBinding(service.kind, binding);
            results.push({ ...result, state: binding.state });
          } catch (error) {
            // One failed project must not cause an automatic destructive rollback of the other.
            if (action === "up") { binding.state = "failed"; await writeBinding(service.kind, binding); }
            results.push({ ...result, state: "failed", message: error.message });
          }
        }
        return { action, root, services: results, ...(action === "up" ? { note: "Compose readiness is not API authorization. Sign in to each service and configure its PAT in RoleWeave." } : {}) };
      });
    },
  };
}

const HELP = `RoleWeave local Docker services — one entry point, two isolated Compose projects

  npm run local-services -- init [all|doc|mem] [--root <directory>]
  npm run local-services -- config [all|doc|mem] [--root <directory>]
  npm run local-services -- doctor
  npm run local-services -- up [all|doc|mem] [--root <directory>]
  npm run local-services -- status [all|doc|mem] [--root <directory>]
  npm run local-services -- stop [all|doc|mem] [--root <directory>]
  npm run local-services -- logs [all|doc|mem] [--root <directory>]

Prepare pinned sources with npm run services first. Docker Compose 2.20+ is required.
init creates missing private environment files and preserves existing ones.
config validates without starting Docker containers. up builds and deploys selected source.
stop preserves containers and every data volume. No down -v or data deletion is provided.
stop/logs find all containers by stable project labels, including old services after a failed upgrade.
`;
export async function main(argv = process.argv.slice(2), { output = console.log, stackFactory = createLocalStack } = {}) {
  const { action, kind, root } = parseLocalArguments(argv);
  if (action === "help") { output(HELP); return; }
  const result = await stackFactory({ root }).perform(action, kind);
  output(JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => { if (result?.available === false || result?.services?.some((service) => service.state === "failed")) process.exitCode = 1; })
    .catch((error) => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
}

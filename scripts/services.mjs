#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

export const SERVICES = Object.freeze({
  doc: { repository: "bytefolk/doc", compose: "docker-compose.yml", origin: "http://localhost:3100", health: "/api/health" },
  mem: { repository: "bytefolk/mem", compose: "deploy/compose/compose.yaml", origin: "http://localhost:8080", health: "/v1/version" },
});
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SCHEMA = "roleweave-service-sources.v1";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_ROOT = path.join(os.homedir(), ".roleweave", "services");
export const ARCHIVE_LIMITS = Object.freeze({ compressedBytes: 64 * 1024 * 1024, unpackedBytes: 256 * 1024 * 1024, fileBytes: 32 * 1024 * 1024, entries: 20_000 });

function archiveRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\\:\x00-\x1f\x7f<>"|?*]/.test(value) || value.startsWith("/")) throw new Error("Unsafe archive path");
  const parts = value.split("/");
  if (parts.length > 64 || parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Unsafe archive path component");
  return parts.join("/");
}

function byteLimiter(maximum, label, digest) {
  let bytes = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maximum) callback(new Error(`${label} exceeds ${maximum} bytes`));
    else { digest?.update(chunk); callback(null, chunk); }
  } });
}

export async function inspectSourceArchive(tarFile, service, sha, limits = ARCHIVE_LIMITS) {
  const tar = await import("tar");
  const prefix = `${service}-${sha}`;
  const seen = new Set();
  const files = [];
  let unpackedBytes = 0;
  let rejected;
  await tar.t({ file: tarFile, strict: true, onReadEntry(entry) {
    try {
      if (seen.size >= limits.entries) throw new Error("Archive has too many entries");
      if (!["File", "OldFile", "Directory"].includes(entry.type) || entry.linkpath) throw new Error(`Archive entry type is not allowed: ${entry.type}`);
      // tar normalizes Windows separators in ReadEntry.path; reject unsafe raw spelling too.
      const rawName = entry.type === "Directory" ? entry.header.path.replace(/\/$/, "") : entry.header.path;
      archiveRelativePath(rawName);
      const name = entry.type === "Directory" ? entry.path.replace(/\/$/, "") : entry.path;
      archiveRelativePath(name);
      if (name !== prefix && !name.startsWith(`${prefix}/`)) throw new Error("Archive does not match the pinned repository root");
      if (name === prefix && entry.type !== "Directory") throw new Error("Archive root must be a directory");
      const identity = name.normalize("NFC").toLowerCase();
      if (seen.has(identity)) throw new Error("Archive contains duplicate or platform-colliding paths");
      seen.add(identity);
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.fileBytes) throw new Error("Archive entry is too large");
      if (entry.mode & 0o7000) throw new Error("Archive contains privileged permission bits");
      unpackedBytes += entry.size;
      if (unpackedBytes > limits.unpackedBytes) throw new Error("Archive contents exceed the unpacked size limit");
      if (entry.type !== "Directory") files.push({ path: name.slice(prefix.length + 1), size: entry.size, mode: entry.mode & 0o777 });
    } catch (error) { rejected ||= error; }
  } });
  if (rejected) throw rejected;
  return files;
}

async function hashFile(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

export async function verifyArchiveIntegrity(checkout, source, { io = fs, initial = false } = {}) {
  if (!SHA256.test(source.archiveSha256 || "") || !Array.isArray(source.files) || source.files.length > ARCHIVE_LIMITS.entries) throw new Error("Archive source integrity manifest is invalid");
  const expected = new Map();
  for (const file of source.files) {
    const name = archiveRelativePath(file.path);
    if (expected.has(name) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > ARCHIVE_LIMITS.fileBytes || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || (!initial && !SHA256.test(file.sha256 || ""))) throw new Error("Archive file integrity entry is invalid");
    expected.set(name, file);
  }
  let entries = 0;
  async function walk(directory, prefix = "") {
    for (const name of await io.readdir(directory)) {
      if (++entries > ARCHIVE_LIMITS.entries) throw new Error("Source tree exceeds the entry limit");
      const relative = prefix ? `${prefix}/${name}` : name;
      const item = path.join(directory, name);
      const stat = await io.lstat(item);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1)) throw new Error("Archive source contains a link or special file");
      if (stat.isDirectory()) { await walk(item, relative); continue; }
      const original = expected.get(relative);
      // The official doc init command writes only these generated files into its checkout.
      if (!original && [".doc/instance-id", "services/collaboration/.env"].includes(relative)) continue;
      if (!original) throw new Error(`Archive source contains an unexpected file: ${relative}`);
      if (stat.size !== original.size || (process.platform !== "win32" && (stat.mode & 0o111) !== (original.mode & 0o111))) throw new Error(`Archive source has changed: ${relative}`);
      const digest = await hashFile(item);
      if (!initial && digest !== original.sha256) throw new Error(`Archive source has changed: ${relative}`);
      if (initial) original.sha256 = digest;
      expected.delete(relative);
    }
  }
  await walk(checkout);
  if (expected.size) throw new Error(`Archive source is missing a file: ${expected.keys().next().value}`);
  return source;
}

export async function prepareSourceArchive({ service, sha, checkout, staging, fetchImpl = fetch, limits = ARCHIVE_LIMITS }) {
  const { repository } = serviceDefinition(service);
  if (!SHA.test(sha)) throw new Error("Archive URL requires a full pinned commit SHA");
  const archivePath = path.join(staging, "source.tar.gz");
  const tarPath = path.join(staging, "source.tar");
  const response = await fetchImpl(`https://codeload.github.com/${repository}/tar.gz/${sha}`, { redirect: "error", signal: AbortSignal.timeout(180_000), headers: { "User-Agent": "RoleWeave-service-sources" } });
  if (!response.ok || !response.body) throw new Error(`Unable to download official source archive: HTTP ${response.status}`);
  const digest = createHash("sha256");
  await pipeline(Readable.fromWeb(response.body), byteLimiter(limits.compressedBytes, "Compressed archive", digest), createWriteStream(archivePath, { flags: "wx", mode: 0o600 }));
  // Bound all decompressed bytes, including headers and padding, before parsing or extracting.
  await pipeline(createReadStream(archivePath), createGunzip(), byteLimiter(limits.unpackedBytes, "Unpacked archive"), createWriteStream(tarPath, { flags: "wx", mode: 0o600 }));
  const files = await inspectSourceArchive(tarPath, service, sha, limits);
  const tar = await import("tar");
  await tar.x({ file: tarPath, cwd: checkout, strip: 1, strict: true, preservePaths: false, preserveOwner: false, chmod: true, processUmask: 0o022, maxDepth: 64, keep: true });
  return verifyArchiveIntegrity(checkout, { transport: "archive", archiveSha256: digest.digest("hex"), files }, { initial: true });
}

function serviceDefinition(service) {
  if (!Object.hasOwn(SERVICES, service)) throw new Error("Service must be doc or mem");
  return SERVICES[service];
}

function validateRef(ref) {
  if (typeof ref !== "string" || !ref.length || ref.length > 200 || /[\s\x00-\x1f\x7f]/.test(ref) || ref.startsWith("-")) {
    throw new Error("Use a Git branch, tag, or full commit SHA as --ref");
  }
  return ref;
}

async function readBoundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub returned an unreadable response");
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("GitHub response exceeds the source metadata limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function resolveSource(service, ref, { fetchImpl = fetch } = {}) {
  const { repository } = serviceDefinition(service);
  validateRef(ref);
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "RoleWeave-service-sources", "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Unable to resolve ${repository}@${ref}: GitHub HTTP ${response.status}`);
  const payload = await readBoundedJson(response);
  if (!SHA.test(payload?.sha)) throw new Error("GitHub did not return a full commit SHA");
  return { service, repository, ref, sha: payload.sha, sourceUrl: `https://github.com/${repository}/commit/${payload.sha}` };
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete childEnv[key];
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    let output = "";
    let bytes = 0;
    let failure;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      // Wait for the owned process tree to close before the caller removes staging.
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: false, windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timeout = setTimeout(() => stop(new Error(`${command} timed out`)), options.timeoutMs ?? 180_000);
    const capture = (chunk) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 1024 * 1024)) {
        stop(new Error(`${command} output exceeded the limit`));
      } else {
        output += chunk.toString();
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", options.mergeStderr === false ? () => {} : capture);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} failed (${code}): ${output.trim().slice(-4000)}`));
      else resolve(output.trim());
    });
  });
}

function emptyManifest(service) {
  return { schemaVersion: SCHEMA, service, repository: serviceDefinition(service).repository, selectedSha: null, selectedAt: null, sources: [] };
}

function validateManifest(manifest, service) {
  if (manifest?.schemaVersion !== SCHEMA || manifest.service !== service || manifest.repository !== SERVICES[service].repository || !Array.isArray(manifest.sources)) {
    throw new Error("Service source manifest is invalid; existing files were left unchanged");
  }
  const seen = new Set();
  for (const source of manifest.sources) {
    if (!SHA.test(source?.sha) || seen.has(source.sha) || typeof source.fetchedAt !== "string") throw new Error("Invalid source entry in manifest");
    validateRef(source.ref);
    if (source.transport !== undefined && !["git", "archive"].includes(source.transport)) throw new Error("Invalid source transport in manifest");
    if (source.transport === "archive" && (!SHA256.test(source.archiveSha256 || "") || !Array.isArray(source.files) || source.files.length > ARCHIVE_LIMITS.entries)) throw new Error("Invalid archive integrity manifest");
    seen.add(source.sha);
  }
  if (manifest.selectedSha !== null && !seen.has(manifest.selectedSha)) throw new Error("Selected source is missing from manifest");
  return manifest;
}

async function rejectSymlink(file, io) {
  try {
    if ((await io.lstat(file)).isSymbolicLink()) throw new Error(`Managed service path must not be a symbolic link: ${file}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function readManifest(root, service, io) {
  await rejectSymlink(path.join(root, service), io);
  const manifestPath = path.join(root, service, "manifest.json");
  await rejectSymlink(manifestPath, io);
  try {
    return validateManifest(JSON.parse(await io.readFile(manifestPath, "utf8")), service);
  } catch (error) {
    if (error.code === "ENOENT") return emptyManifest(service);
    throw error;
  }
}

function sourcePath(root, service, sha) {
  if (!SHA.test(sha)) throw new Error("Source checkout requires a full commit SHA");
  return path.join(root, service, "sources", sha);
}

function runtimeStatus() {
  return { state: "not-managed", message: "Source selection does not start, upgrade, or roll back a running service. Check the configured service connection in RoleWeave." };
}

function quoteArgument(value, platform) {
  const text = String(value);
  return platform === "win32" ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\"'\"'")}'`;
}

export function deploymentInstructions(service, root, sha, platform = process.platform) {
  const definition = serviceDefinition(service);
  const source = sourcePath(root, service, sha);
  const envFile = path.join(root, service, "runtime", ".env");
  // A stable project name keeps volumes attached when the source SHA changes.
  const projectName = `roleweave-${service}-${createHash("sha256").update(root).digest("hex").slice(0, 10)}`;
  const composeArgs = ["compose", "--project-name", projectName, "--env-file", envFile, "--file", path.join(source, definition.compose)];
  const commands = [{ purpose: "Initialize persistent local configuration once without changing existing secrets", command: "node",
    args: [fileURLToPath(new URL("./local-services.mjs", import.meta.url)), "init", service, "--root", root] }];
  commands.push(
    { purpose: "Validate Compose after configuring the environment", command: "docker", args: [...composeArgs, "config", "--quiet"] },
    { purpose: "Deploy only after reviewing migrations and verifying a database/object backup", command: "docker", args: [...composeArgs, "up", "--detach", "--build", "--wait"], requiresDataBackup: true },
    { purpose: "Inspect actual container state", command: "docker", args: [...composeArgs, "ps"] },
  );
  return {
    source, envFile, projectName, origin: definition.origin, healthPath: definition.health,
    deploymentMode: service === "doc" ? "local-development" : "private-self-hosting",
    notes: [
      "These commands are instructions only; source preparation never runs them.",
      "Keep the same root, project name, environment and volumes across source updates. Preserve the environment file; do not regenerate existing secrets.",
      service === "doc"
        ? "doc has no published stable service release. Its supplied Compose runs development schema push; production migration safety is not guaranteed. Back up the database before any upgrade."
        : "mem release tags currently identify MCP artifacts, not a tested release of every service. Review the pinned checkout's docs/DEPLOYMENT.md and migration changes before deployment. Its web /healthz only proves proxy liveness; validate /v1/version, /v1/capabilities and an authorized /v1/files?limit=1 request with the selected workspace.",
      "Rolling back source does not roll back the database; a service downgrade needs an independently verified data recovery plan.",
    ],
    commands: commands.map((entry) => ({ ...entry, display: `${platform === "win32" ? "& " : ""}${[entry.command, ...entry.args].map((arg) => quoteArgument(arg, platform)).join(" ")}` })),
  };
}

export function createServiceManager({ root = DEFAULT_ROOT, io = fs, run = runProcess, resolve = resolveSource, fetchImpl = fetch, prepareArchive = prepareSourceArchive, now = () => new Date(), uuid = randomUUID } = {}) {
  root = path.resolve(root);

  async function canonicalizeRoot() {
    try { root = await io.realpath(root); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  async function locked(service, action) {
    await io.mkdir(root, { recursive: true, mode: 0o700 });
    root = await io.realpath(root);
    const serviceDir = path.join(root, service);
    await rejectSymlink(serviceDir, io);
    await io.mkdir(serviceDir, { recursive: true, mode: 0o700 });
    const lock = path.join(serviceDir, ".source-operation.lock");
    try {
      await io.mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") throw new Error(`Another source operation is active. If its process stopped, remove the empty lock directory: ${lock}`);
      throw error;
    }
    try {
      for (const name of ["sources", "runtime"]) {
        const directory = path.join(serviceDir, name);
        await rejectSymlink(directory, io);
        await io.mkdir(directory, { recursive: true, mode: 0o700 });
      }
      return await action();
    } finally {
      await io.rmdir(lock);
    }
  }

  async function saveManifest(service, manifest) {
    const target = path.join(root, service, "manifest.json");
    await rejectSymlink(target, io);
    const temporary = `${target}.${uuid()}.tmp`;
    try {
      await io.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await io.rename(temporary, target);
    } finally {
      await io.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }

  async function verifyCheckout(service, checkout, sha, source) {
    await rejectSymlink(checkout, io);
    if (source?.transport === "archive") {
      await verifyArchiveIntegrity(checkout, source, { io });
    } else {
      const actual = await run("git", ["-C", checkout, "rev-parse", "HEAD"]);
      if (actual.trim() !== sha) throw new Error("Prepared checkout does not match its pinned commit");
      const changes = await run("git", ["-C", checkout, "status", "--porcelain", "--untracked-files=no"]);
      if (changes.trim()) throw new Error("Prepared source has tracked modifications; preserve them separately before selecting this source");
    }
    const compose = path.join(checkout, SERVICES[service].compose);
    await rejectSymlink(compose, io);
    if (!(await io.stat(compose)).isFile()) throw new Error("Pinned source is missing its expected deployment Compose file");
  }

  function result(service, manifest) {
    const selected = manifest.sources.find((source) => source.sha === manifest.selectedSha);
    const summarize = ({ files, ...source }) => ({ ...source, ...(files ? { fileCount: files.length } : {}) });
    return {
      schemaVersion: SCHEMA, service, repository: SERVICES[service].repository, root,
      preparedSource: selected ? { ...summarize(selected), path: sourcePath(root, service, selected.sha), selectedAt: manifest.selectedAt } : null,
      sources: manifest.sources.map(summarize),
      deployment: runtimeStatus(),
      ...(selected ? { nextSteps: deploymentInstructions(service, root, selected.sha) } : {}),
    };
  }

  return {
    async verify(service, sha) {
      serviceDefinition(service);
      await canonicalizeRoot();
      const manifest = await readManifest(root, service, io);
      const selected = sha ?? manifest.selectedSha;
      const source = manifest.sources.find((entry) => entry.sha === selected);
      if (!source) throw new Error(`No prepared source for ${service}; prepare a pinned version first`);
      await verifyCheckout(service, sourcePath(root, service, selected), selected, source);
      return { ...result(service, manifest), verifiedSource: { sha: selected, path: sourcePath(root, service, selected) } };
    },
    async status(service) {
      serviceDefinition(service);
      await canonicalizeRoot();
      return result(service, await readManifest(root, service, io));
    },
    async plan(service, ref = "main") {
      serviceDefinition(service);
      validateRef(ref);
      await canonicalizeRoot();
      const candidate = await resolve(service, ref);
      if (!SHA.test(candidate?.sha) || candidate.repository !== SERVICES[service].repository) throw new Error("Invalid resolved upstream source");
      const manifest = await readManifest(root, service, io);
      return {
        ...result(service, manifest), candidate,
        candidateDeployment: deploymentInstructions(service, root, candidate.sha),
        sourceChangeAvailable: manifest.selectedSha !== candidate.sha,
        channel: ref === "main" ? "main-preview" : "explicit-ref",
        note: "This is an upstream source commit, not a verified stable deployment. Preparing it does not change running services.",
      };
    },
    async prepare(service, ref, { transport = "git" } = {}) {
      serviceDefinition(service);
      validateRef(ref);
      if (!["git", "archive"].includes(transport)) throw new Error("Source transport must be git or archive");
      const candidate = await resolve(service, ref);
      if (!SHA.test(candidate?.sha) || candidate.repository !== SERVICES[service].repository) throw new Error("Invalid resolved upstream source");
      return locked(service, async () => {
        const manifest = await readManifest(root, service, io);
        const checkout = sourcePath(root, service, candidate.sha);
        let exists = true;
        try { await io.lstat(checkout); } catch (error) { if (error.code === "ENOENT") exists = false; else throw error; }
        const previous = manifest.sources.find((source) => source.sha === candidate.sha);
        let fetchedAt = previous?.fetchedAt;
        let transportMetadata = previous?.transport === "archive" ? { transport: "archive", archiveSha256: previous.archiveSha256, files: previous.files } : { transport: "git" };
        if (!exists) {
          const staging = path.join(root, service, "sources", `.prepare-${uuid()}`);
          await io.mkdir(staging, { mode: 0o700 });
          const stagedCheckout = path.join(staging, "checkout");
          await io.mkdir(stagedCheckout, { mode: 0o700 });
          try {
            if (transport === "archive") {
              transportMetadata = await prepareArchive({ service, sha: candidate.sha, checkout: stagedCheckout, staging, fetchImpl });
            } else {
              await run("git", ["-c", "init.templateDir=", "init", stagedCheckout]);
              await run("git", ["-C", stagedCheckout, "remote", "add", "origin", `https://github.com/${SERVICES[service].repository}.git`]);
              await run("git", ["-C", stagedCheckout, "-c", "protocol.file.allow=never", "fetch", "--no-tags", "--depth=1", "origin", candidate.sha]);
              await run("git", ["-C", stagedCheckout, "-c", "core.hooksPath=", "checkout", "--detach", candidate.sha]);
              transportMetadata = { transport: "git" };
            }
            await verifyCheckout(service, stagedCheckout, candidate.sha, transportMetadata);
            await io.rename(stagedCheckout, checkout);
            fetchedAt = now().toISOString();
          } finally {
            // This exact staging directory was created here, under the canonical managed root.
            const allowed = path.join(root, service, "sources");
            if (path.dirname(staging) !== allowed || !path.basename(staging).startsWith(".prepare-")) throw new Error("Refusing cleanup outside source staging");
            await rejectSymlink(staging, io);
            await io.rm(staging, { recursive: true, force: true });
          }
        } else {
          await verifyCheckout(service, checkout, candidate.sha, previous);
        }
        const source = { sha: candidate.sha, ref, fetchedAt: fetchedAt || now().toISOString(), sourceUrl: candidate.sourceUrl, ...transportMetadata };
        manifest.sources = [...manifest.sources.filter((entry) => entry.sha !== candidate.sha), source];
        manifest.selectedSha = candidate.sha;
        manifest.selectedAt = now().toISOString();
        await saveManifest(service, manifest);
        return result(service, manifest);
      });
    },
    async rollbackSource(service, sha) {
      serviceDefinition(service);
      if (!SHA.test(sha || "")) throw new Error("rollback-source requires --sha with a previously prepared full commit SHA");
      return locked(service, async () => {
        const manifest = await readManifest(root, service, io);
        if (!manifest.sources.some((entry) => entry.sha === sha)) throw new Error("That commit has not been prepared for this service");
        await verifyCheckout(service, sourcePath(root, service, sha), sha, manifest.sources.find((source) => source.sha === sha));
        manifest.selectedSha = sha;
        manifest.selectedAt = now().toISOString();
        await saveManifest(service, manifest);
        return result(service, manifest);
      });
    },
  };
}

export function parseArguments(argv) {
  const [command, service, ...options] = argv;
  if (!command || command === "--help" || command === "help") return { command: "help" };
  if (!["plan", "status", "prepare", "update-source", "rollback-source"].includes(command)) throw new Error("Unknown service source command");
  serviceDefinition(service);
  const parsed = { command, service };
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (!["--root", "--ref", "--channel", "--sha", "--transport"].includes(option) || !options[index + 1] || options[index + 1].startsWith("--")) throw new Error(`Unknown or incomplete option: ${option}`);
    const key = option.slice(2);
    if (parsed[key] !== undefined) throw new Error(`Duplicate option: ${option}`);
    parsed[key] = options[++index];
  }
  if (parsed.ref && parsed.channel) throw new Error("Choose --ref or --channel, not both");
  if (parsed.transport && (!["git", "archive"].includes(parsed.transport) || !["prepare", "update-source"].includes(command))) throw new Error("--transport git|archive is only accepted by prepare/update-source");
  if (parsed.channel && parsed.channel !== "main") throw new Error("Only the explicit preview channel --channel main is supported");
  if (parsed.ref) validateRef(parsed.ref);
  if (["prepare", "update-source"].includes(command) && !parsed.ref && !parsed.channel) throw new Error("Preparing source requires --ref <branch/tag/SHA> or the explicit preview choice --channel main; run plan first");
  if (command === "rollback-source" && (!SHA.test(parsed.sha || "") || parsed.ref || parsed.channel)) throw new Error("rollback-source requires only --sha <previously prepared full SHA> and optional --root");
  if (command !== "rollback-source" && parsed.sha) throw new Error("--sha is only accepted by rollback-source; use --ref to prepare a commit");
  if (command === "status" && (parsed.ref || parsed.channel)) throw new Error("status reads local metadata; use plan to check upstream changes");
  return parsed;
}

const HELP = `RoleWeave independent service sources (requires Node.js 22+, GitHub access)

  node scripts/services.mjs plan doc [--ref main] [--root <directory>]
  node scripts/services.mjs prepare doc --ref <SHA> [--root <directory>]
  node scripts/services.mjs prepare doc --ref <SHA> --transport archive [--root <directory>]
  node scripts/services.mjs update-source mem --channel main [--root <directory>]
  node scripts/services.mjs status doc [--root <directory>]
  node scripts/services.mjs rollback-source doc --sha <previous-SHA> [--root <directory>]

Services: doc, mem. Default root: ~/.roleweave/services.
plan defaults to the main preview channel and only reads upstream metadata.
prepare/update-source resolves a ref, checks out a pinned commit and selects source only.
Default transport git requires Git. Archive uses official codeload with bounded extraction and per-file integrity checks.
status never claims that a prepared source is running. rollback-source never rolls back data.
All results are JSON, including explicit deployment commands; no deployment is automatic.
`;

export async function main(argv = process.argv.slice(2), { output = console.log, managerFactory = createServiceManager } = {}) {
  const parsed = parseArguments(argv);
  if (parsed.command === "help") { output(HELP); return; }
  const manager = managerFactory({ root: parsed.root });
  let result;
  if (parsed.command === "status") result = await manager.status(parsed.service);
  else if (parsed.command === "plan") result = await manager.plan(parsed.service, parsed.ref || parsed.channel || "main");
  else if (parsed.command === "rollback-source") result = await manager.rollbackSource(parsed.service, parsed.sha);
  else if (parsed.transport) result = await manager.prepare(parsed.service, parsed.ref || parsed.channel, { transport: parsed.transport });
  else result = await manager.prepare(parsed.service, parsed.ref || parsed.channel);
  output(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
}

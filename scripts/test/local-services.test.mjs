import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalStack, parseLocalArguments } from "../local-services.mjs";

const FIRST = "a".repeat(40), SECOND = "b".repeat(40);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "roleweave-local-stack-"));
  t.after(async () => { assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  for (const kind of ["doc", "mem"]) await fs.mkdir(path.join(root, kind, "runtime"), { recursive: true });
  const calls = [], initializations = [], verifications = [];
  const state = { sha: FIRST, failConfig: null, failUp: null, offline: false, host: "unix:///var/run/docker.sock", blockUp: null };
  const sourceManagerFactory = () => ({
    status: async (kind) => ({ root, preparedSource: { sha: state.sha, path: path.join(root, kind, "sources", state.sha) } }),
    verify: async (kind, sha = state.sha) => { verifications.push({ kind, sha }); return { verifiedSource: { sha, path: path.join(root, kind, "sources", sha) } }; },
  });
  const initialize = async ({ kind, envFile, sourcePath }) => {
    initializations.push({ kind, envFile, sourcePath });
    let created = false;
    try { await fs.writeFile(envFile, "AUTH_SECRET=fixture-private-token\nMEM_IMAGE_TAG=local\n", { flag: "wx", mode: 0o600 }); created = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    return { created, envFile };
  };
  const run = async (command, args, options) => {
    calls.push({ command, args, options }); assert.equal(command, "docker");
    if (args[0] === "context") return JSON.stringify(state.host);
    if (args[0] === "info") { if (state.offline) throw new Error("secret-docker-endpoint"); return "27.3.1"; }
    if (args[0] === "ps" && args.at(-1) === "{{.ID}}") return "a12345678901\nb12345678902";
    if (["stop", "logs"].includes(args[0])) return "";
    if (args[0] === "ps") return JSON.stringify({ Names: "roleweave-doc-web", State: "running", Status: "Up (healthy)", Ports: "127.0.0.1:3100", Labels: "private-label-token" });
    if (args[1] === "version") return "2.29.1-desktop.1";
    const kind = args[args.indexOf("--project-name") + 1].includes("-doc-") ? "doc" : "mem";
    if (args.includes("config") && state.failConfig === kind) throw new Error("AUTH_SECRET=fixture-private-token");
    if (args.includes("config")) return JSON.stringify({ name: args[args.indexOf("--project-name") + 1], services: { web: {} } });
    if (args.includes("up")) {
      if (state.blockUp) await state.blockUp();
      if (state.failUp === kind) throw new Error("reflected secret");
    }
    return "";
  };
  const stack = createLocalStack({ root, run, initialize, sourceManagerFactory, environment: {} });
  return { root, calls, state, initializations, verifications, stack,
    binding: (kind) => fs.readFile(path.join(root, kind, "runtime", "deployment.json"), "utf8").then(JSON.parse) };
}

test("local command accepts one or both services and refuses arbitrary Docker/data-removal arguments", () => {
  assert.deepEqual(parseLocalArguments(["up"]), { action: "up", kind: "all", root: undefined });
  assert.equal(parseLocalArguments(["stop", "mem", "--root", "some path"]).kind, "mem");
  for (const argv of [["down"], ["stop", "all", "--volumes"], ["up", "../mem"], ["logs", "doc", "--root"], ["up", "--root", "a", "--root", "b"]]) assert.throws(() => parseLocalArguments(argv));
});

test("init prepares both persistent environments without invoking Docker and preserves existing secrets", async (t) => {
  const f = await fixture(t);
  let result = await f.stack.perform("init");
  assert.equal(result.services.length, 2); assert.equal(f.calls.length, 0);
  assert.ok(result.services.every((service) => service.environmentCreated));
  result = await f.stack.perform("init");
  assert.ok(result.services.every((service) => !service.environmentCreated));
  assert.equal(JSON.stringify(result).includes("fixture-private-token"), false);
});

test("config validates both Compose files without contacting the daemon or starting containers", async (t) => {
  const f = await fixture(t); const result = await f.stack.perform("config");
  assert.ok(result.services.every((service) => service.state === "validated"));
  assert.equal(f.calls.filter((call) => call.args.includes("config")).length, 2);
  assert.equal(f.calls.some((call) => ["info", "up", "stop"].some((word) => call.args.includes(word))), false);
});

test("up validates both projects before starting, records deployment input and pins mem images", async (t) => {
  const f = await fixture(t); const result = await f.stack.perform("up");
  assert.ok(result.services.every((service) => service.state === "started"));
  const configs = f.calls.map((call, index) => call.args.includes("config") ? index : -1).filter((index) => index >= 0);
  const starts = f.calls.filter((call) => call.args.includes("up"));
  assert.equal(starts.length, 2);
  assert.ok(configs.every((index) => index < f.calls.indexOf(starts[0])));
  assert.equal(starts[1].options.env.MEM_IMAGE_TAG, FIRST);
  assert.equal(starts[1].options.env.MEM_SERVER_IMAGE, `${result.services[1].project}-server:${FIRST}`);
  assert.equal(starts[0].options.env.AUTH_SECRET, undefined);
  assert.notEqual(result.services[0].project, result.services[1].project);
  for (const kind of ["doc", "mem"]) assert.equal((await f.binding(kind)).sha, FIRST);
  assert.equal(JSON.stringify(result).includes("fixture-private-token"), false);
  assert.ok(f.calls.every((call) => !call.args.includes("down") && !call.args.includes("--volumes")));
});

test("one bad configuration prevents both starts and never reflects credential-bearing stderr", async (t) => {
  const f = await fixture(t); f.state.failConfig = "mem";
  await assert.rejects(f.stack.perform("up"), (error) => !error.message.includes("fixture-private-token") && /mem Compose config failed/.test(error.message));
  assert.equal(f.calls.some((call) => call.args.includes("up")), false);
  assert.equal((await fs.readdir(f.root)).includes(".local-stack-operation.lock"), false);
});

test("partial start failure is explicit and leaves successful service/data untouched", async (t) => {
  const f = await fixture(t); f.state.failUp = "mem";
  const result = await f.stack.perform("up");
  assert.deepEqual(result.services.map((service) => service.state), ["started", "failed"]);
  assert.equal((await f.binding("mem")).state, "failed");
  assert.equal((await f.binding("doc")).state, "started");
  assert.equal(f.calls.some((call) => call.args.includes("stop") || call.args.includes("down")), false);
  assert.equal(JSON.stringify(result).includes("reflected secret"), false);
});

test("source updates do not redirect stop away from the recorded deployment", async (t) => {
  const f = await fixture(t); await f.stack.perform("up", "doc");
  const project = (await f.stack.perform("config", "doc")).services[0].project;
  f.state.sha = SECOND;
  const result = await f.stack.perform("stop", "doc");
  assert.equal(result.services[0].sha, FIRST); assert.equal(result.services[0].project, project);
  const stop = f.calls.find((call) => call.args.includes("stop"));
  assert.deepEqual(stop.args, ["stop", "--time", "30", "a12345678901", "b12345678902"]);
  assert.equal((await f.binding("doc")).state, "stopped");
});

test("remote Docker context is refused before any daemon or deployment request", async (t) => {
  const f = await fixture(t); f.state.host = "ssh://some-host";
  await assert.rejects(f.stack.perform("up"), /local context/);
  assert.equal(f.calls.some((call) => call.args[0] === "info" || call.args.includes("up")), false);
});

test("status reads actual container state, excludes arbitrary labels and reports offline as unknown", async (t) => {
  const f = await fixture(t); let result = await f.stack.perform("status");
  assert.equal(result.services[0].containers[0].state, "running");
  assert.equal(result.services[0].deployment, null);
  assert.equal(JSON.stringify(result).includes("private-label-token"), false);
  f.state.offline = true; result = await f.stack.perform("status");
  assert.equal(result.engine.available, false);
  assert.ok(result.services.every((entry) => entry.state === "unknown"));
  assert.equal(JSON.stringify(result).includes("secret-docker-endpoint"), false);
});

test("a marker-less empty legacy lock from an interrupted startup is reclaimed safely", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, ".local-stack-operation.lock"), { mode: 0o700 });
  const result = await f.stack.perform("init", "doc");
  assert.equal(result.services[0].state, "initialized");
  await assert.rejects(fs.lstat(path.join(f.root, ".local-stack-operation.lock")), { code: "ENOENT" });
});

test("a lock owned by a confirmed-dead local process is reclaimed safely", async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.root, ".local-stack-operation.lock");
  await fs.mkdir(lock, { mode: 0o700 });
  await fs.writeFile(path.join(lock, "owner"), "999999999:00000000-0000-4000-8000-000000000000\n", { mode: 0o600 });
  const result = await f.stack.perform("init", "doc");
  assert.equal(result.services[0].state, "initialized");
  await assert.rejects(fs.lstat(lock), { code: "ENOENT" });
});

test("one stack lock prevents stop interleaving with an unfinished startup", async (t) => {
  const f = await fixture(t); let reached, release;
  const ready = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  f.state.blockUp = async () => { reached(); await gate; };
  const start = f.stack.perform("up", "doc");
  await ready;
  await assert.rejects(f.stack.perform("stop", "doc"), /Another local stack operation/);
  release(); await start;
});

test("a failed upgrade keeps successful source history and stop includes old project containers", async (t) => {
  const f = await fixture(t); await f.stack.perform("up", "doc");
  f.state.sha = SECOND; f.state.failUp = "doc";
  await f.stack.perform("up", "doc");
  const record = await f.binding("doc");
  assert.equal(record.appliedSha, FIRST); assert.equal(record.attemptedSha, SECOND);
  await f.stack.perform("stop", "doc");
  assert.deepEqual(f.calls.find((call) => call.args[0] === "stop").args.slice(-2), ["a12345678901", "b12345678902"]);
});

test("remote Windows named pipes do not pass the local context check", async (t) => {
  const f = await fixture(t); f.state.host = "npipe:////remote-machine/pipe/docker_engine";
  assert.equal((await f.stack.doctor()).available, false);
  f.state.host = "npipe:////./pipe/docker_engine";
  assert.equal((await f.stack.doctor()).available, true);
});

test("explicit mem image names remain owned by the persistent environment", async (t) => {
  const f = await fixture(t); await f.stack.perform("init", "mem");
  await fs.appendFile(path.join(f.root, "mem", "runtime", ".env"), "MEM_SERVER_IMAGE=example/custom:local\n");
  await f.stack.perform("up", "mem");
  assert.equal(f.calls.find((call) => call.args.includes("up")).options.env.MEM_SERVER_IMAGE, undefined);
});

test("daemon readiness rejects zero-exit error text instead of treating it as a version", async (t) => {
  const f = await fixture(t);
  const stack = createLocalStack({ root: f.root, environment: {}, run: async (_command, args) => {
    if (args[0] === "context") return JSON.stringify("npipe:////./pipe/docker_engine");
    if (args[0] === "info") return "error during connect: private-endpoint";
    return "2.29.1";
  } });
  const result = await stack.doctor();
  assert.equal(result.available, false); assert.equal(JSON.stringify(result).includes("private-endpoint"), false);
});

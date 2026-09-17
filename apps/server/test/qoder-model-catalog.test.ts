import assert from "node:assert/strict";
import { type ChildProcess, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { EmployeeModelConfig, TurnRecord, TurnRunRequest, WorkbenchSession } from "@roleweave/shared";
import { employeeModelConfig } from "../src/model-selection.js";
import { parseQoderModelCatalog, QoderModelCatalog, qoderModelCatalog, queryQoderModelCatalog, stopQoderCatalogProbe } from "../src/qoder-model-catalog.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

// Sanitized CLI 1.1.53 single-column format, not a pinned account entitlement list.
const LIST = "MODEL\nAuto\nUltimate\nLite\nDeepSeek-Fixture\nTeam Model (mode-fixture)\n";

async function fixture(t: TestContext) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-qoder-catalog-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".qoder");
  await fs.mkdir(configDir);
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, ORG_WORKBENCH_QODER_BIN: process.execPath };
  return { home, configDir, env };
}

async function executable(t: TestContext, script: string) {
  const result = await fixture(t);
  const file = path.join(result.home, "catalog fixture.cjs");
  await fs.writeFile(file, `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
  let command = file;
  if (process.platform === "win32") {
    command = path.join(result.home, "catalog fixture.cmd");
    await fs.writeFile(command, `@"${process.execPath}" "${file}" %*\r\n`);
  }
  result.env.ORG_WORKBENCH_QODER_BIN = command;
  // Windows launchers require the system command processor, not arbitrary env.
  for (const key of ["SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT"]) {
    if (process.env[key]) result.env[key] = process.env[key];
  }
  return { ...result, command };
}

test("Qoder catalog preserves exact concrete selectors and registered custom IDs without guessed rates", () => {
  const options = parseQoderModelCatalog(LIST)!;
  assert.deepEqual(options.map(({ id, group }) => ({ id, group })), [
    { id: "Auto", group: "tiers" }, { id: "Ultimate", group: "tiers" }, { id: "Lite", group: "tiers" },
    { id: "DeepSeek-Fixture", group: "models" }, { id: "mode-fixture", group: "custom" },
  ]);
  assert.equal(options.at(-1)?.name, "Team Model");
  assert.equal(options.at(-1)?.billing, "unknown");
  assert.equal(options[3]?.billing, "qoder");
  assert.doesNotMatch(JSON.stringify(options), /price|multiplier|rate/i);
  assert.deepEqual(parseQoderModelCatalog(`\u001b[32mMODEL\u001b[0m\r\nAuto\r\nAuto\r\n`), [options[0]]);
});

test("Qoder catalog rejects missing, ambiguous, oversized, and control-bearing output", () => {
  for (const output of ["", "MODEL", "Login required\nMODEL\nAuto", "MODEL PRICE\nAuto 1x", "MODEL\nUnrecognized row with spaces", "MODEL\n--flag", "MODEL\nName\u0000", "MODEL\nTeam (mode-fixture)\u001b[2J", "MODEL\n" + "x".repeat(65_536), "MODEL\n" + Array.from({ length: 257 }, (_, i) => `model-${i}`).join("\n")]) {
    assert.equal(parseQoderModelCatalog(output), null);
  }
});

test("concurrent catalog reads coalesce and clones cannot mutate the cached result", async (t) => {
  const { env } = await fixture(t);
  let calls = 0;
  let release!: (output: string) => void;
  const catalog = new QoderModelCatalog({ query: async () => { calls++; return new Promise((resolve) => { release = resolve; }); } });
  const reads = [catalog.read(env), catalog.read(env), catalog.read(env)];
  assert.equal(calls, 1);
  release(LIST);
  const results = await Promise.all(reads);
  results[0]!.options.length = 0;
  assert.equal(results[1]!.options.length, 5);
  assert.equal((await catalog.read(env)).options.length, 5);
  assert.equal(calls, 1);
});

test("failed refresh is stale only within its bounded age; unavailable reads have a retry TTL", async (t) => {
  const { env } = await fixture(t);
  let now = 0;
  let calls = 0;
  const catalog = new QoderModelCatalog({ now: () => now, ttlMs: 30, retryMs: 5, staleMs: 40, query: async () => ++calls === 1 ? LIST : null });
  assert.equal((await catalog.read(env)).status, "ready");
  now = 31;
  assert.equal((await catalog.read(env)).status, "stale");
  assert.equal(calls, 2);
  now = 34;
  assert.equal((await catalog.read(env)).status, "stale");
  assert.equal(calls, 2);
  now = 38;
  assert.equal((await catalog.read(env)).status, "stale");
  now = 40; // The 5ms failure TTL must not extend the 40ms stale lifetime.
  assert.deepEqual(await catalog.read(env), { status: "unavailable", options: [] });
  assert.equal(calls, 4);
  now = 44;
  assert.equal((await catalog.read(env)).status, "unavailable");
  assert.equal(calls, 4);
  now = 45;
  await catalog.read(env);
  assert.equal(calls, 5);
});

test("mutation reads never start or await a catalog process", async (t) => {
  const { env } = await fixture(t);
  let now = 0;
  let calls = 0;
  let release!: (output: string) => void;
  const catalog = new QoderModelCatalog({ now: () => now, ttlMs: 10, staleMs: 30, query: async () => { calls++; return new Promise((resolve) => { release = resolve; }); } });
  assert.equal((await catalog.read(env, "cached")).status, "unavailable");
  assert.equal(calls, 0);
  const inFlight = catalog.read(env);
  assert.equal((await catalog.read(env, "cached")).status, "unavailable");
  release(LIST);
  await inFlight;
  assert.equal((await catalog.read(env, "cached")).status, "ready");
  now = 11;
  assert.equal((await catalog.read(env, "cached")).status, "stale");
  now = 30;
  assert.equal((await catalog.read(env, "cached")).status, "unavailable");
  assert.equal(calls, 1);
});

test("cache identities follow executable, profile, settings and credentials without forwarding unrelated secrets", async (t) => {
  const { env, configDir, home } = await fixture(t);
  let calls = 0;
  const environments: NodeJS.ProcessEnv[] = [];
  const catalog = new QoderModelCatalog({ query: async (_command, queryEnv) => { calls++; environments.push(queryEnv); return LIST; } });
  env.UNRELATED_SECRET = "do-not-forward";
  await catalog.read(env);
  await fs.writeFile(path.join(configDir, "some-cli-log"), "new log changes directory timestamp");
  await catalog.read(env);
  assert.equal(calls, 1);
  await fs.writeFile(path.join(configDir, "settings.json"), '{"model":{"name":"Auto"}}');
  await catalog.read(env);
  assert.equal(calls, 2);
  await catalog.read({ ...env, QODER_PERSONAL_ACCESS_TOKEN: "fixture-token-one" });
  await catalog.read({ ...env, QODER_PERSONAL_ACCESS_TOKEN: "fixture-token-two" });
  assert.equal(calls, 4);
  await catalog.read({ ...env, QODER_CONFIG_DIR: path.join(home, "other-profile") });
  await catalog.read({ ...env, HOME: path.join(home, "other-home") });
  assert.equal(calls, 6);
  assert.equal(environments.every((entry) => entry.UNRELATED_SECRET === undefined), true);
  assert.equal(environments.at(-2)?.QODER_CONFIG_DIR, path.join(home, "other-profile"));
  const otherCommand = path.join(home, "other-command");
  await fs.writeFile(otherCommand, "fixture", { mode: 0o700 });
  await catalog.read({ ...env, ORG_WORKBENCH_QODER_BIN: otherCommand });
  assert.equal(calls, 7);
  await fs.appendFile(otherCommand, "-changed");
  await catalog.read({ ...env, ORG_WORKBENCH_QODER_BIN: otherCommand });
  assert.equal(calls, 8);
});

test("catalog limits concurrent account identities and fails closed for a missing executable", async (t) => {
  const { env, home } = await fixture(t);
  const releases: Array<(output: string) => void> = [];
  const catalog = new QoderModelCatalog({ query: async () => new Promise((resolve) => releases.push(resolve)) });
  const requests = Array.from({ length: 16 }, (_, i) => catalog.read({ ...env, QODER_CONFIG_DIR: path.join(home, String(i)) }));
  assert.equal((await catalog.read({ ...env, QODER_CONFIG_DIR: path.join(home, "overflow") })).status, "unavailable");
  assert.equal((await catalog.read({ ...env, ORG_WORKBENCH_QODER_BIN: path.join(home, "missing") })).status, "unavailable");
  assert.equal(releases.length, 16);
  releases.forEach((release) => release(LIST));
  await Promise.all(requests);
});

test("read-only CLI invocation uses exact argv and explicit profile without a prompt or inherited secrets", async (t) => {
  const { env, configDir } = await executable(t, `
    const expected = ['--list-models', '--config-dir', process.env.QODER_CONFIG_DIR];
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected) || process.env.UNRELATED_SECRET) process.exit(9);
    process.stdout.write(${JSON.stringify(LIST)});
  `);
  env.QODER_CONFIG_DIR = configDir;
  env.UNRELATED_SECRET = "never-forward-this";
  const result = await new QoderModelCatalog().read(env);
  assert.equal(result.status, "ready");
  assert.equal(result.options[3]?.id, "DeepSeek-Fixture");
});

test("CLI failure, invalid UTF-8, and output overflow produce no raw diagnostics", async (t) => {
  for (const script of [
    "process.stderr.write('private-fixture-diagnostic'); process.exit(1);",
    "process.stdout.write(Buffer.from([0xff, 0xfe]));",
    "process.stdout.write('x'.repeat(70_000));",
    "process.stderr.write('x'.repeat(70_000));",
  ]) {
    const { command, env } = await executable(t, script);
    assert.equal(await queryQoderModelCatalog(command, env), null);
  }
});

test("a stuck catalog query is bounded by its deadline", async (t) => {
  // Self-terminate as well: this timing assertion does not claim Windows cmd
  // descendant cleanup, which requires native Windows acceptance separately.
  const { command, env } = await executable(t, "setTimeout(() => process.exit(0), 3000);");
  const start = Date.now();
  assert.equal(await queryQoderModelCatalog(command, env, 100), null);
  assert.ok(Date.now() - start < 2000);
});

test("Windows catalog cleanup starts a bounded credential-free tree killer before killing its parent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: string[] = [];
  const child = { pid: 54321, kill: () => { events.push("parent"); return true; } } as ChildProcess;
  const killer = Object.assign(new EventEmitter(), { kill: () => { events.push("killer"); return true; } });
  const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
    assert.equal(command, "C:\\Windows\\System32\\taskkill.exe");
    assert.deepEqual(args, ["/PID", "54321", "/T", "/F"]);
    assert.equal(options.shell, false);
    assert.equal(options.stdio, "ignore");
    assert.deepEqual(options.env, { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" });
    events.push("tree");
    return killer;
  }) as unknown as typeof spawn;
  const stopped = stopQoderCatalogProbe(child, { platform: "win32", systemRoot: "C:\\Windows", spawnImpl });
  assert.deepEqual(events, ["tree"]);
  t.mock.timers.tick(1000);
  await stopped;
  assert.deepEqual(events, ["tree", "killer", "parent"]);
  killer.emit("exit", 0);
  assert.deepEqual(events, ["tree", "killer", "parent"]);
});

test("Windows catalog cleanup handles successful tree termination and rejects unsafe PIDs/relative system roots", async () => {
  const events: string[] = [];
  const child = { pid: 54321, kill: () => { events.push("parent"); return true; } } as ChildProcess;
  const killer = Object.assign(new EventEmitter(), { kill: () => true });
  const spawnImpl = (() => { events.push("tree"); return killer; }) as unknown as typeof spawn;
  const stopped = stopQoderCatalogProbe(child, { platform: "win32", systemRoot: "C:\\Windows", spawnImpl });
  assert.deepEqual(events, ["tree"]);
  killer.emit("exit", 0);
  await stopped;
  assert.deepEqual(events, ["tree", "parent"]);
  for (const pid of [undefined, 0, -1, 1, process.pid, NaN, 2.5]) {
    await stopQoderCatalogProbe({ ...child, pid } as ChildProcess, { platform: "win32", spawnImpl });
  }
  assert.deepEqual(events, ["tree", "parent"]);
  for (const ended of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: "SIGKILL" }]) {
    await stopQoderCatalogProbe({ ...child, ...ended } as ChildProcess, { platform: "win32", spawnImpl });
  }
  assert.deepEqual(events, ["tree", "parent"]);
  await stopQoderCatalogProbe(child, { platform: "win32", systemRoot: "relative-root", spawnImpl });
  assert.deepEqual(events, ["tree", "parent", "parent"]);
});

test("Windows timeout removes both the cmd launcher and a permanently stuck CLI descendant", { skip: process.platform !== "win32" }, async (t) => {
  const { command, env, home } = await executable(t, `
    require('node:fs').writeFileSync(require('node:path').join(process.env.HOME, 'started.json'), JSON.stringify({ pid: process.pid, parent: process.ppid }));
    setInterval(() => {}, 1000);
  `);
  const result = queryQoderModelCatalog(command, env, 5000);
  const handshake = path.join(home, "started.json");
  let pids: { pid: number; parent: number } | undefined;
  const started = Date.now();
  while (Date.now() - started < 4000) {
    try { pids = JSON.parse(await fs.readFile(handshake, "utf8")); break; } catch { /* Wait for the CLI handshake. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(pids, "the fake CLI must start before the timeout tests descendant cleanup");
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(() => { for (const pid of [pids!.pid, pids!.parent]) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } } });
  assert.equal(await result, null);
  const cleanupStarted = Date.now();
  while ([pids.pid, pids.parent].some(alive) && Date.now() - cleanupStarted < 2000) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(alive(pids.pid), false, "the CLI descendant must be reaped");
  assert.equal(alive(pids.parent), false, "the cmd launcher must be reaped");
});

test("employee config merges real CLI selectors with local billing and preserves defaults and saved choices", async (t) => {
  const { env, configDir } = await executable(t, `process.stdout.write(${JSON.stringify(LIST)});`);
  await fs.writeFile(path.join(configDir, "settings.json"), JSON.stringify({
    model: { name: "provider/small" },
    providers: { provider: { protocol: "openai", apiKey: "private-fixture-key", baseUrl: "https://example.test/private-path", model: "small" } },
  }));
  const config = await employeeModelConfig("qoder", undefined, true, env);
  assert.equal(config.catalogStatus, "ready");
  assert.equal(config.source, "local-config");
  assert.equal(config.selected, "provider-default");
  assert.equal(config.options.find((entry) => entry.id === "provider-default")?.resolvedModel, "provider/small");
  assert.equal(config.options.find((entry) => entry.id === "provider/small")?.billing, "provider");
  assert.equal(config.options.find((entry) => entry.id === "provider/small")?.group, "custom");
  assert.equal(config.options.find((entry) => entry.id === "DeepSeek-Fixture")?.group, "models");
  assert.doesNotMatch(JSON.stringify(config), /private-fixture-key|private-path/);
  const selected = await employeeModelConfig("qoder", "DeepSeek-Fixture", true, env);
  assert.equal(selected.selected, "DeepSeek-Fixture");
  assert.equal(selected.connection?.billing, "unknown"); // Listing is not a new connection resolver.
  const saved = await employeeModelConfig("qoder", "saved/unknown", true, env);
  assert.deepEqual(saved.options.find((entry) => entry.id === "saved/unknown"), { id: "saved/unknown", name: "saved/unknown", tier: "default", billing: "unknown" });
  const readonly = await employeeModelConfig("qoder", undefined, false, env);
  assert.equal(readonly.catalogStatus, undefined);
  assert.equal(readonly.allowCustomModel, undefined);
  await fs.writeFile(path.join(configDir, "settings.json"), JSON.stringify({ model: { name: "local-only-fixture" } }));
  const configured = await employeeModelConfig("qoder", undefined, true, env);
  assert.equal(configured.options.find((entry) => entry.id === "local-only-fixture")?.group, "custom");
  assert.equal(configured.options.find((entry) => entry.id === "local-only-fixture")?.billing, "unknown");
  await fs.writeFile(path.join(configDir, "settings.json"), JSON.stringify({ model: { name: "auto" } }));
  const legacyTier = await employeeModelConfig("qoder", undefined, true, env);
  assert.equal(legacyTier.options.find((entry) => entry.id === "auto")?.group, "tiers");
});

test("an unavailable catalog keeps routing aliases, local default and unknown saved selectors usable", async (t) => {
  const { env } = await executable(t, "process.stderr.write('login-required-private-fixture'); process.exit(1);");
  const config = await employeeModelConfig("qoder", "saved/unknown", true, env);
  assert.equal(config.catalogStatus, "unavailable");
  assert.equal(config.allowCustomModel, true);
  assert.equal(config.selected, "saved/unknown");
  assert.equal(config.options.find((entry) => entry.id === "auto")?.group, "tiers");
  assert.ok(config.options.some((entry) => entry.id === "provider-default"));
  assert.doesNotMatch(JSON.stringify(config), /login-required-private-fixture/);
});

test("an exact concrete catalog selector saves and reaches the driver without changing session context", async (t) => {
  const { env } = await fixture(t);
  const priorConfigDir = process.env.QODER_CONFIG_DIR;
  process.env.QODER_CONFIG_DIR = path.join(env.HOME!, ".qoder");
  t.after(() => {
    if (priorConfigDir === undefined) delete process.env.QODER_CONFIG_DIR;
    else process.env.QODER_CONFIG_DIR = priorConfigDir;
  });
  const modes: Array<"refresh" | "cached" | undefined> = [];
  t.mock.method(qoderModelCatalog, "read", async (_env: NodeJS.ProcessEnv, mode?: "refresh" | "cached") => {
    modes.push(mode);
    return { status: "ready", options: parseQoderModelCatalog(LIST)! };
  });
  const requests: TurnRunRequest[] = [];
  const server = await startTestServer(undefined, { async turnRun(request) {
    requests.push(request);
    const timestamp = new Date().toISOString();
    return { status: "trusted", diagnostic: "", events: [
      { type: "run.started", runId: request.envelope.turnId, timestamp },
      { type: "run.completed", runId: request.envelope.turnId, timestamp, output: "catalog model selected", terminalReason: "goal_met" },
    ] };
  } });
  const workspace = await copyExampleWorkspace();
  server.ctx.config.bundledElectronEngine = true;
  try {
    const call = (url: string, method: string, body: unknown) => api(server.baseUrl, url, { method, body, token: server.token });
    assert.equal((await call("/workspace/open", "POST", { path: workspace })).status, 200);
    const card = await api(server.baseUrl, "/positions/repo-owner?engine=qoder", { token: server.token });
    assert.equal((card.body as { modelConfig: EmployeeModelConfig }).modelConfig.options.find((entry) => entry.id === "DeepSeek-Fixture")?.group, "models");
    assert.deepEqual(modes, ["refresh"]);
    const selection = await call("/positions/repo-owner/model", "PATCH", { model: "DeepSeek-Fixture", engine: "qoder" });
    assert.equal(selection.status, 200);
    assert.equal((selection.body as EmployeeModelConfig).selected, "DeepSeek-Fixture");
    assert.deepEqual(modes, ["refresh", "cached", "cached"]);
    const session = (await call("/sessions", "POST", { positionId: "repo-owner" })).body as WorkbenchSession;
    const turn = (await call(`/sessions/${session.sessionId}/turns`, "POST", { engine: "qoder", input: "Use the chosen model" })).body as TurnRecord;
    assert.equal(turn.model, "DeepSeek-Fixture");
    assert.equal(turn.conversationRef, session.sessionId);
    assert.equal(requests[0]?.model, "DeepSeek-Fixture");
  } finally {
    await server.ctx.contextExporter.waitForIdle();
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

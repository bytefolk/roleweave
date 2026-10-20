import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { CodexModelCatalog, codexModelCatalog, queryCodexModelCatalog } from "../src/codex-model-catalog.js";
import { employeeModelConfig } from "../src/model-selection.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";
import type { EmployeeModelConfig, TurnRecord, TurnRunRequest, WorkbenchSession } from "@roleweave/shared";

const MODEL = { id: "catalog-row", model: "gpt-fixture-new", displayName: "New model", hidden: false, isDefault: true };
const RESULT = { options: [{ id: MODEL.model, name: MODEL.displayName, tier: "balanced" as const }], recommended: MODEL.model };

async function fixture(t: TestContext, script?: string) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-codex-catalog-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".codex");
  await fs.mkdir(configDir);
  let command = process.execPath;
  if (script !== undefined) {
    const file = path.join(home, "catalog fixture.cjs");
    await fs.writeFile(file, `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
    command = file;
    if (process.platform === "win32") {
      command = path.join(home, "catalog fixture.cmd");
      await fs.writeFile(command, `@"${process.execPath}" "${file}" %*\r\n`);
    }
  }
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, CODEX_HOME: configDir, DIGITAL_EMPLOYEE_CODEX_COMMAND: command };
  for (const key of ["SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
  return { home, configDir, command, env };
}

function rpcScript(handler: string): string {
  return `
    const readline = require('node:readline');
    const reply = (id, result) => process.stdout.write(JSON.stringify({id, result}) + '\\n');
    let initialized = false;
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') { reply(request.id, {userAgent: 'fixture'}); return; }
      if (request.method === 'initialized') { initialized = true; return; }
      if (!initialized || request.method !== 'model/list' || request.params.includeHidden !== false) process.exit(9);
      ${handler}
    });
  `;
}

test("Codex protocol initializes, pages, ignores notifications and preserves inference selectors", async (t) => {
  const { command, env } = await fixture(t, rpcScript(`
    if (!request.params.cursor) {
      process.stdout.write(JSON.stringify({method: 'fixture/notification'}) + '\\n');
      reply(request.id, {data: [${JSON.stringify(MODEL)}, {model: 'hidden', hidden: true}], nextCursor: 'second'});
    } else {
      if (request.params.cursor !== 'second') process.exit(9);
      reply(request.id, {data: [${JSON.stringify(MODEL)}, {model: 'gpt-fixture-luna', displayName: 'Small model'}], nextCursor: null});
    }
  `));
  assert.deepEqual(await queryCodexModelCatalog(command, env), {
    options: [...RESULT.options, { id: "gpt-fixture-luna", name: "Small model", tier: "economy" }], recommended: MODEL.model,
  });
});

test("protocol errors, invalid selectors, repeated cursors and oversized output fail without diagnostics", async (t) => {
  for (const handler of [
    "process.stdout.write(JSON.stringify({id:request.id,error:{message:'private-fixture-diagnostic'}}) + '\\n');",
    "reply(request.id, {data: [{model: '--flag'}]});",
    "reply(request.id, {data: [], nextCursor: 'repeat'});",
    "process.stdout.write('x'.repeat(1024 * 1024 + 1));",
    "process.stdout.write('not json\\n');",
  ]) {
    const { command, env } = await fixture(t, rpcScript(handler));
    assert.equal(await queryCodexModelCatalog(command, env), null);
  }
});

test("stuck Codex catalog is terminated at its deadline", async (t) => {
  const { command, env } = await fixture(t, "setInterval(() => {}, 1000);");
  const start = Date.now();
  assert.equal(await queryCodexModelCatalog(command, env, 100), null);
  assert.ok(Date.now() - start < 2000);
});

test("catalog coalesces reads and mutations never start or await the subprocess", async (t) => {
  const { env } = await fixture(t);
  let calls = 0;
  let release!: (result: typeof RESULT) => void;
  const catalog = new CodexModelCatalog({ query: async () => { calls++; return new Promise((resolve) => { release = resolve; }); } });
  assert.equal((await catalog.read(env, "cached")).status, "unavailable");
  const reads = [catalog.read(env), catalog.read(env)];
  assert.equal(calls, 1);
  assert.equal((await catalog.read(env, "cached")).status, "unavailable");
  release(RESULT);
  const results = await Promise.all(reads);
  results[0]!.options.length = 0;
  assert.deepEqual(results[1], { status: "ready", ...RESULT });
  assert.deepEqual(await catalog.read(env, "cached"), results[1]);
  assert.equal(calls, 1);
});

test("expired catalog refresh discovers upgrades and stale data has a bounded lifetime", async (t) => {
  const { env } = await fixture(t);
  let now = 0;
  let calls = 0;
  const catalog = new CodexModelCatalog({ now: () => now, ttlMs: 10, retryMs: 5, staleMs: 30, query: async () => ++calls === 1 ? RESULT : null });
  assert.equal((await catalog.read(env)).status, "ready");
  now = 11;
  assert.equal((await catalog.read(env)).status, "stale");
  now = 29;
  assert.equal((await catalog.read(env)).status, "stale");
  now = 30;
  assert.deepEqual(await catalog.read(env), { status: "unavailable", options: [] });
  assert.equal(calls, 4);
});

test("cache scope follows profile and login changes and local login excludes service credentials", async (t) => {
  const { env, configDir, home } = await fixture(t);
  const environments: NodeJS.ProcessEnv[] = [];
  const catalog = new CodexModelCatalog({ query: async (_command, environment) => { environments.push(environment); return RESULT; } });
  env.UNRELATED_SECRET = "must-not-forward";
  env.OPENAI_API_KEY = "service-fixture-key";
  env.OPENAI_BASE_URL = "https://example.test";
  await catalog.read(env);
  await catalog.read(env);
  assert.equal(environments.length, 1);
  assert.equal(environments[0]?.OPENAI_API_KEY, undefined);
  assert.equal(environments[0]?.OPENAI_BASE_URL, undefined);
  assert.equal(environments[0]?.CODEX_HOME, configDir);
  await fs.writeFile(path.join(configDir, "auth.json"), "fixture-account-changed");
  await catalog.read(env);
  await catalog.read({ ...env, CODEX_HOME: path.join(home, "other-profile") });
  await catalog.read(env, "refresh", "codex");
  assert.equal(environments.length, 4);
  assert.equal(environments.at(-1)?.OPENAI_API_KEY, env.OPENAI_API_KEY);
  assert.equal(environments.every((entry) => entry.UNRELATED_SECRET === undefined), true);
});

test("fresh Codex list takes precedence over old disk cache and saved selections remain intact", async (t) => {
  const { env, configDir } = await fixture(t, rpcScript(`reply(request.id, {data: [${JSON.stringify(MODEL)}], nextCursor: null});`));
  await fs.writeFile(path.join(configDir, "models_cache.json"), JSON.stringify({models: [{slug: "gpt-fixture-old", visibility: "list"}]}));
  const config = await employeeModelConfig("codex-local", undefined, true, env);
  assert.equal(config.source, "provider-catalog");
  assert.equal(config.catalogStatus, "ready");
  assert.equal(config.recommended, MODEL.model);
  assert.equal(config.options.some((option) => option.id === "gpt-fixture-old"), false);
  const saved = await employeeModelConfig("codex-local", "gpt-fixture-old", true, env, "cached");
  assert.equal(saved.selected, "gpt-fixture-old");
  assert.ok(saved.options.some((option) => option.id === saved.selected));
});

test("missing CLI falls back to marked disk cache or provider default with manual model input", async (t) => {
  const { env, configDir, home } = await fixture(t);
  env.DIGITAL_EMPLOYEE_CODEX_COMMAND = path.join(home, "missing");
  await fs.writeFile(path.join(configDir, "models_cache.json"), JSON.stringify({models: [{slug: "gpt-fixture-old", visibility: "list"}]}));
  const cached = await employeeModelConfig("codex", undefined, true, env);
  assert.equal(cached.source, "local-cache");
  assert.equal(cached.catalogStatus, "stale");
  assert.ok(cached.options.some((option) => option.id === "gpt-fixture-old"));
  await fs.rm(path.join(configDir, "models_cache.json"));
  const unavailable = await employeeModelConfig("codex", undefined, true, env);
  assert.equal(unavailable.selected, "provider-default");
  assert.equal(unavailable.catalogStatus, "unavailable");
  assert.equal(unavailable.allowCustomModel, true);
  assert.equal(unavailable.customModelFormat, "strict");
});

test("model from the refreshed catalog saves and reaches the Codex turn driver", async (t) => {
  t.mock.method(codexModelCatalog, "read", async () => ({ status: "ready", ...RESULT }));
  const requests: TurnRunRequest[] = [];
  const server = await startTestServer(undefined, { async turnRun(request) {
    requests.push(request);
    return { status: "trusted", diagnostic: "", events: [{ type: "run.completed", runId: request.envelope.turnId, timestamp: new Date().toISOString(), output: "done", terminalReason: "goal_met" }] };
  } });
  const workspace = await copyExampleWorkspace();
  server.ctx.config.bundledElectronEngine = true;
  try {
    const call = (url: string, method: string, body: unknown) => api(server.baseUrl, url, { method, body, token: server.token });
    assert.equal((await call("/workspace/open", "POST", { path: workspace })).status, 200);
    const card = await api(server.baseUrl, "/positions/repo-owner?engine=codex", { token: server.token });
    assert.equal((card.body as { modelConfig: EmployeeModelConfig }).modelConfig.catalogStatus, "ready");
    const selection = await call("/positions/repo-owner/model", "PATCH", { model: MODEL.model, engine: "codex" });
    assert.equal(selection.status, 200);
    const session = (await call("/sessions", "POST", { positionId: "repo-owner" })).body as WorkbenchSession;
    const turn = await call(`/sessions/${session.sessionId}/turns`, "POST", { engine: "codex", input: "Use the new model" });
    assert.equal(turn.status, 200);
    assert.equal((turn.body as TurnRecord).model, MODEL.model);
    assert.equal(requests[0]?.model, MODEL.model);
  } finally {
    await server.ctx.contextExporter.waitForIdle();
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

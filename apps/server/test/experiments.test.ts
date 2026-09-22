import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExperimentsResponse, ReportsAdviceRequest, ReportsAdviceResponse, TurnRecord } from "@roleweave/shared";
import { ExperimentsService } from "../src/experiments/service.js";
import { EXPERIMENTS_FILE } from "../src/experiments/store.js";
import { JEV_ENDPOINT, JevAdviceProvider, type AdviceMetadata, type AdviceProvider } from "../src/experiments/provider.js";
import { resolveServerConfig } from "../src/config.js";
import { api, assertPosixMode, copyExampleWorkspace, startTestServer, type TestServer } from "./helpers.js";

async function open(server: TestServer, dir: string): Promise<void> {
  assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } })).status, 200);
}
async function settings(server: TestServer, dir: string): Promise<ExperimentsResponse> {
  const response = await api(server.baseUrl, `/experiments?workspacePath=${encodeURIComponent(dir)}`, { token: server.token });
  assert.equal(response.status, 200);
  return response.body as ExperimentsResponse;
}
function binding(state: ExperimentsResponse): ReportsAdviceRequest {
  return { workspacePath: state.workspacePath, workspaceSession: state.workspaceSession, revision: state.revision };
}
async function update(server: TestServer, state: ExperimentsResponse, enabled: boolean) {
  return api(server.baseUrl, "/experiments", { method: "PATCH", token: server.token, body: { ...binding(state), enabled } });
}
async function advise(server: TestServer, state: ExperimentsResponse) {
  return api(server.baseUrl, "/reports/advice", { method: "POST", token: server.token, body: binding(state) });
}
async function failure(dir: string, index = 0, code = "engine_unavailable"): Promise<void> {
  const conversation = path.join(dir, ".digital-employee", "workbench", "conversations", "community-operator");
  await fs.mkdir(path.join(conversation, "turns"), { recursive: true });
  await fs.writeFile(path.join(conversation, "conversation.json"), JSON.stringify({
    schemaVersion: "conversation.v1", conversationId: "private-conversation", positionId: "community-operator", createdAt: "2026-09-22T01:00:00.000Z",
  }));
  const record: TurnRecord = {
    schemaVersion: "turn-record.v1", conversationId: "private-conversation", positionId: "community-operator", turnId: `turn-${index}`,
    engine: "qoder", status: "failed", input: "DO NOT SEND private task body", runId: `run-${index}`,
    envelopeDigest: `sha256:${"a".repeat(64)}`, createdAt: new Date(1_790_000_000_000 + index * 1000).toISOString(),
    updatedAt: new Date(1_790_000_001_000 + index * 1000).toISOString(), events: [
      { type: "run.started", runId: `run-${index}`, timestamp: new Date(1_790_000_000_000 + index * 1000).toISOString() },
      { type: "run.failed", runId: `run-${index}`, timestamp: new Date(1_790_000_001_000 + index * 1000).toISOString(), error: { code, message: "DO NOT SEND error message", retryable: true, terminalReason: "engine_internal_error" } },
    ],
    error: { code, message: "DO NOT SEND error message", retryable: true, diagnostic: "DO NOT SEND diagnostic" },
  };
  await fs.writeFile(path.join(conversation, "turns", `turn-${index}.json`), JSON.stringify(record));
}
function fakeProvider(): AdviceProvider & { calls: AdviceMetadata[][] } {
  return { calls: [], async evaluate(items) { this.calls.push(items); return items.map(() => "inspect_run" as const); } };
}
async function fixture(provider: AdviceProvider = fakeProvider(), configured = true) {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  if (configured) server.ctx.config.jevApiKey = "secret-key-must-not-escape";
  server.ctx.experimentsService = new ExperimentsService(server.ctx, { provider });
  await open(server, dir);
  return { server, dir, async close() { await server.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}

test("experiments: default off, reads and enabling never call provider; persisted per workspace across restart", async () => {
  const provider = fakeProvider();
  const f = await fixture(provider);
  const other = await copyExampleWorkspace();
  try {
    const initial = await settings(f.server, f.dir);
    assert.equal(initial.enabled, false);
    assert.equal(initial.availability, "disabled");
    await assert.rejects(fs.stat(path.join(f.dir, EXPERIMENTS_FILE)), { code: "ENOENT" });
    await failure(f.dir);
    assert.equal(((await advise(f.server, initial)).body as ReportsAdviceResponse).status, "disabled");
    assert.equal(provider.calls.length, 0);
    assert.equal((await api(f.server.baseUrl, "/reports", { token: f.server.token })).status, 200);
    const enabled = await update(f.server, initial, true);
    assert.equal(enabled.status, 200);
    assert.equal((enabled.body as ExperimentsResponse).enabled, true);
    assert.equal(provider.calls.length, 0);
    await assertPosixMode(path.join(f.dir, EXPERIMENTS_FILE), 0o600);
    await open(f.server, other);
    assert.equal((await settings(f.server, other)).enabled, false);
    await open(f.server, f.dir);
    const reopened = await settings(f.server, f.dir);
    assert.equal(reopened.enabled, true);
    assert.notEqual(reopened.workspaceSession, initial.workspaceSession);
    const restarted = await startTestServer();
    try {
      await open(restarted, f.dir);
      const loaded = await settings(restarted, f.dir);
      assert.equal(loaded.enabled, true);
      assert.equal(loaded.availability, "not_configured");
      assert.notEqual(loaded.workspaceSession, reopened.workspaceSession);
    } finally { await restarted.close(); }
  } finally { await f.close(); await fs.rm(other, { recursive: true, force: true }); }
});

test("experiments: requires auth and exact request shape; stale revisions and reopened sessions conflict", async () => {
  const f = await fixture();
  try {
    assert.equal((await api(f.server.baseUrl, "/experiments")).status, 401);
    assert.equal((await api(f.server.baseUrl, "/experiments", { token: f.server.token })).status, 409);
    const initial = await settings(f.server, f.dir);
    assert.equal((await api(f.server.baseUrl, "/reports/advice", { method: "POST", token: f.server.token, body: { ...binding(initial), text: "secret" } })).status, 400);
    assert.equal((await update(f.server, initial, true)).status, 200);
    assert.equal((await update(f.server, initial, false)).status, 409);
    await open(f.server, f.dir);
    assert.equal((await update(f.server, initial, false)).status, 409);
    assert.equal((await advise(f.server, initial)).status, 409);
  } finally { await f.close(); }
});

test("experiments: concurrent toggles are revision-checked and serialized", async () => {
  const f = await fixture();
  try {
    const initial = await settings(f.server, f.dir);
    const responses = await Promise.all([update(f.server, initial, true), update(f.server, initial, false)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal((await settings(f.server, f.dir)).revision, 1);
  } finally { await f.close(); }
});

test("experiments: missing credentials remain visible, no external call or secret in API", async () => {
  const provider = fakeProvider();
  const f = await fixture(provider, false);
  try {
    const enabled = (await update(f.server, await settings(f.server, f.dir), true)).body as ExperimentsResponse;
    assert.equal(enabled.availability, "not_configured");
    assert.equal(enabled.provider.configured, false);
    assert.equal((await advise(f.server, enabled)).status, 200);
    assert.equal(((await advise(f.server, enabled)).body as ReportsAdviceResponse).reason, "not_configured");
    assert.equal(provider.calls.length, 0);
    assert.deepEqual(Object.keys(enabled.provider).sort(), ["configured", "endpointHost", "name"]);
  } finally { await f.close(); }
});

test("experiments: explicit advice makes one bounded batch, normalizes arbitrary error text and caches identical facts", async () => {
  const provider = fakeProvider();
  const f = await fixture(provider);
  try {
    for (let index = 0; index < 24; index++) await failure(f.dir, index, index === 23 ? "private_customer_identifier_123" : "engine_unavailable");
    const before = await api(f.server.baseUrl, "/reports", { token: f.server.token });
    const enabled = (await update(f.server, await settings(f.server, f.dir), true)).body as ExperimentsResponse;
    const response = await advise(f.server, enabled);
    assert.equal(response.status, 200);
    const body = response.body as ReportsAdviceResponse;
    assert.equal(body.status, "ready");
    assert.equal(body.total, 24);
    assert.equal(body.considered, 20);
    assert.equal(body.items.length, 20);
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(provider.calls[0]![0], { status: "failed", errorCode: "other", budgetRelated: false });
    assert.ok(provider.calls[0]!.every(item => Object.keys(item).sort().join() === "budgetRelated,errorCode,status"));
    assert.equal(JSON.stringify(provider.calls).includes("private"), false);
    assert.equal(JSON.stringify(response).includes("secret-key"), false);
    assert.equal(((await advise(f.server, enabled)).body as ReportsAdviceResponse).cached, true);
    assert.equal(provider.calls.length, 1);
    assert.deepEqual((await api(f.server.baseUrl, "/reports", { token: f.server.token })).body, before.body);
    await failure(f.dir, 24);
    await advise(f.server, enabled);
    assert.equal(provider.calls.length, 2);
  } finally { await f.close(); }
});

test("experiments: concurrent identical snapshots share the external request", async () => {
  let release!: () => void;
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const f = await fixture({ async evaluate(items) { calls++; started(); await gate; return items.map(() => "inspect_run"); } });
  try {
    await failure(f.dir);
    const enabled = (await update(f.server, await settings(f.server, f.dir), true)).body as ExperimentsResponse;
    const first = advise(f.server, enabled);
    await start;
    const second = advise(f.server, enabled);
    // Wait for the independent factual read before releasing the shared request.
    await new Promise(resolve => setTimeout(resolve, 30));
    release();
    const results = await Promise.all([first, second]);
    assert.ok(results.every(result => result.status === 200));
    assert.equal(calls, 1);
  } finally { release(); await f.close(); }
});

test("experiments: disabling aborts pending work and late results cannot repopulate advice", async () => {
  let release!: () => void;
  let started!: () => void;
  let signal: AbortSignal | undefined;
  const start = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ async evaluate(items, pendingSignal) { signal = pendingSignal; started(); await gate; return items.map(() => "inspect_run"); } });
  try {
    await failure(f.dir);
    const enabled = (await update(f.server, await settings(f.server, f.dir), true)).body as ExperimentsResponse;
    const pending = advise(f.server, enabled);
    await start;
    const disabled = await update(f.server, enabled, false);
    assert.equal(disabled.status, 200);
    assert.equal(signal?.aborted, true);
    assert.equal((await pending).status, 409);
    release();
    assert.equal(((await advise(f.server, disabled.body as ExperimentsResponse)).body as ReportsAdviceResponse).status, "disabled");
  } finally { release(); await f.close(); }
});

test("experiments: workspace switching cancels old requests and A-B-A cannot reuse an opening token", async () => {
  let started!: () => void;
  let signal: AbortSignal | undefined;
  const start = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture({ async evaluate(_items, pendingSignal) { signal = pendingSignal; started(); return new Promise(() => undefined); } });
  const other = await copyExampleWorkspace();
  try {
    await failure(f.dir);
    const enabled = (await update(f.server, await settings(f.server, f.dir), true)).body as ExperimentsResponse;
    const pending = advise(f.server, enabled);
    await start;
    await open(f.server, other);
    assert.equal(signal?.aborted, true);
    assert.equal((await pending).status, 409);
    await open(f.server, f.dir);
    assert.equal((await update(f.server, enabled, false)).status, 409);
    assert.equal((await settings(f.server, f.dir)).enabled, true);
  } finally { await f.close(); await fs.rm(other, { recursive: true, force: true }); }
});

test("experiments: timeout is bounded and cached; provider failures never suppress raw reports", async () => {
  let calls = 0;
  const f = await fixture({ async evaluate() { calls++; return new Promise(() => undefined); } });
  try {
    f.server.ctx.config.jevTimeoutMs = 15;
    await failure(f.dir);
    const enabled = (await update(f.server, await settings(f.server, f.dir), true)).body as ExperimentsResponse;
    const response = await advise(f.server, enabled);
    assert.equal(response.status, 200);
    assert.equal((response.body as ReportsAdviceResponse).reason, "timeout");
    assert.equal(((await advise(f.server, enabled)).body as ReportsAdviceResponse).cached, true);
    assert.equal(calls, 1);
    assert.equal((await api(f.server.baseUrl, "/reports", { token: f.server.token })).status, 200);
  } finally { await f.close(); }
});

test("experiments: upstream errors use a bounded public fallback and never echo provider diagnostics", async () => {
  let calls = 0;
  const f = await fixture({ async evaluate() { calls++; throw new Error("Authorization: private-provider-key and private response"); } });
  try {
    await failure(f.dir);
    const enabled = (await update(f.server, await settings(f.server, f.dir), true)).body as ExperimentsResponse;
    const response = await advise(f.server, enabled);
    assert.equal(response.status, 200);
    assert.equal((response.body as ReportsAdviceResponse).reason, "provider_error");
    assert.equal(JSON.stringify(response).includes("private"), false);
    assert.equal(((await advise(f.server, enabled)).body as ReportsAdviceResponse).cached, true);
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test("experiments: a failed disable save inhibits new work until persistence succeeds", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const provider = fakeProvider();
  const f = await fixture(provider);
  const parent = path.dirname(path.join(f.dir, EXPERIMENTS_FILE));
  try {
    await failure(f.dir);
    const enabled = (await update(f.server, await settings(f.server, f.dir), true)).body as ExperimentsResponse;
    await fs.chmod(parent, 0o500);
    const response = await update(f.server, enabled, false);
    assert.equal(response.status, 500);
    assert.equal((await settings(f.server, f.dir)).availability, "storage_error");
    assert.equal(((await advise(f.server, enabled)).body as ReportsAdviceResponse).reason, "settings_invalid");
    assert.equal(provider.calls.length, 0);
    await fs.chmod(parent, 0o700);
    assert.equal((await update(f.server, enabled, false)).status, 200);
  } finally { await fs.chmod(parent, 0o700); await f.close(); }
});

test("experiments: manual consent revocation is rechecked before pending results are published", async () => {
  let started!: () => void;
  let release!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ async evaluate(items) { started(); await gate; return items.map(() => "inspect_run"); } });
  try {
    await failure(f.dir);
    const enabled = (await update(f.server, await settings(f.server, f.dir), true)).body as ExperimentsResponse;
    const pending = advise(f.server, enabled);
    await start;
    await fs.writeFile(path.join(f.dir, EXPERIMENTS_FILE), JSON.stringify({ schemaVersion: "experiments.v1", enabled: false, revision: enabled.revision + 1 }));
    release();
    assert.equal((await pending).status, 409);
    assert.equal((await settings(f.server, f.dir)).enabled, false);
  } finally { release(); await f.close(); }
});

test("experiments: invalid settings fail closed and can be explicitly reset; symlinks never overwrite a target", async () => {
  const provider = fakeProvider();
  const f = await fixture(provider);
  try {
    const file = path.join(f.dir, EXPERIMENTS_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{"enabled":true}');
    const broken = await settings(f.server, f.dir);
    assert.equal(broken.availability, "storage_error");
    assert.equal(broken.enabled, false);
    assert.equal((await update(f.server, broken, true)).status, 409);
    assert.equal((await update(f.server, broken, false)).status, 200);
    assert.equal(provider.calls.length, 0);
    if (process.platform !== "win32") {
      const target = path.join(f.dir, "sentinel");
      await fs.writeFile(target, "KEEP");
      await fs.rm(file);
      await fs.symlink(target, file);
      const unsafe = await settings(f.server, f.dir);
      assert.equal(unsafe.availability, "storage_error");
      assert.equal((await update(f.server, unsafe, false)).status, 500);
      assert.equal(await fs.readFile(target, "utf8"), "KEEP");
    }
  } finally { await f.close(); }
});

test("experiments: corruption repair and revision rollback cannot revive a stale request or earlier opt-in", async () => {
  const provider = fakeProvider();
  const f = await fixture(provider);
  try {
    const enabled = (await update(f.server, await settings(f.server, f.dir), true)).body as ExperimentsResponse;
    const file = path.join(f.dir, EXPERIMENTS_FILE);
    await fs.writeFile(file, "corrupted");
    const broken = await settings(f.server, f.dir);
    assert.equal(broken.revision, enabled.revision);
    const repaired = (await update(f.server, broken, false)).body as ExperimentsResponse;
    assert.ok(repaired.revision > enabled.revision);
    assert.equal((await update(f.server, enabled, true)).status, 409);
    await fs.writeFile(file, JSON.stringify({ schemaVersion: "experiments.v1", revision: enabled.revision, enabled: true }));
    const rolledBack = await settings(f.server, f.dir);
    assert.equal(rolledBack.availability, "storage_error");
    assert.equal(rolledBack.enabled, false);
    assert.equal(rolledBack.revision, repaired.revision);
    assert.equal(((await advise(f.server, rolledBack)).body as ReportsAdviceResponse).reason, "settings_invalid");
    assert.equal(provider.calls.length, 0);
  } finally { await f.close(); }
});

test("jev provider: official typed HTTP protocol, fixed destination and no redirect or free-text response", async () => {
  let request: RequestInit | undefined;
  const fetcher = (async (url, init) => {
    assert.equal(url, JEV_ENDPOINT);
    request = init;
    return new Response(JSON.stringify({ answers: { item_0: { type: "choice", choice: "inspect_run", confidence: 0.9,
      probabilities: { inspect_run: 0.9, check_connection: 0.1, inspect_budget: 0, insufficient_information: 0 }, explanation: "must not return raw text" } } }));
  }) as typeof fetch;
  const provider = new JevAdviceProvider("server-key", "jev-latest", fetcher);
  assert.deepEqual(await provider.evaluate([{ status: "failed", errorCode: "other", budgetRelated: false }], new AbortController().signal), ["inspect_run"]);
  assert.equal(request?.redirect, "error");
  const body = JSON.parse(request?.body as string) as { state: unknown; questions: unknown; model: string };
  assert.deepEqual(body.state, [{ status: "failed", errorCode: "other", budgetRelated: false }]);
  assert.equal(body.model, "jev-latest");
  assert.ok(body.questions);
});

test("jev provider: malformed, unknown, oversized and failed responses are rejected; uncertain answers abstain", async () => {
  const item: AdviceMetadata[] = [{ status: "failed", errorCode: "other", budgetRelated: false }];
  const valid = { answers: { item_0: { type: "choice", choice: "inspect_run", confidence: 0.2,
    probabilities: { inspect_run: 0.4, check_connection: 0.2, inspect_budget: 0.2, insufficient_information: 0.2 } } } };
  const evaluate = (response: Response) => new JevAdviceProvider("key", undefined, (async () => response) as typeof fetch).evaluate(item, new AbortController().signal);
  assert.deepEqual(await evaluate(new Response(JSON.stringify(valid))), ["insufficient_information"]);
  await assert.rejects(evaluate(new Response(JSON.stringify({ answers: { item_0: { ...valid.answers.item_0, choice: "execute_command" } } }))));
  await assert.rejects(evaluate(new Response(JSON.stringify({ answers: { item_0: { ...valid.answers.item_0, confidence: 2 } } }))));
  await assert.rejects(evaluate(new Response(JSON.stringify({ answers: { item_0: { ...valid.answers.item_0, choice: "inspect_budget", confidence: 0.9 } } }))));
  await assert.rejects(evaluate(new Response("x".repeat(70_000))));
  await assert.rejects(evaluate(new Response("private provider error", { status: 401 })));
});

test("jev config: server-only ROLEWEAVE environment and bounded timeout", () => {
  const config = resolveServerConfig({ ROLEWEAVE_JEV_API_KEY: " key ", ROLEWEAVE_JEV_TIMEOUT_MS: "999999", ROLEWEAVE_JEV_MODEL: "bad model" }, []);
  assert.equal(config.jevApiKey, "key");
  assert.equal(config.jevTimeoutMs, 5_000);
  assert.equal(config.jevModel, "jev-latest");
  assert.equal(resolveServerConfig({}, []).jevApiKey, undefined);
});

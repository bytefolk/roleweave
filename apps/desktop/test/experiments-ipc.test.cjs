const assert = require("node:assert/strict");
const test = require("node:test");
const { experimentsGet, experimentsUpdate, reportsAdvice, readyHostChoice } = require("../src/experiments-ipc.cjs");
const scope = { workspacePath: "/workspace/a?b#c", workspaceSession: "00000000-0000-4000-8000-000000000001", revision: 0 };

test("experiment IPC rejects body uploads, destinations, credentials and malformed scope before HTTP", async () => {
  let calls = 0;
  const api = async () => { calls++; };
  for (const value of [null, [], {}, { ...scope, workspaceSession: "stale" }, { ...scope, revision: -1 }, { ...scope, revision: 1.5 }, { ...scope, input: "message body" }, { ...scope, apiKey: "secret" }, { ...scope, url: "https://other.example" }]) {
    assert.equal((await reportsAdvice(value, api)).status, 400);
    assert.equal((await readyHostChoice(value && { ...value, candidates: [{ positionId: "a", engine: "qoder", ready: true }] }, api)).status, 400);
    assert.equal((await experimentsUpdate(value && { ...value, enabled: true }, api)).status, 400);
  }
  assert.equal((await experimentsUpdate({ ...scope, enabled: "true" }, api)).status, 400);
  assert.equal(calls, 0);
});

test("experiment IPC encodes paths and forwards project scope without a generic endpoint", async () => {
  const calls = [];
  const api = async (...args) => { calls.push(args); return { status: 200 }; };
  await experimentsGet(scope.workspacePath, api);
  await experimentsUpdate({ ...scope, enabled: false }, api);
  await reportsAdvice(scope, api);
  const candidates = [{ positionId: "a", engine: "qoder", ready: true }];
  await readyHostChoice({ ...scope, candidates }, api);
  assert.equal(new URL(calls[0][0], "http://localhost").searchParams.get("workspacePath"), scope.workspacePath);
  assert.deepEqual(calls.slice(1), [
    ["/experiments", { method: "PATCH", body: { ...scope, enabled: false } }],
    ["/reports/advice", { method: "POST", body: scope }],
    ["/ready-host/choice", { method: "POST", body: { ...scope, candidates } }],
  ]);
});

test("ready-host IPC rejects extra candidate fields before HTTP", async () => {
  let calls = 0;
  const api = async () => { calls++; };
  assert.equal((await readyHostChoice({ ...scope, candidates: [{ positionId: "a", engine: "qoder", ready: true, prompt: "secret" }] }, api)).status, 400);
  assert.equal(calls, 0);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { experimentsGet, experimentsUpdate, reportsAdvice, sendGateAdvice } = require("../src/experiments-ipc.cjs");
const scope = { workspacePath: "/workspace/a?b#c", workspaceSession: "00000000-0000-4000-8000-000000000001", revision: 0 };

test("experiment IPC rejects body uploads, destinations, credentials and malformed scope before HTTP", async () => {
  let calls = 0;
  const api = async () => { calls++; };
  for (const value of [null, [], {}, { ...scope, workspaceSession: "stale" }, { ...scope, revision: -1 }, { ...scope, revision: 1.5 }, { ...scope, input: "message body" }, { ...scope, apiKey: "secret" }, { ...scope, url: "https://other.example" }]) {
    assert.equal((await reportsAdvice(value, api)).status, 400);
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
  assert.equal(new URL(calls[0][0], "http://localhost").searchParams.get("workspacePath"), scope.workspacePath);
  assert.deepEqual(calls.slice(1), [
    ["/experiments", { method: "PATCH", body: { ...scope, enabled: false } }],
    ["/reports/advice", { method: "POST", body: scope }],
  ]);
});

test("send-gate IPC accepts only a confirmed summary and a position id", async () => {
  assert.equal(typeof sendGateAdvice, "function");
  const calls = [];
  const api = async (...args) => { calls.push(args); return { status: 200 }; };
  const valid = {
    ...scope,
    positionId: "community-operator",
    taskSummary: { value: "Summarize contributor feedback", confirmed: true },
  };
  assert.equal((await sendGateAdvice(valid, api)).status, 200);
  assert.deepEqual(calls, [["/turns/send-gate-advice", { method: "POST", body: valid }]]);
  for (const request of [
    { ...valid, input: "DO NOT SEND composer draft" },
    { ...valid, positionId: "../owner" },
    { ...valid, taskSummary: { value: "summary", confirmed: false } },
    { ...valid, taskSummary: { value: "summary", confirmed: true, token: "secret" } },
  ]) assert.equal((await sendGateAdvice(request, api)).status, 400);
  assert.equal(calls.length, 1);
});

test("preload exposes one enumerated send-gate advice method", async () => {
  const calls = [];
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/preload.js"), "utf8"), {
    require: id => {
      assert.equal(id, "electron");
      return {
        contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
        ipcRenderer: {
          invoke: async (...args) => { calls.push(args); return { status: 200 }; },
          on: () => undefined,
          removeListener: () => undefined,
        },
      };
    },
  });
  assert.equal(typeof bridge.sendGateAdvice, "function");
  const request = { ...scope, positionId: "community-operator" };
  await bridge.sendGateAdvice(request);
  assert.deepEqual(calls, [["owb:turn:send-gate-advice", request]]);
});

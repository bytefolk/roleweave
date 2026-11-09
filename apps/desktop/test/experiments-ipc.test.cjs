const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { budgetRemainingAdvice, experimentsGet, experimentsUpdate, reportsAdvice } = require("../src/experiments-ipc.cjs");
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

test("budget advice IPC accepts only the scoped position identity", async () => {
  const calls = [];
  const api = async (...args) => { calls.push(args); return { status: 200 }; };
  const request = { ...scope, positionId: "repo-owner" };
  assert.equal((await budgetRemainingAdvice(request, api)).status, 200);
  assert.deepEqual(calls, [["/turns/budget-remaining-advice", { method: "POST", body: request }]]);

  for (const invalid of [
    { ...request, remainingPerTask: 10 },
    { ...request, remainingPerDay: 20 },
    { ...request, input: "private draft" },
    { ...request, positionId: "../owner" },
  ]) {
    assert.equal((await budgetRemainingAdvice(invalid, api)).status, 400);
  }
  assert.equal(calls.length, 1);
});

test("budget advice crosses only its enumerated trusted-window preload channel", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "../src/preload.js"), "utf8");
  assert.match(main, /ipcMain\.handle\("owb:turns:budget-advice"/);
  assert.match(main, /isTrustedWindowSender\(event, mainWindow, trustedRendererUrl\)/);
  assert.match(preload, /budgetRemainingAdvice:\s*\(request\)\s*=>\s*ipcRenderer\.invoke\("owb:turns:budget-advice", request\)/);
});

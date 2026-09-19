const assert = require("node:assert/strict");
const test = require("node:test");
const { approvalList, approvalDecision } = require("../src/approvals-center-ipc.cjs");
const request = { id: "a".repeat(64), workspaceToken: "00000000-0000-4000-8000-000000000001", requestId: "00000000-0000-4000-8000-000000000002", expectedVersion: 1, decision: "granted" };
test("approval IPC rejects arbitrary source overrides and UTF-8 overflow before HTTP", async () => {
  let called = 0;
  for (const bad of [null, { ...request, sessionId: "other" }, { ...request, reason: "字".repeat(342) }, { ...request, id: "../escape" }, { ...request, scope: "run" }]) {
    assert.equal((await approvalDecision(bad, async () => { called++; })).status, 400);
  }
  assert.equal(called, 0);
});
test("approval IPC forwards a bounded decision and encodes workspace path", async () => {
  await approvalDecision(request, async (route, options) => {
    assert.equal(route, `/approvals/${request.id}/decision`);
    assert.equal(options.body.workspaceToken, request.workspaceToken);
    assert.equal(options.body.id, undefined); return { status: 202 };
  });
  await approvalList({ workspacePath: "/workspace/a?b" }, async route => {
    assert.equal(new URL(route, "http://localhost").searchParams.get("workspacePath"), "/workspace/a?b"); return { status: 200 };
  });
});

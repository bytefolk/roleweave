const assert = require("node:assert/strict");
const test = require("node:test");
const { approvalList, approvalDecision, approvalBatchDecision, approvalAudit } = require("../src/approvals-center-ipc.cjs");
const request = { id: "a".repeat(64), workspaceToken: "00000000-0000-4000-8000-000000000001", requestId: "00000000-0000-4000-8000-000000000002", expectedVersion: 1, decision: "granted" };
test("approval IPC rejects arbitrary source overrides and UTF-8 overflow before HTTP", async () => {
  let called = 0;
  for (const bad of [null, { ...request, sessionId: "other" }, { ...request, reason: "字".repeat(342) }, { ...request, id: "../escape" }, { ...request, scope: "workspace" }]) {
    assert.equal((await approvalDecision(bad, async () => { called++; })).status, 400);
  }
  assert.equal(called, 0);
});
test("#403 batch IPC forwards only bounded per-item versions", async () => {
  const batch = { workspaceToken: request.workspaceToken, requestId: request.requestId, decision: "granted", items: [{ id: "a".repeat(64), expectedVersion: 1 }, { id: "b".repeat(64), expectedVersion: 2 }] };
  await approvalBatchDecision(batch, async (route, options) => {
    assert.equal(route, "/approvals/batch/decision");
    assert.deepEqual(options.body.items, batch.items); return { status: 202 };
  });
  assert.equal((await approvalBatchDecision({ ...batch, items: [batch.items[0]] }, async () => { throw new Error("must not call"); })).status, 400);
  assert.equal((await approvalBatchDecision({ ...batch, items: [batch.items[0], { ...batch.items[0] }] }, async () => { throw new Error("must not call"); })).status, 400);
});
test("approval IPC forwards a bounded decision and encodes workspace path", async () => {
  await approvalDecision(request, async (route, options) => {
    assert.equal(route, `/approvals/${request.id}/decision`);
    assert.equal(options.body.workspaceToken, request.workspaceToken);
    assert.equal(options.body.id, undefined); return { status: 202 };
  });
  await approvalList({ workspacePath: "/workspace/a?b", status: "pending" }, async route => {
    const url = new URL(route, "http://localhost");
    assert.equal(url.searchParams.get("workspacePath"), "/workspace/a?b");
    assert.equal(url.searchParams.get("status"), "pending");
    return { status: 200 };
  });
  assert.equal((await approvalList({ workspacePath: "/workspace/a?b", status: "invalid" }, async () => { throw new Error("must not call"); })).status, 400);
});
test("approval audit IPC validates approval ID and forwards to audit trail endpoint", async () => {
  let called = 0;
  for (const bad of [null, {}, { id: 123 }, { id: "bad" }, { id: "../escape" }, { id: "g".repeat(64) }]) {
    const res = await approvalAudit(bad, async () => { called++; });
    assert.equal(res.status, 400);
  }
  assert.equal(called, 0);

  const validId = "c".repeat(64);
  const auditRes = await approvalAudit({ id: validId }, async (route) => {
    assert.equal(route, `/approvals/${validId}/audit`);
    return { status: 200, body: { approvalId: validId, events: [] } };
  });
  assert.equal(auditRes.status, 200);
  assert.deepEqual(auditRes.body, { approvalId: validId, events: [] });
});

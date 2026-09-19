import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ApprovalList, ApprovalView, EngineEvent, GroupConversation, TurnRunDriver, TurnRunRequest, TurnRunResult } from "@roleweave/shared";
import { api, copyExampleWorkspace, startTestServer, type TestServer } from "./helpers.js";
import { approvals } from "../src/approvals/service.js";

class ApprovalDriver implements TurnRunDriver {
  calls: TurnRunRequest[] = [];
  expiresAt = new Date(Date.now() + 60000).toISOString();
  hold?: Promise<void>;
  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    this.calls.push(request);
    const runId = crypto.randomUUID(), timestamp = new Date().toISOString();
    const base = { runId, timestamp };
    const d = request.envelope.pendingApproval;
    const events: EngineEvent[] = [{ ...base, type: "run.started" }];
    if (d) {
      await this.hold;
      if (d.decision === "granted") events.push({ ...base, type: "approval.granted", approvalId: d.approvalId, grantedBy: "operator", scope: "once" }, { ...base, type: "run.completed", output: "done", terminalReason: "goal_met" });
      else events.push({ ...base, type: "approval.denied", approvalId: d.approvalId, deniedBy: "operator" }, { ...base, type: "run.failed", error: { code: "engine.approval_denied", message: "denied", retryable: false, terminalReason: "cancelled" } });
    } else events.push({ ...base, type: "approval.requested", approvalId: "same-engine-id", action: { kind: "write", description: "write report", target: "report.md" }, expiresAt: this.expiresAt },
      { ...base, type: "run.failed", error: { code: "engine.approval_required", message: "waiting", retryable: true, terminalReason: "engine_internal_error" } });
    for (const event of events) request.onEvent?.(event);
    return { status: "trusted", events, diagnostic: "" };
  }
}
async function open(s: TestServer, workspace: string) {
  assert.equal((await api(s.baseUrl, "/workspace/open", { token: s.token, method: "POST", body: { path: workspace } })).status, 200);
}
async function request(s: TestServer, positionId = "repo-owner") {
  const existing = await s.ctx.sessionStore.list(s.ctx.workspace.requireOpen().dir, positionId);
  let id = existing.activeSessionId;
  if (!id) {
    const c = await api(s.baseUrl, "/sessions", { token: s.token, method: "POST", body: { positionId } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    id = (c.body as { sessionId: string }).sessionId;
  }
  const r = await api(s.baseUrl, `/sessions/${id}/turns`, { token: s.token, method: "POST", body: { input: "original task: write report", engine: "qoder" } });
  assert.equal(r.status, 200);
  return id;
}
async function list(s: TestServer): Promise<ApprovalList> {
  const r = await api(s.baseUrl, "/approvals", { token: s.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as ApprovalList;
}
function body(snapshot: ApprovalList, a = snapshot.items[0]!, decision = "granted") {
  return { workspaceToken: snapshot.workspaceToken, requestId: crypto.randomUUID(), expectedVersion: a.version, decision };
}
async function settle(s: TestServer, id: string) {
  for (let i = 0; i < 100; i++) {
    const a = (await list(s)).items.find(a => a.id === id)!;
    if (!["starting", "running"].includes(a.execution.phase)) return a;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error("Approval did not settle");
}

test("approval center restores the source session, preserves expiry, is idempotent and survives restart", async () => {
  const driver = new ApprovalDriver(), workspace = await copyExampleWorkspace();
  let s = await startTestServer(undefined, driver);
  try {
    await open(s, workspace);
    const originalSession = await request(s);
    // A different employee can be selected while deciding this item.
    await request(s, "community-operator");
    const snapshot = await list(s);
    assert.equal(snapshot.items.length, 2);
    assert.notEqual(snapshot.items[0]!.id, snapshot.items[1]!.id);
    const a = snapshot.items.find(a => a.source.positionId === "repo-owner")!;
    const decision = body(snapshot, a);
    const route = `/approvals/${a.id}/decision`;
    const responses = await Promise.all([0, 1].map(() => api(s.baseUrl, route, { token: s.token, method: "POST", body: decision })));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 202]);
    const done = await settle(s, a.id);
    assert.equal(done.execution.phase, "completed");
    assert.notEqual(done.execution.turnId, a.source.turnId, "a decision must execute in a new recovery turn");
    const history = await s.ctx.turnStore.sessionHistory(workspace, originalSession, a.source.positionId, new Date().toISOString());
    const source = history.turns.find(turn => turn.turnId === a.source.turnId);
    assert.equal(source?.error?.code, "engine.approval_required", "the source turn remains immutable");
    assert.equal(driver.calls.filter(c => c.envelope.pendingApproval).length, 1);
    const resume = driver.calls.find(c => c.envelope.pendingApproval)!;
    assert.equal(resume.envelope.conversationRef, originalSession);
    assert.equal(resume.envelope.pendingApproval!.expiresAt, driver.expiresAt);
    assert.match(resume.envelope.input, /original task: write report/);
    assert.equal((await api(s.baseUrl, route, { token: s.token, method: "POST", body: { ...decision, decision: "denied" } })).status, 409);
    await s.close();
    s = await startTestServer(undefined, driver);
    await open(s, workspace);
    const reloaded = await list(s);
    const restored = reloaded.items.find(i => i.id === a.id)!;
    assert.equal(restored.status, "granted"); assert.equal(restored.execution.phase, "completed");
    const repeated = await api(s.baseUrl, route, { token: s.token, method: "POST", body: { ...decision, workspaceToken: reloaded.workspaceToken } });
    assert.equal(repeated.status, 200);
    assert.equal(driver.calls.filter(c => c.envelope.pendingApproval).length, 1);
  } finally { await s.close(); }
});

test("group approvals stay visible but read-only and never dispatch a recovery turn", async () => {
  const driver = new ApprovalDriver(), s = await startTestServer(undefined, driver);
  try {
    await open(s, await copyExampleWorkspace());
    const created = await api(s.baseUrl, "/groups", {
      token: s.token,
      method: "POST",
      body: { memberPositionIds: ["repo-owner", "community-operator"] },
    });
    assert.equal(created.status, 201);
    const group = created.body as GroupConversation;
    const accepted = await api(s.baseUrl, `/groups/${group.conversationRef}/turns`, {
      token: s.token,
      method: "POST",
      body: { input: "group task requiring approval", mentions: ["repo-owner"], engine: "qoder" },
    });
    assert.equal(accepted.status, 202);

    let snapshot: ApprovalList | undefined;
    for (let i = 0; i < 100; i++) {
      const next = await list(s);
      if (next.items.length > 0) { snapshot = next; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(snapshot, "group approval should remain visible in the queue");
    const approval = snapshot.items[0]!;
    assert.equal(approval.source.kind, "group");
    assert.equal(approval.canDecide, false);
    assert.equal(approval.unavailableReason, "approval_source_unsupported");
    const rejected = await api(s.baseUrl, `/approvals/${approval.id}/decision`, {
      token: s.token,
      method: "POST",
      body: body(snapshot, approval),
    });
    assert.equal(rejected.status, 409);
    assert.equal(driver.calls.length, 1, "read-only group approval must not start a recovery turn");
  } finally { await s.close(); }
});

test("expired, rotated and stale-workspace approvals cannot execute", async () => {
  const driver = new ApprovalDriver(), s = await startTestServer(undefined, driver);
  try {
    const workspace = await copyExampleWorkspace(); await open(s, workspace);
    driver.expiresAt = new Date(Date.now() - 1000).toISOString();
    const session = await request(s);
    let snapshot = await list(s), a = snapshot.items[0]!;
    assert.equal(a.status, "expired"); assert.equal(a.canDecide, false);
    assert.equal((await api(s.baseUrl, `/approvals/${a.id}/decision`, { token: s.token, method: "POST", body: body(snapshot) })).status, 410);
    driver.expiresAt = new Date(Date.now() + 60000).toISOString();
    await request(s);
    snapshot = await list(s); a = snapshot.items.find(a => a.status === "pending")!;
    await api(s.baseUrl, `/sessions/${session}/rotate`, { token: s.token, method: "POST", body: {} });
    assert.equal((await api(s.baseUrl, `/approvals/${a.id}/decision`, { token: s.token, method: "POST", body: body(snapshot, a) })).status, 409);
    await open(s, workspace);
    assert.equal((await api(s.baseUrl, `/approvals/${a.id}/decision`, { token: s.token, method: "POST", body: body(snapshot, a) })).status, 409);
    assert.equal(driver.calls.filter(c => c.envelope.pendingApproval).length, 0);
  } finally { await s.close(); }
});

test("denial settles without granting, and concurrent opposite verdict loses", async () => {
  const driver = new ApprovalDriver(), s = await startTestServer(undefined, driver);
  try {
    await open(s, await copyExampleWorkspace()); await request(s);
    const snapshot = await list(s), a = snapshot.items[0]!, route = `/approvals/${a.id}/decision`;
    const denied = await api(s.baseUrl, route, { token: s.token, method: "POST", body: body(snapshot, a, "denied") });
    assert.equal(denied.status, 202);
    assert.equal((await api(s.baseUrl, route, { token: s.token, method: "POST", body: body(snapshot, a) })).status, 409);
    const done = await settle(s, a.id);
    assert.equal(done.status, "denied"); assert.equal(done.execution.phase, "denied");
  } finally { await s.close(); }
});

test("crash after durable intent is reconciled as indeterminate, never replayed", async () => {
  const driver = new ApprovalDriver(), workspace = await copyExampleWorkspace();
  let s = await startTestServer(undefined, driver);
  try {
    await open(s, workspace); await request(s);
    const snapshot = await list(s), a: ApprovalView = snapshot.items[0]!;
    const { canDecide: _canDecide, unavailableReason: _reason, ...record } = a;
    record.status = "granted";
    record.decision = { requestId: crypto.randomUUID(), expectedVersion: a.version, decision: "granted", scope: "once", decidedBy: "operator", decidedAt: new Date().toISOString() };
    record.execution = { phase: "starting", turnId: crypto.randomUUID() }; record.version++;
    await approvals(s.ctx).store.put(workspace, record);
    await s.close(); s = await startTestServer(undefined, driver); await open(s, workspace);
    const recovered = (await list(s)).items[0]!;
    assert.equal(recovered.status, "granted"); assert.equal(recovered.execution.phase, "indeterminate");
    assert.equal(driver.calls.length, 1);
  } finally { await s.close(); }
});

test("second writer and corrupt records fail explicitly instead of returning an empty queue", async () => {
  const workspace = await copyExampleWorkspace(), driver = new ApprovalDriver();
  const s = await startTestServer(undefined, driver), other = await startTestServer();
  try {
    await open(s, workspace); await request(s); const snapshot = await list(s);
    await open(other, workspace);
    assert.equal((await api(other.baseUrl, "/approvals", { token: other.token })).status, 409);
    await fs.writeFile(path.join(workspace, ".digital-employee/workbench/approvals", `${snapshot.items[0]!.id}.json`), "{}");
    assert.equal((await api(s.baseUrl, "/approvals", { token: s.token })).status, 500);
  } finally { await s.close(); await other.close(); }
});

test("pagination detects a changing snapshot and invalid requests never invoke the engine", async () => {
  const driver = new ApprovalDriver(), s = await startTestServer(undefined, driver);
  try {
    await open(s, await copyExampleWorkspace()); await request(s); await request(s, "community-operator");
    const first = await api(s.baseUrl, "/approvals?limit=1", { token: s.token });
    const snapshot = first.body as ApprovalList;
    assert.ok(snapshot.nextCursor);
    const a = snapshot.items[0]!;
    const invalid = await api(s.baseUrl, `/approvals/${a.id}/decision`, { token: s.token, method: "POST", body: { ...body(snapshot), reason: "字".repeat(342) } });
    assert.equal(invalid.status, 400);
    const valid = await api(s.baseUrl, `/approvals/${a.id}/decision`, { token: s.token, method: "POST", body: body(snapshot) });
    assert.equal(valid.status, 202);
    assert.equal((await api(s.baseUrl, `/approvals?limit=1&cursor=${encodeURIComponent(snapshot.nextCursor!)}`, { token: s.token })).status, 409);
  } finally { await s.close(); }
});

test("expiry after acceptance but before dispatch prevents any engine call", async () => {
  const driver = new ApprovalDriver(), s = await startTestServer(undefined, driver);
  const realNow = Date.now;
  try {
    await open(s, await copyExampleWorkspace()); await request(s);
    const snapshot = await list(s), a = snapshot.items[0]!;
    const original = s.ctx.turnStore.beginSession.bind(s.ctx.turnStore);
    s.ctx.turnStore.beginSession = async input => {
      const record = await original(input);
      Date.now = () => Date.parse(driver.expiresAt) + 1;
      return record;
    };
    const response = await api(s.baseUrl, `/approvals/${a.id}/decision`, { token: s.token, method: "POST", body: body(snapshot, a) });
    assert.equal(response.status, 202);
    const result = await settle(s, a.id);
    assert.equal(result.status, "granted"); assert.equal(result.execution.phase, "failed");
    assert.equal(result.execution.errorCode, "approval_expired"); assert.equal(driver.calls.length, 1);
  } finally { Date.now = realNow; await s.close(); }
});

test("legacy position approvals resume without inventing a session", async () => {
  const driver = new ApprovalDriver(), s = await startTestServer(undefined, driver);
  try {
    await open(s, await copyExampleWorkspace());
    assert.equal((await api(s.baseUrl, "/turns", { token: s.token, method: "POST", body: { positionId: "repo-owner", input: "legacy", engine: "qoder" } })).status, 200);
    const snapshot = await list(s), a = snapshot.items[0]!;
    assert.equal(a.source.kind, "position");
    assert.equal((await api(s.baseUrl, `/approvals/${a.id}/decision`, { token: s.token, method: "POST", body: body(snapshot, a) })).status, 202);
    assert.equal((await settle(s, a.id)).execution.phase, "completed");
    assert.equal(driver.calls[1]!.envelope.conversationRef, undefined);
  } finally { await s.close(); }
});

test("actual engine approval gate: grant consumes model, denial and expiry do not", {
  skip: !process.env.APPROVAL_ENGINE_MODULE && "Set APPROVAL_ENGINE_MODULE to a built digital-employee engine module",
}, async () => {
  const engine = await import(process.env.APPROVAL_ENGINE_MODULE!) as {
    executeTurn(request: Record<string, unknown>, ports: Record<string, unknown>): AsyncIterable<EngineEvent>;
    createDeterministicModelPort(script: string[]): unknown;
    createInMemoryEvidenceSink(): unknown;
  };
  const calls: EngineEvent[][] = [];
  const driver: TurnRunDriver = {
    async turnRun(request) {
      const pending = request.envelope.pendingApproval;
      const events: EngineEvent[] = [];
      const now = new Date();
      for await (const event of engine.executeTurn({
        workspaceRef: request.workspace, positionId: request.positionId, turnId: request.envelope.turnId,
        runId: crypto.randomUUID(), input: request.envelope.input, budget: { maxIterations: 2 },
        ...(pending ? { pendingApproval: pending } : {
          deadline: new Date(now.getTime() + 60000).toISOString(),
          approvalAction: { kind: "write", description: "write report", target: "report.md", preview: { version: "write-approval.v1", previewId: "preview", previewDigest: "sha256:ab12", state: "preview_validated" } },
        }),
      }, { model: engine.createDeterministicModelPort(["done"]), evidenceSink: engine.createInMemoryEvidenceSink(), now: () => now })) {
        events.push(event); request.onEvent?.(event);
      }
      calls.push(events); return { status: "trusted", events, diagnostic: "" };
    },
  };
  const s = await startTestServer(undefined, driver);
  try {
    await open(s, await copyExampleWorkspace());
    for (const decision of ["granted", "denied"] as const) {
      await request(s);
      const snapshot = await list(s), a = snapshot.items.find(a => a.status === "pending")!;
      assert.ok(a, JSON.stringify(snapshot));
      assert.equal((await api(s.baseUrl, `/approvals/${a.id}/decision`, { token: s.token, method: "POST", body: body(snapshot, a, decision) })).status, 202);
      assert.equal((await settle(s, a.id)).execution.phase, decision === "granted" ? "completed" : "denied");
      assert.equal(calls.at(-1)!.some(e => e.type === "model.delta"), decision === "granted");
    }
    const events: EngineEvent[] = [];
    for await (const e of engine.executeTurn({ workspaceRef: "ws", positionId: "repo-owner", turnId: "expired", runId: "expired", input: "resume", budget: { maxIterations: 2 }, pendingApproval: { approvalId: "expired", decision: "granted", decidedBy: "operator", expiresAt: new Date(Date.now() - 1000).toISOString() } }, { model: engine.createDeterministicModelPort(["done"]), evidenceSink: engine.createInMemoryEvidenceSink() })) events.push(e);
    assert.equal(events.some(e => e.type === "model.delta"), false);
    assert.ok(events.some(e => e.type === "run.failed" && e.error.code === "engine.approval_expired"));
  } finally { await s.close(); }
});

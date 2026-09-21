import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ApprovalChangePreview, ApprovalList, ApprovalView, EngineEvent, GroupConversation, TurnRunDriver, TurnRunRequest, TurnRunResult } from "@roleweave/shared";
import { approvalPreviewFingerprintInput, approvalRunScopeBindingInput } from "@roleweave/shared";
import { api, copyExampleWorkspace, startTestServer, type TestServer } from "./helpers.js";
import { approvals } from "../src/approvals/service.js";

class ApprovalDriver implements TurnRunDriver {
  calls: TurnRunRequest[] = [];
  expiresAt = new Date(Date.now() + 60000).toISOString();
  target = "report.md";
  reason = "The write needs operator approval";
  actionKind: "write" | "exec" | "network" | "tool" = "write";
  approvalCount = 1;
  runScope = false;
  invalidRunBinding = false;
  preview?: ApprovalChangePreview;
  hold?: Promise<void>;
  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    this.calls.push(request);
    const runId = crypto.randomUUID(), timestamp = new Date().toISOString();
    const base = { runId, timestamp };
    const d = request.envelope.pendingApproval;
    const batch = request.envelope.pendingApprovals;
    const events: EngineEvent[] = [{ ...base, type: "run.started" }];
    if (d || batch) {
      await this.hold;
      const decisions = batch ?? [d!];
      if (decisions[0]!.decision === "granted") events.push(...decisions.map(decision => ({ ...base, type: "approval.granted" as const, approvalId: decision.approvalId, grantedBy: "operator" as const, scope: decision.scope ?? "once" })), { ...base, type: "run.completed", output: "done", terminalReason: "goal_met" });
      else events.push(...decisions.map(decision => ({ ...base, type: "approval.denied" as const, approvalId: decision.approvalId, deniedBy: "operator" as const })), { ...base, type: "run.failed", error: { code: "engine.approval_denied", message: "denied", retryable: false, terminalReason: "cancelled" } });
    } else {
      for (let index = 0; index < this.approvalCount; index++) {
        const approvalId = this.approvalCount === 1 ? "same-engine-id" : `same-engine-id-${index + 1}`;
        const action = { kind: this.actionKind, description: "write report", target: this.target };
        const binding = `sha256:${crypto.createHash("sha256").update(approvalRunScopeBindingInput(approvalId, runId, action, this.expiresAt)).digest("hex")}`;
        events.push({ ...base, type: "approval.requested", approvalId, action: {
          ...action,
          ...(this.preview ? { preview: this.preview } : {}),
          ...(this.runScope ? { scope: { version: "approval-scope-offer.v1" as const, allowed: ["once", "run"] as Array<"once" | "run">, runBinding: this.invalidRunBinding ? `sha256:${"0".repeat(64)}` : binding } } : {}),
        }, reason: this.reason, expiresAt: this.expiresAt });
      }
      events.push(
      { ...base, type: "run.failed", error: { code: "engine.approval_required", message: "waiting", retryable: true, terminalReason: "engine_internal_error" } });
    }
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

const batchPolicy = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "roleweave-approval-policy.v1",
  version: "batch-tools-1",
  default: { eligibleApprovers: ["operator"], threshold: 1, batch: { maxItems: 4, actionKinds: ["tool"] }, ...overrides },
});

async function rejectBatch(driver: ApprovalDriver, policy: Record<string, unknown>, versions?: (version: number) => number) {
  const workspace = await copyExampleWorkspace(), s = await startTestServer(undefined, driver);
  try {
    await fs.mkdir(path.join(workspace, ".digital-employee", "workbench"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".digital-employee", "workbench", "approval-policy.json"), JSON.stringify(policy));
    await open(s, workspace); await request(s);
    const snapshot = await list(s);
    const response = await api(s.baseUrl, "/approvals/batch/decision", {
      token: s.token, method: "POST",
      body: { workspaceToken: snapshot.workspaceToken, requestId: crypto.randomUUID(), decision: "granted", items: snapshot.items.map(item => ({ id: item.id, expectedVersion: versions?.(item.version) ?? item.version })) },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual((response.body as { items: Array<{ status: string }> }).items.map(item => item.status), snapshot.items.map(() => "rejected"));
    assert.equal(driver.calls.filter(call => call.envelope.pendingApprovals).length, 0);
  } finally { await s.close(); }
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
    assert.equal(a.context?.risk, "high");
    assert.equal(a.context?.impact, "workspace_write");
    assert.equal(a.context?.permissions.mode, "read_only");
    assert.equal(a.context?.preview.status, "unavailable");
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

test("run scope is opt-in, source-bound, durable, and idempotent", async () => {
  const driver = new ApprovalDriver();
  driver.runScope = true;
  const s = await startTestServer(undefined, driver);
  try {
    await open(s, await copyExampleWorkspace()); await request(s);
    const snapshot = await list(s), a = snapshot.items[0]!, route = `/approvals/${a.id}/decision`;
    assert.deepEqual(a.context?.scope.allowed, ["once", "run"]);
    const decision = { ...body(snapshot, a), scope: "run" as const };
    const accepted = await api(s.baseUrl, route, { token: s.token, method: "POST", body: decision });
    assert.equal(accepted.status, 202);
    assert.equal((accepted.body as ApprovalView).decision?.scope, "run");
    const done = await settle(s, a.id);
    assert.equal(done.decision?.scope, "run");
    assert.equal(driver.calls.find(call => call.envelope.pendingApproval)?.envelope.pendingApproval?.scope, "run");
    const replay = await api(s.baseUrl, route, { token: s.token, method: "POST", body: { ...decision, workspaceToken: (await list(s)).workspaceToken } });
    assert.equal(replay.status, 200, "same request retains the original scope");
    const changedScope = await api(s.baseUrl, route, { token: s.token, method: "POST", body: { ...decision, scope: "once", workspaceToken: (await list(s)).workspaceToken } });
    assert.equal(changedScope.status, 409, "a request id cannot be replayed with a wider or narrower boundary");
  } finally { await s.close(); }
});

test("run scope rejects undeclared, tampered, denied, and expired offers before dispatch", async () => {
  for (const variant of ["undeclared", "tampered"] as const) {
    const driver = new ApprovalDriver();
    driver.runScope = variant === "tampered";
    driver.invalidRunBinding = variant === "tampered";
    const s = await startTestServer(undefined, driver);
    try {
      await open(s, await copyExampleWorkspace()); await request(s);
      const snapshot = await list(s), a = snapshot.items[0]!;
      assert.deepEqual(a.context?.scope.allowed, ["once"], `${variant} offer must not be rendered as an eligible run scope`);
      const response = await api(s.baseUrl, `/approvals/${a.id}/decision`, { token: s.token, method: "POST", body: { ...body(snapshot, a), scope: "run" } });
      assert.equal(response.status, 409, variant);
      assert.equal(driver.calls.filter(call => call.envelope.pendingApproval).length, 0, variant);
    } finally { await s.close(); }
  }
  const driver = new ApprovalDriver(); driver.runScope = true;
  const s = await startTestServer(undefined, driver);
  try {
    await open(s, await copyExampleWorkspace()); await request(s);
    const snapshot = await list(s), a = snapshot.items[0]!;
    const denied = await api(s.baseUrl, `/approvals/${a.id}/decision`, { token: s.token, method: "POST", body: { ...body(snapshot, a, "denied"), scope: "run" } });
    assert.equal(denied.status, 409);
    driver.expiresAt = new Date(Date.now() - 1).toISOString();
    // Existing records retain their request expiry; creating a new expiring
    // request proves expiry wins before a run-scope grant can be dispatched.
    await request(s, "community-operator");
    const expired = (await list(s)).items.find(item => item.source.positionId === "community-operator")!;
    assert.equal(expired.status, "expired");
    const response = await api(s.baseUrl, `/approvals/${expired.id}/decision`, { token: s.token, method: "POST", body: { ...body(await list(s), expired), scope: "run" } });
    assert.equal(response.status, 410);
  } finally { await s.close(); }
});

test("multi-party policy rejects unauthorized actors, accepts a delegated co-sign, and exports a verified audit trail", async () => {
  const driver = new ApprovalDriver(), workspace = await copyExampleWorkspace(), s = await startTestServer(undefined, driver);
  try {
    await fs.mkdir(path.join(workspace, ".digital-employee", "workbench"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".digital-employee", "workbench", "approval-policy.json"), JSON.stringify({
      schemaVersion: "roleweave-approval-policy.v1", version: "release-7",
      default: { eligibleApprovers: ["alice", "bob"], threshold: 2, delegations: { alice: ["carol"] } },
    }));
    await open(s, workspace); await request(s);
    let snapshot = await list(s), approval = snapshot.items[0]!;
    s.ctx.config.approvalActorId = "mallory";
    assert.equal((await api(s.baseUrl, `/approvals/${approval.id}/decision`, { token: s.token, method: "POST", body: body(snapshot, approval) })).status, 403);

    s.ctx.config.approvalActorId = "carol";
    const delegated = { ...body(snapshot, approval), delegatedFrom: "alice" };
    assert.equal((await api(s.baseUrl, `/approvals/${approval.id}/decision`, { token: s.token, method: "POST", body: delegated })).status, 200);
    snapshot = await list(s); approval = snapshot.items[0]!;
    assert.deepEqual(approval.progress, { required: 2, granted: 1, pending: 1, escalated: false });
    assert.equal("policy" in approval, false, "queue must not disclose the approver roster");

    s.ctx.config.approvalActorId = "bob";
    assert.equal((await api(s.baseUrl, `/approvals/${approval.id}/decision`, { token: s.token, method: "POST", body: body(snapshot, approval) })).status, 202);
    const audit = await api(s.baseUrl, `/approvals/${approval.id}/audit`, { token: s.token });
    assert.equal(audit.status, 200);
    const events = (audit.body as { events: Array<{ type: string; actor?: string; delegatedFrom?: string; policyVersion: string; hash: string }> }).events;
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(event => event.type), ["requested", "decision", "decision"]);
    assert.deepEqual(events[1], { ...events[1], actor: "carol", delegatedFrom: "alice", policyVersion: "release-7" });
    assert.ok(events.every(event => /^sha256:[a-f0-9]{64}$/.test(event.hash)));
  } finally { await s.close(); }
});

test("persisted policy snapshots remain bound to their digest", async () => {
  const driver = new ApprovalDriver(), workspace = await copyExampleWorkspace(), s = await startTestServer(undefined, driver);
  try {
    await fs.mkdir(path.join(workspace, ".digital-employee", "workbench"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".digital-employee", "workbench", "approval-policy.json"), JSON.stringify({
      schemaVersion: "roleweave-approval-policy.v1", version: "bound-1",
      default: { eligibleApprovers: ["alice"], threshold: 1 },
    }));
    await open(s, workspace); await request(s); await list(s);
    const [record] = await approvals(s.ctx).store.list(workspace);
    record!.policy!.eligibleApprovers = ["mallory"];
    await assert.rejects(approvals(s.ctx).store.put(workspace, record!));
  } finally { await s.close(); }
});

test("multi-party grants cannot widen scope based on the final voter", async () => {
  const driver = new ApprovalDriver(); driver.runScope = true;
  const workspace = await copyExampleWorkspace(), s = await startTestServer(undefined, driver);
  try {
    await fs.mkdir(path.join(workspace, ".digital-employee", "workbench"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".digital-employee", "workbench", "approval-policy.json"), JSON.stringify({
      schemaVersion: "roleweave-approval-policy.v1", version: "scope-1",
      default: { eligibleApprovers: ["alice", "bob"], threshold: 2 },
    }));
    await open(s, workspace); await request(s);
    let snapshot = await list(s), approval = snapshot.items[0]!;
    s.ctx.config.approvalActorId = "alice";
    assert.equal((await api(s.baseUrl, `/approvals/${approval.id}/decision`, { token: s.token, method: "POST", body: { ...body(snapshot, approval), scope: "once" } })).status, 200);
    snapshot = await list(s); approval = snapshot.items[0]!;
    s.ctx.config.approvalActorId = "bob";
    assert.equal((await api(s.baseUrl, `/approvals/${approval.id}/decision`, { token: s.token, method: "POST", body: { ...body(snapshot, approval), scope: "run" } })).status, 202);
    await settle(s, approval.id);
    assert.equal(driver.calls.find(call => call.envelope.pendingApproval)?.envelope.pendingApproval?.scope, "once");
  } finally { await s.close(); }
});

test("escalation does not count grants from principals outside the escalated policy", async () => {
  const driver = new ApprovalDriver(), workspace = await copyExampleWorkspace(), s = await startTestServer(undefined, driver);
  try {
    await fs.mkdir(path.join(workspace, ".digital-employee", "workbench"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".digital-employee", "workbench", "approval-policy.json"), JSON.stringify({
      schemaVersion: "roleweave-approval-policy.v1", version: "escalation-votes-1",
      default: { eligibleApprovers: ["alice", "bob"], threshold: 2, escalation: { afterMs: 1000, eligibleApprovers: ["incident-commander"], threshold: 1 } },
    }));
    await open(s, workspace); await request(s);
    let snapshot = await list(s), approval = snapshot.items[0]!;
    s.ctx.config.approvalActorId = "alice";
    assert.equal((await api(s.baseUrl, `/approvals/${approval.id}/decision`, { token: s.token, method: "POST", body: body(snapshot, approval) })).status, 200);
    const realNow = Date.now;
    try {
      Date.now = () => Date.parse(approval.requestedAt) + 1001;
      snapshot = await list(s); approval = snapshot.items[0]!;
      assert.deepEqual(approval.progress, { required: 1, granted: 0, pending: 1, escalated: true });
    } finally { Date.now = realNow; }
  } finally { await s.close(); }
});

test("policy escalation persists and deterministically changes the active threshold", async () => {
  const driver = new ApprovalDriver(), workspace = await copyExampleWorkspace(), s = await startTestServer(undefined, driver);
  try {
    await fs.mkdir(path.join(workspace, ".digital-employee", "workbench"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".digital-employee", "workbench", "approval-policy.json"), JSON.stringify({
      schemaVersion: "roleweave-approval-policy.v1", version: "escalation-1",
      default: { eligibleApprovers: ["alice", "bob"], threshold: 2, escalation: { afterMs: 1, eligibleApprovers: ["escalation-oncall"], threshold: 1 } },
    }));
    await open(s, workspace); await request(s); await new Promise(resolve => setTimeout(resolve, 15));
    const snapshot = await list(s), approval = snapshot.items[0]!;
    assert.deepEqual(approval.progress, { required: 1, granted: 0, pending: 1, escalated: true });
    s.ctx.config.approvalActorId = "alice";
    assert.equal((await api(s.baseUrl, `/approvals/${approval.id}/decision`, { token: s.token, method: "POST", body: body(snapshot, approval) })).status, 403);
    s.ctx.config.approvalActorId = "escalation-oncall";
    const fresh = (await list(s)).items[0]!;
    assert.equal((await api(s.baseUrl, `/approvals/${fresh.id}/decision`, { token: s.token, method: "POST", body: body(await list(s), fresh) })).status, 202);
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

test("approval views redact secrets while preserving safe decision context", async () => {
  const driver = new ApprovalDriver();
  driver.target = "https://alice:password@example.com/upload?token=top-secret";
  driver.reason = "Authorization: Bearer top-secret";
  const preview = {
    version: "approval-change-preview.v1" as const, previewId: "preview-1",
    files: [{ path: "reports/summary.md", change: "modify" as const, before: "token=top-secret", after: "token=rotated" }],
  };
  driver.preview = {
    ...preview,
    previewFingerprint: `sha256:${crypto.createHash("sha256").update(approvalPreviewFingerprintInput("same-engine-id", { kind: "write", description: "write report", target: driver.target }, preview)).digest("hex")}`,
  };
  const s = await startTestServer(undefined, driver);
  try {
    await open(s, await copyExampleWorkspace()); await request(s);
    const approval = (await list(s)).items[0]!;
    const serialized = JSON.stringify(approval);
    assert.equal(serialized.includes("password"), false);
    assert.equal(serialized.includes("top-secret"), false);
    assert.match(approval.action.target!, /\[redacted\]/);
    assert.match(approval.context?.parameterSummary ?? "", /\[redacted\]/);
    assert.equal(approval.context?.preview.status, "available");
    assert.match(JSON.stringify(approval.context?.preview), /\[redacted\]/);
  } finally { await s.close(); }
});

test("#403 batches one homogeneous restricted-tool source through one recovery turn", async () => {
  const driver = new ApprovalDriver(); driver.actionKind = "tool"; driver.approvalCount = 2;
  const workspace = await copyExampleWorkspace(), s = await startTestServer(undefined, driver);
  try {
    await fs.mkdir(path.join(workspace, ".digital-employee", "workbench"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".digital-employee", "workbench", "approval-policy.json"), JSON.stringify(batchPolicy()));
    await open(s, workspace); await request(s);
    const snapshot = await list(s);
    const payload = {
      workspaceToken: snapshot.workspaceToken,
      requestId: crypto.randomUUID(),
      decision: "granted",
      items: snapshot.items.map(item => ({ id: item.id, expectedVersion: item.version })),
    };
    const response = await api(s.baseUrl, "/approvals/batch/decision", {
      token: s.token, method: "POST",
      body: payload,
    });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const replay = await api(s.baseUrl, "/approvals/batch/decision", { token: s.token, method: "POST", body: payload });
    assert.equal(replay.status, 200, "the same batch request must reuse its member decisions");
    for (const item of snapshot.items) assert.equal((await settle(s, item.id)).execution.phase, "completed");
    assert.equal(driver.calls.filter(call => call.envelope.pendingApprovals).length, 1);
    assert.equal(driver.calls.find(call => call.envelope.pendingApprovals)?.envelope.pendingApprovals?.length, 2);
  } finally { await s.close(); }
});

test("#403 rejects unclassified tool batches before dispatch", async () => {
  const driver = new ApprovalDriver(); driver.actionKind = "tool"; driver.approvalCount = 2;
  await rejectBatch(driver, {
    schemaVersion: "roleweave-approval-policy.v1",
    version: "single-tool-only-1",
    default: { eligibleApprovers: ["operator"], threshold: 1 },
  });
});

test("#403 rejects classified tool members from different source runs before dispatch", async () => {
  const driver = new ApprovalDriver(); driver.actionKind = "tool";
  const workspace = await copyExampleWorkspace(), s = await startTestServer(undefined, driver);
  try {
    await fs.mkdir(path.join(workspace, ".digital-employee", "workbench"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".digital-employee", "workbench", "approval-policy.json"), JSON.stringify(batchPolicy()));
    await open(s, workspace);
    await request(s, "repo-owner");
    await request(s, "community-operator");
    const snapshot = await list(s);
    assert.equal(snapshot.items.length, 2);
    const response = await api(s.baseUrl, "/approvals/batch/decision", {
      token: s.token,
      method: "POST",
      body: { workspaceToken: snapshot.workspaceToken, requestId: crypto.randomUUID(), decision: "granted", items: snapshot.items.map(item => ({ id: item.id, expectedVersion: item.version })) },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual((response.body as { items: Array<{ status: string }> }).items.map(item => item.status), ["rejected", "rejected"]);
    assert.equal(driver.calls.filter(call => call.envelope.pendingApprovals).length, 0);
  } finally { await s.close(); }
});

test("#403 rolls back every member and compensates the audit ledger when one batch persistence write fails", async () => {
  const driver = new ApprovalDriver(); driver.actionKind = "tool"; driver.approvalCount = 2;
  const workspace = await copyExampleWorkspace(), s = await startTestServer(undefined, driver);
  try {
    await fs.mkdir(path.join(workspace, ".digital-employee", "workbench"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".digital-employee", "workbench", "approval-policy.json"), JSON.stringify(batchPolicy()));
    await open(s, workspace); await request(s);
    const snapshot = await list(s), service = approvals(s.ctx);
    const originalPut = service.store.put.bind(service.store);
    let grantedWrites = 0;
    service.store.put = async (directory, record) => {
      if (record.status === "granted" && record.execution.phase === "starting" && ++grantedWrites === 2) {
        throw new Error("synthetic second-member write failure");
      }
      await originalPut(directory, record);
    };
    const failedPayload = { workspaceToken: snapshot.workspaceToken, requestId: crypto.randomUUID(), decision: "granted" as const, items: snapshot.items.map(item => ({ id: item.id, expectedVersion: item.version })) };
    try {
      const response = await api(s.baseUrl, "/approvals/batch/decision", {
        token: s.token, method: "POST",
        body: failedPayload,
      });
      assert.equal(response.status, 500, JSON.stringify(response.body));
      assert.equal((response.body as { code: string }).code, "approval_storage_failed");
      assert.equal((response.body as { message: string }).message, "Approval batch persistence failed; every member was restored", JSON.stringify(response.body));
    } finally {
      service.store.put = originalPut;
    }
    const restored = await list(s);
    assert.ok(restored.items.every(item => item.status === "pending" && item.execution.phase === "not_started" && item.decision === undefined));
    assert.equal(driver.calls.filter(call => call.envelope.pendingApprovals).length, 0);
    for (const item of restored.items) {
      const audit = await api(s.baseUrl, `/approvals/${item.id}/audit`, { token: s.token });
      assert.equal(audit.status, 200, JSON.stringify(audit.body));
      const events = (audit.body as { events: Array<{ type: string; requestId?: string; revertedRequestId?: string; batchId?: string }> }).events;
      assert.deepEqual(events.map(event => event.type), ["requested", "decision", "decision_reverted"]);
      assert.equal(events[1]!.batchId, failedPayload.requestId);
      assert.equal(events[2]!.batchId, failedPayload.requestId);
      assert.equal(events[2]!.revertedRequestId, events[1]!.requestId);
    }
    const retry = await api(s.baseUrl, "/approvals/batch/decision", {
      token: s.token,
      method: "POST",
      body: { workspaceToken: restored.workspaceToken, requestId: crypto.randomUUID(), decision: "granted", items: restored.items.map(item => ({ id: item.id, expectedVersion: item.version })) },
    });
    assert.equal(retry.status, 202, JSON.stringify(retry.body));
    for (const item of restored.items) await settle(s, item.id);
    for (const item of restored.items) {
      const audit = await api(s.baseUrl, `/approvals/${item.id}/audit`, { token: s.token });
      const events = (audit.body as { events: Array<{ type: string; requestId?: string; revertedRequestId?: string }> }).events;
      const reverted = new Set(events.filter(event => event.type === "decision_reverted").map(event => event.revertedRequestId));
      assert.equal(events.filter(event => event.type === "decision" && !reverted.has(event.requestId)).length, 1, "only the retry is an unreverted grant");
    }
  } finally { await s.close(); }
});

test("#403 compensates already-appended decisions when the second audit append fails", async () => {
  const driver = new ApprovalDriver(); driver.actionKind = "tool"; driver.approvalCount = 2;
  const workspace = await copyExampleWorkspace(), s = await startTestServer(undefined, driver);
  try {
    await fs.mkdir(path.join(workspace, ".digital-employee", "workbench"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".digital-employee", "workbench", "approval-policy.json"), JSON.stringify(batchPolicy()));
    await open(s, workspace); await request(s);
    const snapshot = await list(s), service = approvals(s.ctx);
    const originalAppend = service.store.appendAudit.bind(service.store);
    let decisionAppends = 0;
    service.store.appendAudit = async (directory, event) => {
      if (event.type === "decision" && ++decisionAppends === 2) throw new Error("synthetic second-member audit failure");
      return originalAppend(directory, event);
    };
    const payload = { workspaceToken: snapshot.workspaceToken, requestId: crypto.randomUUID(), decision: "granted", items: snapshot.items.map(item => ({ id: item.id, expectedVersion: item.version })) };
    try {
      const response = await api(s.baseUrl, "/approvals/batch/decision", { token: s.token, method: "POST", body: payload });
      assert.equal(response.status, 500, JSON.stringify(response.body));
      assert.equal((response.body as { code: string }).code, "approval_storage_failed");
    } finally {
      service.store.appendAudit = originalAppend;
    }
    const restored = await list(s);
    assert.ok(restored.items.every(item => item.status === "pending" && item.execution.phase === "not_started" && item.decision === undefined));
    const audits = await Promise.all(restored.items.map(async item => {
      const response = await api(s.baseUrl, `/approvals/${item.id}/audit`, { token: s.token });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return (response.body as { events: Array<{ type: string; requestId?: string; revertedRequestId?: string; batchId?: string }> }).events;
    }));
    const events = audits.flat();
    const decisions = events.filter(event => event.type === "decision");
    const reversals = events.filter(event => event.type === "decision_reverted");
    assert.equal(decisions.length, 1);
    assert.equal(reversals.length, 1);
    assert.equal(reversals[0]!.batchId, payload.requestId);
    assert.equal(reversals[0]!.revertedRequestId, decisions[0]!.requestId);
    assert.equal(driver.calls.filter(call => call.envelope.pendingApprovals).length, 0);
  } finally { await s.close(); }
});

test("#403 makes a failed record rollback observable", async () => {
  const driver = new ApprovalDriver(); driver.actionKind = "tool"; driver.approvalCount = 2;
  const workspace = await copyExampleWorkspace(), s = await startTestServer(undefined, driver);
  try {
    await fs.mkdir(path.join(workspace, ".digital-employee", "workbench"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".digital-employee", "workbench", "approval-policy.json"), JSON.stringify(batchPolicy()));
    await open(s, workspace); await request(s);
    const snapshot = await list(s), service = approvals(s.ctx);
    const published: Array<{ id?: string }> = [];
    const unsubscribe = s.ctx.bus.subscribe(event => {
      if (event.type === "approvals.changed") published.push(event.payload as { id?: string });
    });
    const originalPut = service.store.put.bind(service.store);
    let grantedWrites = 0, rollbackWrites = 0;
    service.store.put = async (directory, record) => {
      if (record.status === "granted" && record.execution.phase === "starting" && ++grantedWrites === 2) throw new Error("synthetic second-member write failure");
      if (record.status === "pending" && ++rollbackWrites === 1) throw new Error("synthetic rollback write failure");
      await originalPut(directory, record);
    };
    try {
      const response = await api(s.baseUrl, "/approvals/batch/decision", {
        token: s.token,
        method: "POST",
        body: { workspaceToken: snapshot.workspaceToken, requestId: crypto.randomUUID(), decision: "granted", items: snapshot.items.map(item => ({ id: item.id, expectedVersion: item.version })) },
      });
      assert.equal(response.status, 500, JSON.stringify(response.body));
      assert.deepEqual(response.body, { code: "approval_storage_failed", message: "Approval batch persistence failed and rollback could not be confirmed", retryable: true });
    } finally {
      service.store.put = originalPut;
      unsubscribe();
    }
    assert.deepEqual(new Set(published.map(event => event.id)), new Set(snapshot.items.map(item => item.id)));
    assert.equal(driver.calls.filter(call => call.envelope.pendingApprovals).length, 0);
  } finally { await s.close(); }
});

test("#403 rejects write approvals at the batch boundary", async () => {
  const driver = new ApprovalDriver(); driver.approvalCount = 2;
  await rejectBatch(driver, batchPolicy());
});

test("#403 rejects exec approvals at the batch boundary", async () => {
  const driver = new ApprovalDriver(); driver.actionKind = "exec"; driver.approvalCount = 2;
  await rejectBatch(driver, batchPolicy());
});

test("#403 rejects network approvals at the batch boundary", async () => {
  const driver = new ApprovalDriver(); driver.actionKind = "network"; driver.approvalCount = 2;
  await rejectBatch(driver, batchPolicy());
});

test("#403 rejects expired approvals at the batch boundary", async () => {
  const driver = new ApprovalDriver(); driver.actionKind = "tool"; driver.approvalCount = 2; driver.expiresAt = new Date(Date.now() - 1000).toISOString();
  await rejectBatch(driver, batchPolicy());
});

test("#403 rejects version-conflicted approvals at the batch boundary", async () => {
  const driver = new ApprovalDriver(); driver.actionKind = "tool"; driver.approvalCount = 2;
  await rejectBatch(driver, batchPolicy(), version => version + 1);
});

test("#403 rejects batches that still need more than one approval principal", async () => {
  const driver = new ApprovalDriver(); driver.actionKind = "tool"; driver.approvalCount = 2;
  await rejectBatch(driver, batchPolicy({ eligibleApprovers: ["operator", "reviewer"], threshold: 2 }));
});

test("#403 rejects run-scope offers at the batch boundary", async () => {
  const driver = new ApprovalDriver(); driver.actionKind = "tool"; driver.approvalCount = 2; driver.runScope = true;
  await rejectBatch(driver, batchPolicy());
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

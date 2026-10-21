import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import { isTaskBriefingRequest, type ApprovalList, type EngineEvent, type Goal, type GoalDetail, type TurnRecord, type TurnRunDriver, type TurnRunRequest } from "@roleweave/shared";
import { createTaskBriefing, isTaskBriefingSnapshot, renderTaskBriefing, snapshotTaskBriefing, taskBriefingBinding } from "../src/turns/task-briefing.js";
import { serializeContextPayload } from "../src/turns/context-snapshot.js";
import { isTurnRecord, parseRfc3339Instant } from "../src/turns/store.js";
import { materializeThreadContext } from "../src/turns/thread-context.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

const timestamp = "2026-10-21T00:00:00.000Z";
function plan(): Goal {
  return { schemaVersion: "goal.v1", goalId: "project-one", title: "Ship the report", description: "Use verified sources",
    acceptanceCriteria: ["Cite each claim", "List unresolved questions"], status: "in_progress", health: "unknown", branches: [],
    workItems: [{ taskId: "task-one", title: "Prepare analysis", description: "Separate facts and assumptions", status: "todo", priority: "normal", assigneePositionId: "repo-owner" }],
    createdAt: timestamp, updatedAt: timestamp };
}
const identity = () => ({ turnId: crypto.randomUUID(), sessionId: crypto.randomUUID(), positionId: "repo-owner", generatedAt: timestamp });
const validTime = (value: unknown) => parseRfc3339Instant(value) !== null;

test("briefing request is a revision reference, never client-authored requirements", () => {
  const value = { expectedWorkspacePath: "/workspace", expectedUpdatedAt: timestamp };
  assert.equal(isTaskBriefingRequest(value), true);
  for (const invalid of [null, [], {}, { ...value, payload: plan() }, { ...value, expectedUpdatedAt: "yesterday" },
    { ...value, expectedWorkspacePath: "\0workspace" }, { ...value, expectedWorkspacePath: "" }]) assert.equal(isTaskBriefingRequest(invalid), false);
});

test("complete briefing is injected byte-for-byte and reserves budget ahead of optional history", () => {
  const goal = plan();
  const snapshot = createTaskBriefing(goal, goal.workItems![0]!, identity());
  const requiredContext = renderTaskBriefing(snapshot);
  const current = "Original request";
  const result = materializeThreadContext({ input: current, enabled: false, turns: [], requiredContext });
  assert.equal(result.input, requiredContext + current);
  assert.ok(result.input.includes(serializeContextPayload(snapshot.payload)));
  assert.equal(result.metadata.contextBytes, Buffer.byteLength(requiredContext));
  assert.equal(result.metadata.sourceTurnCount, 0);
  assert.equal(isTaskBriefingSnapshot(snapshot, validTime), true);
  assert.deepEqual(snapshot.payload.acceptanceCriteria, goal.acceptanceCriteria);
  const history = Array.from({ length: 20 }, (_, i) => ({ turnId: String(i), input: "history".repeat(5000), output: "answer".repeat(5000), status: "completed" as const, createdAt: timestamp }));
  const bounded = materializeThreadContext({ input: "x".repeat(248 * 1024), enabled: true, turns: history, requiredContext });
  assert.ok(Buffer.byteLength(bounded.input) <= 256 * 1024);
  assert.ok(bounded.input.includes(requiredContext));
  assert.ok(bounded.metadata.omittedTurnCount > 0);
  assert.throws(() => materializeThreadContext({ input: "x".repeat(256 * 1024), enabled: false, turns: [], requiredContext }), /insufficient space/);
});

test("required criteria never silently truncate and recognizable secrets are filtered", () => {
  const goal = plan();
  goal.description = "TOKEN=secretvalue <analysis>private</analysis>";
  goal.acceptanceCriteria = ["汉".repeat(4096)];
  const snapshot = createTaskBriefing(goal, goal.workItems![0]!, identity());
  assert.doesNotMatch(renderTaskBriefing(snapshot), /secretvalue|>private<|\uFFFD/);
  assert.equal(snapshot.payload.redacted, true);
  assert.equal(snapshot.payload.acceptanceCriteria[0], goal.acceptanceCriteria[0]);
  goal.acceptanceCriteria = Array.from({ length: 16 }, () => "\u0001".repeat(4096));
  assert.throws(() => createTaskBriefing(goal, goal.workItems![0]!, identity()), /48 KiB/);
  assert.throws(() => createTaskBriefing(plan(), plan().workItems![0]!, { ...identity(), positionId: "release-engineer" }), /assignee changed/);
});

test("snapshot hashes, timestamps and parent execution linkage are validated", () => {
  const goal = plan(), who = identity();
  const snapshot = createTaskBriefing(goal, goal.workItems![0]!, who);
  const context = materializeThreadContext({ input: "request", enabled: false, turns: [], requiredContext: renderTaskBriefing(snapshot) });
  const turn: TurnRecord = { schemaVersion: "turn-record.v1", conversationId: who.sessionId, conversationRef: who.sessionId,
    turnId: who.turnId, positionId: who.positionId, engine: "qoder", status: "running", input: "request",
    goalId: goal.goalId, branchId: "task-one", envelopeDigest: `sha256:${"a".repeat(64)}`, createdAt: timestamp, updatedAt: timestamp,
    events: [], threadContext: context.metadata, taskBriefing: snapshot };
  assert.equal(isTurnRecord(turn), true);
  for (const patch of [{ payloadBytes: snapshot.payloadBytes + 1 }, { payloadDigest: "invalid" }, { unexpected: true }]) {
    assert.equal(isTaskBriefingSnapshot({ ...snapshot, ...patch }, validTime), false);
  }
  for (const patch of [{ turnId: crypto.randomUUID() }, { sessionId: crypto.randomUUID() }, { positionId: "release-engineer" },
    { goalId: "another-goal" }, { taskId: "another-task" }, { generatedAt: "2020-01-01T00:00:00Z" }]) {
    assert.equal(isTurnRecord({ ...turn, taskBriefing: snapshotTaskBriefing({ ...snapshot.payload, ...patch }) }), false);
  }
  assert.equal(isTaskBriefingSnapshot(snapshotTaskBriefing({ ...snapshot.payload, generatedAt: "2026-02-30T00:00:00Z" }), validTime), false);
  assert.deepEqual(taskBriefingBinding(turn, "/workspace"), { goalId: goal.goalId, branchId: "task-one", taskBriefing: { expectedWorkspacePath: "/workspace", expectedUpdatedAt: timestamp } });
});

async function fixture(t: test.TestContext, driver?: TurnRunDriver) {
  const server = await startTestServer(undefined, driver);
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await server.ctx.contextExporter.waitForIdle(); await fs.rm(workspace, { recursive: true, force: true }); });
  const call = (url: string, method = "GET", body?: unknown) => api(server.baseUrl, url, { method, token: server.token, ...(body !== undefined ? { body } : {}) });
  assert.equal((await call("/workspace/open", "POST", { path: workspace })).status, 200);
  const created = await call("/goals", "POST", { title: "Authoritative goal", description: "Authoritative background", acceptanceCriteria: ["Server-owned acceptance criterion"] });
  const goalId = (created.body as { goalId: string }).goalId;
  const url = `/goals/${goalId}`;
  const initial = (await call(url)).body as GoalDetail;
  assert.equal((await call(url, "PATCH", { expectedUpdatedAt: initial.goal.updatedAt, workItems: [{ ...plan().workItems![0], title: "Authoritative task" }] })).status, 200);
  const detail = (await call(url)).body as GoalDetail;
  const session = await call("/sessions", "POST", { positionId: "repo-owner" });
  const sessionId = (session.body as { sessionId: string }).sessionId;
  const request = { engine: "qoder", input: "Original task input", goalId, branchId: "task-one", taskBriefing: { expectedWorkspacePath: workspace, expectedUpdatedAt: detail.goal.updatedAt } };
  return { server, workspace, call, detail, url, sessionId, request, turnUrl: `/sessions/${sessionId}/turns` };
}

test("session execution saves the exact injected briefing, projects it for review and survives reopen", async t => {
  let request: TurnRunRequest | undefined;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  t.after(() => finish());
  const f = await fixture(t, { async turnRun(value) {
    request = value; started(); await gate;
    return { status: "trusted", diagnostic: "", events: [
      { type: "run.started", runId: "run-one", timestamp: new Date().toISOString() },
      { type: "run.completed", runId: "run-one", timestamp: new Date().toISOString(), output: "Real delivery", terminalReason: "goal_met" },
    ] };
  } });
  const pending = f.call(f.turnUrl, "POST", f.request);
  await ready;
  const running = (await f.server.ctx.turnStore.sessionHistory(f.workspace, f.sessionId, "repo-owner", new Date().toISOString())).turns[0]!;
  assert.equal(running.status, "running");
  assert.ok(running.taskBriefing);
  assert.ok(request!.envelope.input.includes(serializeContextPayload(running.taskBriefing.payload)));
  assert.match(request!.envelope.input, /Authoritative background|Server-owned acceptance criterion/);
  assert.equal(running.input, f.request.input);
  finish();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual((response.body as TurnRecord).taskBriefing, running.taskBriefing);
  const detail = (await f.call(f.url)).body as GoalDetail;
  assert.deepEqual(detail.taskDeliveries!["task-one"]!.taskBriefing, running.taskBriefing);
  assert.notEqual(detail.goal.workItems![0]!.status, "done", "completion cannot grant human acceptance");
  await f.call(f.url, "PATCH", { expectedUpdatedAt: detail.goal.updatedAt, acceptanceCriteria: ["Changed review criterion"] });
  const changed = (await f.call(f.url)).body as GoalDetail;
  assert.deepEqual(changed.taskDeliveries!["task-one"]!.taskBriefing, running.taskBriefing, "review cannot regenerate historical input from a new plan");
  const reopened = await startTestServer();
  try {
    await api(reopened.baseUrl, "/workspace/open", { method: "POST", token: reopened.token, body: { path: f.workspace } });
    const restored = await reopened.ctx.turnStore.sessionHistory(f.workspace, f.sessionId, "repo-owner", new Date().toISOString());
    assert.deepEqual(restored.turns[0]!.taskBriefing, running.taskBriefing);
  } finally { await reopened.close(); }
});

test("stale, foreign, missing and client-authored briefings never reach the driver", async t => {
  let calls = 0;
  const f = await fixture(t, { async turnRun() { calls++; throw new Error("must not run"); } });
  const base = f.request.taskBriefing;
  for (const [patch, expected] of [
    [{ taskBriefing: { ...base, expectedUpdatedAt: timestamp } }, 409],
    [{ taskBriefing: { ...base, expectedWorkspacePath: "/foreign-workspace" } }, 409],
    [{ taskBriefing: { ...base, payload: "forged" } }, 400],
    [{ branchId: "missing-task" }, 409],
    [{ goalId: undefined }, 400],
  ] as const) assert.equal((await f.call(f.turnUrl, "POST", { ...f.request, ...patch })).status, expected);
  const other = await f.call("/sessions", "POST", { positionId: "release-engineer" });
  assert.equal((await f.call(`/sessions/${(other.body as { sessionId: string }).sessionId}/turns`, "POST", f.request)).status, 409);
  assert.equal((await f.call(f.turnUrl, "POST", { ...f.request, input: "x".repeat(256 * 1024) })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await f.server.ctx.turnStore.sessionHistory(f.workspace, f.sessionId, "repo-owner", new Date().toISOString())).turns.length, 0);
});

test("explicit retry retains briefing binding and rejects a changed plan instead of dropping context", async t => {
  const inputs: TurnRunRequest[] = [];
  const f = await fixture(t, { async turnRun(request) { inputs.push(request); return { status: "indeterminate", events: [], diagnostic: "", code: "turn_timeout" }; } });
  const first = (await f.call(f.turnUrl, "POST", f.request)).body as TurnRecord;
  const retry = { engine: "qoder", input: first.input, retryOf: first.turnId };
  const second = await f.call(f.turnUrl, "POST", retry);
  assert.equal(second.status, 200);
  assert.deepEqual((second.body as TurnRecord).taskBriefing!.payload.acceptanceCriteria, first.taskBriefing!.payload.acceptanceCriteria);
  assert.equal((second.body as TurnRecord).goalId, first.goalId);
  assert.equal((await f.call(f.turnUrl, "POST", { ...retry, goalId: "foreign-goal" })).status, 400);
  assert.equal((await f.call(f.url, "PATCH", { expectedUpdatedAt: f.detail.goal.updatedAt, acceptanceCriteria: ["New criterion"] })).status, 200);
  assert.equal((await f.call(f.turnUrl, "POST", { ...retry, retryOf: (second.body as TurnRecord).turnId })).status, 409);
  assert.equal(inputs.length, 2);
  assert.deepEqual(first.taskBriefing!.payload.acceptanceCriteria, ["Server-owned acceptance criterion"]);
});

for (const changedPlan of [false, true]) test(`approval resume revalidates its original task briefing (changed plan: ${changedPlan})`, async t => {
  const inputs: TurnRunRequest[] = [];
  const f = await fixture(t, { async turnRun(request) {
    inputs.push(request);
    const base = { runId: crypto.randomUUID(), timestamp: new Date().toISOString() };
    const events: EngineEvent[] = [{ ...base, type: "run.started" }];
    if (request.envelope.pendingApproval) {
      events.push({ ...base, type: "approval.granted", approvalId: "briefing-approval", grantedBy: "operator", scope: "once" },
        { ...base, type: "run.completed", terminalReason: "goal_met", output: "Approved output" });
    } else {
      events.push({ ...base, type: "approval.requested", approvalId: "briefing-approval", action: { kind: "write", description: "Write report", target: "report.md" } },
        { ...base, type: "run.failed", error: { code: "engine.approval_required", message: "Approval needed", retryable: true, terminalReason: "engine_internal_error" } });
    }
    return { status: "trusted", diagnostic: "", events };
  } });
  const source = await f.call(f.turnUrl, "POST", f.request);
  assert.equal(source.status, 200);
  if (changedPlan) assert.equal((await f.call(f.url, "PATCH", { expectedUpdatedAt: f.detail.goal.updatedAt, acceptanceCriteria: ["Changed requirement"] })).status, 200);
  const list = (await f.call("/approvals")).body as ApprovalList;
  const approval = list.items[0]!;
  assert.ok(approval);
  const decision = await f.call(`/approvals/${approval.id}/decision`, "POST", { workspaceToken: list.workspaceToken, requestId: crypto.randomUUID(), expectedVersion: approval.version, decision: "granted" });
  assert.equal(decision.status, 202);
  let settled;
  for (let i = 0; i < 100; i++) {
    settled = ((await f.call("/approvals")).body as ApprovalList).items.find(item => item.id === approval.id)!;
    if (!["starting", "running"].includes(settled.execution.phase)) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(settled!.execution.phase, changedPlan ? "indeterminate" : "completed");
  assert.equal(inputs.length, changedPlan ? 1 : 2);
  if (!changedPlan) {
    const history = await f.server.ctx.turnStore.sessionHistory(f.workspace, f.sessionId, "repo-owner", new Date().toISOString());
    const resumed = history.turns.find(turn => turn.turnId === settled!.execution.turnId)!;
    assert.equal(resumed.goalId, f.request.goalId);
    assert.equal(resumed.taskBriefing!.payload.planUpdatedAt, f.request.taskBriefing.expectedUpdatedAt);
    assert.ok(inputs[1]!.envelope.input.includes(serializeContextPayload(resumed.taskBriefing!.payload)));
  }
});

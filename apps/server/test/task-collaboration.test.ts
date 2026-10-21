import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import { validateGoalWorkItems, isTaskCollaborationContext, taskDependenciesReady, type GoalDetail, type GoalWorkItem,
  type TurnRecord, type TurnRunDriver, type TurnRunRequest } from "@roleweave/shared";
import { projectTaskCollaboration } from "../src/goals/collaboration.js";
import { serializeContextPayload } from "../src/turns/context-snapshot.js";
import { isTurnRecord, parseRfc3339Instant } from "../src/turns/store.js";
import { isTaskBriefingSnapshot, snapshotTaskBriefing } from "../src/turns/task-briefing.js";
import { materializeThreadContext } from "../src/turns/thread-context.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

const timestamp = "2026-10-21T00:00:00.000Z";
const upstream = (): GoalWorkItem => ({ taskId: "upstream", title: "Prepare specification", status: "todo", priority: "normal", assigneePositionId: "repo-owner" });
const downstream = (): GoalWorkItem => ({ taskId: "downstream", title: "Implement specification", status: "todo", priority: "normal", assigneePositionId: "repo-owner",
  dependsOn: ["upstream"], participants: [{ positionId: "release-engineer", role: "reviewer", responsibility: "Check deployment risks" }] });
const validTime = (value: unknown) => parseRfc3339Instant(value) !== null;

test("task relationship contract rejects duplicates, missing references, self edges, cycles and implicit responsibilities", () => {
  assert.equal(validateGoalWorkItems([upstream(), downstream()]).ok, true);
  const bad = [
    { ...downstream(), dependsOn: ["upstream", "upstream"] }, { ...downstream(), dependsOn: ["another-project-task"] },
    { ...downstream(), dependsOn: ["downstream"] }, { ...downstream(), dependsOn: "upstream" },
    { ...downstream(), participants: [{ positionId: "release-engineer", role: "reviewer", responsibility: "" }] },
    { ...downstream(), participants: [{ positionId: "repo-owner", role: "reviewer", responsibility: "same as assignee" }] },
    { ...downstream(), participants: [...downstream().participants!, ...downstream().participants!] },
    { ...downstream(), participants: [{ ...downstream().participants![0], role: "owner" }] },
    { ...downstream(), participants: [{ ...downstream().participants![0], permissions: ["admin"] }] },
    { ...downstream(), participants: [{ ...downstream().participants![0], responsibility: "x".repeat(1025) }] },
    { ...downstream(), participants: Array.from({ length: 9 }, (_, i) => ({ positionId: `person-${i}`, role: "contributor", responsibility: "work" })) },
  ];
  for (const item of bad) assert.equal(validateGoalWorkItems([upstream(), item]).ok, false);
  assert.equal(validateGoalWorkItems([{ ...upstream(), dependsOn: ["downstream"] }, downstream()]).ok, false);
  assert.equal(validateGoalWorkItems([downstream()]).ok, false, "deleting an upstream requires an explicit dependency edit");
});

test("unavailable history never becomes a ready manual task, including prototype-shaped identifiers", () => {
  const source = { ...upstream(), taskId: "toString", status: "done" as const };
  const task = { ...downstream(), dependsOn: ["toString"] };
  const goal = { schemaVersion: "goal.v1" as const, goalId: "goal-one", title: "Goal", description: "", acceptanceCriteria: [],
    status: "open" as const, health: "unknown" as const, branches: [], workItems: [source, task], createdAt: timestamp, updatedAt: timestamp };
  const missing = projectTaskCollaboration(goal, task, { deliveries: {}, executions: {}, tasksWithTurns: new Set(), historyAvailable: false }, timestamp);
  assert.equal(taskDependenciesReady(missing), false);
  assert.equal(missing.dependencies[0]!.readiness, "unavailable");
  assert.equal(isTaskCollaborationContext(missing, validTime, "repo-owner"), true);
  const manual = projectTaskCollaboration(goal, task, { deliveries: {}, executions: {}, tasksWithTurns: new Set(), historyAvailable: true }, timestamp);
  assert.equal(manual.dependencies[0]!.readiness, "manual_done");
  assert.equal(taskDependenciesReady(manual), true);
});

test("direct downstream references are bounded with explicit omissions", () => {
  const source = upstream();
  const tasks = [source, ...Array.from({ length: 20 }, (_, i) => ({ ...downstream(), taskId: `next-${i}` }))];
  const goal = { schemaVersion: "goal.v1" as const, goalId: "goal-one", title: "Goal", description: "", acceptanceCriteria: [],
    status: "open" as const, health: "unknown" as const, branches: [], workItems: tasks, createdAt: timestamp, updatedAt: timestamp };
  const context = projectTaskCollaboration(goal, source, { deliveries: {}, executions: {}, tasksWithTurns: new Set(), historyAvailable: true }, timestamp);
  assert.equal(context.dependents.length, 8);
  assert.equal(context.omittedDependentCount, 12);
  assert.equal(isTaskCollaborationContext(context, validTime, "repo-owner"), true);
});

class Driver implements TurnRunDriver {
  calls: TurnRunRequest[] = [];
  failUpstream = false;
  failDownstream = false;
  gate?: Promise<void>;
  onStart?: () => void;
  async turnRun(request: TurnRunRequest) {
    this.calls.push(request); this.onStart?.(); await this.gate;
    if ((this.failUpstream && request.envelope.input.includes('"taskId":"upstream"')) || (this.failDownstream && request.envelope.input.includes('"taskId":"downstream"'))) {
      return { status: "indeterminate" as const, diagnostic: "", code: "turn_timeout", events: [] };
    }
    const base = { runId: crypto.randomUUID(), timestamp: new Date().toISOString() };
    return { status: "trusted" as const, diagnostic: "", events: [
      { ...base, type: "run.started" as const },
      { ...base, type: "run.completed" as const, terminalReason: "goal_met" as const,
        output: "VERIFIED-PUBLIC-UPSTREAM-621 TOKEN=credentialvalue <analysis>private trace</analysis> " + "汉".repeat(900) },
    ] };
  }
}
async function fixture(t: test.TestContext) {
  const driver = new Driver(), server = await startTestServer(undefined, driver), workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await server.ctx.contextExporter.waitForIdle(); await fs.rm(workspace, { recursive: true, force: true }); });
  const call = (url: string, method = "GET", body?: unknown) => api(server.baseUrl, url, { method, token: server.token, ...(body !== undefined ? { body } : {}) });
  assert.equal((await call("/workspace/open", "POST", { path: workspace })).status, 200);
  const created = await call("/goals", "POST", { title: "Collaborative project", description: "Implement the approved specification", acceptanceCriteria: ["Verified evidence"] });
  const goalId = (created.body as { goalId: string }).goalId, url = `/goals/${goalId}`;
  let detail = (await call(url)).body as GoalDetail;
  assert.equal((await call(url, "PATCH", { expectedUpdatedAt: detail.goal.updatedAt, workItems: [upstream(), downstream()] })).status, 200);
  const sessionId = ((await call("/sessions", "POST", { positionId: "repo-owner" })).body as { sessionId: string }).sessionId;
  const turnUrl = `/sessions/${sessionId}/turns`;
  const load = async () => (await call(url)).body as GoalDetail;
  const run = async (taskId: string) => { detail = await load(); return call(turnUrl, "POST", { engine: "qoder", input: `Work on ${taskId}`, goalId, branchId: taskId,
    taskBriefing: { expectedWorkspacePath: workspace, expectedUpdatedAt: detail.goal.updatedAt } }); };
  const acceptUpstream = async () => {
    detail = await load();
    return call(`${url}/tasks/upstream/acceptance`, "POST", { expectedWorkspacePath: workspace, expectedUpdatedAt: detail.goal.updatedAt,
      source: detail.taskDeliveries!["upstream"]!.source, idempotencyKey: crypto.randomUUID(), decision: "accepted", verdicts: [{ criteriaIndex: 0, passed: true }] });
  };
  return { server, workspace, call, driver, url, goalId, sessionId, turnUrl, load, run, acceptUpstream };
}

test("configured dependencies cannot bypass the gate through omitted briefings or bare turns", async t => {
  const f = await fixture(t);
  for (const route of [f.turnUrl, "/turns"]) {
    const response = await f.call(route, "POST", { engine: "qoder", input: "Bypass dependencies", goalId: f.goalId, branchId: "downstream", ...(route === "/turns" ? { positionId: "repo-owner" } : {}) });
    assert.equal(response.status, 409);
  }
  const blocked = await f.run("downstream");
  assert.equal(blocked.status, 409);
  assert.equal((blocked.body as { code: string }).code, "goal_dependency_blocked");
  const group = await f.call("/groups", "POST", { memberPositionIds: ["repo-owner", "release-engineer"] });
  const groupUrl = `/groups/${(group.body as { conversationRef: string }).conversationRef}/turns`;
  assert.equal((await f.call(groupUrl, "POST", { engine: "qoder", input: "Bypass through a group", goalId: f.goalId, branchId: "downstream", mentions: ["repo-owner", "release-engineer"] })).status, 409);
  assert.equal(((await f.call(groupUrl)).body as { items: unknown[] }).items.length, 0, "rejection precedes durable group acceptance");
  assert.equal(f.driver.calls.length, 0);
  const state = await f.load();
  for (const task of [{ ...downstream(), participants: [{ positionId: "outsider", role: "contributor", responsibility: "work" }] }, { ...downstream(), dependsOn: ["other-project-task"] }]) {
    assert.equal((await f.call(f.url, "PATCH", { expectedUpdatedAt: state.goal.updatedAt, workItems: [upstream(), task] })).status, 400);
  }
  assert.equal((await f.call(f.url, "PATCH", { expectedUpdatedAt: state.goal.updatedAt, workItems: [downstream()] })).status, 400);
  assert.equal((await f.load()).goal.updatedAt, state.goal.updatedAt);
});

test("completion alone does not unlock a dependency; accepted source is injected once, saved and survives restart", async t => {
  const f = await fixture(t);
  assert.equal((await f.run("upstream")).status, 200);
  const before = await f.load();
  assert.equal(before.taskCollaborations!["downstream"]!.dependencies[0]!.readiness, "pending");
  assert.equal((await f.run("downstream")).status, 409);
  assert.equal((await f.acceptUpstream()).status, 200);
  const approved = await f.load();
  const source = approved.taskDeliveries!["upstream"]!.source;
  assert.equal(approved.taskCollaborations!["downstream"]!.dependencies[0]!.readiness, "accepted");
  let release!: () => void, started!: () => void;
  f.driver.gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; }); f.driver.onStart = started;
  t.after(() => release());
  const pending = f.run("downstream"); await ready;
  const history = await f.server.ctx.turnStore.sessionHistory(f.workspace, f.sessionId, "repo-owner", new Date().toISOString());
  const running = history.turns.find(turn => turn.status === "running")!;
  const saved = structuredClone(running.taskBriefing!);
  const input = f.driver.calls.at(-1)!.envelope.input;
  assert.ok(input.includes(serializeContextPayload(saved.payload)));
  assert.equal(input.split("VERIFIED-PUBLIC-UPSTREAM-621").length - 1, 1, "same-session history cannot duplicate a dependency source");
  assert.doesNotMatch(input, /credentialvalue|private trace|\uFFFD/);
  assert.equal(saved.payload.collaboration!.dependencies[0]!.delivery!.turnId, source.turnId);
  assert.equal(saved.payload.collaboration!.dependencies[0]!.delivery!.outputDigest, source.outputDigest);
  assert.equal(saved.payload.collaboration!.dependencies[0]!.delivery!.truncated, true);
  assert.equal(saved.payload.redacted, true);
  assert.equal(running.threadContext!.sourceTurnCount, 1);
  assert.equal(isTurnRecord(running), true);
  assert.equal(isTurnRecord({ ...running, threadContext: { ...running.threadContext!, sourceTurnCount: 0 } }), false);
  release();
  const result = await pending; assert.equal(result.status, 200);
  assert.deepEqual((result.body as TurnRecord).taskBriefing, saved);
  assert.equal(f.driver.calls.length, 2, "recording a reviewer does not automatically dispatch another employee");
  const reopened = await startTestServer();
  try {
    await api(reopened.baseUrl, "/workspace/open", { method: "POST", token: reopened.token, body: { path: f.workspace } });
    const restored = await reopened.ctx.turnStore.sessionHistory(f.workspace, f.sessionId, "repo-owner", new Date().toISOString());
    assert.deepEqual(restored.turns.find(turn => turn.turnId === running.turnId)!.taskBriefing, saved);
  } finally { await reopened.close(); }
  const altered = structuredClone(saved.payload);
  altered.collaboration!.dependencies[0]!.delivery!.outputExcerpt = "altered";
  assert.equal(isTaskBriefingSnapshot(snapshotTaskBriefing(altered), validTime), false, "recomputing the outer hash cannot hide an excerpt digest mismatch");
});

test("a newer failed upstream attempt blocks a retry while the old execution snapshot remains unchanged", async t => {
  const f = await fixture(t);
  await f.run("upstream"); await f.acceptUpstream();
  f.driver.failDownstream = true;
  const failed = (await f.run("downstream")).body as TurnRecord;
  const saved = structuredClone(failed.taskBriefing);
  f.driver.failDownstream = false; f.driver.failUpstream = true;
  await f.run("upstream");
  assert.equal((await f.load()).taskCollaborations!["downstream"]!.dependencies[0]!.readiness, "pending");
  const retry = await f.call(f.turnUrl, "POST", { engine: "qoder", input: failed.input, retryOf: failed.turnId });
  assert.equal(retry.status, 409);
  assert.equal((retry.body as { code: string }).code, "goal_dependency_blocked");
  assert.equal(f.driver.calls.length, 3);
  const records = await f.server.ctx.turnStore.sessionHistory(f.workspace, f.sessionId, "repo-owner", new Date().toISOString());
  assert.deepEqual(records.turns.find(turn => turn.turnId === failed.turnId)!.taskBriefing, saved);
});

test("current criteria invalidate old acceptance; manual predecessors remain explicit and carry no invented output", async t => {
  const f = await fixture(t);
  await f.run("upstream"); await f.acceptUpstream();
  let detail = await f.load();
  assert.equal((await f.call(f.url, "PATCH", { expectedUpdatedAt: detail.goal.updatedAt, acceptanceCriteria: ["New acceptance criterion"] })).status, 200);
  assert.equal((await f.run("downstream")).status, 409);
  assert.equal((await f.acceptUpstream()).status, 200);
  assert.equal((await f.run("downstream")).status, 200);
  detail = await f.load();
  assert.equal((await f.call(f.url, "PATCH", { expectedUpdatedAt: detail.goal.updatedAt, workItems: [
    { taskId: "manual", title: "Human check", status: "done", priority: "normal" },
    { ...downstream(), dependsOn: ["manual"] },
  ] })).status, 200);
  const manual = await f.run("downstream");
  assert.equal(manual.status, 200);
  const relation = (manual.body as TurnRecord).taskBriefing!.payload.collaboration!.dependencies[0]!;
  assert.equal(relation.readiness, "manual_done"); assert.equal(relation.delivery, undefined);
});

test("required dependency sources share the source budget with history and deduplication is not an omission", () => {
  const result = materializeThreadContext({ input: "request", enabled: true, requiredContext: "Required public dependency output\n", requiredSourceIds: ["source"],
    turns: [{ turnId: "source", input: "old", output: "duplicate", status: "completed", createdAt: timestamp },
      ...Array.from({ length: 20 }, (_, i) => ({ turnId: `history-${i}`, input: "old", output: "result", status: "completed" as const, createdAt: timestamp }))] });
  assert.doesNotMatch(result.input, /duplicate/);
  assert.equal(result.metadata.sourceTurnCount, 12);
  assert.equal(result.metadata.omittedTurnCount, 9);
});

test("dependency history read failure cannot start a turn or fall back to plan-only readiness", async t => {
  const f = await fixture(t);
  await f.run("upstream"); await f.acceptUpstream();
  const detail = await f.load();
  const original = f.server.ctx.turnStore.reportRecords.bind(f.server.ctx.turnStore);
  f.server.ctx.turnStore.reportRecords = async () => { throw new Error("unavailable evidence"); };
  try {
    const current = await f.load();
    assert.equal(current.executionUnavailable, true);
    assert.equal(current.taskCollaborations!["downstream"]!.dependencies[0]!.readiness, "unavailable");
    const response = await f.call(f.turnUrl, "POST", { engine: "qoder", input: "Work on downstream", goalId: f.goalId, branchId: "downstream",
      taskBriefing: { expectedWorkspacePath: f.workspace, expectedUpdatedAt: detail.goal.updatedAt } });
    assert.equal(response.status, 500);
    assert.equal(f.driver.calls.length, 1);
  } finally { f.server.ctx.turnStore.reportRecords = original; }
});

test("older plan writers cannot erase relationships by omission; explicit empty arrays clear them", async t => {
  const f = await fixture(t);
  let current = await f.load();
  const oldWriterTask = { taskId: "downstream", title: "Renamed implementation", status: "todo", priority: "normal", assigneePositionId: "repo-owner" };
  assert.equal((await f.call(f.url, "PATCH", { expectedUpdatedAt: current.goal.updatedAt, workItems: [upstream(), oldWriterTask] })).status, 200);
  current = await f.load();
  assert.deepEqual(current.goal.workItems!.find(item => item.taskId === "downstream")!.dependsOn, ["upstream"]);
  assert.equal(current.goal.workItems!.find(item => item.taskId === "downstream")!.participants?.[0]?.role, "reviewer");
  assert.equal((await f.call(f.url, "PATCH", { expectedUpdatedAt: current.goal.updatedAt, workItems: [oldWriterTask] })).status, 400);
  assert.equal((await f.call(f.url, "PATCH", { expectedUpdatedAt: current.goal.updatedAt, workItems: [upstream(), { ...oldWriterTask, dependsOn: [], participants: [] }] })).status, 200);
  current = await f.load();
  assert.deepEqual(current.goal.workItems!.find(item => item.taskId === "downstream")!.dependsOn, []);
  assert.deepEqual(current.goal.workItems!.find(item => item.taskId === "downstream")!.participants, []);
});

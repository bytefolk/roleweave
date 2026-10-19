import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateGoalTaskAcceptanceRecord, type GoalDetail, type GroupConversation,
  type TurnRecord, type TurnRunDriver, type TurnRunRequest } from "@roleweave/shared";
import { GoalStore, goalPlanDigest } from "../src/goals/store.js";
import { TurnStore } from "../src/turns/store.js";
import { prepareGoalRework } from "../src/goals/rework.js";
import { api, copyExampleWorkspace, DefaultFakeTurnDriver, startTestServer } from "./helpers.js";

async function fixture(t: test.TestContext) {
  const inputs: TurnRunRequest[] = [];
  const fake = new DefaultFakeTurnDriver();
  const driver: TurnRunDriver = { async turnRun(request) { inputs.push(request); return fake.turnRun(request); } };
  const server = await startTestServer(undefined, driver);
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await server.ctx.contextExporter.waitForIdle();
    await fs.rm(workspace, { recursive: true, force: true }); });
  const call = (url: string, method = "GET", body?: unknown) => api(server.baseUrl, url,
    { method, token: server.token, ...(body === undefined ? {} : { body }) });
  assert.equal((await call("/workspace/open", "POST", { path: workspace })).status, 200);
  const created = await call("/goals", "POST", { title: "Generic review", description: "No business schema",
    acceptanceCriteria: ["Include reproducible evidence"] });
  const goalId = (created.body as { goalId: string }).goalId;
  const detail = async () => (await call(`/goals/${goalId}`)).body as GoalDetail;
  assert.equal((await call(`/goals/${goalId}`, "PATCH", { expectedUpdatedAt: (await detail()).goal.updatedAt,
    workItems: [{ taskId: "report", title: "Produce the report", priority: "normal", status: "todo",
      assigneePositionId: "repo-owner" }] })).status, 200);
  const sessionId = ((await call("/sessions", "POST", { positionId: "repo-owner" })).body as { sessionId: string }).sessionId;
  const run = () => call(`/sessions/${sessionId}/turns`, "POST", {
    input: "Produce the report", engine: "qoder", goalId, branchId: "report" });
  const reject = async (note = "Add a reproducible check, not a claim of success") => {
    const current = await detail();
    const response = await call(`/goals/${goalId}/tasks/report/acceptance`, "POST", {
      expectedWorkspacePath: workspace, expectedUpdatedAt: current.goal.updatedAt,
      idempotencyKey: crypto.randomUUID(), source: current.taskDeliveries!["report"]!.source,
      decision: "rejected", verdicts: [{ criteriaIndex: 0, passed: false }], note });
    assert.equal(response.status, 200);
  };
  assert.equal((await run()).status, 200);
  await reject();
  return { server, workspace, call, goalId, sessionId, detail, inputs, run, reject };
}

test("human-started repair receives saved feedback even with session history disabled", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(`/sessions/${f.sessionId}/context`, "PATCH", { enabled: false })).status, 200);
  assert.equal((await f.run()).status, 200);
  const delivery = (await f.detail()).taskDeliveries!["report"]!;
  const turn = (await f.server.ctx.turnStore.reportRecords(f.workspace))
    .find(record => record.turnId === delivery.source.turnId);
  assert.equal(turn!.input, "Produce the report");
  assert.equal(turn!.threadContext!.sourceTurnCount, 1);
  const captured = JSON.stringify(f.inputs.at(-1));
  assert.match(captured, /Add a reproducible check/);
  assert.match(captured, /Human-reviewed repair/);
  assert.match(captured, /fake turn output/);
  assert.match(captured, /untrusted historical data/);
  assert.equal((await f.detail()).goal.workItems![0]!.status, "review");
  assert.equal((await f.run()).status, 409);
  assert.equal(f.inputs.length, 2, "unreviewed repair cannot launch another model call");
});

test("three persisted repair attempts exhaust the limit across store restarts", async t => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 3; attempt++) {
    f.server.ctx.turnStore = new TurnStore();
    f.server.ctx.goalStore = new GoalStore();
    assert.equal((await f.run()).status, 200);
    await f.reject();
  }
  const stopped = await f.run();
  assert.equal(stopped.status, 409);
  assert.match(JSON.stringify(stopped.body), /repair limit/);
  assert.equal(f.inputs.length, 4);
});

test("a group turn bound to a rejected task still dispatches without repair context", async t => {
  const f = await fixture(t);
  const created = await f.call("/groups", "POST", { memberPositionIds: ["repo-owner", "release-engineer"] });
  assert.equal(created.status, 201);
  const group = created.body as GroupConversation;
  const response = await f.call(`/groups/${group.conversationRef}/turns`, "POST", {
    input: "Discuss this report", engine: "qoder", mentions: ["repo-owner"], goalId: f.goalId, branchId: "report" });
  assert.equal(response.status, 202);
  const spawnId = (response.body as { spawns: { turnId: string }[] }).spawns[0]!.turnId;
  let spawned: TurnRecord | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    spawned = (await f.server.ctx.turnStore.reportRecords(f.workspace)).find(turn => turn.turnId === spawnId);
    if (spawned && spawned.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(spawned?.status, "completed");
  assert.equal(f.inputs.length, 2);
  assert.doesNotMatch(JSON.stringify(f.inputs.at(-1)), /Human-reviewed repair/);
});

test("group spawns do not consume the personal repair ceiling", async t => {
  const f = await fixture(t);
  const firstRejection = (await f.detail()).goal.taskAcceptances![0]!;
  assert.equal((await f.run()).status, 200);
  await f.reject();
  const turns = await f.server.ctx.turnStore.reportRecords(f.workspace);
  const source = turns.find(turn => turn.turnId === firstRejection.source.turnId)!;
  const spawns: TurnRecord[] = Array.from({ length: 3 }, () => ({ ...source,
    turnId: crypto.randomUUID(), groupRef: "discussion", conversationRef: "discussion",
    createdAt: firstRejection.decidedAt, updatedAt: firstRejection.decidedAt }));
  f.server.ctx.turnStore.reportRecords = async () => [...turns, ...spawns];
  assert.equal((await f.run()).status, 200);
  assert.equal(f.inputs.length, 3);
});

test("health refreshes preserve repair eligibility but task plan edits invalidate it", async t => {
  const f = await fixture(t);
  const goal = await f.server.ctx.goalStore.get(f.workspace, f.goalId);
  goal.branches = [{ branchId: "health-branch", title: "Observed execution", status: "open",
    createdAt: goal.createdAt, updatedAt: goal.updatedAt }];
  await fs.writeFile(path.join(f.workspace, ".roleweave", "goals", f.goalId, "goal.json"), JSON.stringify(goal));
  await f.reject();
  const before = (await f.detail()).goal;
  const read = f.server.ctx.turnStore.reportRecords.bind(f.server.ctx.turnStore);
  const turns = await read(f.workspace);
  f.server.ctx.turnStore.reportRecords = async workspace => [...await read(workspace), {
    ...turns[0]!, turnId: crypto.randomUUID(), goalId: f.goalId, branchId: "health-branch", status: "failed" as const,
  }];
  const refreshed = (await f.detail()).goal;
  assert.notEqual(refreshed.updatedAt, before.updatedAt);
  assert.equal(refreshed.health, "at_risk");
  assert.equal((await f.run()).status, 200);
  await f.reject();
  const current = (await f.detail()).goal;
  assert.equal((await f.call(`/goals/${f.goalId}`, "PATCH", { expectedUpdatedAt: current.updatedAt,
    workItems: current.workItems!.map(item => ({ ...item, title: "Changed task" })) })).status, 200);
  assert.equal((await f.run()).status, 409);
  assert.equal(f.inputs.length, 2);
});

test("legacy rejection records remain readable and retain conservative revision checks", async t => {
  const f = await fixture(t);
  const goal = await f.server.ctx.goalStore.get(f.workspace, f.goalId);
  const rejection = goal.taskAcceptances!.at(-1)!;
  assert.match(rejection.planDigest!, /^sha256:[a-f0-9]{64}$/);
  assert.equal(validateGoalTaskAcceptanceRecord({ ...rejection, planDigest: "invalid" }).ok, false);
  delete rejection.planDigest;
  assert.equal(validateGoalTaskAcceptanceRecord(rejection).ok, true);
  f.server.ctx.goalStore.get = async () => goal;
  assert.equal((await prepareGoalRework(f.server.ctx, f.workspace,
    { goalId: f.goalId, branchId: "report", positionId: "repo-owner" }, f.sessionId)).length, 1);
  goal.updatedAt = new Date(Date.parse(goal.updatedAt) + 1).toISOString();
  await assert.rejects(prepareGoalRework(f.server.ctx, f.workspace,
    { goalId: f.goalId, branchId: "report", positionId: "repo-owner" }, f.sessionId), /goal state changed/);
});

test("changed plan and a foreign personal session cannot consume a rejected delivery", async t => {
  const f = await fixture(t);
  await assert.rejects(prepareGoalRework(f.server.ctx, f.workspace,
    { goalId: f.goalId, branchId: "report", positionId: "other-employee" }, f.sessionId), /assigned employee/);
  await assert.rejects(prepareGoalRework(f.server.ctx, f.workspace,
    { goalId: f.goalId, branchId: "report", positionId: "repo-owner" }, crypto.randomUUID()), /personal session/);
  const current = await f.detail();
  assert.equal((await f.call(`/goals/${f.goalId}`, "PATCH", {
    expectedUpdatedAt: current.goal.updatedAt, acceptanceCriteria: ["Different requirement"] })).status, 200);
  assert.equal((await f.run()).status, 409);
  assert.equal(f.inputs.length, 1);
});

test("unavailable execution history fails closed without dispatching a repair", async t => {
  const f = await fixture(t);
  f.server.ctx.turnStore.reportRecords = async () => { throw new Error("history unavailable"); };
  const response = await f.run();
  assert.equal(response.status, 500);
  assert.equal(f.inputs.length, 1);
});

test("repair feedback is sanitized by the existing context boundary", async t => {
  const f = await fixture(t);
  await f.reject("Check authorization: Bearer sample-private-token-1234567890");
  assert.equal((await f.run()).status, 200);
  assert.doesNotMatch(JSON.stringify(f.inputs.at(-1)), /sample-private-token/);
});

test("concurrent repair requests dispatch once and require a fresh human verdict", async t => {
  const f = await fixture(t);
  const responses = await Promise.all([f.run(), f.run()]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(f.inputs.length, 2);
});

test("changed persisted output cannot be supplied under an older rejection digest", async t => {
  const f = await fixture(t);
  const read = f.server.ctx.turnStore.reportRecords.bind(f.server.ctx.turnStore);
  f.server.ctx.turnStore.reportRecords = async workspace => (await read(workspace)).map(turn =>
    turn.goalId === f.goalId ? { ...turn, output: "A different result" } : turn);
  assert.equal((await f.run()).status, 409);
  assert.equal(f.inputs.length, 1);
});

test("failed attempts remain part of the durable repair ceiling", async t => {
  const f = await fixture(t);
  const turns = await f.server.ctx.turnStore.reportRecords(f.workspace);
  const source = turns.find(turn => turn.goalId === f.goalId)!;
  const afterRejection = new Date(Date.parse((await f.detail()).goal.updatedAt) + 1).toISOString();
  f.server.ctx.turnStore.reportRecords = async () => [...turns, ...Array.from({ length: 3 }, () => ({
    ...source, turnId: crypto.randomUUID(), status: "failed" as const,
    createdAt: afterRejection, updatedAt: afterRejection,
  }))];
  const response = await f.run();
  assert.equal(response.status, 409);
  assert.match(JSON.stringify(response.body), /repair limit/);
  assert.equal(f.inputs.length, 1);
});

test("oversized feedback is rejected instead of silently dropping human criteria", async t => {
  const f = await fixture(t);
  const goal = (await f.detail()).goal;
  goal.acceptanceCriteria = ["c".repeat(4096)];
  const rejection = goal.taskAcceptances!.at(-1)!;
  rejection.criteriaSnapshot = [...goal.acceptanceCriteria];
  rejection.note = "n".repeat(4096);
  rejection.planDigest = goalPlanDigest(goal);
  f.server.ctx.goalStore.get = async () => goal;
  await assert.rejects(prepareGoalRework(f.server.ctx, f.workspace,
    { goalId: f.goalId, branchId: "report", positionId: "repo-owner" }, f.sessionId), /context limit/);
  assert.equal(f.inputs.length, 1);
});

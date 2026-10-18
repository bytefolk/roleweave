import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import type { GoalDetail, TurnRunDriver, TurnRunRequest } from "@roleweave/shared";
import { GoalStore } from "../src/goals/store.js";
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
  f.server.ctx.goalStore.get = async () => goal;
  await assert.rejects(prepareGoalRework(f.server.ctx, f.workspace,
    { goalId: f.goalId, branchId: "report", positionId: "repo-owner" }, f.sessionId), /context limit/);
  assert.equal(f.inputs.length, 1);
});

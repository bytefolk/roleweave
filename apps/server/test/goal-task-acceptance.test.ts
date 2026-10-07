import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateGoalTaskAcceptanceCreateRequest, validateGoalTaskAcceptanceRecord,
  type GoalDetail, type GoalTaskAcceptanceCreateRequest, type GoalTaskAcceptanceCreateResponse } from "@roleweave/shared";
import { GoalStore, projectTaskDeliveries } from "../src/goals/store.js";
import { nodeAtomicTurnWriteOperations } from "../src/turns/store.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

async function fixture(t: test.TestContext, withExecution = true) {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  const call = (url: string, method = "GET", body?: unknown, token: string | null = server.token) =>
    api(server.baseUrl, url, { method, token, ...(body !== undefined ? { body } : {}) });
  assert.equal((await call("/workspace/open", "POST", { path: workspace })).status, 200);
  const created = await call("/goals", "POST", { title: "Review the delivery", description: "Human review of persisted work",
    acceptanceCriteria: ["The answer covers the task", "The result is reproducible"] });
  const goalId = (created.body as { goalId: string }).goalId;
  const goalUrl = `/goals/${goalId}`;
  let detail = (await call(goalUrl)).body as GoalDetail;
  assert.equal((await call(goalUrl, "PATCH", { expectedUpdatedAt: detail.goal.updatedAt, workItems: [
    { taskId: "task-one", title: "Prepare report", priority: "normal", status: "todo", assigneePositionId: "repo-owner" },
    { taskId: "manual", title: "Manual planning item", priority: "low", status: "todo" },
  ] })).status, 200);
  let sessionId: string | undefined;
  if (withExecution) {
    const session = await call("/sessions", "POST", { positionId: "repo-owner" });
    assert.equal(session.status, 201);
    sessionId = (session.body as { sessionId: string }).sessionId;
    const turn = await call(`/sessions/${sessionId}/turns`, "POST", {
      engine: "qoder", input: "Produce a report", goalId, branchId: "task-one",
    });
    assert.equal(turn.status, 200);
  }
  detail = (await call(goalUrl)).body as GoalDetail;
  const acceptanceUrl = `${goalUrl}/tasks/task-one/acceptance`;
  const request = (): GoalTaskAcceptanceCreateRequest => ({ expectedWorkspacePath: workspace,
    expectedUpdatedAt: detail.goal.updatedAt, idempotencyKey: crypto.randomUUID(),
    source: detail.taskDeliveries!["task-one"]!.source, decision: "accepted",
    verdicts: [{ criteriaIndex: 0, passed: true }, { criteriaIndex: 1, passed: true }] });
  return { server, workspace, call, goalId, goalUrl, acceptanceUrl, detail, request, sessionId };
}

test("a human acceptance atomically commits done with the exact plan and saved session output, survives restart", async t => {
  const f = await fixture(t);
  const body = f.request();
  const response = await f.call(f.acceptanceUrl, "POST", body);
  assert.equal(response.status, 200);
  const { record } = response.body as GoalTaskAcceptanceCreateResponse;
  assert.equal(record.scope, "goal-task");
  assert.equal(record.schemaVersion, "goal-task-acceptance.v1");
  assert.equal(record.decidedBy, "operator");
  assert.equal(record.planUpdatedAt, f.detail.goal.updatedAt);
  assert.deepEqual(record.criteriaSnapshot, f.detail.goal.acceptanceCriteria);
  assert.equal(record.source.sessionId, f.sessionId);
  assert.equal(record.source.outputDigest, `sha256:${crypto.createHash("sha256").update(JSON.stringify("fake turn output")).digest("hex")}`);
  assert.equal(validateGoalTaskAcceptanceRecord(record).ok, true);
  const restarted = await new GoalStore().get(f.workspace, f.goalId);
  assert.equal(restarted.workItems![0]!.status, "done");
  assert.deepEqual(restarted.taskAcceptances, [record]);
  assert.equal(restarted.updatedAt, record.decidedAt);
  const persisted = JSON.parse(await fs.readFile(path.join(f.workspace, ".roleweave", "goals", f.goalId, "goal.json"), "utf8"));
  assert.equal(persisted.workItems[0].status, "done");
  assert.equal(persisted.taskAcceptances[0].acceptanceId, record.acceptanceId);
  const listed = await f.call("/goals");
  assert.equal("taskAcceptances" in (listed.body as { goals: object[] }).goals[0]!, false);
});

test("reject keeps a reason and review status; payload-bound retries replay one durable decision", async t => {
  const f = await fixture(t);
  const rejected: GoalTaskAcceptanceCreateRequest = { ...f.request(), decision: "rejected", verdicts: [{ criteriaIndex: 1, passed: false }], note: "Reproduction evidence is missing" };
  const [first, replay] = await Promise.all([f.call(f.acceptanceUrl, "POST", rejected), f.call(f.acceptanceUrl, "POST", rejected)]);
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  let stored = await f.server.ctx.goalStore.get(f.workspace, f.goalId);
  assert.equal(stored.taskAcceptances!.length, 1);
  assert.equal(stored.workItems![0]!.status, "review");
  assert.equal((await f.call(f.acceptanceUrl, "POST", { ...rejected, note: "Different reason" })).status, 409);
  assert.equal((await f.call(`${f.goalUrl}/tasks/manual/acceptance`, "POST", rejected)).status, 409);
  const accepted = { ...f.request(), expectedUpdatedAt: stored.updatedAt };
  assert.equal((await f.call(f.acceptanceUrl, "POST", accepted)).status, 200);
  stored = await f.server.ctx.goalStore.get(f.workspace, f.goalId);
  assert.equal(stored.taskAcceptances!.length, 2);
  assert.equal(stored.workItems![0]!.status, "done");
  // A historical replay neither erases the later acceptance nor flips status back.
  assert.deepEqual((await f.call(f.acceptanceUrl, "POST", rejected)).body, first.body);
  assert.equal((await f.server.ctx.goalStore.get(f.workspace, f.goalId)).workItems![0]!.status, "done");
});

test("stale plan, output, turn, session and workspace cannot accept another delivery", async t => {
  const f = await fixture(t);
  const body = f.request();
  assert.equal((await f.call(f.goalUrl, "PATCH", { acceptanceCriteria: ["A changed requirement"] })).status, 200);
  assert.equal((await f.call(f.acceptanceUrl, "POST", body)).status, 409);
  const current = await f.server.ctx.goalStore.get(f.workspace, f.goalId);
  const fresh = { ...body, expectedUpdatedAt: current.updatedAt, verdicts: [{ criteriaIndex: 0, passed: true }] };
  for (const source of [
    { ...body.source, outputDigest: `sha256:${"0".repeat(64)}` },
    { ...body.source, turnId: "nonexistent-turn" },
    { ...body.source, sessionId: crypto.randomUUID() },
    { ...body.source, positionId: "release-engineer" },
  ]) assert.equal((await f.call(f.acceptanceUrl, "POST", { ...fresh, source })).status, 409);
  assert.equal((await f.call(f.acceptanceUrl, "POST", { ...fresh, expectedWorkspacePath: `${f.workspace}-other` })).status, 409);
  assert.equal((await f.call(`${f.goalUrl}/tasks/manual/acceptance`, "POST", fresh)).status, 409);
  assert.equal((await f.server.ctx.goalStore.get(f.workspace, f.goalId)).taskAcceptances, undefined);
});

test("only authenticated operator input with every accepted criterion or a rejection reason is permitted", async t => {
  const f = await fixture(t);
  const body = f.request();
  assert.equal((await f.call(f.acceptanceUrl, "POST", body, null)).status, 401);
  assert.equal((await f.call(f.acceptanceUrl, "POST", body, "wrong-token")).status, 401);
  for (const extra of [{ decidedBy: "operator" }, { decidedAt: new Date().toISOString() }, { spaceId: "imaginary-space" }, { acceptanceId: "forged" }]) {
    assert.equal((await f.call(f.acceptanceUrl, "POST", { ...body, ...extra })).status, 400);
  }
  assert.equal((await f.call(f.acceptanceUrl, "POST", { ...body, verdicts: [{ criteriaIndex: 0, passed: true }] })).status, 400);
  assert.equal((await f.call(f.acceptanceUrl, "POST", { ...body, verdicts: [{ criteriaIndex: 0, passed: true }, { criteriaIndex: 1, passed: false }] })).status, 400);
  assert.equal((await f.call(f.acceptanceUrl, "POST", { ...body, decision: "rejected", note: "   " })).status, 400);
  assert.equal((await f.call(f.acceptanceUrl, "POST", { ...body, source: { ...body.source, positionId: "outsider" } })).status, 403);
  assert.equal(validateGoalTaskAcceptanceCreateRequest({ ...body, verdicts: [{ criteriaIndex: 0, passed: true, evidencePath: "private/claim.txt" }] }).ok, false);
});

test("status PATCH cannot fabricate acceptance for any executed task while manual Done remains compatible", async t => {
  const f = await fixture(t);
  const patch = (taskId: string, status: string) => ({ expectedUpdatedAt: f.detail.goal.updatedAt,
    workItems: f.detail.goal.workItems!.map(item => item.taskId === taskId ? { ...item, status } : item) });
  assert.equal((await f.call(f.goalUrl, "PATCH", patch("task-one", "done"))).status, 409);
  assert.equal((await f.call(f.goalUrl, "PATCH", patch("manual", "done"))).status, 200);
  const updated = (await f.call(f.goalUrl)).body as GoalDetail;
  assert.equal(updated.goal.workItems!.find(item => item.taskId === "manual")!.status, "done");
  assert.equal(updated.goal.workItems!.find(item => item.taskId === "task-one")!.status, "todo");
  assert.equal((await f.call(f.acceptanceUrl, "POST", { ...f.request(), expectedUpdatedAt: updated.goal.updatedAt })).status, 200);
  const accepted = (await f.call(f.goalUrl)).body as GoalDetail;
  assert.equal((await f.call(f.goalUrl, "PATCH", { expectedUpdatedAt: accepted.goal.updatedAt, workItems: accepted.goal.workItems })).status, 200);
  assert.equal((await f.call(f.goalUrl, "PATCH", { acceptanceCriteria: ["New acceptance standard"] })).status, 200);
  const changed = (await f.call(f.goalUrl)).body as GoalDetail;
  assert.equal((await f.call(f.goalUrl, "PATCH", { expectedUpdatedAt: changed.goal.updatedAt, workItems: changed.goal.workItems })).status, 409);
});

test("legacy completed execution stays visible but requires a real session before human acceptance", async t => {
  const f = await fixture(t, false);
  assert.equal((await f.call("/turns", "POST", { positionId: "repo-owner", engine: "qoder", input: "Legacy run", goalId: f.goalId, branchId: "task-one" })).status, 200);
  const detail = (await f.call(f.goalUrl)).body as GoalDetail;
  assert.equal(detail.taskExecutions!["task-one"]!.status, "completed");
  assert.equal(detail.taskDeliveryUnavailable!["task-one"], "session_required");
  assert.equal(detail.taskDeliveries!["task-one"], undefined);
  assert.equal((await f.call(f.goalUrl, "PATCH", { expectedUpdatedAt: detail.goal.updatedAt,
    workItems: detail.goal.workItems!.map(item => item.taskId === "task-one" ? { ...item, status: "done" } : item) })).status, 409);
});

test("an atomic write failure leaves both the acceptance history and task status unchanged", async t => {
  const f = await fixture(t);
  const store = new GoalStore({ acceptanceWriteOperations: { ...nodeAtomicTurnWriteOperations,
    async rename() { throw new Error("injected pre-commit failure"); } } });
  await assert.rejects(store.acceptTask(f.workspace, f.goalId, "task-one", f.request(), "operator"), /atomic|commit|persist|rename/);
  const goal = await new GoalStore().get(f.workspace, f.goalId);
  assert.equal(goal.workItems![0]!.status, "todo");
  assert.equal(goal.taskAcceptances, undefined);
  assert.equal(goal.updatedAt, f.detail.goal.updatedAt);
});

test("a newer task attempt invalidates the reviewed output and a live task blocks the acceptance transaction", async t => {
  const f = await fixture(t);
  const old = f.request();
  assert.equal((await f.call(`/sessions/${f.sessionId}/turns`, "POST", {
    engine: "qoder", input: "Replace the first delivery", goalId: f.goalId, branchId: "task-one",
  })).status, 200);
  assert.equal((await f.call(f.acceptanceUrl, "POST", old)).status, 409);
  const detail = (await f.call(f.goalUrl)).body as GoalDetail;
  const fresh = { ...old, source: detail.taskDeliveries!["task-one"]!.source, expectedUpdatedAt: detail.goal.updatedAt };
  assert.notEqual(fresh.source.turnId, old.source.turnId);
  const reservation = f.server.ctx.runningTurns.reserve(f.workspace, "repo-owner", "held-turn");
  try { assert.equal((await f.call(f.acceptanceUrl, "POST", fresh)).status, 409); }
  finally { reservation.release(); }
  assert.equal((await f.call(f.acceptanceUrl, "POST", fresh)).status, 200);
});

test("unavailable execution evidence never opens a manual Done or human acceptance bypass", async t => {
  const f = await fixture(t);
  const store = new GoalStore({ async readTurns() { throw new Error("execution storage unavailable"); } });
  await assert.rejects(store.acceptTask(f.workspace, f.goalId, "task-one", f.request(), "operator"), /unavailable/);
  await assert.rejects(store.update(f.workspace, f.goalId, { expectedUpdatedAt: f.detail.goal.updatedAt,
    workItems: f.detail.goal.workItems!.map(item => item.taskId === "task-one" ? { ...item, status: "done" } : item) }), /unavailable/);
  const detail = await store.getDetail(f.workspace, f.goalId);
  assert.equal(detail.executionUnavailable, true);
  assert.equal(detail.taskDeliveries, undefined);
  assert.equal(detail.goal.workItems![0]!.status, "todo");
});

test("empty criteria cannot be accepted; append-only decisions cannot be supplied through plan PATCH", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.goalUrl, "PATCH", { acceptanceCriteria: [] })).status, 200);
  const goal = await f.server.ctx.goalStore.get(f.workspace, f.goalId);
  assert.equal((await f.call(f.acceptanceUrl, "POST", { ...f.request(), expectedUpdatedAt: goal.updatedAt })).status, 400);
  assert.equal((await f.call(f.goalUrl, "PATCH", { taskAcceptances: [{ decision: "accepted" }] })).status, 400);
  assert.equal((await f.call(f.goalUrl, "PATCH", { expectedUpdatedAt: goal.updatedAt,
    workItems: goal.workItems!.map(item => item.taskId === "task-one" ? { ...item, status: "done" } : item), taskAcceptances: [] })).status, 400);
});

test("failed latest attempts and reassignment cannot reuse an older employee delivery", async t => {
  const f = await fixture(t);
  const original = f.request();
  f.server.ctx.turnDriver = { async turnRun(request) {
    const timestamp = new Date().toISOString();
    const runId = request.envelope.turnId;
    return { status: "trusted", diagnostic: "", events: [
      { type: "run.started", runId, timestamp },
      { type: "run.failed", runId, timestamp, error: { code: "fixture_failed", message: "No completed result", retryable: false, terminalReason: "engine_internal_error" } },
    ] };
  } };
  assert.equal((await f.call(`/sessions/${f.sessionId}/turns`, "POST", {
    engine: "qoder", input: "New attempt fails", goalId: f.goalId, branchId: "task-one",
  })).status, 200);
  const failed = (await f.call(f.goalUrl)).body as GoalDetail;
  assert.equal(failed.taskDeliveries!["task-one"], undefined);
  assert.equal(failed.taskDeliveryUnavailable!["task-one"], "execution_incomplete");
  assert.equal((await f.call(f.acceptanceUrl, "POST", { ...original, expectedUpdatedAt: failed.goal.updatedAt })).status, 409);
  assert.equal((await f.call(f.goalUrl, "PATCH", { expectedUpdatedAt: failed.goal.updatedAt,
    workItems: failed.goal.workItems!.map(item => item.taskId === "task-one" ? { ...item, assigneePositionId: "release-engineer" } : item) })).status, 200);
  const reassigned = (await f.call(f.goalUrl)).body as GoalDetail;
  assert.equal((await f.call(f.acceptanceUrl, "POST", { ...original, expectedUpdatedAt: reassigned.goal.updatedAt })).status, 409);
  assert.equal((await f.call(f.goalUrl, "PATCH", { expectedUpdatedAt: reassigned.goal.updatedAt,
    workItems: reassigned.goal.workItems!.map(item => item.taskId === "task-one" ? { ...item, status: "done" } : item) })).status, 409);
});

test("task delivery maps preserve reserved JavaScript property names without inherited phantom deliveries", async t => {
  const f = await fixture(t);
  const turns = await f.server.ctx.turnStore.reportRecords(f.workspace);
  const turn = turns.find(record => record.goalId === f.goalId)!;
  const goal = { ...f.detail.goal, workItems: [
    { ...f.detail.goal.workItems![0]!, taskId: "__proto__" },
    { ...f.detail.goal.workItems![0]!, taskId: "constructor" },
  ] };
  const projected = projectTaskDeliveries(goal, [{ ...turn, branchId: "__proto__" }]);
  assert.equal(Object.hasOwn(projected.taskDeliveries, "__proto__"), true);
  assert.equal(projected.taskDeliveries["__proto__"]!.source.turnId, turn.turnId);
  assert.equal(projected.taskDeliveries["constructor"], undefined);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(projected.taskDeliveries)), "__proto__"), true);
});

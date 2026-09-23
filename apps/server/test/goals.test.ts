import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { routes, validateGoal, validateGoalUpdateRequest, type Goal, type GoalActivity, type GoalDetail, type GoalWorkItem, type TurnRecord } from "@roleweave/shared";
import { GoalStore, projectTaskExecutions } from "../src/goals/store.js";
import { api, connectSse, copyExampleWorkspace, startTestServer } from "./helpers.js";

async function openWorkspace(baseUrl: string, token: string, dir: string): Promise<void> {
  const opened = await api(baseUrl, "/workspace/open", {
    method: "POST",
    token,
    body: { path: dir },
  });
  assert.equal(opened.status, 200);
}

async function createGoal(
  baseUrl: string,
  token: string,
  body: Record<string, unknown> = { title: "Ship v1.0", description: "Release the first stable version" },
): Promise<{ goalId: string }> {
  const created = await api(baseUrl, routes.goals, {
    method: "POST",
    token,
    body,
  });
  assert.equal(created.status, 201);
  return created.body as { goalId: string };
}

test("goal CRUD lifecycle: create, list, get with activity, update, delete", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);

    const { goalId } = await createGoal(server.baseUrl, server.token, {
      title: "Ship v1.0",
      description: "Release the first stable version",
      acceptanceCriteria: ["All tests pass", "Docs updated"],
    });
    assert.match(goalId, /^[a-f0-9-]{36}$/);

    const listed = await api(server.baseUrl, routes.goals, { token: server.token });
    assert.equal(listed.status, 200);
    const goals = (listed.body as { goals: Array<{ goalId: string; title: string }> }).goals;
    assert.equal(goals.length, 1);
    assert.equal(goals[0]!.goalId, goalId);
    assert.equal(goals[0]!.title, "Ship v1.0");

    const detail = await api(server.baseUrl, `${routes.goals}/${goalId}`, { token: server.token });
    assert.equal(detail.status, 200);
    const detailBody = detail.body as { goal: Goal; activity: GoalActivity[] };
    assert.equal(detailBody.goal.goalId, goalId);
    assert.equal(detailBody.goal.status, "open");
    assert.equal(detailBody.goal.health, "unknown");
    assert.deepEqual(detailBody.goal.acceptanceCriteria, ["All tests pass", "Docs updated"]);
    assert.equal(detailBody.activity.length, 1);
    assert.equal(detailBody.activity[0]!.kind, "created");

    const updated = await api(server.baseUrl, `${routes.goals}/${goalId}`, {
      method: "PATCH",
      token: server.token,
      body: { status: "in_progress" },
    });
    assert.equal(updated.status, 200);

    const afterUpdate = await api(server.baseUrl, `${routes.goals}/${goalId}`, { token: server.token });
    const afterBody = afterUpdate.body as { goal: Goal; activity: GoalActivity[] };
    assert.equal(afterBody.goal.status, "in_progress");
    assert.equal(afterBody.activity.length, 2);
    assert.equal(afterBody.activity[1]!.kind, "status_changed");

    const deleted = await api(server.baseUrl, `${routes.goals}/${goalId}`, {
      method: "DELETE",
      token: server.token,
    });
    assert.equal(deleted.status, 200);

    const afterDelete = await api(server.baseUrl, routes.goals, { token: server.token });
    assert.equal((afterDelete.body as { goals: unknown[] }).goals.length, 0);
  } finally {
    await server.close();
  }
});

test("goal create validation fails closed before any persistence", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);

    const bodies = [
      {},
      { title: "" },
      { title: "x".repeat(257) },
      { title: "ok", description: "x".repeat(4097) },
      { title: "ok", acceptanceCriteria: ["x".repeat(513)] },
      { title: "ok", acceptanceCriteria: Array.from({ length: 17 }, (_, i) => `c${i}`) },
      { title: "ok", extra: true },
    ];
    for (const body of bodies) {
      const response = await api(server.baseUrl, routes.goals, {
        method: "POST",
        token: server.token,
        body,
      });
      assert.equal(response.status, 400, `${JSON.stringify(body).slice(0, 60)} → ${response.status}`);
    }

    const listed = await api(server.baseUrl, routes.goals, { token: server.token });
    assert.equal((listed.body as { goals: unknown[] }).goals.length, 0);
  } finally {
    await server.close();
  }
});

test("goal status transitions enforce the allowed graph", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const { goalId } = await createGoal(server.baseUrl, server.token);

    const illegal = await api(server.baseUrl, `${routes.goals}/${goalId}`, {
      method: "PATCH",
      token: server.token,
      body: { status: "completed" },
    });
    assert.equal(illegal.status, 409);

    const valid = await api(server.baseUrl, `${routes.goals}/${goalId}`, {
      method: "PATCH",
      token: server.token,
      body: { status: "in_progress" },
    });
    assert.equal(valid.status, 200);

    const completed = await api(server.baseUrl, `${routes.goals}/${goalId}`, {
      method: "PATCH",
      token: server.token,
      body: { status: "completed" },
    });
    assert.equal(completed.status, 200);

    const illegalReopen = await api(server.baseUrl, `${routes.goals}/${goalId}`, {
      method: "PATCH",
      token: server.token,
      body: { status: "in_progress" },
    });
    assert.equal(illegalReopen.status, 409);
  } finally {
    await server.close();
  }
});

test("goal get returns 404 for missing or unsafe IDs", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);

    const missing = await api(server.baseUrl, `${routes.goals}/${"0".repeat(36)}`, { token: server.token });
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { code: string }).code, "goal_missing");

    const unsafe = await api(server.baseUrl, `${routes.goals}/..%2Fescape`, { token: server.token });
    assert.equal(unsafe.status, 404);
  } finally {
    await server.close();
  }
});

test("goal health auto-computes from bound turn records", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);

    const { goalId } = await createGoal(server.baseUrl, server.token, {
      title: "Health test",
      description: "Test health auto-computation",
      acceptanceCriteria: ["c1"],
    });

    await api(server.baseUrl, `${routes.goals}/${goalId}`, {
      method: "PATCH",
      token: server.token,
      body: { status: "in_progress" },
    });

    // Seed a turn record bound to this goal directly via the store.
    const turnStore = server.ctx.turnStore;
    const goalStore = server.ctx.goalStore;

    // No bound turns → health stays unknown.
    const beforeTurns = await api(server.baseUrl, `${routes.goals}/${goalId}`, { token: server.token });
    assert.equal((beforeTurns.body as { goal: Goal }).goal.health, "unknown");

    // Manually write a completed turn bound to this goal to test health computation.
    const fakeTurn: TurnRecord = {
      schemaVersion: "turn-record.v1",
      turnId: "test-turn-001",
      positionId: "repo-owner",
      conversationId: "test-conversation",
      input: "test input",
      engine: "qoder",
      status: "completed",
      envelopeDigest: "sha256-fake",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
      goalId,
    };

    // Write the turn record directly via the store's begin/complete cycle is complex;
    // instead we test computeHealthFromTurns directly.
    const { computeHealthFromTurns } = await import("../src/goals/store.js");
    const goal = (await goalStore.get(workspace, goalId));

    // No bound turns → unknown
    assert.equal(computeHealthFromTurns(goal, []), "unknown");

    // Completed turn (no branch match) → still unknown (no branch matched)
    assert.equal(computeHealthFromTurns(goal, [fakeTurn]), "unknown");

    // Create a goal with branches to test branch-based health
    const branchedGoal: Goal = {
      ...goal,
      branches: [{ branchId: "main", title: "main branch", status: "open", createdAt: goal.createdAt, updatedAt: goal.createdAt }],
    };

    // Completed turn on the branch → on_track
    const branchTurn: TurnRecord = { ...fakeTurn, branchId: "main" };
    assert.equal(computeHealthFromTurns(branchedGoal, [branchTurn]), "on_track");

    // Failed turn → at_risk
    const failedTurn: TurnRecord = { ...branchTurn, status: "failed" };
    assert.equal(computeHealthFromTurns(branchedGoal, [failedTurn]), "at_risk");

    // Indeterminate turn → at_risk
    const indeterminateTurn: TurnRecord = { ...branchTurn, status: "indeterminate" };
    assert.equal(computeHealthFromTurns(branchedGoal, [indeterminateTurn]), "at_risk");
  } finally {
    await server.close();
  }
});

test("goal SSE events fire on create, update, and delete", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  const sse = connectSse(server.baseUrl, server.token);
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);

    const { goalId } = await createGoal(server.baseUrl, server.token);
    const created = await sse.waitForEvent("goal.created");
    const createdPayload = (JSON.parse(created.data) as { payload: { goalId: string } }).payload;
    assert.equal(createdPayload.goalId, goalId);

    const beforeUpdate = sse.events.length;
    await api(server.baseUrl, `${routes.goals}/${goalId}`, {
      method: "PATCH",
      token: server.token,
      body: { title: "Updated title" },
    });
    const updated = await sse.waitForEvent("goal.updated");
    const updatedPayload = (JSON.parse(updated.data) as { payload: { goalId: string } }).payload;
    assert.equal(updatedPayload.goalId, goalId);
    assert.ok(sse.events.length > beforeUpdate, "update event must be new");

    const beforeDelete = sse.events.length;
    await api(server.baseUrl, `${routes.goals}/${goalId}`, {
      method: "DELETE",
      token: server.token,
    });
    // Wait for a new goal.updated event after the delete
    let deletedPayload: { goalId: string; deleted: boolean } | undefined;
    for (let i = 0; i < 50 && !deletedPayload; i += 1) {
      const newEvents = sse.events.slice(beforeDelete);
      const found = newEvents.find((e) => e.event === "goal.updated");
      if (found) {
        const parsed = JSON.parse(found.data) as { payload: { goalId: string; deleted?: boolean } };
        if (parsed.payload.deleted === true) {
          deletedPayload = parsed.payload as { goalId: string; deleted: boolean };
        }
      }
      if (!deletedPayload) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(deletedPayload, "delete event with deleted:true must arrive");
    assert.equal(deletedPayload!.goalId, goalId);
    assert.equal(deletedPayload!.deleted, true);
  } finally {
    sse.close();
    await server.close();
  }
});

const plannedTask: GoalWorkItem = {
  taskId: "board-task-1",
  title: "Implement the project board",
  description: "Persist the agreed plan and show real execution evidence",
  status: "todo",
  priority: "high",
  assigneePositionId: "repo-owner",
  startDate: "2028-02-28",
  dueDate: "2028-02-29",
};

test("work item validation accepts real date-only schedules and rejects malformed or unbounded plans", () => {
  const expectedUpdatedAt = "2026-09-22T00:00:00.000Z";
  assert.equal(validateGoalUpdateRequest({ workItems: [plannedTask], expectedUpdatedAt }).ok, true);
  const invalidItems = [
    { ...plannedTask, startDate: "2026-02-29" },
    { ...plannedTask, startDate: "2028-02-30" },
    { ...plannedTask, startDate: "2028-13-01" },
    { ...plannedTask, startDate: "0000-01-01" },
    { ...plannedTask, startDate: "2028-2-28" },
    { ...plannedTask, startDate: "2028-03-01" },
    { ...plannedTask, dueDate: "2028-02-27" },
    { ...plannedTask, taskId: "task/1" },
    { ...plannedTask, taskId: "x".repeat(65) },
    { ...plannedTask, title: " " },
    { ...plannedTask, title: "x".repeat(257) },
    { ...plannedTask, description: "x".repeat(4097) },
    { ...plannedTask, description: "bad\0text" },
    { ...plannedTask, assigneePositionId: "invalid position" },
    { ...plannedTask, status: "completed" },
    { ...plannedTask, priority: "urgent" },
    { ...plannedTask, injected: true },
  ];
  for (const item of invalidItems) {
    assert.equal(validateGoalUpdateRequest({ workItems: [item], expectedUpdatedAt }).ok, false, JSON.stringify(item).slice(0, 120));
  }
  assert.equal(validateGoalUpdateRequest({ workItems: [plannedTask, plannedTask], expectedUpdatedAt }).ok, false);
  assert.equal(validateGoalUpdateRequest({ workItems: Array.from({ length: 65 }, (_, i) => ({ ...plannedTask, taskId: `task-${i}` })), expectedUpdatedAt }).ok, false);
  assert.equal(validateGoalUpdateRequest({ workItems: [plannedTask] }).ok, false);
  assert.equal(validateGoalUpdateRequest({ expectedUpdatedAt }).ok, false);
  assert.equal(validateGoalUpdateRequest({ workItems: [], expectedUpdatedAt: "invalid" }).ok, false);
});

test("HTTP work item edits persist bounded plans across store reloads and preserve old goal files", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const { goalId } = await createGoal(server.baseUrl, server.token);
    const initial = await server.ctx.goalStore.get(workspace, goalId);
    assert.equal(initial.workItems, undefined);
    assert.equal(validateGoal(initial).ok, true, "existing goal.v1 files need no migration");
    const workItems = Array.from({ length: 64 }, (_, index) => ({ ...plannedTask, taskId: `task-${index}`, description: "任务说明".repeat(1024) }));
    const update = await api(server.baseUrl, `${routes.goals}/${goalId}`, {
      method: "PATCH", token: server.token, body: { workItems, expectedUpdatedAt: initial.updatedAt },
    });
    assert.equal(update.status, 200);
    const persisted = await new GoalStore().get(workspace, goalId);
    assert.deepEqual(persisted.workItems, workItems);
    assert.notEqual(persisted.updatedAt, initial.updatedAt);
    const listed = await api(server.baseUrl, routes.goals, { token: server.token });
    assert.equal(listed.status, 200);
    const summary = (listed.body as { goals: Record<string, unknown>[] }).goals[0]!;
    assert.equal(summary.goalId, goalId);
    assert.equal(Object.hasOwn(summary, "workItems"), false, "list responses must not include full task descriptions");
    const detail = await api(server.baseUrl, `${routes.goals}/${goalId}`, { token: server.token });
    assert.deepEqual((detail.body as GoalDetail).goal.workItems, workItems);
    const rejected = await api(server.baseUrl, `${routes.goals}/${goalId}`, {
      method: "PATCH", token: server.token, body: { workItems: [{ ...plannedTask, dueDate: "2026-02-30" }], expectedUpdatedAt: persisted.updatedAt },
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await new GoalStore().get(workspace, goalId), persisted, "invalid plan leaves saved state unchanged");
  } finally {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("concurrent board edits return 409 without losing the winning edit", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const { goalId } = await createGoal(server.baseUrl, server.token);
    const initial = await server.ctx.goalStore.get(workspace, goalId);
    const results = await Promise.all(["First editor", "Second editor"].map((title) => api(server.baseUrl, `${routes.goals}/${goalId}`, {
      method: "PATCH", token: server.token,
      body: { workItems: [{ ...plannedTask, title }], expectedUpdatedAt: initial.updatedAt },
    })));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    const winner = results[0]!.status === 200 ? "First editor" : "Second editor";
    const saved = await server.ctx.goalStore.get(workspace, goalId);
    assert.equal(saved.workItems?.[0]?.title, winner);
    const unguarded = await api(server.baseUrl, `${routes.goals}/${goalId}`, {
      method: "PATCH", token: server.token, body: { workItems: [] },
    });
    assert.equal(unguarded.status, 400);
    assert.equal((await server.ctx.goalStore.get(workspace, goalId)).updatedAt, saved.updatedAt);
  } finally {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("board revisions advance even when edits share one millisecond", async () => {
  const workspace = await copyExampleWorkspace();
  try {
    const store = new GoalStore();
    const now = "2026-09-22T01:00:00.000Z";
    const goal = await store.create(workspace, { title: "Revision test", description: "Concurrent board revisions" }, now);
    const saved = await store.update(workspace, goal.goalId, { workItems: [plannedTask], expectedUpdatedAt: goal.updatedAt }, now);
    assert.notEqual(saved.updatedAt, goal.updatedAt);
    await assert.rejects(store.update(workspace, goal.goalId, { workItems: [], expectedUpdatedAt: goal.updatedAt }, now), { status: 409 });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("HTTP task execution preserves goal and task binding and never marks the human plan done", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const { goalId } = await createGoal(server.baseUrl, server.token);
    const initial = await server.ctx.goalStore.get(workspace, goalId);
    await server.ctx.goalStore.update(workspace, goalId, { workItems: [plannedTask], expectedUpdatedAt: initial.updatedAt });
    const executed = await api(server.baseUrl, "/turns", {
      method: "POST", token: server.token,
      body: { positionId: "repo-owner", input: "Implement the planned board task", engine: "qoder", goalId, branchId: plannedTask.taskId },
    });
    assert.equal(executed.status, 200);
    const record = executed.body as TurnRecord;
    assert.equal(record.goalId, goalId);
    assert.equal(record.branchId, plannedTask.taskId);
    const detail = (await api(server.baseUrl, `${routes.goals}/${goalId}`, { token: server.token })).body as GoalDetail;
    assert.deepEqual(detail.taskExecutions?.[plannedTask.taskId], {
      turnId: record.turnId, positionId: "repo-owner", status: "completed", startedAt: record.createdAt, completedAt: record.updatedAt,
    });
    assert.equal(detail.goal.workItems?.[0]?.status, "todo");
    const diskTurns = await server.ctx.turnStore.reportRecords(workspace);
    assert.equal(diskTurns.find((turn) => turn.turnId === record.turnId)?.branchId, plannedTask.taskId);
  } finally {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("execution projection picks the latest matching attempt and excludes other goals, tasks and assignees", () => {
  const now = "2026-09-22T00:00:00.000Z";
  const goal: Goal = { schemaVersion: "goal.v1", goalId: "goal-1", title: "Project", description: "Plan", status: "open", health: "unknown", acceptanceCriteria: [], branches: [], workItems: [plannedTask], createdAt: now, updatedAt: now };
  const base: TurnRecord = { schemaVersion: "turn-record.v1", turnId: "older", positionId: "repo-owner", conversationId: "conversation", engine: "qoder", input: "Task", status: "completed", envelopeDigest: "digest", createdAt: now, updatedAt: "2026-09-22T04:00:00.000Z", events: [], goalId: goal.goalId, branchId: plannedTask.taskId };
  const newest: TurnRecord = { ...base, turnId: "newest", status: "running", createdAt: "2026-09-22T01:00:00.000Z", updatedAt: "2026-09-22T01:00:00.000Z" };
  const later = { ...base, createdAt: "2026-09-22T02:00:00.000Z" };
  const projection = projectTaskExecutions(goal, [base, newest,
    { ...later, goalId: "other-goal" }, { ...later, branchId: "other-task" }, { ...later, positionId: "reviewer" },
  ], () => true);
  assert.deepEqual(projection, { [plannedTask.taskId]: { turnId: "newest", positionId: "repo-owner", status: "running", startedAt: newest.createdAt } });
  assert.deepEqual(projectTaskExecutions({ ...goal, workItems: [{ ...plannedTask, assigneePositionId: undefined }] }, [base]), {});
});

test("HTTP execution status requires an exact live reservation and does not rewrite orphaned turn records", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const { goalId } = await createGoal(server.baseUrl, server.token);
    const goal = await server.ctx.goalStore.get(workspace, goalId);
    await server.ctx.goalStore.update(workspace, goalId, { workItems: [plannedTask], expectedUpdatedAt: goal.updatedAt });
    const record = await server.ctx.turnStore.begin({ workspace, positionId: "repo-owner", turnId: "orphaned-board-turn", engine: "qoder", message: "planned task", envelopeDigest: `sha256:${"a".repeat(64)}`, now: "2026-09-22T00:00:00.000Z", goalId, branchId: plannedTask.taskId });
    const readExecution = async () => {
      const result = await api(server.baseUrl, `${routes.goals}/${goalId}`, { token: server.token });
      assert.equal(result.status, 200);
      return (result.body as GoalDetail).taskExecutions?.[plannedTask.taskId];
    };
    const orphan = await readExecution();
    assert.equal(orphan?.status, "indeterminate");
    assert.equal(orphan?.completedAt, undefined, "unknown end time must not be invented");
    const other = server.ctx.runningTurns.reserve(workspace, "repo-owner", "different-turn");
    try { assert.equal((await readExecution())?.status, "indeterminate"); } finally { other.release(); }
    const actual = server.ctx.runningTurns.reserve(workspace, "repo-owner", record.turnId);
    try { assert.equal((await readExecution())?.status, "running"); } finally { actual.release(); }
    assert.equal((await server.ctx.turnStore.reportRecords(workspace))[0]?.status, "running", "read projection must not mutate execution history");
  } finally {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("health refresh preserves concurrent task edits and list consistency without hiding unavailable execution evidence", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const { goalId } = await createGoal(server.baseUrl, server.token);
    const goal = await server.ctx.goalStore.get(workspace, goalId);
    const branched = { ...goal, workItems: [plannedTask], health: "on_track", branches: [{ branchId: "main", title: "Main", status: "open", createdAt: goal.createdAt, updatedAt: goal.updatedAt }] };
    const file = path.join(workspace, ".roleweave", "goals", goalId, "goal.json");
    await fs.writeFile(file, JSON.stringify(branched));
    const changedTask = { ...plannedTask, title: "Edited task title" };
    const [refreshed, staleEdit] = await Promise.allSettled([
      server.ctx.goalStore.getDetail(workspace, goalId, []),
      server.ctx.goalStore.update(workspace, goalId, { workItems: [changedTask], expectedUpdatedAt: goal.updatedAt }),
    ]);
    assert.equal(refreshed.status, "fulfilled");
    assert.equal(staleEdit.status, "rejected");
    if (staleEdit.status === "rejected") assert.equal(staleEdit.reason.status, 409);
    const projected = await server.ctx.goalStore.getDetail(workspace, goalId, []);
    assert.equal(projected.goal.health, "unknown");
    assert.notEqual(projected.goal.updatedAt, goal.updatedAt);
    assert.equal(projected.activity.length, 2);
    assert.deepEqual(projected.goal.workItems, [plannedTask]);
    const edited = await server.ctx.goalStore.update(workspace, goalId, { workItems: [changedTask], expectedUpdatedAt: projected.goal.updatedAt });
    const detail = await server.ctx.goalStore.getDetail(workspace, goalId, []);
    const listed = await server.ctx.goalStore.list(workspace);
    assert.equal(listed[0]?.health, detail.goal.health);
    assert.deepEqual(detail.goal.workItems, [changedTask]);
    assert.equal(detail.goal.updatedAt, edited.updatedAt, "unchanged health must not invalidate the revision");
    const before = await fs.readFile(file, "utf8");
    const collision = { ...plannedTask, taskId: "main" };
    assert.equal(validateGoal({ ...branched, workItems: [collision] }).ok, false);
    const collided = await api(server.baseUrl, `${routes.goals}/${goalId}`, {
      method: "PATCH", token: server.token, body: { workItems: [collision], expectedUpdatedAt: edited.updatedAt },
    });
    assert.equal(collided.status, 400);
    assert.equal(await fs.readFile(file, "utf8"), before);
    server.ctx.turnStore.reportRecords = async () => { throw new Error("execution evidence unavailable"); };
    const response = await api(server.baseUrl, `${routes.goals}/${goalId}`, { token: server.token });
    assert.equal(response.status, 200);
    assert.equal((response.body as GoalDetail).executionUnavailable, true);
    assert.equal((response.body as GoalDetail).taskExecutions, undefined);
  } finally {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

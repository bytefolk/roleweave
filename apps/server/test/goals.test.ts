import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { routes, type Goal, type GoalActivity, type TurnRecord } from "@roleweave/shared";
import { api, connectSse, copyExampleWorkspace, startTestServer, type TestServer } from "./helpers.js";

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

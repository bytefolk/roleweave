import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Goal, TurnRecord } from "@roleweave/shared";
import { layaEnabled } from "../src/laya/config.js";
import { askLaya } from "../src/laya/client.js";
import { computeHealthFromTurns, GoalStore, resolveGoalHealth, resolveLayaHealthOverlay } from "../src/goals/store.js";

function branchedGoal(): Goal {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: "goal.v1",
    goalId: "goal-1",
    title: "Ship",
    description: "Ship it",
    acceptanceCriteria: [],
    status: "in_progress",
    health: "unknown",
    branches: [{ branchId: "main", title: "main", status: "open", createdAt: now, updatedAt: now }],
    createdAt: now,
    updatedAt: now,
  };
}

function turn(status: TurnRecord["status"]): TurnRecord {
  return {
    schemaVersion: "turn-record.v1",
    turnId: `turn-${status}`,
    positionId: "repo-owner",
    conversationId: "c1",
    input: "do the work",
    engine: "qoder",
    status,
    envelopeDigest: "sha256-fake",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    events: [],
    goalId: "goal-1",
    branchId: "main",
    ...(status === "failed"
      ? { error: { code: "engine_internal_error", message: "boom", retryable: false } }
      : {}),
  };
}

test("layaEnabled remains explicit opt-in for local inference", () => {
  assert.equal(layaEnabled({}), false);
  assert.equal(layaEnabled({ ROLEWEAVE_LAYA_ENABLED: "" }), false);
  assert.equal(layaEnabled({ ROLEWEAVE_LAYA_ENABLED: "0" }), false);
  assert.equal(layaEnabled({ ROLEWEAVE_LAYA_ENABLED: "false" }), false);
  assert.equal(layaEnabled({ ROLEWEAVE_LAYA_ENABLED: "1" }), true);
  assert.equal(layaEnabled({ ROLEWEAVE_LAYA_ENABLED: "true" }), true);
  assert.equal(layaEnabled({ ROLEWEAVE_LAYA_ENABLED: "YES" }), true);
});

test("askLaya returns null when disabled or local service is unavailable", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("network should not run");
  };
  assert.equal(await askLaya({ state: "x", questions: { a: { type: "noul", instructions: "y" } } }, { env: {}, fetchImpl }), null);
  assert.equal(
    await askLaya(
      { state: "x", questions: { a: { type: "noul", instructions: "y" } } },
      { env: { ROLEWEAVE_LAYA_ENABLED: "1" }, fetchImpl },
    ),
    null,
  );
});

test("askLaya posts a System One payload and returns typed answers", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({
        answers: {
          health: {
            type: "choice",
            selected: "blocked",
            probabilities: { on_track: 0.05, at_risk: 0.2, blocked: 0.7, unknown: 0.05 },
            confidence: 0.81,
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const result = await askLaya(
    {
      state: { summary: "turns failed with permission errors" },
      questions: {
        health: {
          type: "choice",
          instructions: "Classify goal health",
          criteria: { on_track: "advancing", at_risk: "failing", blocked: "stuck", unknown: "not enough" },
        },
      },
    },
    {
      env: {
        ROLEWEAVE_LAYA_ENABLED: "1",
        ROLEWEAVE_LAYA_URL: "http://127.0.0.1:18081/v1/systemone",
      },
      fetchImpl,
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://127.0.0.1:18081/v1/systemone");
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("authorization"), null);
  assert.equal(result?.health?.type, "choice");
  if (result?.health?.type === "choice") assert.equal(result.health.selected, "blocked");
});

test("askLaya returns null when the HTTP call fails or times out", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("timeout");
  };
  assert.equal(
    await askLaya(
      { state: "x", questions: { a: { type: "noul", instructions: "y" } } },
      { env: { ROLEWEAVE_LAYA_ENABLED: "1" }, fetchImpl },
    ),
    null,
  );
});

test("resolveGoalHealth keeps the heuristic when Laya is off", async () => {
  const goal = branchedGoal();
  const failed = turn("failed");
  assert.equal(computeHealthFromTurns(goal, [failed]), "at_risk");
  assert.equal(await resolveGoalHealth(goal, [failed], { env: {} }), "at_risk");
  assert.equal(await resolveGoalHealth(goal, [turn("completed")], { env: {} }), "on_track");
});

test("resolveGoalHealth stays on the heuristic when Laya is enabled", async () => {
  const goal = branchedGoal();
  const failed = turn("failed");
  assert.equal(
    await resolveGoalHealth(goal, [failed], {
      env: { ROLEWEAVE_LAYA_ENABLED: "1" },
      log: () => {},
      ask: async () => ({
        health: {
          type: "choice",
          selected: "blocked",
          probabilities: { blocked: 1 },
          confidence: 0.9,
        },
      }),
    }),
    "at_risk",
  );
});

test("resolveLayaHealthOverlay returns a Choice without sending turn bodies", async () => {
  const goal = branchedGoal();
  const failed = { ...turn("failed"), input: "secret prompt", output: "secret tool payload" };
  let seen: unknown;
  const overlay = await resolveLayaHealthOverlay(goal, [failed], {
    env: { ROLEWEAVE_LAYA_ENABLED: "1" },
    log: () => {},
    ask: async (request) => {
      seen = request;
      return {
        health: {
          type: "choice",
          selected: "blocked",
          probabilities: { blocked: 1 },
          confidence: 0.9,
        },
      };
    },
  });
  assert.equal(overlay, "blocked");
  assert.equal(computeHealthFromTurns(goal, [failed]), "at_risk");
  const turns = (seen as { state: { turns: Array<Record<string, unknown>> } }).state.turns;
  assert.equal(turns.length, 1);
  assert.deepEqual(Object.keys(turns[0]!).sort(), ["errorCode", "status"]);
  assert.equal(turns[0]!.status, "failed");
  assert.equal(turns[0]!.errorCode, "engine_internal_error");
  assert.equal("input" in turns[0]!, false);
  assert.equal("output" in turns[0]!, false);
  const serialized = JSON.stringify(seen);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("do the work"), false);
});

test("resolveLayaHealthOverlay does not let on_track or an invalid option clear failed/indeterminate", async () => {
  const goal = branchedGoal();
  const failed = turn("failed");
  const enabled = { env: { ROLEWEAVE_LAYA_ENABLED: "1" }, log: () => {} };
  assert.equal(
    await resolveLayaHealthOverlay(goal, [failed], {
      ...enabled,
      ask: async () => ({
        health: { type: "choice", selected: "on_track", probabilities: { on_track: 1 }, confidence: 1 },
      }),
    }),
    null,
  );
  assert.equal(
    await resolveLayaHealthOverlay(goal, [turn("indeterminate")], {
      ...enabled,
      ask: async () => ({
        health: { type: "choice", selected: "unknown", probabilities: { unknown: 1 }, confidence: 1 },
      }),
    }),
    null,
  );
  assert.equal(
    await resolveLayaHealthOverlay(goal, [failed], {
      ...enabled,
      ask: async () => ({
        health: { type: "choice", selected: "external", probabilities: { external: 1 }, confidence: 1 },
      }),
    }),
    null,
  );
});

test("resolveLayaHealthOverlay falls back to null when Laya throws or returns an invalid option", async () => {
  const goal = branchedGoal();
  const failed = turn("failed");
  assert.equal(
    await resolveLayaHealthOverlay(goal, [failed], {
      env: { ROLEWEAVE_LAYA_ENABLED: "1" },
      log: () => {},
      ask: async () => {
        throw new Error("boom");
      },
    }),
    null,
  );
  assert.equal(
    await resolveLayaHealthOverlay(goal, [failed], {
      env: { ROLEWEAVE_LAYA_ENABLED: "1" },
      log: () => {},
      ask: async () => ({ health: { type: "choice", selected: "not-a-status", probabilities: {}, confidence: 0 } }),
    }),
    null,
  );
});

test("getDetail persists heuristic health and exposes Laya only as healthOverlay", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "rw-laya-goal-"));
  try {
    const store = new GoalStore();
    const created = await store.create(workspace, { title: "Ship", description: "desc" });
    const stored = await store.get(workspace, created.goalId);
    const branched: Goal = {
      ...stored,
      branches: [{ branchId: "main", title: "main", status: "open", createdAt: stored.createdAt, updatedAt: stored.updatedAt }],
    };
    await fs.writeFile(
      path.join(workspace, ".roleweave", "goals", created.goalId, "goal.json"),
      JSON.stringify(branched),
    );
    const failed: TurnRecord = { ...turn("failed"), goalId: created.goalId };
    const layaOn = {
      env: { ROLEWEAVE_LAYA_ENABLED: "1" },
      log: () => {},
    };

    const overlay = await store.getDetail(workspace, created.goalId, [failed], undefined, {
      ...layaOn,
      ask: async () => ({
        health: { type: "choice", selected: "blocked", probabilities: { blocked: 1 }, confidence: 0.9 },
      }),
    });
    assert.equal(overlay.goal.health, "at_risk");
    assert.equal(overlay.healthOverlay, "blocked");
    assert.equal((await store.get(workspace, created.goalId)).health, "at_risk");

    const cleared = await store.getDetail(workspace, created.goalId, [failed], undefined, {
      ...layaOn,
      ask: async () => ({
        health: { type: "choice", selected: "on_track", probabilities: { on_track: 1 }, confidence: 1 },
      }),
    });
    assert.equal(cleared.goal.health, "at_risk");
    assert.equal(cleared.healthOverlay, undefined);
    assert.equal((await store.get(workspace, created.goalId)).health, "at_risk");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

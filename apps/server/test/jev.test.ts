import assert from "node:assert/strict";
import test from "node:test";
import type { Goal, TurnRecord } from "@roleweave/shared";
import { jevEnabled } from "../src/jev/config.js";
import { askJev } from "../src/jev/client.js";
import { computeHealthFromTurns, resolveGoalHealth, resolveJevHealthOverlay } from "../src/goals/store.js";

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

test("jevEnabled is off unless ROLEWEAVE_JEV_ENABLED is a truthy flag", () => {
  assert.equal(jevEnabled({}), false);
  assert.equal(jevEnabled({ ROLEWEAVE_JEV_ENABLED: "" }), false);
  assert.equal(jevEnabled({ ROLEWEAVE_JEV_ENABLED: "0" }), false);
  assert.equal(jevEnabled({ ROLEWEAVE_JEV_ENABLED: "false" }), false);
  assert.equal(jevEnabled({ ROLEWEAVE_JEV_ENABLED: "1" }), true);
  assert.equal(jevEnabled({ ROLEWEAVE_JEV_ENABLED: "true" }), true);
  assert.equal(jevEnabled({ ROLEWEAVE_JEV_ENABLED: "YES" }), true);
});

test("askJev returns null when disabled or unconfigured, without fetching", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("network should not run");
  };
  assert.equal(await askJev({ state: "x", questions: { a: { type: "noul", instructions: "y" } } }, { env: {}, fetchImpl }), null);
  assert.equal(
    await askJev(
      { state: "x", questions: { a: { type: "noul", instructions: "y" } } },
      { env: { ROLEWEAVE_JEV_ENABLED: "1" }, fetchImpl },
    ),
    null,
  );
});

test("askJev posts a System One payload and returns typed answers", async () => {
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

  const result = await askJev(
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
        ROLEWEAVE_JEV_ENABLED: "1",
        ROLEWEAVE_JEV_API_KEY: "test-key",
        ROLEWEAVE_JEV_URL: "https://api.typesafe.ai/v1/systemone",
      },
      fetchImpl,
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.typesafe.ai/v1/systemone");
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("authorization"), "Bearer test-key");
  assert.equal(result?.health?.type, "choice");
  if (result?.health?.type === "choice") assert.equal(result.health.selected, "blocked");
});

test("askJev returns null when the HTTP call fails or times out", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("timeout");
  };
  assert.equal(
    await askJev(
      { state: "x", questions: { a: { type: "noul", instructions: "y" } } },
      { env: { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" }, fetchImpl },
    ),
    null,
  );
});

test("resolveGoalHealth keeps the heuristic when Jev is off", async () => {
  const goal = branchedGoal();
  const failed = turn("failed");
  assert.equal(computeHealthFromTurns(goal, [failed]), "at_risk");
  assert.equal(await resolveGoalHealth(goal, [failed], { env: {} }), "at_risk");
  assert.equal(await resolveGoalHealth(goal, [turn("completed")], { env: {} }), "on_track");
});

test("resolveGoalHealth stays on the heuristic when Jev is enabled", async () => {
  const goal = branchedGoal();
  const failed = turn("failed");
  assert.equal(
    await resolveGoalHealth(goal, [failed], {
      env: { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" },
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

test("resolveJevHealthOverlay returns a Choice without sending turn bodies", async () => {
  const goal = branchedGoal();
  const failed = turn("failed");
  let seen: unknown;
  const overlay = await resolveJevHealthOverlay(goal, [failed], {
    env: { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" },
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
  assert.deepEqual(Object.keys(turns[0]!).sort(), ["errorCode", "status"]);
});

test("resolveJevHealthOverlay falls back to null when Jev throws or returns an invalid option", async () => {
  const goal = branchedGoal();
  const failed = turn("failed");
  assert.equal(
    await resolveJevHealthOverlay(goal, [failed], {
      env: { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" },
      log: () => {},
      ask: async () => {
        throw new Error("boom");
      },
    }),
    null,
  );
  assert.equal(
    await resolveJevHealthOverlay(goal, [failed], {
      env: { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" },
      log: () => {},
      ask: async () => ({ health: { type: "choice", selected: "not-a-status", probabilities: {}, confidence: 0 } }),
    }),
    "at_risk",
  );
});

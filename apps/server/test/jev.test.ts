import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Goal, TurnRecord } from "@roleweave/shared";
import { jevEnabled } from "../src/jev/config.js";
import { askJev } from "../src/jev/client.js";
import { computeHealthFromTurns, GoalStore, resolveGoalHealth, resolveJevHealthOverlay } from "../src/goals/store.js";
import {
  heuristicApprovalRisk,
  heuristicModelTier,
  overlayApprovalRisk,
  overlayDispatchPlan,
  overlayEscalation,
  overlayHireSuggest,
  overlayModelTier,
  overlayNextOwner,
  overlayRelayNext,
  overlaySecretSecondPass,
  overlayTurnPolicy,
  shouldAutoDispatch,
} from "../src/jev/judgments.js";

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
  const failed = { ...turn("failed"), input: "secret prompt", output: "secret tool payload" };
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

test("resolveJevHealthOverlay does not let on_track or an invalid option clear failed/indeterminate", async () => {
  const goal = branchedGoal();
  const failed = turn("failed");
  const enabled = { env: { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" }, log: () => {} };
  assert.equal(
    await resolveJevHealthOverlay(goal, [failed], {
      ...enabled,
      ask: async () => ({
        health: { type: "choice", selected: "on_track", probabilities: { on_track: 1 }, confidence: 1 },
      }),
    }),
    null,
  );
  assert.equal(
    await resolveJevHealthOverlay(goal, [turn("indeterminate")], {
      ...enabled,
      ask: async () => ({
        health: { type: "choice", selected: "unknown", probabilities: { unknown: 1 }, confidence: 1 },
      }),
    }),
    null,
  );
  assert.equal(
    await resolveJevHealthOverlay(goal, [failed], {
      ...enabled,
      ask: async () => ({
        health: { type: "choice", selected: "external", probabilities: { external: 1 }, confidence: 1 },
      }),
    }),
    null,
  );
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
    null,
  );
});

test("getDetail persists heuristic health and exposes Jev only as healthOverlay", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "rw-jev-goal-"));
  try {
    const store = new GoalStore();
    const created = await store.create(workspace, { title: "Ship", description: "desc" });
    const stored = await store.get(workspace, created.goalId);
    const branched: Goal = {
      ...stored,
      branches: [{ branchId: "main", title: "main", status: "open", createdAt: stored.createdAt, updatedAt: stored.updatedAt }],
    };
    await fs.writeFile(
      path.join(workspace, ".digital-employee", "workbench", "goals", created.goalId, "goal.json"),
      JSON.stringify(branched),
    );
    const failed: TurnRecord = { ...turn("failed"), goalId: created.goalId };
    const jevOn = {
      env: { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" },
      log: () => {},
    };

    const overlay = await store.getDetail(workspace, created.goalId, [failed], {
      ...jevOn,
      ask: async () => ({
        health: { type: "choice", selected: "blocked", probabilities: { blocked: 1 }, confidence: 0.9 },
      }),
    });
    assert.equal(overlay.goal.health, "at_risk");
    assert.equal(overlay.healthOverlay, "blocked");
    assert.equal((await store.get(workspace, created.goalId)).health, "at_risk");

    const cleared = await store.getDetail(workspace, created.goalId, [failed], {
      ...jevOn,
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

const jevOn = { env: { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" }, log: () => {} };

test("approval risk overlay is advisory and flag-off is null", async () => {
  const action = { kind: "exec" as const, description: "ls", target: "/tmp" };
  assert.equal(heuristicApprovalRisk("exec"), "high");
  assert.equal(await overlayApprovalRisk(action, { env: {}, log: () => {} }), null);
  assert.equal(
    await overlayApprovalRisk(action, {
      ...jevOn,
      ask: async () => ({ risk: { type: "score", score: 0.1, confidence: 0.9 } }),
    }),
    "low",
  );
});

test("escalation overlay classifies without replacing the row", async () => {
  assert.equal(await overlayEscalation({ status: "failed" }, { env: {}, log: () => {} }), null);
  const overlay = await overlayEscalation(
    { status: "failed", error: { code: "turn_budget_exceeded", message: "cap", retryable: false } },
    {
      ...jevOn,
      ask: async () => ({
        category: { type: "choice", selected: "budget", probabilities: { budget: 1 }, confidence: 1 },
        needsAttention: { type: "noul", probability: 0.2 },
      }),
    },
  );
  assert.deepEqual(overlay, { category: "budget", needsAttention: false });
});

test("hire suggest is null when Jev is off and validates budget when on", async () => {
  assert.equal(await overlayHireSuggest({ description: "docs" }, 10_000, { env: {}, log: () => {} }), null);
  const overlay = await overlayHireSuggest({ description: "write code" }, 10_000, {
    ...jevOn,
    ask: async () => ({
      tools: { type: "choice", selected: "edit", probabilities: { edit: 1 }, confidence: 1 },
      approval: { type: "noul", probability: 0.9 },
      perDay: { type: "score", score: 0.4, confidence: 0.8 },
    }),
  });
  assert.ok(overlay);
  assert.equal(overlay.mode, "approval_required");
  assert.deepEqual(overlay.tools, ["Read", "Grep", "Glob", "Edit", "Write"]);
  assert.ok(overlay.perTaskTokens <= overlay.perDayTokens);
  assert.ok(overlay.perDayTokens <= 10_000);
});

test("model tier keeps regex hits and only asks Jev for unknown slugs", async () => {
  assert.equal(heuristicModelTier("luna-fast"), "economy");
  assert.equal(heuristicModelTier("gpt-opus"), "powerful");
  assert.equal(heuristicModelTier("mystery-17"), "balanced");
  assert.equal(await overlayModelTier("luna-fast", "Luna", { env: {}, log: () => {} }), "economy");
  assert.equal(
    await overlayModelTier("mystery-17", "Mystery", {
      ...jevOn,
      ask: async () => ({
        tier: { type: "choice", selected: "powerful", probabilities: { powerful: 1 }, confidence: 1 },
      }),
    }),
    "powerful",
  );
});

test("turn policy and dispatch plan are null when Jev is off", async () => {
  assert.equal(await overlayTurnPolicy({ attachmentCount: 0, historyCount: 1, mode: "read_only" }, { env: {}, log: () => {} }), null);
  assert.equal(await overlayDispatchPlan(["a"], [{ id: "a", name: "A", mode: "read_only" }], { env: {}, log: () => {} }), null);
  assert.equal(shouldAutoDispatch({}), false);
  assert.equal(shouldAutoDispatch({ ROLEWEAVE_JEV_AUTO_DISPATCH: "1" }), false);
  assert.equal(shouldAutoDispatch({ ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_AUTO_DISPATCH: "1" }), true);
});

test("dispatch plan ranks members from per-member scores", async () => {
  const plan = await overlayDispatchPlan(
    ["a", "b"],
    [
      { id: "a", name: "A", mode: "read_only" },
      { id: "b", name: "B", mode: "approval_required" },
    ],
    {
      ...jevOn,
      ask: async () => ({
        mode: { type: "choice", selected: "relay", probabilities: { relay: 1 }, confidence: 1 },
        reviewer: { type: "noul", probability: 0.1 },
        fit_b: { type: "score", score: 0.9, confidence: 0.8 },
        fit_a: { type: "score", score: 0.2, confidence: 0.8 },
      }),
    },
  );
  assert.deepEqual(plan?.mentions, ["b", "a"]);
  assert.equal(plan?.mode, "relay");
});

test("relay next can STOP and next-owner stays a suggestion", async () => {
  assert.equal(await overlayRelayNext(["a", "b"], { status: "completed" }, { env: {}, log: () => {} }), null);
  assert.equal(
    await overlayRelayNext(["a", "b"], { status: "completed" }, {
      ...jevOn,
      ask: async () => ({
        next: { type: "choice", selected: "STOP", probabilities: { STOP: 1 }, confidence: 1 },
        complete: { type: "noul", probability: 0.9 },
      }),
    }),
    "STOP",
  );
  assert.equal(await overlayNextOwner(["reviewer"], { status: "completed", positionId: "a" }, { env: {}, log: () => {} }), null);
  const suggestion = await overlayNextOwner(["reviewer"], { status: "completed", positionId: "a" }, {
    ...jevOn,
    ask: async () => ({
      needed: { type: "noul", probability: 0.8 },
      who: { type: "choice", selected: "reviewer", probabilities: { reviewer: 1 }, confidence: 1 },
    }),
  });
  assert.deepEqual(suggestion, { positionId: "reviewer" });
});

test("secret second pass is off by default", async () => {
  assert.equal(await overlaySecretSecondPass("hello", { env: {}, log: () => {} }), false);
  assert.equal(
    await overlaySecretSecondPass("maybe-secret", {
      ...jevOn,
      ask: async () => ({ secret: { type: "noul", probability: 0.95 } }),
    }),
    true,
  );
});

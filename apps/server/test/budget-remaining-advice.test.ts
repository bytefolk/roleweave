import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import type {
  BudgetRemainingAdviceResponse,
  BudgetReport,
  ExperimentsResponse,
} from "@roleweave/shared";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";
import {
  parseBudgetRemainingChoice,
  projectBudgetRemainingFact,
  resolveBudgetRemainingChoice,
} from "../src/turns/budget-remaining-advice.js";
import { askLaya } from "../src/laya/client.js";

function budget(overrides: Partial<BudgetReport> = {}): BudgetReport {
  return {
    positionId: "repo-owner",
    declared: { perTask: { tokens: 100 }, perDay: { tokens: 500 } },
    recorded: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
    latestTurn: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
    state: "within",
    ...overrides,
  };
}

test("budget advice projects only the provable per-task remainder", () => {
  assert.deepEqual(projectBudgetRemainingFact("repo-owner", budget()), {
    positionId: "repo-owner",
    remainingPerTask: 60,
    remainingPerDay: null,
  });
});

test("budget advice never emits a negative remaining value", () => {
  assert.equal(projectBudgetRemainingFact("repo-owner", budget({
    latestTurn: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
    state: "exceeded",
  })).remainingPerTask, 0);
});

test("budget advice treats missing or invalid token operands as unknown", () => {
  for (const report of [
    budget({ declared: { perTask: {}, perDay: { tokens: 500 } } }),
    budget({ declared: { perTask: { tokens: Number.NaN }, perDay: { tokens: 500 } } }),
    budget({ latestTurn: { inputTokens: 0, outputTokens: 0, totalTokens: -1 } }),
  ]) {
    assert.equal(projectBudgetRemainingFact("repo-owner", report).remainingPerTask, null);
  }
});

test("budget advice sends only remaining facts and accepts the finite Choice", async () => {
  let outbound: unknown;
  const choice = await resolveBudgetRemainingChoice({
    positionId: "repo-owner",
    remainingPerTask: 60,
    remainingPerDay: 240,
  }, async request => {
    outbound = request;
    return {
      budgetAction: {
        type: "choice",
        selected: "shrink",
        confidence: 0.8,
        probabilities: { shrink: 0.8, switch_employee: 0.1, send_anyway: 0.1 },
      },
    };
  });

  assert.equal(choice, "shrink");
  assert.deepEqual((outbound as { state: unknown }).state, {
    remainingPerTask: 60,
    remainingPerDay: 240,
    positionId: "repo-owner",
  });
  assert.deepEqual(
    Object.keys((outbound as { questions: { budgetAction: { criteria: object } } }).questions.budgetAction.criteria),
    ["shrink", "switch_employee", "send_anyway"],
  );
});

test("budget advice abstains on malformed, incomplete, or uncertain Choices", () => {
  const valid = {
    type: "choice" as const,
    selected: "shrink",
    confidence: 0.8,
    probabilities: { shrink: 0.8, switch_employee: 0.1, send_anyway: 0.1 },
  };
  const invalid = [
    { ...valid, selected: "change_budget" },
    { ...valid, confidence: 0.59 },
    { ...valid, confidence: Number.NaN },
    { ...valid, probabilities: { shrink: 0.8, switch_employee: 0.2 } },
    { ...valid, probabilities: { ...valid.probabilities, injected: 0 } },
    { ...valid, probabilities: { ...valid.probabilities, send_anyway: Number.POSITIVE_INFINITY } },
    { ...valid, extra: "not allowed" },
  ];
  for (const answer of invalid) {
    assert.equal(parseBudgetRemainingChoice(answer as never), null);
  }
});

test("budget advice never invokes Laya for an unknown or invalid remainder", async () => {
  let calls = 0;
  const result = await resolveBudgetRemainingChoice({
    positionId: "repo-owner",
    remainingPerTask: Number.NaN,
    remainingPerDay: 240,
  }, async () => {
    calls += 1;
    return null;
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("budget advice rejects uncontracted fields in the raw Laya Choice", async () => {
  const answers = await askLaya({
    state: { remainingPerTask: 60, remainingPerDay: 240, positionId: "repo-owner" },
    questions: {
      budgetAction: {
        type: "choice",
        instructions: "Choose one action",
        criteria: { shrink: "shrink", switch_employee: "switch", send_anyway: "send" },
      },
    },
  }, {
    env: { ROLEWEAVE_LAYA_ENABLED: "1" },
    strictAnswerShape: true,
    fetchImpl: async () => new Response(JSON.stringify({
      answers: {
        budgetAction: {
          type: "choice",
          selected: "shrink",
          confidence: 0.8,
          probabilities: { shrink: 0.8, switch_employee: 0.1, send_anyway: 0.1 },
          execute: "not allowed",
        },
      },
    })),
  });

  assert.equal(parseBudgetRemainingChoice(answers?.budgetAction), null);
});

test("budget advice route rejects extra fields and missing or unknown positions", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    assert.equal((await api(server.baseUrl, "/workspace/open", {
      method: "POST", token: server.token, body: { path: dir },
    })).status, 200);
    const initial = (await api(server.baseUrl, `/experiments?workspacePath=${encodeURIComponent(dir)}`, {
      token: server.token,
    })).body as ExperimentsResponse;
    const scope = {
      workspacePath: initial.workspacePath,
      workspaceSession: initial.workspaceSession,
      revision: initial.revision,
    };

    for (const body of [
      { ...scope, positionId: "community-operator", input: "private draft" },
      scope,
      { ...scope, positionId: "missing-position" },
    ]) {
      assert.equal((await api(server.baseUrl, "/turns/budget-remaining-advice", {
        method: "POST", token: server.token, body,
      })).status, 400);
    }
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("budget advice route returns flag_off without reading or inferring budget advice", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    assert.equal((await api(server.baseUrl, "/workspace/open", {
      method: "POST", token: server.token, body: { path: dir },
    })).status, 200);
    const initial = (await api(server.baseUrl, `/experiments?workspacePath=${encodeURIComponent(dir)}`, {
      token: server.token,
    })).body as ExperimentsResponse;

    const response = await api(server.baseUrl, "/turns/budget-remaining-advice", {
      method: "POST",
      token: server.token,
      body: {
        workspacePath: initial.workspacePath,
        workspaceSession: initial.workspaceSession,
        revision: initial.revision,
        positionId: "community-operator",
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body as BudgetRemainingAdviceResponse, {
      workspacePath: initial.workspacePath,
      workspaceSession: initial.workspaceSession,
      revision: initial.revision,
      status: "disabled",
      reason: "flag_off",
      fact: {
        positionId: "community-operator",
        remainingPerTask: null,
        remainingPerDay: null,
      },
      suggestion: null,
    });
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("budget advice route abstains before inference when daily remaining is unknown", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    assert.equal((await api(server.baseUrl, "/workspace/open", {
      method: "POST", token: server.token, body: { path: dir },
    })).status, 200);
    const initial = (await api(server.baseUrl, `/experiments?workspacePath=${encodeURIComponent(dir)}`, {
      token: server.token,
    })).body as ExperimentsResponse;
    const enabled = (await api(server.baseUrl, "/experiments", {
      method: "PATCH",
      token: server.token,
      body: {
        workspacePath: initial.workspacePath,
        workspaceSession: initial.workspaceSession,
        revision: initial.revision,
        enabled: true,
      },
    })).body as ExperimentsResponse;

    const response = await api(server.baseUrl, "/turns/budget-remaining-advice", {
      method: "POST",
      token: server.token,
      body: {
        workspacePath: enabled.workspacePath,
        workspaceSession: enabled.workspaceSession,
        revision: enabled.revision,
        positionId: "community-operator",
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body as BudgetRemainingAdviceResponse, {
      workspacePath: enabled.workspacePath,
      workspaceSession: enabled.workspaceSession,
      revision: enabled.revision,
      status: "abstained",
      reason: "unknown_remaining",
      fact: {
        positionId: "community-operator",
        remainingPerTask: null,
        remainingPerDay: null,
      },
      suggestion: null,
    });
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

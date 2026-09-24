import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalContext } from "@roleweave/shared";
import { layaEnabled } from "../src/laya/config.js";
import {
  agingAgeMs,
  agingAdviceState,
  agingNeedsAttention,
  assertAgingAdvicePayload,
  attachApprovalAgingOverlay,
  mapAdviceChoiceToAging,
  presentAgingQueue,
  resolveApprovalAgingOverlay,
} from "../src/approvals/aging-overlay.js";

const now = Date.parse("2026-09-24T18:00:00.000Z");
const createdAt = "2026-09-01T00:00:00.000Z";
const baseContext: ApprovalContext = {
  risk: "high",
  requestedCapability: "exec",
  impact: "command_execution",
  permissions: { mode: "approval_required", allowedTools: [], deniedTools: [] },
  preview: { status: "unavailable", reason: "engine_preview_not_supplied" },
  scope: { allowed: ["once"] },
};

test("overlay cannot hide pending high items from the rule-risk layer", () => {
  const now = Date.parse("2026-09-24T18:00:00.000Z");
  const highPending = {
    id: "high-pending",
    createdAt: "2026-09-01T00:00:00.000Z",
    now,
    decision: { kind: "pending" as const },
    risk: "high" as const,
  };
  const mediumPending = {
    id: "medium-pending",
    createdAt: "2026-09-24T17:00:00.000Z",
    now,
    decision: { kind: "pending" as const },
    risk: "medium" as const,
  };

  const ranked = presentAgingQueue([mediumPending, highPending], {
    "high-pending": { choice: "wait", needsAttention: false },
    "medium-pending": { choice: "nudge", needsAttention: true },
  });

  const highIndex = ranked.findIndex((row) => row.id === "high-pending");
  const mediumIndex = ranked.findIndex((row) => row.id === "medium-pending");
  assert.notEqual(highIndex, -1, "pending high must remain visible when overlay says wait");
  assert.equal(ranked[highIndex]?.risk, "high");
  assert.ok(highIndex < mediumIndex, "pending high stays in the high rule-risk layer above medium");
});

test("aging clock is deterministic against createdAt and does not invent expiry", () => {
  assert.equal(agingAgeMs(createdAt, now), now - Date.parse(createdAt));
  assert.equal(agingNeedsAttention("wait"), false);
  assert.equal(agingNeedsAttention("nudge"), true);
});

test("aging payload rejects bodies outside { createdAt, now, decision.kind, risk }", () => {
  const payload = agingAdviceState({ createdAt, now, decisionKind: "pending", risk: "high" });
  assert.doesNotThrow(() => assertAgingAdvicePayload(payload));
  assert.throws(() => assertAgingAdvicePayload({ ...payload, description: "rm -rf" }));
  assert.throws(() => assertAgingAdvicePayload({ ...payload, target: "./secret" }));
  assert.deepEqual(Object.keys(payload).sort(), ["createdAt", "decision", "now", "risk"]);
  assert.deepEqual((payload.decision as { kind: string }), { kind: "pending" });
});

test("unknown Laya choice does not become an aging overlay", () => {
  assert.equal(mapAdviceChoiceToAging("deny"), null);
  assert.equal(mapAdviceChoiceToAging("discuss-close"), "discuss-close");
});

test("ROLEWEAVE_LAYA_ENABLED remains explicit opt-in", () => {
  assert.equal(layaEnabled({}), false);
});

test("flag off: no aging overlay and ask is not invoked", async () => {
  let called = false;
  const result = await attachApprovalAgingOverlay(baseContext, { createdAt, decisionKind: "pending" }, {
    env: {},
    now,
    ask: async () => {
      called = true;
      return { aging: { type: "choice", selected: "nudge", probabilities: {}, confidence: 1 } };
    },
  });
  assert.equal(called, false);
  assert.equal((result as ApprovalContext & { agingOverlay?: string }).agingOverlay, undefined);
  assert.equal(result.risk, "high");
});

test("expired items skip aging overlay so existing clock helpers remain authoritative", async () => {
  let called = false;
  const overlay = await resolveApprovalAgingOverlay(
    { createdAt, decisionKind: "expired", risk: "high" },
    {
      env: { ROLEWEAVE_LAYA_ENABLED: "1" },
      now,
      ask: async () => {
        called = true;
        return { aging: { type: "choice", selected: "discuss-close", probabilities: { "discuss-close": 1 }, confidence: 1 } };
      },
    },
  );
  assert.equal(called, false);
  assert.equal(overlay, undefined);
});

test("discuss-close is copy only and never posts a decision", async () => {
  let posted = 0;
  const attached = await attachApprovalAgingOverlay(baseContext, { createdAt, decisionKind: "pending" }, {
    env: { ROLEWEAVE_LAYA_ENABLED: "1" },
    now,
    ask: async (request) => {
      assertAgingAdvicePayload(request.state as Record<string, unknown>);
      return { aging: { type: "choice", selected: "discuss-close", probabilities: { "discuss-close": 1 }, confidence: 1 } };
    },
  });
  assert.equal((attached as ApprovalContext & { agingOverlay?: string }).agingOverlay, "discuss-close");
  assert.equal(attached.risk, "high");
  assert.equal(posted, 0);
});

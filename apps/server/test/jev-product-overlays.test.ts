import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReceiptEvent,
  applyRelayStopSuggestion,
  applySendGateSuggestion,
  approvalAgingAdvice,
  assertNoTurnBodies,
  budgetRemainingAdvice,
  deliveryPreflightItem,
  dismissHandoffAdvice,
  filterPendingHighItems,
  inFlightDuplicateAdvice,
  outboundPreflightJson,
  overlayCannotCancelRunning,
  overlayClickResolvesItem,
  readyHostAdvice,
  relayStopAdvice,
  sendTimeHumanGate,
} from "../src/jev/product-overlays.js";

test("#461 abstains without taskSummary and never implies a turn POST", () => {
  assert.equal(sendTimeHumanGate({ mode: "read_only" }).status, "abstain");
  assert.equal(sendTimeHumanGate({ mode: "read_only", taskSummary: "fix login" }).status, "suggest");
  const applied = applySendGateSuggestion();
  assert.equal(applied.postsTurn, false);
  assert.equal(applied.envelopeChanged, false);
});

test("#462 abstains when remaining unknown and cannot raise hire caps", () => {
  assert.equal(budgetRemainingAdvice({ remainingPerTask: null, remainingPerDay: 1, hirePerTask: 10, hirePerDay: 10 }).status, "abstain");
  assert.throws(() => budgetRemainingAdvice({ remainingPerTask: 99, remainingPerDay: 99, hirePerTask: 10, hirePerDay: 10 }));
  assert.equal(
    budgetRemainingAdvice({ remainingPerTask: 8, remainingPerDay: 8, hirePerTask: 10, hirePerDay: 10 }).status,
    "suggest",
  );
});

test("#463 keeps running facts and abstains matching without summary; no cancel", () => {
  const running = [{ positionId: "a", status: "running" }];
  const result = inFlightDuplicateAdvice({ running });
  assert.deepEqual(result.facts, running);
  assert.equal(result.advice.status, "abstain");
  assert.equal(result.canCancel, false);
  assert.equal(overlayCannotCancelRunning(), false);
});

test("#464 cannot skip dismiss confirm", () => {
  const result = dismissHandoffAdvice({
    candidates: [{ id: "b", name: "B", mode: "read_only" }],
    runningCount: 1,
    pendingApprovalCount: 0,
    boundGoalCount: 2,
  });
  assert.equal(result.canSkipConfirm, false);
  assert.equal(result.advice.status, "suggest");
});

test("#465 does not call Jev when zero or one ready host", () => {
  assert.equal(readyHostAdvice({ selectedReady: false, readyPositionIds: [] }).status, "abstain");
  assert.equal(readyHostAdvice({ selectedReady: false, readyPositionIds: ["only"] }).status, "abstain");
  assert.equal(readyHostAdvice({ selectedReady: false, readyPositionIds: ["a", "b"] }).status, "suggest");
});

test("#466 never hides pending high items", () => {
  const result = approvalAgingAdvice({
    createdAtMs: 0,
    nowMs: 3 * 86400_000,
    decisionKind: "pending",
    ruleRisk: "high",
    overlayNeedsAttention: false,
  });
  assert.equal(result.hidePendingHigh, false);
  const kept = filterPendingHighItems([
    { id: "keep", decisionKind: "pending", ruleRisk: "high" as const },
  ]);
  assert.equal(kept.length, 1);
});

test("#467 conflict or dangling id is undetermined and never overall pass", () => {
  const conflict = deliveryPreflightItem({ materialIds: ["m1"], versions: { m1: ["v1", "v2"] }, danglingIds: [] });
  assert.equal(conflict.status, "undetermined");
  assert.equal(conflict.overallPass, false);
  const dangling = deliveryPreflightItem({ materialIds: ["m1"], versions: {}, danglingIds: ["m1"] });
  assert.equal(dangling.status, "undetermined");
  const outbound = outboundPreflightJson(["chosen"], { chosen: "ok", UNIQUE_UNSELECTED_MARKER: "nope" });
  assert.equal(outbound.chosen, "ok");
  assert.equal(Object.prototype.hasOwnProperty.call(outbound, "UNIQUE_UNSELECTED_MARKER"), false);
});

test("#468 overlay click is not resolve; mixed events stay split", () => {
  assert.equal(overlayClickResolvesItem(), false);
  const afterClick = applyReceiptEvent([], "overlay_click");
  assert.deepEqual(afterClick.sort(), ["suggestion_applied", "viewed"].sort());
  assert.ok(!afterClick.includes("owner_resolved"));
  const mixed = applyReceiptEvent(applyReceiptEvent(["viewed"], "original_action_ok"), "original_action_fail");
  assert.ok(mixed.includes("action_succeeded") || mixed.includes("viewed"));
  assert.ok(!mixed.includes("owner_resolved"));
});

test("#469 flag off keeps mention order and never rewrites spawns", () => {
  const off = relayStopAdvice({
    flagOn: false,
    mentionOrder: ["a", "b"],
    completed: { positionId: "a", status: "completed", hasOutput: true },
  });
  assert.deepEqual(off.order, ["a", "b"]);
  assert.equal(off.rewriteSpawns, false);
  assert.equal(off.advice.status, "abstain");
  const on = relayStopAdvice({
    flagOn: true,
    mentionOrder: ["a", "b"],
    completed: { positionId: "a", status: "completed", hasOutput: true },
  });
  assert.equal(on.rewriteSpawns, false);
  assert.equal(on.advice.status, "suggest");
  assert.equal(applyRelayStopSuggestion().autoStopRemaining, false);
});

test("overlay payloads reject turn bodies", () => {
  assert.doesNotThrow(() => assertNoTurnBodies({ kind: "exec", mode: "read_only" }));
  assert.throws(() => assertNoTurnBodies({ kind: "exec", input: "x" }));
});

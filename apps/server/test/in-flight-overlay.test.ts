import assert from "node:assert/strict";
import test from "node:test";
import { RunningTurnRegistry } from "../src/turns/running.js";
import {
  assertInFlightAdvicePayload,
  presentInFlightOverlay,
  resolveInFlightChoice,
} from "../src/turns/in-flight-overlay.js";

const facts = [{ positionId: "issue-researcher", status: "running" as const, errorCode: "budget_exhausted" }];

test("flag off hides the in-flight list", () => {
  const view = presentInFlightOverlay({ flagOn: false, hasConfirmedTaskSummary: true, facts, choice: "join_existing" });
  assert.equal(view.visible, false);
  assert.deepEqual(view.facts, []);
  assert.equal(view.matching, "abstain");
});

test("without taskSummary the list is facts-only and matching abstains", () => {
  const view = presentInFlightOverlay({ flagOn: true, hasConfirmedTaskSummary: false, facts, choice: "join_existing" });
  assert.equal(view.visible, true);
  assert.deepEqual(view.facts, facts);
  assert.equal(view.matching, "abstain");
});

test("send anyway does not drop running rows", () => {
  const view = presentInFlightOverlay({ flagOn: true, hasConfirmedTaskSummary: true, facts, choice: "send_anyway" });
  assert.equal(view.matching, "send_anyway");
  assert.equal(view.facts.length, 1);
});

test("advice payload rejects input/output bodies", () => {
  assert.doesNotThrow(() => assertInFlightAdvicePayload({ positionId: "p1", status: "running" }));
  assert.throws(() => assertInFlightAdvicePayload({ positionId: "p1", status: "running", input: "secret" }));
  assert.throws(() => assertInFlightAdvicePayload({ positionId: "p1", status: "running", output: "secret" }));
});

test("unknown Laya choice stays abstain", async () => {
  const matching = await resolveInFlightChoice(facts, true, {
    env: { ROLEWEAVE_LAYA_ENABLED: "1" },
    ask: async () => ({ action: { type: "choice", selected: "cancel_turn", probabilities: { cancel_turn: 1 }, confidence: 1 } }),
  });
  assert.equal(matching, "abstain");
});

test("registry lists in-flight turn positions without exposing abort hooks", () => {
  const registry = new RunningTurnRegistry();
  const hold = registry.reserve("/tmp/ws", "issue-researcher", "turn-1");
  assert.deepEqual(registry.listInFlight("/tmp/ws"), [{ positionId: "issue-researcher", status: "running" }]);
  hold.release();
  assert.deepEqual(registry.listInFlight("/tmp/ws"), []);
});

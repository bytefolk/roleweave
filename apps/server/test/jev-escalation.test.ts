import assert from "node:assert/strict";
import test from "node:test";
import type { EscalationEntry } from "@roleweave/shared";
import { overlayEscalations } from "../src/jev/escalation.js";
import type { JevAsk } from "../src/jev/client.js";

const enabled = { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" };
const row: EscalationEntry = {
  schemaVersion: "turn-escalation.v1",
  positionId: "p",
  turnId: "t",
  at: "2026-01-01T00:00:00.000Z",
  status: "failed",
  code: "engine_internal_error",
  reportingChain: ["p"],
  budgetRelated: false,
};

test("escalation overlay is a no-op when Jev is off", async () => {
  const ask: JevAsk = async () => { throw new Error("must not run"); };
  assert.deepEqual(await overlayEscalations([row], { env: {}, ask }), [row]);
});

test("escalation overlay keeps the row when needsAttention is false", async () => {
  const ask: JevAsk = async () => ({
    category: { type: "choice", selected: "benign", probabilities: { benign: 1 }, confidence: 1 },
    needsAttention: { type: "noul", probability: 0.1 },
  });
  const [next] = await overlayEscalations([row], { env: enabled, ask });
  assert.equal(next?.category, "benign");
  assert.equal(next?.needsAttention, false);
  assert.equal(next?.code, "engine_internal_error");
});

test("escalation overlay state has no turn bodies", async () => {
  const seen: unknown[] = [];
  const ask: JevAsk = async (request) => {
    seen.push(request.state);
    return null;
  };
  await overlayEscalations([row], { env: enabled, ask });
  assert.deepEqual(seen, [{ status: "failed", errorCode: "engine_internal_error", budgetRelated: false }]);
});

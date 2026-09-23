import assert from "node:assert/strict";
import test from "node:test";
import {
  assertKindOnlyAdvicePayload,
  mapAdviceChoiceToRisk,
  presentApprovalRisk,
  ruleRiskFromKind,
} from "../src/approvals/risk-overlay.js";

test("rule risk matches capabilityContext (exec/write/network high, tool medium)", () => {
  assert.equal(ruleRiskFromKind("exec"), "high");
  assert.equal(ruleRiskFromKind("write"), "high");
  assert.equal(ruleRiskFromKind("network"), "high");
  assert.equal(ruleRiskFromKind("tool"), "medium");
});

test("display risk stays on the rule when overlay is lower (#460)", () => {
  const view = presentApprovalRisk("high", "medium");
  assert.equal(view.display, "high");
  assert.equal(view.overlay, "medium");
  assert.equal(view.notAdopted, true);
});

test("kind-only payload rejects description/target/input/output", () => {
  assert.doesNotThrow(() => assertKindOnlyAdvicePayload({ kind: "exec" }));
  assert.throws(() => assertKindOnlyAdvicePayload({ kind: "exec", description: "rm -rf" }));
  assert.throws(() => assertKindOnlyAdvicePayload({ kind: "exec", input: "secret" }));
  assert.throws(() => assertKindOnlyAdvicePayload({ kind: "exec", output: "secret" }));
});

test("unknown Jev choice does not become a risk overlay", () => {
  assert.equal(mapAdviceChoiceToRisk("low"), null);
  assert.equal(mapAdviceChoiceToRisk("high"), "high");
});

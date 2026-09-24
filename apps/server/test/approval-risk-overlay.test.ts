import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalContext } from "@roleweave/shared";
import { layaEnabled } from "../src/laya/config.js";
import {
  assertKindOnlyAdvicePayload,
  attachApprovalRiskOverlay,
  mapAdviceChoiceToRisk,
  presentApprovalRisk,
  resolveApprovalRiskOverlay,
  ruleRiskFromKind,
} from "../src/approvals/risk-overlay.js";

const baseContext: ApprovalContext = {
  risk: "high",
  requestedCapability: "exec",
  impact: "command_execution",
  permissions: { mode: "approval_required", allowedTools: [], deniedTools: [] },
  preview: { status: "unavailable", reason: "engine_preview_not_supplied" },
  scope: { allowed: ["once"] },
};

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

test("unknown Laya choice does not become a risk overlay", () => {
  assert.equal(mapAdviceChoiceToRisk("low"), null);
  assert.equal(mapAdviceChoiceToRisk("high"), "high");
});

test("ROLEWEAVE_LAYA_ENABLED remains explicit opt-in", () => {
  assert.equal(layaEnabled({}), false);
  assert.equal(layaEnabled({ ROLEWEAVE_LAYA_ENABLED: "" }), false);
  assert.equal(layaEnabled({ ROLEWEAVE_LAYA_ENABLED: "0" }), false);
  assert.equal(layaEnabled({ ROLEWEAVE_LAYA_ENABLED: "false" }), false);
  assert.equal(layaEnabled({ ROLEWEAVE_LAYA_ENABLED: "1" }), true);
});

test("flag off: no overlay and ask is not invoked", async () => {
  let called = false;
  const result = await attachApprovalRiskOverlay(baseContext, { kind: "exec" }, {
    env: {},
    ask: async () => {
      called = true;
      return { risk: { type: "choice", selected: "medium", probabilities: {}, confidence: 1 } };
    },
  });
  assert.equal(called, false);
  assert.equal(result.risk, "high");
  assert.equal((result as ApprovalContext & { riskOverlay?: string }).riskOverlay, undefined);
});

test("outbound Laya state is kind-only and overlay stays non-authoritative", async () => {
  const states: unknown[] = [];
  const overlay = await resolveApprovalRiskOverlay("exec", {
    env: { ROLEWEAVE_LAYA_ENABLED: "1" },
    ask: async (request) => {
      states.push(request.state);
      assertKindOnlyAdvicePayload(request.state as Record<string, unknown>);
      return { risk: { type: "choice", selected: "medium", probabilities: { medium: 1 }, confidence: 1 } };
    },
  });
  assert.deepEqual(states, [{ kind: "exec" }]);
  assert.equal(overlay, "medium");
  const attached = await attachApprovalRiskOverlay(baseContext, { kind: "exec" }, {
    env: { ROLEWEAVE_LAYA_ENABLED: "1" },
    ask: async () => ({ risk: { type: "choice", selected: "medium", probabilities: { medium: 1 }, confidence: 1 } }),
  });
  assert.equal(attached.risk, "high");
  assert.equal((attached as ApprovalContext & { riskOverlay?: string }).riskOverlay, "medium");
});

test("invalid or failed advice produces no overlay", async () => {
  assert.equal(
    await resolveApprovalRiskOverlay("exec", {
      env: { ROLEWEAVE_LAYA_ENABLED: "1" },
      ask: async () => ({ risk: { type: "choice", selected: "low", probabilities: {}, confidence: 1 } }),
    }),
    undefined,
  );
  assert.equal(
    await resolveApprovalRiskOverlay("exec", {
      env: { ROLEWEAVE_LAYA_ENABLED: "1" },
      ask: async () => {
        throw new Error("timeout");
      },
    }),
    undefined,
  );
});

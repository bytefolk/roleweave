import assert from "node:assert/strict";
import test from "node:test";
import { resolveReadyHostChoice, sanitizeReadyHostFacts } from "../src/org/ready-host-overlay.js";

const unready = { positionId: "codex-writer", engine: "codex", ready: false };
const qoder = { positionId: "qoder-owner", engine: "qoder", ready: true };
const claude = { positionId: "claude-reviewer", engine: "claude-code", ready: true };

test("sanitizeReadyHostFacts keeps only positionId/engine/ready", () => {
  assert.deepEqual(
    sanitizeReadyHostFacts([{ positionId: "a", engine: "qoder", ready: true, prompt: "secret" }]),
    [],
  );
  assert.deepEqual(sanitizeReadyHostFacts([{ positionId: "a", engine: "qoder", ready: true }]), [
    { positionId: "a", engine: "qoder", ready: true },
  ]);
});

test("0 or 1 ready candidate never calls the provider", async () => {
  let calls = 0;
  const ask = async () => {
    calls += 1;
    return null;
  };
  assert.equal(await resolveReadyHostChoice([unready], { env: { ROLEWEAVE_LAYA_ENABLED: "1" }, ask }), null);
  assert.equal(await resolveReadyHostChoice([unready, qoder], { env: { ROLEWEAVE_LAYA_ENABLED: "1" }, ask }), null);
  assert.equal(calls, 0);
});

test("disabled Laya never calls the provider even with 2+ ready hosts", async () => {
  let calls = 0;
  const ask = async () => {
    calls += 1;
    return null;
  };
  assert.equal(await resolveReadyHostChoice([qoder, claude], { env: {}, ask }), null);
  assert.equal(calls, 0);
});

test("2+ ready hosts send only bounded facts and require the Choice to hit the set", async () => {
  let seen: unknown;
  const selected = await resolveReadyHostChoice([unready, qoder, claude], {
    env: { ROLEWEAVE_LAYA_ENABLED: "1" },
    ask: async (request) => {
      seen = request;
      return {
        host: {
          type: "choice",
          selected: "qoder-owner",
          probabilities: { "qoder-owner": 0.7, "claude-reviewer": 0.3 },
          confidence: 0.7,
        },
      };
    },
  });
  assert.equal(selected, "qoder-owner");
  const state = (seen as { state: Array<Record<string, unknown>> }).state;
  assert.deepEqual(state, [
    { positionId: "qoder-owner", engine: "qoder", ready: true },
    { positionId: "claude-reviewer", engine: "claude-code", ready: true },
  ]);
  for (const fact of state) {
    assert.deepEqual(Object.keys(fact).sort(), ["engine", "positionId", "ready"]);
  }
});

test("timeout, invalid option, and out-of-set Choice fail closed", async () => {
  const enabled = { env: { ROLEWEAVE_LAYA_ENABLED: "1" } };
  assert.equal(
    await resolveReadyHostChoice([qoder, claude], {
      ...enabled,
      ask: async () => {
        throw new Error("timeout");
      },
    }),
    null,
  );
  assert.equal(
    await resolveReadyHostChoice([qoder, claude], {
      ...enabled,
      ask: async () => ({
        host: { type: "choice", selected: "stranger", probabilities: { stranger: 1 }, confidence: 1 },
      }),
    }),
    null,
  );
  assert.equal(
    await resolveReadyHostChoice([qoder, claude], {
      ...enabled,
      ask: async () => ({ host: { type: "noul", probability: 0.9 } }),
    }),
    null,
  );
});

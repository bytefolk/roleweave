import assert from "node:assert/strict";
import test from "node:test";
import { resolveThreadContextOverlay } from "../src/jev/thread-context-overlay.js";

const enabled = { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" };

test("thread-context overlay is null when Jev is off", async () => {
  assert.equal(
    await resolveThreadContextOverlay({
      enabled: true, sourceTurnCount: 3, contextBytes: 100, truncated: true, omittedTurnCount: 2, failedOrCancelledCount: 1,
    }, { env: {}, ask: async () => { throw new Error("must not run"); } }),
    null,
  );
});

test("thread-context overlay uses counts not excerpts", async () => {
  const seen: unknown[] = [];
  const overlay = await resolveThreadContextOverlay(
    { enabled: true, sourceTurnCount: 12, contextBytes: 64000, truncated: true, omittedTurnCount: 4, failedOrCancelledCount: 2 },
    {
      env: enabled,
      ask: async (request) => {
        seen.push(request.state);
        return { rotate: { type: "noul", probability: 0.9 }, disable: { type: "noul", probability: 0.1 } };
      },
    },
  );
  assert.deepEqual(overlay, { suggestRotate: true });
  assert.equal(JSON.stringify(seen).includes("summary"), false);
});

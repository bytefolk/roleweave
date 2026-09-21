import assert from "node:assert/strict";
import test from "node:test";
import { resolveStaleOverlay } from "../src/jev/stale.js";

const enabled = { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" };

test("stale overlay is null when Jev is off", async () => {
  assert.equal(
    await resolveStaleOverlay(
      { updatedAt: "2026-01-01T00:00:00.000Z", boundTurnCount: 0 },
      { env: {}, ask: async () => { throw new Error("must not run"); } },
    ),
    null,
  );
});

test("stale overlay is true only on a high noul", async () => {
  assert.equal(
    await resolveStaleOverlay(
      { updatedAt: "2026-01-01T00:00:00.000Z", boundTurnCount: 0 },
      { env: enabled, ask: async () => ({ stale: { type: "noul", probability: 0.9 } }) },
    ),
    true,
  );
  assert.equal(
    await resolveStaleOverlay(
      { updatedAt: "2026-01-01T00:00:00.000Z", boundTurnCount: 0 },
      { env: enabled, ask: async () => ({ stale: { type: "noul", probability: 0.1 } }) },
    ),
    null,
  );
});

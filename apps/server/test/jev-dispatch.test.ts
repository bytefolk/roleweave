import assert from "node:assert/strict";
import test from "node:test";
import type { GroupConversation } from "@roleweave/shared";
import { resolveDispatchOverlay } from "../src/jev/dispatch.js";

const enabled = { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" };
const group: GroupConversation = {
  schemaVersion: "conversation-group.v1",
  conversationRef: "g1",
  sessionId: "s1",
  members: ["writer", "reviewer"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("dispatch overlay is null when Jev is off", async () => {
  assert.equal(
    await resolveDispatchOverlay(group, [{ id: "writer", name: "W" }], {
      env: {},
      ask: async () => { throw new Error("must not run"); },
    }),
    null,
  );
});

test("dispatch overlay keeps group members and suggested mode", async () => {
  const overlay = await resolveDispatchOverlay(
    group,
    [{ id: "writer", name: "Writer" }, { id: "reviewer", name: "Reviewer" }],
    { env: enabled, ask: async () => ({ mode: { type: "choice", selected: "relay", probabilities: {}, confidence: 1 } }) },
  );
  assert.deepEqual(overlay, { mentions: ["writer", "reviewer"], mode: "relay" });
});

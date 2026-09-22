import assert from "node:assert/strict";
import test from "node:test";
import { resolveAssigneeOverlay } from "../src/jev/assignee.js";
import type { JevAsk } from "../src/jev/client.js";

const enabled = { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" };

test("assignee overlay is null when Jev is off", async () => {
  const ask: JevAsk = async () => { throw new Error("must not run"); };
  assert.equal(await resolveAssigneeOverlay([{ id: "p", name: "P", mode: "read_only" }], { env: {}, ask }), null);
});

test("assignee overlay only returns a known positionId", async () => {
  const overlay = await resolveAssigneeOverlay(
    [{ id: "release-engineer", name: "RE", mode: "approval_required" }],
    { env: enabled, ask: async () => ({ assignee: { type: "choice", selected: "release-engineer", probabilities: {}, confidence: 1 } }) },
  );
  assert.deepEqual(overlay, { positionId: "release-engineer" });
  assert.equal(
    await resolveAssigneeOverlay(
      [{ id: "release-engineer", name: "RE", mode: "approval_required" }],
      { env: enabled, ask: async () => ({ assignee: { type: "choice", selected: "nope", probabilities: {}, confidence: 1 } }) },
    ),
    null,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { resolveUncoveredGoals } from "../src/jev/audit-goals.js";

const enabled = { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" };

test("audit overlay is null when Jev is off", async () => {
  assert.equal(
    await resolveUncoveredGoals(["gone"], [], [{ goalId: "g", positionIds: ["gone"] }], {
      env: {},
      ask: async () => { throw new Error("must not run"); },
    }),
    null,
  );
});

test("audit overlay joins dismissed ids to goal bindings without diffs", async () => {
  const ids = await resolveUncoveredGoals(
    ["release-engineer"],
    [],
    [{ goalId: "ship", positionIds: ["release-engineer"] }],
    { env: enabled, ask: async () => ({ uncovered: { type: "noul", probability: 0.8 } }) },
  );
  assert.deepEqual(ids, ["ship"]);
});

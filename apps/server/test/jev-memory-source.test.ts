import assert from "node:assert/strict";
import test from "node:test";
import { resolveMemorySourceOverlay } from "../src/jev/memory-source.js";

const enabled = { ROLEWEAVE_JEV_ENABLED: "1", ROLEWEAVE_JEV_API_KEY: "k" };

test("memory overlay is null when Jev is off", async () => {
  assert.equal(
    await resolveMemorySourceOverlay([{ kind: "workspace_docs", state: "ready", binding: "bound" }], {
      env: {},
      ask: async () => { throw new Error("must not run"); },
    }),
    null,
  );
});

test("memory overlay maps a rail without source bodies", async () => {
  const seen: unknown[] = [];
  const rail = await resolveMemorySourceOverlay(
    [{ kind: "workspace_docs", state: "ready", binding: "bound", itemCount: 2 }],
    {
      env: enabled,
      ask: async (request) => {
        seen.push(request.state);
        return { rail: { type: "choice", selected: "sessions", probabilities: {}, confidence: 1 } };
      },
    },
  );
  assert.equal(rail, "sessions");
  assert.equal(JSON.stringify(seen).includes("input"), false);
});

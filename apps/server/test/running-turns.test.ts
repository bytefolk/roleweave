import assert from "node:assert/strict";
import test from "node:test";
import { OrgApiError } from "@roleweave/shared";
import { RunningTurnRegistry } from "../src/turns/running.js";

test("reservations isolate employees and workspaces and reject a duplicate before any async work", () => {
  const registry = new RunningTurnRegistry();
  const first = registry.reserve("/workspace/a", "writer");
  const second = registry.reserve("/workspace/a", "reviewer");
  const otherWorkspace = registry.reserve("/workspace/b", "writer");
  assert.throws(() => registry.reserve("/workspace/a/.", "writer"), (error: unknown) =>
    error instanceof OrgApiError && error.status === 409 && error.code === "session_conflict");
  first.release();
  const replacement = registry.reserve("/workspace/a", "writer");
  first.release();
  assert.throws(() => registry.reserve("/workspace/a", "writer"));
  replacement.release();
  second.release();
  otherWorkspace.release();
});

test("cancellation before the driver registers its abort remains position and workspace scoped", () => {
  const registry = new RunningTurnRegistry();
  const writer = registry.reserve("/workspace/a", "writer");
  const reviewer = registry.reserve("/workspace/a", "reviewer");
  let writerAborts = 0;
  let reviewerAborts = 0;
  reviewer.setAbort(() => { reviewerAborts += 1; });
  assert.equal(registry.cancel("/workspace/b", "writer"), false);
  assert.equal(registry.cancel("/workspace/a", "writer"), true);
  writer.setAbort(() => { writerAborts += 1; });
  assert.equal(registry.cancel("/workspace/a", "writer"), true);
  assert.equal(writerAborts, 1);
  assert.equal(reviewerAborts, 0);
  writer.release();
  writer.setAbort(() => { writerAborts += 1; });
  assert.equal(writerAborts, 1);
  assert.equal(registry.cancel("/workspace/a", "writer"), false);
  reviewer.release();
});

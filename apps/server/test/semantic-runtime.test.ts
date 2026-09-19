import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertExecutable,
  canTransitionAction,
  receiptAllowsSucceeded,
  sameIdempotencyRetry,
  type ActionProposal,
  type ExecutionReceipt,
} from "@roleweave/shared";

const EXAMPLE = fileURLToPath(new URL("../../../../examples/github-ops/semantic", import.meta.url));

function loadJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLE, name), "utf8")) as unknown;
}

const approvedMerge: ActionProposal = {
  schemaVersion: "action-proposal.v1alpha1",
  id: "act-merge-184",
  objectId: "obj-pr-184",
  decisionId: "dec-merge-ok",
  intent: "squash-merge",
  target: { kind: "github.pull_request", id: "bytefolk/mem#184", version: "sha-aaa" },
  expectedEffect: "PR closed, squash commit on main",
  preconditions: ["required checks green", "non-author CODEOWNER approval", "not draft"],
  permissionScope: "pr-gatekeeper:merge",
  approvalRequired: true,
  approvalId: "appr-merge-184",
  idempotencyKey: "github-ops/merge/bytefolk/mem#184/sha-aaa",
  expiresAt: "2099-01-01T00:00:00.000Z",
  state: "approved",
};

test("#328 AC-003: action cannot run without approval", () => {
  const proposed = { ...approvedMerge, state: "proposed" as const, approvalId: undefined };
  assert.equal(assertExecutable(proposed, "sha-aaa"), "action_not_approved");
  assert.equal(assertExecutable({ ...approvedMerge, approvalId: undefined }, "sha-aaa"), "approval_missing");
  assert.equal(assertExecutable(approvedMerge, "sha-aaa"), null);
});

test("#328 AC-003: invalid proposal expiry fails closed", () => {
  assert.equal(
    assertExecutable({ ...approvedMerge, expiresAt: "not-a-timestamp" }, "sha-aaa"),
    "proposal_expiry_invalid",
  );
});

test("#328 AC-003: retries reuse the same idempotency identity", () => {
  const retry = { ...approvedMerge };
  assert.equal(sameIdempotencyRetry(approvedMerge, retry), true);
  assert.equal(sameIdempotencyRetry(approvedMerge, { ...retry, idempotencyKey: "other" }), false);
});

test("#328 AC-003: retries cannot reuse an idempotency identity across target versions", () => {
  const changedTarget = {
    ...approvedMerge,
    target: { ...approvedMerge.target, version: "sha-bbb" },
  };
  assert.equal(sameIdempotencyRetry(approvedMerge, changedTarget), false);
});

test("#328 AC-003: target version change invalidates the proposal", () => {
  assert.equal(assertExecutable(approvedMerge, "sha-bbb"), "target_version_stale");
});

test("#328 AC-003: pre-run states cannot transition directly to failed", () => {
  assert.equal(canTransitionAction("proposed", "failed"), false);
  assert.equal(canTransitionAction("approved", "failed"), false);
  assert.equal(canTransitionAction("proposed", "approved"), true);
  assert.equal(canTransitionAction("approved", "running"), true);
});

test("#328 AC-003: indeterminate never becomes succeeded", () => {
  assert.equal(canTransitionAction("indeterminate", "succeeded"), false);
  assert.equal(canTransitionAction("running", "indeterminate"), true);
  assert.equal(canTransitionAction("running", "succeeded"), true);
  const receipt: ExecutionReceipt = {
    schemaVersion: "execution-receipt.v1alpha1",
    id: "rcpt-1",
    proposalId: approvedMerge.id,
    turnId: "turn-1",
    positionId: "pr-gatekeeper",
    actor: "pr-gatekeeper",
    permissionReevaluated: true,
    targetVersionObserved: "sha-aaa",
    terminalState: "succeeded",
    readback: { ok: false, observed: "unknown" },
  };
  assert.equal(receiptAllowsSucceeded(receipt), false);
  assert.equal(receiptAllowsSucceeded({ ...receipt, readback: { ok: true, observed: "merged" } }), true);
  assert.equal(receiptAllowsSucceeded({ ...receipt, terminalState: "indeterminate", readback: { ok: false, observed: "timeout" } }), false);
});

test("#328 AC-002: committed github-ops semantic examples stay parseable", () => {
  const analysis = loadJson("read-only-analysis.v1.json") as { objects: unknown[]; evidence: unknown[]; decision: { uncertainty: string } };
  const write = loadJson("write-pr-merge.v1.json") as { proposal: ActionProposal; receipt: ExecutionReceipt };
  assert.ok(Array.isArray(analysis.objects) && analysis.objects.length >= 1);
  assert.ok(Array.isArray(analysis.evidence) && analysis.evidence.length >= 1);
  assert.equal(typeof analysis.decision.uncertainty, "string");
  assert.equal(write.proposal.idempotencyKey.includes("sha-"), true);
  assert.equal(write.receipt.permissionReevaluated, true);
  assert.equal(write.receipt.terminalState, "succeeded");
  assert.equal(write.receipt.readback.ok, true);
});

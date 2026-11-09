import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { turnEngines, type ApprovalAuditEvent, type ApprovalRecord } from "@roleweave/shared";
import {
  DELIVERY_TARGET_PREFIX,
  deliveryAcceptance,
  deliveryTarget,
  deliveryTargetRef,
  isDeliveryAcceptance,
  verifyApprovalAuditChain,
} from "../src/approvals/delivery.js";
import { ruleRiskFromKind } from "../src/approvals/risk-overlay.js";

const ENGINE = turnEngines[0]!;
const NOW = "2026-09-29T00:00:00.000Z";

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const base: ApprovalRecord = {
    schemaVersion: "workbench-approval.v2",
    id: "a".repeat(64),
    version: 1,
    approvalId: "appr-delivery-1",
    source: {
      kind: "session",
      positionId: "pos-1",
      conversationId: "conv-1",
      turnId: "11111111-1111-4111-8111-111111111111",
      runId: "run-1",
      engine: ENGINE,
    },
    action: { kind: "tool", description: "交付验收", target: deliveryTarget("order-7") },
    requestedAt: NOW,
    status: "pending",
    execution: { phase: "not_started" },
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...base, ...overrides, source: { ...base.source, ...(overrides.source ?? {}) }, action: { ...base.action, ...(overrides.action ?? {}) } };
}

/** Mirrors the writer in approvals/store.ts: seq, then the event, then
 * previousHash, with the digest appended last. */
type AuditSeed = Omit<ApprovalAuditEvent, "seq" | "previousHash" | "hash">;

function chain(seeds: AuditSeed[]): ApprovalAuditEvent[] {
  const events: ApprovalAuditEvent[] = [];
  for (const seed of seeds) {
    const previous = events.at(-1);
    const body = { seq: events.length + 1, ...seed, ...(previous ? { previousHash: previous.hash } : {}) };
    const hash = `sha256:${crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
    events.push({ ...body, hash });
  }
  return events;
}

function requested(approvalId: string): AuditSeed {
  return { approvalId, timestamp: NOW, type: "requested", policyVersion: "local-operator-v1", policyDigest: "sha256:" + "b".repeat(64) };
}

function decided(approvalId: string, decision: "granted" | "denied", overrides: Partial<AuditSeed> = {}): AuditSeed {
  return {
    approvalId,
    requestId: "22222222-2222-4222-8222-222222222222",
    timestamp: "2026-09-29T00:00:05.000Z",
    type: "decision",
    actor: "operator",
    decision,
    scope: "once",
    policyVersion: "local-operator-v1",
    policyDigest: "sha256:" + "b".repeat(64),
    ...overrides,
  };
}

test("delivery target round-trips the platform reference", () => {
  assert.equal(deliveryTarget("order-7"), `${DELIVERY_TARGET_PREFIX}order-7`);
  assert.equal(deliveryTargetRef(deliveryTarget("order-7")), "order-7");
});

test("targets outside the convention are not delivery references", () => {
  assert.equal(deliveryTargetRef(undefined), undefined);
  assert.equal(deliveryTargetRef("order-7"), undefined);
  assert.equal(deliveryTargetRef("delivery:"), undefined, "an empty reference carries no delivery");
  assert.equal(deliveryTargetRef(deliveryTarget("x".repeat(9000))), undefined, "over-long targets stay out");
});

test("only the tool kind carries acceptance — the vocabulary is untouched", () => {
  assert.equal(isDeliveryAcceptance(record()), true);
  assert.equal(isDeliveryAcceptance(record({ action: { kind: "write", description: "d", target: deliveryTarget("order-7") } })), false);
  assert.equal(isDeliveryAcceptance(record({ action: { kind: "exec", description: "d", target: deliveryTarget("order-7") } })), false);
  assert.equal(isDeliveryAcceptance(record({ action: { kind: "network", description: "d", target: deliveryTarget("order-7") } })), false);
  assert.equal(isDeliveryAcceptance(record({ action: { kind: "tool", description: "d", target: undefined } })), false, "no target, no delivery");
});

test("an acceptance must stay bound to the turn that requested it", () => {
  assert.equal(isDeliveryAcceptance(record({ source: { ...record().source, turnId: "" } })), false);
  assert.equal(isDeliveryAcceptance(record({ source: { ...record().source, runId: "" } })), false);
});

test("acceptance lands on medium risk, which is why no new kind is needed", () => {
  const acceptance = record();
  assert.equal(acceptance.action.kind, "tool");
  assert.equal(ruleRiskFromKind(acceptance.action.kind), "medium");
});

test("a granted audit chain settles as accepted", () => {
  const approval = record({ status: "granted" });
  const audit = chain([requested(approval.id), decided(approval.id, "granted")]);
  const result = deliveryAcceptance(approval, audit);
  assert.equal(result?.state, "accepted");
  assert.equal(result?.deliveryRef, "order-7");
  assert.equal(result?.decidedAt, "2026-09-29T00:00:05.000Z");
  assert.equal(result?.policyDigest, "sha256:" + "b".repeat(64));
});

test("a denied audit chain settles as declined", () => {
  const approval = record({ status: "denied" });
  const audit = chain([requested(approval.id), decided(approval.id, "denied")]);
  assert.equal(deliveryAcceptance(approval, audit)?.state, "declined");
});

test("a pending approval stays pending even under a multi-approver policy", () => {
  const approval = record({ status: "pending" });
  const audit = chain([requested(approval.id), decided(approval.id, "granted")]);
  assert.equal(deliveryAcceptance(approval, audit)?.state, "pending", "a partial grant does not settle");
});

test("another approval's events do not leak into this verdict", () => {
  const other = "c".repeat(64);
  const approval = record({ status: "denied" });
  // One workspace log: a neighbouring approval is granted at seq 1-2, ours is
  // denied, and only our own decision may settle the record.
  const audit = chain([
    requested(other), decided(other, "granted"),
    requested(approval.id), decided(approval.id, "denied"),
  ]);
  const result = deliveryAcceptance(approval, audit);
  assert.equal(result?.state, "declined");
});

test("an acceptance that is not the first approval in the workspace log still settles", () => {
  // seq is workspace-global (store.ts:212: `seq: existing.length + 1`), so the
  // interesting case is an approval whose own events start mid-log. Verifying
  // a per-approval slice used to fail closed here for every approval but the
  // first one ever written.
  const earlier = "d".repeat(64);
  const approval = record({ status: "granted" });
  const audit = chain([
    requested(earlier), decided(earlier, "granted"),
    requested(approval.id), decided(approval.id, "granted"),
  ]);
  const mine = audit.filter(event => event.approvalId === approval.id);
  assert.deepEqual(mine.map(event => event.seq), [3, 4], "our events do not start at 1");
  assert.notEqual(mine[0]?.previousHash, undefined, "our first event back-references the earlier approval");
  assert.equal(deliveryAcceptance(approval, audit)?.state, "accepted");
});

test("tampering outside this approval's own events fails closed", () => {
  // Our approval is the *first* one in the log here, so a per-approval slice
  // would verify cleanly. Only verifying the log whole can see this.
  const approval = record({ status: "granted" });
  const other = "e".repeat(64);
  const audit = chain([
    requested(approval.id), decided(approval.id, "granted"),
    requested(other), decided(other, "granted"),
  ]);
  const tampered = audit.map(event =>
    event.approvalId === other && event.type === "decision" ? { ...event, actor: "someone-else" } : event);
  assert.equal(verifyApprovalAuditChain(tampered), false);
  const result = deliveryAcceptance(approval, tampered);
  assert.equal(result?.state, "indeterminate");
  assert.equal(result?.reason, "audit_chain_broken");
});

test("a tampered audit chain fails closed", () => {
  const approval = record({ status: "granted" });
  const audit = chain([requested(approval.id), decided(approval.id, "granted")]);
  const tampered = audit.map(event => event.type === "decision" ? { ...event, decision: "denied" as const } : event);
  assert.equal(verifyApprovalAuditChain(tampered), false);
  const result = deliveryAcceptance(approval, tampered);
  assert.equal(result?.state, "indeterminate");
  assert.equal(result?.reason, "audit_chain_broken");
});

test("a decision recorded without its policy fails closed", () => {
  const approval = record({ status: "granted" });
  const audit = chain([requested(approval.id), decided(approval.id, "granted", { policyDigest: "" })]);
  const result = deliveryAcceptance(approval, audit);
  assert.equal(result?.state, "indeterminate");
  assert.equal(result?.reason, "policy_digest_missing");
});

test("a record that disagrees with its audit fails closed", () => {
  const approval = record({ status: "granted" });
  const audit = chain([requested(approval.id), decided(approval.id, "denied")]);
  const result = deliveryAcceptance(approval, audit);
  assert.equal(result?.state, "indeterminate");
  assert.equal(result?.reason, "record_status_mismatch");
});

test("an approval that never decided never settles", () => {
  const approval = record({ status: "expired" });
  const audit = chain([requested(approval.id)]);
  const result = deliveryAcceptance(approval, audit);
  assert.equal(result?.state, "indeterminate");
  assert.equal(result?.reason, "not_settled");
});

test("an approval without a delivery target is not an acceptance", () => {
  const approval = record({ status: "granted", action: { kind: "tool", description: "d", target: "tool:shell" } });
  const audit = chain([requested(approval.id), decided(approval.id, "granted")]);
  assert.equal(deliveryAcceptance(approval, audit), undefined);
});

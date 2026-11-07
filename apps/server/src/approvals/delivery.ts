import crypto from "node:crypto";
import type { ApprovalAuditEvent, ApprovalRecord } from "@roleweave/shared";

/**
 * Buyer delivery acceptance, carried on the existing approval contract (C2).
 *
 * Acceptance is **not** a new approval kind. `action.kind` stays `tool` — the
 * only vocabulary entry `ruleRiskFromKind` maps to `medium` — and the
 * commercial meaning rides in `action.target` behind `DELIVERY_TARGET_PREFIX`.
 * RoleWeave never parses past the prefix: buyer, order and listing stay out of
 * this repository and are attached by `digital-employee-platform`.
 *
 * Everything below is projection over records the existing machinery already
 * writes. Nothing here widens the vocabulary, the schema version, or the event
 * set, and nothing here decides who a buyer is.
 *
 * Inherited invariants, deliberately not re-created here:
 *  - A record can only exist because a running turn emitted
 *    `approval.requested` (`approvals/service.ts`), which is why
 *    `source.turnId` / `source.runId` are required — an acceptance cannot be
 *    minted without a turn behind it.
 *  - The verdict returns through `approval.granted` on the sealed envelope of
 *    the resumption turn (#187 Option 1, terminal-and-resume). There is no
 *    suspended-turn path and no second settlement channel.
 */
export const DELIVERY_TARGET_PREFIX = "delivery:";

/** Same bound the approval store applies to `action.target`. */
const TARGET_MAX_CHARS = 8192;

/** Build the platform-facing target for a delivery reference. */
export function deliveryTarget(ref: string): string {
  return `${DELIVERY_TARGET_PREFIX}${ref}`;
}

/** The reference behind the prefix, or undefined when the target is not a
 * delivery acceptance target. The reference itself is opaque — it belongs to
 * the platform, so it is returned whole and never interpreted. */
export function deliveryTargetRef(target: string | undefined): string | undefined {
  if (target === undefined || !target.startsWith(DELIVERY_TARGET_PREFIX)) return undefined;
  const ref = target.slice(DELIVERY_TARGET_PREFIX.length);
  return ref.length > 0 && target.length <= TARGET_MAX_CHARS ? ref : undefined;
}

/** True when this approval encodes a delivery acceptance.
 *
 * `kind` is pinned to `tool` on purpose: adding a `delivery` value would mean
 * editing the engine #187 vocabulary first (shared/turns.ts mirrors it
 * verbatim), which C2 exists to avoid. */
export function isDeliveryAcceptance(record: ApprovalRecord): boolean {
  if (record.action.kind !== "tool") return false;
  if (deliveryTargetRef(record.action.target) === undefined) return false;
  // An acceptance is only real while it is bound to the turn that asked for it.
  return typeof record.source?.turnId === "string" && record.source.turnId.length > 0 &&
    typeof record.source?.runId === "string" && record.source.runId.length > 0;
}

export type DeliveryAcceptanceState = "pending" | "accepted" | "declined" | "indeterminate";

export type DeliveryIndeterminateReason =
  /** The hash chain or seq continuity of the audit log does not hold. */
  | "audit_chain_broken"
  /** A decision was recorded without the policy it was decided under. */
  | "policy_digest_missing"
  /** The record and the audit disagree about the outcome. */
  | "record_status_mismatch"
  /** Settled as expired / cancelled / indeterminate, so it never decided. */
  | "not_settled";

export interface DeliveryAcceptance {
  /** Engine-side approval id, not the local identity hash. */
  approvalId: string;
  /** Opaque platform reference carried in `action.target`. */
  deliveryRef: string;
  state: DeliveryAcceptanceState;
  /** Present only when `state` is `indeterminate`. */
  reason?: DeliveryIndeterminateReason;
  decidedAt?: string;
  /** The actor the audit recorded. Buyer identity is not modelled yet: the
   * engine protocol still marks `decidedBy` as `operator`. */
  decidedBy?: string;
  policyVersion?: string;
  policyDigest?: string;
}

function auditDigest(body: Record<string, unknown>): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

/** Recompute the append-only audit chain: seq continuity, `previousHash`
 * back-reference, and each event's own digest. Mirrors the writer in
 * `approvals/store.ts`, so a hand-edited or truncated log fails closed.
 *
 * The argument is the **whole workspace log**, never one approval's slice of
 * it. `store.ts` numbers `seq` from `existing.length + 1` across every
 * approval in the workspace, and chains each event to whatever event was
 * appended before it. Slicing by `approvalId` first therefore destroys both
 * properties for every approval except the first one ever written: the slice
 * no longer starts at 1 and no longer starts from an absent `previousHash`. */
export function verifyApprovalAuditChain(events: readonly ApprovalAuditEvent[]): boolean {
  let previous: string | undefined;
  for (const [index, event] of events.entries()) {
    const { hash, ...unsigned } = event;
    if (event.seq !== index + 1) return false;
    if (event.previousHash !== previous) return false;
    if (auditDigest(unsigned) !== hash) return false;
    previous = hash;
  }
  return true;
}

/** Read acceptance off the existing `approval.granted` audit chain.
 *
 * Returns undefined when the record is not a delivery acceptance, so callers
 * can filter without a second predicate. Settlement is read-only: the verdict
 * is whatever the sealed envelope already recorded. */
export function deliveryAcceptance(
  record: ApprovalRecord,
  audit: readonly ApprovalAuditEvent[],
): DeliveryAcceptance | undefined {
  if (!isDeliveryAcceptance(record)) return undefined;
  const ref = deliveryTargetRef(record.action.target);
  if (ref === undefined) return undefined;
  const base: DeliveryAcceptance = { approvalId: record.approvalId, deliveryRef: ref, state: "pending" };
  // Verify before selecting, not after: the chain is a property of the log.
  if (!verifyApprovalAuditChain(audit)) {
    return { ...base, state: "indeterminate", reason: "audit_chain_broken" };
  }
  const events = audit.filter(event => event.approvalId === record.id);
  // A partial grant under a multi-approver policy is still pending; the
  // threshold belongs to policy.ts and is not recomputed here.
  if (record.status === "pending") return base;
  if (record.status !== "granted" && record.status !== "denied") {
    return { ...base, state: "indeterminate", reason: "not_settled" };
  }
  const decision = events.filter(event => event.type === "decision").at(-1);
  if (!decision || decision.decision !== record.status) {
    return { ...base, state: "indeterminate", reason: "record_status_mismatch" };
  }
  if (!decision.policyDigest) {
    return { ...base, state: "indeterminate", reason: "policy_digest_missing" };
  }
  return {
    ...base,
    state: decision.decision === "granted" ? "accepted" : "declined",
    decidedAt: decision.timestamp,
    ...(decision.actor === undefined ? {} : { decidedBy: decision.actor }),
    policyVersion: decision.policyVersion,
    policyDigest: decision.policyDigest,
  };
}

/**
 * Ontology Runtime / trusted-action contracts for #328 R2.
 *
 * This is a pure, fail-closed contract slice. It does not persist state,
 * talk to GitHub, or replace TurnRecord / Approval / Handoff. It names the
 * objects an Agent may query and the action/receipt loop an execution must
 * leave behind.
 */
export const SEMANTIC_RUNTIME_SCHEMA_VERSION = "semantic-runtime.v1alpha1" as const;
export const BUSINESS_OBJECT_REF_SCHEMA_VERSION = "business-object-ref.v1alpha1" as const;
export const EVIDENCE_REF_SCHEMA_VERSION = "evidence-ref.v1alpha1" as const;
export const DECISION_RECORD_SCHEMA_VERSION = "decision-record.v1alpha1" as const;
export const ACTION_PROPOSAL_SCHEMA_VERSION = "action-proposal.v1alpha1" as const;
export const EXECUTION_RECEIPT_SCHEMA_VERSION = "execution-receipt.v1alpha1" as const;

export const semanticObjectKinds = ["object", "relation", "metric", "event"] as const;
export type SemanticObjectKind = (typeof semanticObjectKinds)[number];

export const actionProposalStates = [
  "proposed",
  "approved",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "indeterminate",
] as const;
export type ActionProposalState = (typeof actionProposalStates)[number];

export interface BusinessObjectRef {
  schemaVersion: typeof BUSINESS_OBJECT_REF_SCHEMA_VERSION;
  kind: SemanticObjectKind;
  id: string;
  displayName: string;
  source: string;
  scope: string;
  timeRange?: { start: string; end: string };
  version: string;
  digest: string;
}

export interface EvidenceRef {
  schemaVersion: typeof EVIDENCE_REF_SCHEMA_VERSION;
  id: string;
  objectId: string;
  provenance: string;
  locator: string;
  digest: string;
  observedAt: string;
}

export interface DecisionRecord {
  schemaVersion: typeof DECISION_RECORD_SCHEMA_VERSION;
  id: string;
  objectId: string;
  conclusion: string;
  uncertainty: "low" | "medium" | "high";
  evidenceIds: string[];
  turnId: string;
  positionId: string;
}

export interface ActionProposal {
  schemaVersion: typeof ACTION_PROPOSAL_SCHEMA_VERSION;
  id: string;
  objectId: string;
  decisionId: string;
  intent: string;
  target: { kind: string; id: string; version: string };
  expectedEffect: string;
  preconditions: string[];
  permissionScope: string;
  approvalRequired: boolean;
  approvalId?: string;
  idempotencyKey: string;
  expiresAt: string;
  state: ActionProposalState;
}

export interface ExecutionReceipt {
  schemaVersion: typeof EXECUTION_RECEIPT_SCHEMA_VERSION;
  id: string;
  proposalId: string;
  turnId: string;
  positionId: string;
  actor: string;
  permissionReevaluated: boolean;
  targetVersionObserved: string;
  terminalState: Exclude<ActionProposalState, "proposed" | "approved" | "running">;
  externalId?: string;
  readback: { ok: boolean; exception?: string; observed: string };
}

const allowedActionTransitions: Readonly<Record<ActionProposalState, readonly ActionProposalState[]>> = {
  proposed: ["approved", "cancelled"],
  approved: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled", "indeterminate"],
  succeeded: [],
  failed: [],
  cancelled: [],
  indeterminate: [],
};

export function canTransitionAction(from: unknown, to: unknown): boolean {
  if (!actionProposalStates.includes(from as ActionProposalState) || !actionProposalStates.includes(to as ActionProposalState)) {
    return false;
  }
  return allowedActionTransitions[from as ActionProposalState].includes(to as ActionProposalState);
}

/** Succeeded is illegal without a successful readback or an explicit exception. */
export function receiptAllowsSucceeded(receipt: Pick<ExecutionReceipt, "terminalState" | "readback">): boolean {
  if (receipt.terminalState !== "succeeded") return false;
  return receipt.readback.ok === true || Boolean(receipt.readback.exception);
}

export function assertExecutable(proposal: ActionProposal, observedTargetVersion: string): string | null {
  if (proposal.state !== "approved") return "action_not_approved";
  if (proposal.approvalRequired && !proposal.approvalId) return "approval_missing";
  if (!proposal.permissionScope) return "permission_scope_missing";
  if (proposal.target.version !== observedTargetVersion) return "target_version_stale";
  const expiresAt = Date.parse(proposal.expiresAt);
  if (!Number.isFinite(expiresAt)) return "proposal_expiry_invalid";
  if (expiresAt <= Date.now()) return "proposal_expired";
  return null;
}

export function sameIdempotencyRetry(first: ActionProposal, retry: ActionProposal): boolean {
  return (
    first.idempotencyKey === retry.idempotencyKey &&
    first.id === retry.id &&
    first.target.id === retry.target.id &&
    first.target.version === retry.target.version
  );
}

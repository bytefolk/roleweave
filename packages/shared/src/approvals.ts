import type { ApprovalChangePreview } from "./approval-preview.js";
import type { ApprovalRequestedEvent, TurnEngine } from "./turns.js";

export type ApprovalStatus = "pending" | "granted" | "denied" | "expired" | "cancelled" | "indeterminate";
export type ApprovalPhase = "not_started" | "starting" | "running" | "completed" | "denied" | "failed" | "indeterminate";
export type ApprovalRiskLevel = "medium" | "high";
export type ApprovalImpactKind = "workspace_write" | "command_execution" | "external_network" | "restricted_tool";

/** Safe, request-time context projected from the engine action and position
 * policy. It deliberately carries enums and redacted summaries rather than
 * raw credentials, command arguments, or opaque engine payloads. */
export interface ApprovalContext {
  risk: ApprovalRiskLevel;
  requestedCapability: "exec" | "write" | "network" | "tool";
  parameterSummary?: string;
  impact: ApprovalImpactKind;
  permissions: {
    mode: "read_only" | "approval_required";
    allowedTools: string[];
    deniedTools: string[];
  };
  preview:
    | { status: "unavailable"; reason: "engine_preview_not_supplied" }
    | ({ status: "available" } & ApprovalChangePreview);
  scope: { allowed: Array<"once" | "run"> };
}

export interface ApprovalDecisionRequest {
  requestId: string;
  expectedVersion: number;
  decision: "granted" | "denied";
  scope: "once" | "run";
  reason?: string;
  /** The eligible principal whose policy authority this actor is exercising. */
  delegatedFrom?: string;
}

export interface ApprovalPolicySnapshot {
  version: string;
  digest: string;
  eligibleApprovers: string[];
  threshold: number;
  delegations: Record<string, string[]>;
  /** Explicit opt-in for #403. The server accepts only `tool` here; writes,
   * commands and network requests are never batchable by configuration. */
  batch?: { maxItems: number; actionKinds: Array<"tool"> };
  escalation?: { at: string; eligibleApprovers: string[]; threshold: number };
}
export interface ApprovalDecisionEvent {
  requestId: string;
  expectedVersion: number;
  decision: "granted" | "denied";
  scope: "once" | "run";
  actor: string;
  delegatedFrom?: string;
  reason?: string;
  decidedAt: string;
  /** Batch operation identity; individual requestId remains the idempotency
   * key and audit handle for this particular member. */
  batchId?: string;
}
export interface ApprovalPolicyProgress {
  required: number;
  granted: number;
  pending: number;
  escalated: boolean;
}
export interface ApprovalAuditEvent {
  approvalId: string;
  seq: number;
  timestamp: string;
  type: "requested" | "decision" | "escalated" | "decision_reverted";
  requestId?: string;
  actor?: string;
  delegatedFrom?: string;
  decision?: "granted" | "denied";
  scope?: "once" | "run";
  policyVersion: string;
  policyDigest: string;
  previousHash?: string;
  hash: string;
  batchId?: string;
  /** The decision request invalidated by an append-only batch rollback. */
  revertedRequestId?: string;
}
export interface ApprovalRecord {
  schemaVersion: "workbench-approval.v1" | "workbench-approval.v2";
  id: string;
  version: number;
  approvalId: string;
  source: {
    kind: "session" | "position" | "group";
    positionId: string;
    conversationId: string;
    turnId: string;
    runId: string;
    engine: TurnEngine;
  };
  action: ApprovalRequestedEvent["action"];
  context?: ApprovalContext;
  requestReason?: string;
  requestedAt: string;
  expiresAt?: string;
  status: ApprovalStatus;
  decision?: ApprovalDecisionRequest & { decidedBy: "operator"; decidedAt: string };
  policy?: ApprovalPolicySnapshot;
  decisions?: ApprovalDecisionEvent[];
  progress?: ApprovalPolicyProgress;
  execution: { phase: ApprovalPhase; turnId?: string; errorCode?: string };
  createdAt: string;
  updatedAt: string;
}
export interface ApprovalView extends Omit<ApprovalRecord, "policy" | "decisions" | "schemaVersion"> {
  schemaVersion: "workbench-approval.v1";
  canDecide: boolean;
  unavailableReason?: string;
  /** Server-projected, non-sensitive #403 classification. Absence means this
   * item must stay a single approval; it never exposes policy rosters. */
  batch?: { maxItems: number };
}
export interface ApprovalList {
  items: ApprovalView[];
  nextCursor: string | null;
  pendingCount: number;
  revision: string;
  syncState: "ready";
  /** Opaque instance token, invalidated even by reopening the same directory. */
  workspaceToken: string;
}

/** Server-only batch input. Every member retains its own optimistic version;
 * the outer requestId makes retries stable without reusing a single-item
 * decision id. */
export interface ApprovalBatchDecisionRequest {
  requestId: string;
  decision: "granted";
  reason?: string;
  items: Array<{ id: string; expectedVersion: number }>;
}

export interface ApprovalBatchDecisionResult {
  id: string;
  status: "accepted" | "rejected";
  record?: ApprovalView;
  code?: string;
  message?: string;
}

export interface ApprovalBatchDecisionResponse {
  requestId: string;
  items: ApprovalBatchDecisionResult[];
}

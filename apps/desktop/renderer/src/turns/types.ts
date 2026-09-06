export type TurnEngine = "qoder" | "claude-code" | "claude-local";

export type TurnStatus = "running" | "completed" | "failed" | "indeterminate";

/** User-safe milestones for the conversation view. This deliberately carries
 * no model chain-of-thought or raw engine event payloads. */
export type TurnProgressKind =
  | "received"
  | "working"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "unknown";

export interface TurnProgressStep {
  kind: TurnProgressKind;
  at: string;
}

export interface PositionMentionOption {
  id: string;
  name: string;
}

export interface TurnEngineAvailability {
  configured: boolean;
  ready: boolean;
  reason?: string;
}

/** Renderer projection of the #193 verdict field (engine shape verbatim). */
export interface TurnPendingApprovalInput {
  approvalId: string;
  decision: "granted" | "denied";
  decidedBy: "operator";
  scope?: "once" | "run";
  reason?: string;
  expiresAt?: string;
}

/** Approval request awaiting an operator verdict, projected from the
 * persisted record's approval.requested event (#187 mirror). */
export interface TurnApprovalRequest {
  approvalId: string;
  kind: string;
  description: string;
  target?: string;
  expiresAt?: string;
}

export interface TurnRecord {
  id: string;
  positionId: string;
  positionName: string;
  engine: TurnEngine;
  input: string;
  status: TurnStatus;
  createdAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
  /** Engine runId when the server record carries one; keys live-stream dedupe. */
  runId?: string;
  /** Live engine-reported usage; present only on provisional live rows. */
  totalTokens?: number;
  envelopeDigest?: string;
  evidenceDigest?: string;
  retryOf?: string;
  /** Present when the turn settled as engine.approval_required. */
  approvalRequest?: TurnApprovalRequest;
  /** Safe, high-level execution milestones derived from server-owned events. */
  progress?: TurnProgressStep[];
}

export interface CreateTurnRequest {
  positionId: string;
  engine: TurnEngine;
  input: string;
  /** A retry always starts a new turn. This is provenance, never an id to mutate. */
  retryOf?: string;
  /** Operator verdict for a resume turn (#187 Option 1 terminal-and-resume). */
  pendingApproval?: TurnPendingApprovalInput;
}

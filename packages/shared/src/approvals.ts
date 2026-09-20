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
}
export interface ApprovalRecord {
  schemaVersion: "workbench-approval.v1";
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
  execution: { phase: ApprovalPhase; turnId?: string; errorCode?: string };
  createdAt: string;
  updatedAt: string;
}
export interface ApprovalView extends ApprovalRecord {
  canDecide: boolean;
  unavailableReason?: string;
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

import type { ApprovalRequestedEvent, TurnEngine } from "./turns.js";

export type ApprovalStatus = "pending" | "granted" | "denied" | "expired" | "cancelled" | "indeterminate";
export type ApprovalPhase = "not_started" | "starting" | "running" | "completed" | "denied" | "failed" | "indeterminate";
export interface ApprovalDecisionRequest {
  requestId: string;
  expectedVersion: number;
  decision: "granted" | "denied";
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
  requestReason?: string;
  requestedAt: string;
  expiresAt?: string;
  status: ApprovalStatus;
  decision?: ApprovalDecisionRequest & { decidedBy: "operator"; decidedAt: string; scope: "once" };
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

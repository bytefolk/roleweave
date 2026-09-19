/**
 * ApprovalQueue (design spec §5 · 审批/越权事件队列) client display model.
 *
 * Contract boundary (do not invent vocabulary, only project):
 *   - `approvalId / action.kind / action.description / action.target / expiresAt`
 *     come from engine.v1 `approval.requested` (see packages/shared/turns.ts
 *     `ApprovalRequestedEvent`, mirroring #187).
 *   - `mode / toolAllow / toolDeny` come from org-permissions.v1 (from
 *     `GET /positions/:id` -> `PositionCardData.permissions` + `mode`).
 *   - decision and execution state are projected from GET /approvals.
 *     The callback id is the workbench record id (not the engine approvalId).
 *     The server alone constructs the resume-turn envelope.
 */
import type { TurnApprovalActionKind } from "@roleweave/shared";
import { zhText } from "@roleweave/ui";

export type ApprovalCategory = TurnApprovalActionKind;

export type ApprovalDecisionState =
  | { kind: "pending" }
  | { kind: "granted"; scope: "once" | "run"; decidedAt?: string }
  | { kind: "denied"; reason?: string; decidedAt?: string }
  | { kind: "expired" | "cancelled" | "indeterminate" };

export interface ApprovalQueueItem {
  canDecide?: boolean;
  busy?: boolean;
  error?: string;
  unavailableReason?: string;
  executionPhase?: import("@roleweave/shared").ApprovalPhase;
  requestReason?: string;
  approvalId: string;
  positionId: string;
  positionName?: string;
  positionMode?: "read_only" | "approval_required";
  category: ApprovalCategory;
  description: string;
  target?: string;
  requestedAt?: string;
  expiresAt?: string;
  /** Snapshot of the position permissions.toolDeny list; only used for the
   * overreach badge. Omit or leave empty to disable the check. */
  toolDeny?: string[];
  /** Concrete tool key the request is asking for; compared against toolDeny.
   * Absent means "cannot judge by toolDeny; fall back to mode-only rule". */
  requestedTool?: string;
  decision: ApprovalDecisionState;
}

export interface ApprovalQueueCallbacks {
  /** granted defaults to scope=once (contract default per §5.1); reason optional. */
  onApprove: (approvalId: string, reason?: string) => void;
  /** denied MUST allow an empty reason (contract permits absent reason). */
  onDeny: (approvalId: string, reason?: string) => void;
}

/** #146：展示词面走 apr.kind.* 目录；该导出以 zh 目录为源保持旧值。 */
export const APPROVAL_CATEGORY_LABEL: Record<ApprovalCategory, string> = {
  exec: zhText("apr.kind.exec"),
  write: zhText("apr.kind.write"),
  network: zhText("apr.kind.network"),
  tool: zhText("apr.kind.tool"),
};

/**
 * Overreach detection (conservative):
 *   1) `read_only` position asks for write/network/exec -> overreach;
 *   2) `requestedTool` hits `toolDeny` -> overreach;
 *   3) otherwise cannot judge -> return false (no guessing).
 */
export function isPermissionOverreach(item: ApprovalQueueItem): boolean {
  if (
    item.positionMode === "read_only" &&
    (item.category === "write" || item.category === "network" || item.category === "exec")
  ) {
    return true;
  }
  if (item.requestedTool && item.toolDeny?.includes(item.requestedTool)) {
    return true;
  }
  return false;
}

export function isDecided(item: ApprovalQueueItem): boolean {
  return item.decision.kind !== "pending";
}

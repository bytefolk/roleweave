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
import type { ApprovalContext, ApprovalPolicyProgress, ApprovalRecord, TurnApprovalActionKind } from "@roleweave/shared";
import { zhText } from "@roleweave/ui";

export type ApprovalCategory = TurnApprovalActionKind;

export type ApprovalDecisionState =
  | { kind: "pending" }
  | { kind: "granted"; scope: "once" | "run"; decidedAt?: string; decidedBy?: string; reason?: string }
  | { kind: "denied"; reason?: string; decidedAt?: string; decidedBy?: string }
  | { kind: "expired" | "cancelled" | "indeterminate" };

/** Display-only deadline state. The server remains authoritative for the
 * persisted decision; this merely prevents a stale pending item from being
 * submitted after its declared deadline. */
export type ApprovalExpiryState = "active" | "expiring" | "expired";

export type ApprovalSource = ApprovalRecord["source"];

export interface ApprovalQueueItem {
  canDecide?: boolean;
  busy?: boolean;
  error?: string;
  unavailableReason?: string;
  executionPhase?: import("@roleweave/shared").ApprovalPhase;
  requestReason?: string;
  context?: ApprovalContext;
  /** Aggregate policy state only; candidate identities are intentionally not
   * projected into the approval queue. */
  policyProgress?: ApprovalPolicyProgress;
  source?: ApprovalSource;
  executionTurnId?: string;
  executionErrorCode?: string;
  approvalId: string;
  positionId: string;
  positionName?: string;
  positionMode?: "read_only" | "approval_required";
  category: ApprovalCategory;
  description: string;
  target?: string;
  /** The server's projection of the engine-declared eligible grant scopes. */
  scopeAllowed?: Array<"once" | "run">;
  /** Non-sensitive server projection: this member is policy-classified for a
   * restricted-tool batch, subject to final source/version checks at submit time. */
  batchMaxItems?: number;
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
  /** granted defaults to scope=once; run is available only when the server
   * projected it as eligible. */
  onApprove: (approvalId: string, reason?: string, scope?: "once" | "run") => void;
  /** denied MUST allow an empty reason (contract permits absent reason). */
  onDeny: (approvalId: string, reason?: string) => void;
  onApproveBatch?: (approvalIds: string[]) => void;
  /** Open the persisted source conversation when the source is addressable. */
  onOpenSource?: (item: ApprovalQueueItem) => void;
  /** Open the reports surface; it may still be empty when no receipt exists. */
  onOpenEvidence?: (item: ApprovalQueueItem) => void;
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

/**
 * A local deadline makes a pending record non-actionable before the next
 * authoritative server snapshot persists its expired status. Keep this
 * projection separate from `isDecided`: expiry is not an operator verdict.
 */
export function isActionablePending(item: ApprovalQueueItem, now: number): boolean {
  return item.decision.kind === "pending" && approvalExpiryState(item, now) !== "expired";
}

/**
 * Project an approval deadline against a caller-supplied clock. Keeping the
 * clock outside this helper lets the queue, card, and detail drawer update in
 * lockstep on the same minute tick.
 */
export function approvalExpiryState(item: ApprovalQueueItem, now: number): ApprovalExpiryState {
  if (item.decision.kind === "expired") return "expired";
  if (item.decision.kind !== "pending" || !item.expiresAt) return "active";
  const expiresAt = Date.parse(item.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return "expired";
  if (expiresAt <= now + 24 * 60 * 60 * 1000) return "expiring";
  return "active";
}

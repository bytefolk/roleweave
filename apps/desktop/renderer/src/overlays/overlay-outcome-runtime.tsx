import { useEffect } from "react";
import {
  OVERLAY_ACTION_OUTCOME,
  persistOverlayActionOutcome,
  type OverlayActionOutcomeDetail,
} from "./overlay-receipt-store.js";

export type OverlayPendingSource = "turn" | "approval";

export type OverlayBranchIdentity = {
  positionId: string;
  sessionId: string;
};

/** Clicked processing action waiting for a real system terminal event. */
export type OverlayPendingAction = {
  workspaceKey: string;
  itemId: string;
  actionId: string;
  source: OverlayPendingSource;
  branches: OverlayBranchIdentity[];
  /** Bound from the first future matching turn.started. */
  turnId?: string;
  /** Bound from the approval the operator actually decided. */
  approvalId?: string;
};

export type OverlayApprovalSource = {
  positionId: string;
  conversationId: string;
  turnId?: string;
};

const pending = new Map<string, OverlayPendingAction>();

export function overlayPendingKey(workspaceKey: string, itemId: string, actionId: string): string {
  return `${workspaceKey}\0${itemId}\0${actionId}`;
}

function isUnbound(action: OverlayPendingAction): boolean {
  return action.source === "turn" ? !action.turnId : !action.approvalId;
}

function validBranches(branches: OverlayBranchIdentity[] | undefined): OverlayBranchIdentity[] {
  if (!branches || branches.length === 0) return [];
  const next: OverlayBranchIdentity[] = [];
  for (const branch of branches) {
    if (!branch.positionId || !branch.sessionId) continue;
    next.push({ positionId: branch.positionId, sessionId: branch.sessionId });
  }
  return next;
}

function branchMatches(action: OverlayPendingAction, identity: OverlayBranchIdentity): boolean {
  return action.branches.some(
    (branch) => branch.positionId === identity.positionId && branch.sessionId === identity.sessionId,
  );
}

export function registerPendingOverlayAction(action: OverlayPendingAction): void {
  if (!action.workspaceKey || !action.itemId || !action.actionId) return;
  const branches = validBranches(action.branches);
  if (branches.length === 0) return;
  const next: OverlayPendingAction = {
    ...action,
    branches,
    turnId: action.source === "turn" ? undefined : action.turnId,
    approvalId: action.source === "approval" ? undefined : action.approvalId,
  };
  const nextKey = overlayPendingKey(next.workspaceKey, next.itemId, next.actionId);
  for (const [key, existing] of [...pending.entries()]) {
    if (key === nextKey) continue;
    if (existing.workspaceKey !== next.workspaceKey || existing.source !== next.source) continue;
    if (!isUnbound(existing)) continue;
    pending.delete(key);
  }
  pending.set(nextKey, next);
}

export function resetOverlayOutcomeRuntimeForTests(): void {
  pending.clear();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function writePending(action: OverlayPendingAction): void {
  pending.set(overlayPendingKey(action.workspaceKey, action.itemId, action.actionId), action);
}

/** Fail-closed: bind only when exactly one unbound pending matches this branch. */
function uniqueUnbound(
  workspaceKey: string,
  source: OverlayPendingSource,
  identity: OverlayBranchIdentity,
): OverlayPendingAction | undefined {
  const matches = [...pending.values()].filter(
    (action) =>
      action.workspaceKey === workspaceKey &&
      action.source === source &&
      isUnbound(action) &&
      branchMatches(action, identity),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function existingBound(
  workspaceKey: string,
  source: OverlayPendingSource,
  idField: "turnId" | "approvalId",
  id: string,
): OverlayPendingAction | undefined {
  return [...pending.values()].find(
    (action) => action.workspaceKey === workspaceKey && action.source === source && action[idField] === id,
  );
}

/**
 * Bind an operator decision to the single pending open-approvals whose
 * stored branch identities uniquely match ApprovalView.source.
 * The same approvalId stays on one origin; retries do not fan out.
 */
export function bindOverlayApprovalDecision(
  workspaceKey: string | undefined,
  approvalId: string,
  source: OverlayApprovalSource,
): OverlayPendingAction | undefined {
  if (!workspaceKey || !approvalId || !source.positionId || !source.conversationId) return undefined;
  const already = existingBound(workspaceKey, "approval", "approvalId", approvalId);
  if (already) return already;
  const match = uniqueUnbound(workspaceKey, "approval", {
    positionId: source.positionId,
    sessionId: source.conversationId,
  });
  if (!match) return undefined;
  const bound = { ...match, approvalId };
  writePending(bound);
  return bound;
}

function bindTurnStarted(event: {
  workspaceKey: string;
  turnId?: string;
  positionId?: string;
  sessionId?: string;
}): void {
  if (!event.turnId || !event.positionId || !event.sessionId) return;
  if (existingBound(event.workspaceKey, "turn", "turnId", event.turnId)) return;
  const match = uniqueUnbound(event.workspaceKey, "turn", {
    positionId: event.positionId,
    sessionId: event.sessionId,
  });
  if (!match) return;
  writePending({ ...match, turnId: event.turnId });
}

function settleExact(
  workspaceKey: string,
  source: OverlayPendingSource,
  idField: "turnId" | "approvalId",
  id: string,
  ok: boolean,
): void {
  const action = existingBound(workspaceKey, source, idField, id);
  if (!action) return;
  persistOverlayActionOutcome(action.workspaceKey, action.itemId, action.actionId, ok);
  pending.delete(overlayPendingKey(action.workspaceKey, action.itemId, action.actionId));
}

/**
 * Map an existing control-plane SSE envelope onto pending overlay actions.
 * Unbound pending actions are not settled by old or workspace-wide terminals.
 */
export function consumeOverlaySystemEvent(raw: unknown, fallbackWorkspaceKey?: string): void {
  if (!raw || typeof raw !== "object") return;
  const envelope = raw as { type?: unknown; payload?: unknown };
  const type = typeof envelope.type === "string" ? envelope.type : undefined;
  if (!type) return;
  const payload =
    envelope.payload && typeof envelope.payload === "object"
      ? (envelope.payload as Record<string, unknown>)
      : {};
  const workspaceKey = asString(payload.workspacePath) ?? fallbackWorkspaceKey;
  if (!workspaceKey) return;
  const turnId = asString(payload.turnId);
  const approvalId = asString(payload.approvalId);
  const positionId = asString(payload.positionId);
  const sessionId = asString(payload.sessionId);

  if (type === "turn.started") {
    bindTurnStarted({ workspaceKey, turnId, positionId, sessionId });
    return;
  }
  if (type === "turn.completed" || type === "turn.failed" || type === "turn.indeterminate") {
    if (!turnId) return;
    settleExact(workspaceKey, "turn", "turnId", turnId, type === "turn.completed");
    return;
  }
  if (type === "turn.approval.granted" || type === "turn.approval.denied") {
    if (!approvalId) return;
    settleExact(workspaceKey, "approval", "approvalId", approvalId, type === "turn.approval.granted");
  }
}

/** Typed-outcome bus only. SSE consumption belongs on App's existing onEvent. */
export function OverlayOutcomeRuntime({ workspaceKey }: { workspaceKey?: string }) {
  useEffect(() => {
    const onOutcome = (event: Event) => {
      const detail = (event as CustomEvent<OverlayActionOutcomeDetail>).detail;
      if (!detail?.itemId || !detail.actionId || typeof detail.ok !== "boolean") return;
      persistOverlayActionOutcome(
        detail.workspaceKey ?? workspaceKey,
        detail.itemId,
        detail.actionId,
        detail.ok,
      );
    };
    window.addEventListener(OVERLAY_ACTION_OUTCOME, onOutcome);
    return () => {
      window.removeEventListener(OVERLAY_ACTION_OUTCOME, onOutcome);
    };
  }, [workspaceKey]);
  return null;
}

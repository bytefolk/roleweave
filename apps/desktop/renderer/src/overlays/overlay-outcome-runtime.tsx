import { useEffect } from "react";
import {
  OVERLAY_ACTION_OUTCOME,
  persistOverlayActionOutcome,
  type OverlayActionOutcomeDetail,
} from "./overlay-receipt-store.js";

export type OverlayPendingSource = "turn" | "approval";

/** Clicked processing action waiting for a real system terminal event. */
export type OverlayPendingAction = {
  workspaceKey: string;
  itemId: string;
  actionId: string;
  source: OverlayPendingSource;
  positionId?: string;
  sessionId?: string;
  /** Bound from the first future matching turn.started. */
  turnId?: string;
  /** Bound from the approval the operator actually decided. */
  approvalId?: string;
};

const pending = new Map<string, OverlayPendingAction>();

export function overlayPendingKey(workspaceKey: string, itemId: string, actionId: string): string {
  return `${workspaceKey}\0${itemId}\0${actionId}`;
}

export function registerPendingOverlayAction(action: OverlayPendingAction): void {
  if (!action.workspaceKey || !action.itemId || !action.actionId) return;
  pending.set(overlayPendingKey(action.workspaceKey, action.itemId, action.actionId), {
    ...action,
    turnId: action.source === "turn" ? undefined : action.turnId,
    approvalId: action.source === "approval" ? undefined : action.approvalId,
  });
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

function mostRecentUnbound(
  workspaceKey: string,
  source: OverlayPendingSource,
  matches: (action: OverlayPendingAction) => boolean,
): OverlayPendingAction | undefined {
  const items = [...pending.values()].reverse();
  return items.find(
    (action) =>
      action.workspaceKey === workspaceKey &&
      action.source === source &&
      (source === "turn" ? !action.turnId : !action.approvalId) &&
      matches(action),
  );
}

/**
 * Bind the most recently clicked unbound open-approvals pending in this
 * workspace to the approval the operator actually decided. Workspace-level
 * approval SSE without this id does not settle any Goal.
 */
export function bindOverlayApprovalDecision(
  workspaceKey: string | undefined,
  approvalId: string,
): OverlayPendingAction | undefined {
  if (!workspaceKey || !approvalId) return undefined;
  const match = mostRecentUnbound(workspaceKey, "approval", () => true);
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
  if (!event.turnId || !event.positionId) return;
  const match = mostRecentUnbound(event.workspaceKey, "turn", (action) => {
    if (!action.positionId || action.positionId !== event.positionId) return false;
    if (action.sessionId && action.sessionId !== event.sessionId) return false;
    return true;
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
  for (const [key, action] of [...pending.entries()]) {
    if (action.workspaceKey !== workspaceKey) continue;
    if (action.source !== source) continue;
    if (action[idField] !== id) continue;
    persistOverlayActionOutcome(action.workspaceKey, action.itemId, action.actionId, ok);
    pending.delete(key);
  }
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

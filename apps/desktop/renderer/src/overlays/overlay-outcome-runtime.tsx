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
  turnId?: string;
};

const pending = new Map<string, OverlayPendingAction>();

export function overlayPendingKey(workspaceKey: string, itemId: string, actionId: string): string {
  return `${workspaceKey}\0${itemId}\0${actionId}`;
}

export function registerPendingOverlayAction(action: OverlayPendingAction): void {
  if (!action.workspaceKey || !action.itemId || !action.actionId) return;
  pending.set(overlayPendingKey(action.workspaceKey, action.itemId, action.actionId), action);
}

export function resetOverlayOutcomeRuntimeForTests(): void {
  pending.clear();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function matchesCorrelation(
  action: OverlayPendingAction,
  event: { positionId?: string; sessionId?: string; turnId?: string },
): boolean {
  if (action.sessionId && action.sessionId !== event.sessionId) return false;
  if (action.positionId && action.positionId !== event.positionId) return false;
  if (action.turnId && action.turnId !== event.turnId) return false;
  return true;
}

/**
 * Map an existing control-plane SSE envelope onto pending overlay actions.
 * Association is workspaceKey + itemId + actionId, held in the pending registry
 * from the click — not inferred from the overlay detail panel.
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

  let source: OverlayPendingSource | undefined;
  let ok: boolean | undefined;
  if (type === "turn.completed") {
    source = "turn";
    ok = true;
  } else if (type === "turn.failed" || type === "turn.indeterminate") {
    source = "turn";
    ok = false;
  } else if (type === "turn.approval.granted") {
    source = "approval";
    ok = true;
  } else if (type === "turn.approval.denied") {
    source = "approval";
    ok = false;
  } else {
    return;
  }

  const eventCorr = {
    positionId: asString(payload.positionId),
    sessionId: asString(payload.sessionId),
    turnId: asString(payload.turnId),
  };

  for (const [key, action] of [...pending.entries()]) {
    if (action.workspaceKey !== workspaceKey) continue;
    if (action.source !== source) continue;
    if (!matchesCorrelation(action, eventCorr)) continue;
    persistOverlayActionOutcome(action.workspaceKey, action.itemId, action.actionId, ok);
    pending.delete(key);
  }
}

/** App/workspace-lifetime listener. Must outlive Goals/Reports detail panels. */
export function OverlayOutcomeRuntime({ workspaceKey }: { workspaceKey?: string }) {
  useEffect(() => {
    const subscribe = window.owb?.onEvent;
    const offEvent =
      typeof subscribe === "function"
        ? subscribe((raw) => consumeOverlaySystemEvent(raw, workspaceKey))
        : undefined;
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
      offEvent?.();
      window.removeEventListener(OVERLAY_ACTION_OUTCOME, onOutcome);
    };
  }, [workspaceKey]);
  return null;
}

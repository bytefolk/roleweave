import { describe, expect, it, afterEach } from "vitest";
import {
  bindOverlayApprovalDecision,
  consumeOverlaySystemEvent,
  registerPendingOverlayAction,
  resetOverlayOutcomeRuntimeForTests,
} from "../src/overlays/overlay-outcome-runtime";
import {
  readOverlayReceipts,
  resetOverlayReceiptStoreForTests,
} from "../src/overlays/overlay-receipt-store";
import { hasMixedActionOutcomes, isOverlayResolved, splitActionOutcomes } from "../src/overlays/overlay-receipts";

afterEach(() => {
  resetOverlayOutcomeRuntimeForTests();
  resetOverlayReceiptStoreForTests();
  window.localStorage?.clear?.();
});

describe("overlay outcome runtime", () => {
  it("does not consume an unbound or stale turn terminal", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-turn",
      source: "turn",
      positionId: "owner",
      sessionId: "sess-1",
    });
    consumeOverlaySystemEvent({
      type: "turn.completed",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "old-turn" },
    });
    consumeOverlaySystemEvent({
      type: "turn.completed",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1" },
    });
    expect(readOverlayReceipts("ws-a", "goal:one").receipts).toEqual([]);
  });

  it("writes only after turn.started binds the exact turnId", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-turn",
      source: "turn",
      positionId: "owner",
    });
    consumeOverlaySystemEvent({
      type: "turn.started",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "turn-new" },
    });
    consumeOverlaySystemEvent({
      type: "turn.completed",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "old-turn" },
    });
    expect(readOverlayReceipts("ws-a", "goal:one").receipts).toEqual([]);
    consumeOverlaySystemEvent({
      type: "turn.completed",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "turn-new" },
    });
    expect(splitActionOutcomes(readOverlayReceipts("ws-a", "goal:one"))).toEqual([
      { actionId: "open-turn", outcome: "action_succeeded" },
    ]);
  });

  it("settles only the item bound to the decided approvalId", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-approvals",
      source: "approval",
    });
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:two",
      actionId: "open-approvals",
      source: "approval",
    });
    consumeOverlaySystemEvent({
      type: "turn.approval.denied",
      payload: { workspacePath: "ws-a", approvalId: "apr-1" },
    });
    expect(readOverlayReceipts("ws-a", "goal:one").receipts).toEqual([]);
    expect(readOverlayReceipts("ws-a", "goal:two").receipts).toEqual([]);

    expect(bindOverlayApprovalDecision("ws-a", "apr-1")?.itemId).toBe("goal:two");
    consumeOverlaySystemEvent({
      type: "turn.approval.denied",
      payload: { workspacePath: "ws-a", approvalId: "apr-1" },
    });
    expect(readOverlayReceipts("ws-a", "goal:one").receipts).toEqual([]);
    expect(splitActionOutcomes(readOverlayReceipts("ws-a", "goal:two"))).toEqual([
      { actionId: "open-approvals", outcome: "action_failed" },
    ]);
    expect(isOverlayResolved(readOverlayReceipts("ws-a", "goal:two"))).toBe(false);
  });

  it("persists mixed split from exact turn and approval terminals without auto-resolve", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-turn",
      source: "turn",
      positionId: "owner",
      sessionId: "sess-1",
    });
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-approvals",
      source: "approval",
    });
    consumeOverlaySystemEvent({
      type: "turn.started",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "turn-new" },
    });
    consumeOverlaySystemEvent({
      type: "turn.completed",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "turn-new" },
    });
    bindOverlayApprovalDecision("ws-a", "apr-1");
    consumeOverlaySystemEvent({
      type: "turn.approval.denied",
      payload: { workspacePath: "ws-a", approvalId: "apr-1" },
    });
    const item = readOverlayReceipts("ws-a", "goal:one");
    expect(splitActionOutcomes(item)).toEqual([
      { actionId: "open-turn", outcome: "action_succeeded" },
      { actionId: "open-approvals", outcome: "action_failed" },
    ]);
    expect(hasMixedActionOutcomes(item)).toBe(true);
    expect(isOverlayResolved(item)).toBe(false);
  });
});

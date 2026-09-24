import { describe, expect, it, afterEach } from "vitest";
import {
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
  it("persists turn and approval terminals by workspaceKey+itemId+actionId without a panel", () => {
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
      type: "turn.completed",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1" },
    });
    consumeOverlaySystemEvent({
      type: "turn.approval.denied",
      payload: { workspacePath: "ws-a" },
    });

    const item = readOverlayReceipts("ws-a", "goal:one");
    expect(splitActionOutcomes(item)).toEqual([
      { actionId: "open-turn", outcome: "action_succeeded" },
      { actionId: "open-approvals", outcome: "action_failed" },
    ]);
    expect(hasMixedActionOutcomes(item)).toBe(true);
    expect(isOverlayResolved(item)).toBe(false);
  });

  it("ignores terminals that do not match the pending action correlation", () => {
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
      payload: { workspacePath: "ws-a", positionId: "other", sessionId: "sess-9" },
    });
    consumeOverlaySystemEvent({
      type: "turn.completed",
      payload: { workspacePath: "ws-b", positionId: "owner", sessionId: "sess-1" },
    });
    expect(readOverlayReceipts("ws-a", "goal:one").receipts).toEqual([]);
  });
});

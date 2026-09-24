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

  it("writes only after turn.started uniquely binds the exact turnId", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-turn",
      source: "turn",
      positionId: "owner",
      sessionId: "sess-1",
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

  it("settles only the goal whose branch identity uniquely matches the approval source", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-approvals",
      source: "approval",
      positionId: "owner",
      sessionId: "sess-1",
    });
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:two",
      actionId: "open-approvals",
      source: "approval",
      positionId: "other",
      sessionId: "sess-2",
    });
    expect(
      bindOverlayApprovalDecision("ws-a", "apr-1", {
        positionId: "owner",
        conversationId: "sess-1",
      })?.itemId,
    ).toBe("goal:one");
    consumeOverlaySystemEvent({
      type: "turn.approval.denied",
      payload: { workspacePath: "ws-a", approvalId: "apr-1" },
    });
    expect(splitActionOutcomes(readOverlayReceipts("ws-a", "goal:one"))).toEqual([
      { actionId: "open-approvals", outcome: "action_failed" },
    ]);
    expect(readOverlayReceipts("ws-a", "goal:two").receipts).toEqual([]);
  });

  it("does not bind when the approval source matches zero or many branches", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-approvals",
      source: "approval",
      positionId: "owner",
      sessionId: "sess-1",
    });
    expect(
      bindOverlayApprovalDecision("ws-a", "apr-none", {
        positionId: "stranger",
        conversationId: "sess-9",
      }),
    ).toBeUndefined();
    expect(readOverlayReceipts("ws-a", "goal:one").receipts).toEqual([]);
  });

  it("supersedes an old unbound origin sharing the same destination", () => {
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
      itemId: "goal:two",
      actionId: "open-turn",
      source: "turn",
      positionId: "owner",
      sessionId: "sess-1",
    });
    consumeOverlaySystemEvent({
      type: "turn.started",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "turn-new" },
    });
    consumeOverlaySystemEvent({
      type: "turn.completed",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "turn-new" },
    });
    expect(readOverlayReceipts("ws-a", "goal:one").receipts).toEqual([]);
    expect(splitActionOutcomes(readOverlayReceipts("ws-a", "goal:two"))).toEqual([
      { actionId: "open-turn", outcome: "action_succeeded" },
    ]);
  });

  it("does not let a superseded pending bind on a later action", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-approvals",
      source: "approval",
      positionId: "owner",
      sessionId: "sess-1",
    });
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:two",
      actionId: "open-approvals",
      source: "approval",
      positionId: "owner",
      sessionId: "sess-1",
    });
    expect(
      bindOverlayApprovalDecision("ws-a", "apr-later", {
        positionId: "owner",
        conversationId: "sess-1",
      })?.itemId,
    ).toBe("goal:two");
    consumeOverlaySystemEvent({
      type: "turn.approval.granted",
      payload: { workspacePath: "ws-a", approvalId: "apr-later" },
    });
    expect(readOverlayReceipts("ws-a", "goal:one").receipts).toEqual([]);
    expect(splitActionOutcomes(readOverlayReceipts("ws-a", "goal:two"))).toEqual([
      { actionId: "open-approvals", outcome: "action_succeeded" },
    ]);
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
      positionId: "owner",
      sessionId: "sess-1",
    });
    consumeOverlaySystemEvent({
      type: "turn.started",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "turn-new" },
    });
    consumeOverlaySystemEvent({
      type: "turn.completed",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "turn-new" },
    });
    bindOverlayApprovalDecision("ws-a", "apr-1", { positionId: "owner", conversationId: "sess-1" });
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

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

const destA = [{ positionId: "owner", sessionId: "sess-1" }];
const destB = [{ positionId: "other", sessionId: "sess-2" }];

describe("overlay outcome runtime", () => {
  it("does not consume an unbound or stale turn terminal", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-turn",
      source: "turn",
      branches: destA,
    });
    consumeOverlaySystemEvent({
      type: "turn.completed",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "old-turn" },
    });
    expect(readOverlayReceipts("ws-a", "goal:one").receipts).toEqual([]);
  });

  it("writes only after turn.started uniquely binds the exact turnId", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-turn",
      source: "turn",
      branches: destA,
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
      branches: destA,
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
  });

  it("does not bind a leftover origin after a later goal becomes the active origin", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-approvals",
      source: "approval",
      branches: destA,
    });
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:two",
      actionId: "open-approvals",
      source: "approval",
      branches: destB,
    });
    expect(
      bindOverlayApprovalDecision("ws-a", "apr-stale", {
        positionId: "owner",
        conversationId: "sess-1",
      }),
    ).toBeUndefined();
    expect(
      bindOverlayApprovalDecision("ws-a", "apr-b", {
        positionId: "other",
        conversationId: "sess-2",
      })?.itemId,
    ).toBe("goal:two");
    consumeOverlaySystemEvent({
      type: "turn.approval.granted",
      payload: { workspacePath: "ws-a", approvalId: "apr-b" },
    });
    expect(readOverlayReceipts("ws-a", "goal:one").receipts).toEqual([]);
    expect(splitActionOutcomes(readOverlayReceipts("ws-a", "goal:two"))).toEqual([
      { actionId: "open-approvals", outcome: "action_succeeded" },
    ]);
  });

  it("does not bind when the approval source matches no branch", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-approvals",
      source: "approval",
      branches: destA,
    });
    expect(
      bindOverlayApprovalDecision("ws-a", "apr-none", {
        positionId: "stranger",
        conversationId: "sess-9",
      }),
    ).toBeUndefined();
    expect(readOverlayReceipts("ws-a", "goal:one").receipts).toEqual([]);
  });

  it("keeps a failed approval retry on one origin instead of fanning out", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-approvals",
      source: "approval",
      branches: destA,
    });
    expect(
      bindOverlayApprovalDecision("ws-a", "apr-1", {
        positionId: "owner",
        conversationId: "sess-1",
      })?.itemId,
    ).toBe("goal:one");
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:two",
      actionId: "open-approvals",
      source: "approval",
      branches: destA,
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

  it("does not rebind a new pending when turn.started replays an occupied turnId", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-turn",
      source: "turn",
      branches: destA,
    });
    consumeOverlaySystemEvent({
      type: "turn.started",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "turn-new" },
    });
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:two",
      actionId: "open-turn",
      source: "turn",
      branches: destA,
    });
    consumeOverlaySystemEvent({
      type: "turn.started",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "turn-new" },
    });
    consumeOverlaySystemEvent({
      type: "turn.completed",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "turn-new" },
    });
    expect(splitActionOutcomes(readOverlayReceipts("ws-a", "goal:one"))).toEqual([
      { actionId: "open-turn", outcome: "action_succeeded" },
    ]);
    expect(readOverlayReceipts("ws-a", "goal:two").receipts).toEqual([]);
  });

  it("does not let a superseded turn pending bind the next unrelated turn", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-turn",
      source: "turn",
      branches: destA,
    });
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:two",
      actionId: "open-turn",
      source: "turn",
      branches: destB,
    });
    consumeOverlaySystemEvent({
      type: "turn.started",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "turn-old-origin" },
    });
    consumeOverlaySystemEvent({
      type: "turn.completed",
      payload: { workspacePath: "ws-a", positionId: "owner", sessionId: "sess-1", turnId: "turn-old-origin" },
    });
    expect(readOverlayReceipts("ws-a", "goal:one").receipts).toEqual([]);
    consumeOverlaySystemEvent({
      type: "turn.started",
      payload: { workspacePath: "ws-a", positionId: "other", sessionId: "sess-2", turnId: "turn-new" },
    });
    consumeOverlaySystemEvent({
      type: "turn.completed",
      payload: { workspacePath: "ws-a", positionId: "other", sessionId: "sess-2", turnId: "turn-new" },
    });
    expect(readOverlayReceipts("ws-a", "goal:one").receipts).toEqual([]);
    expect(splitActionOutcomes(readOverlayReceipts("ws-a", "goal:two"))).toEqual([
      { actionId: "open-turn", outcome: "action_succeeded" },
    ]);
  });

  it("persists mixed split from exact turn and approval terminals without auto-resolve", () => {
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-turn",
      source: "turn",
      branches: destA,
    });
    registerPendingOverlayAction({
      workspaceKey: "ws-a",
      itemId: "goal:one",
      actionId: "open-approvals",
      source: "approval",
      branches: destA,
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

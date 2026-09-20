import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue, type ApprovalQueueItem } from "../src/approvals/ApprovalQueue";

const noop = () => {};

const makeItem = (overrides: Partial<ApprovalQueueItem>): ApprovalQueueItem => ({
  approvalId: `approval-${Math.random()}`,
  positionId: "test-position",
  category: "write",
  description: "Test",
  decision: { kind: "pending" },
  ...overrides,
});

describe("ApprovalQueue sorting", () => {
  it("sorts pending items by urgency (critical first) then by expiry proximity", () => {
    const now = Date.parse("2026-09-20T00:00:00Z");
    const items = [
      makeItem({ approvalId: "normal", expiresAt: "2026-09-25T00:00:00Z" }), // normal, 5 days
      makeItem({ approvalId: "expiring-late", expiresAt: "2026-09-21T12:00:00Z" }), // warning, 36h
      makeItem({ approvalId: "critical", expiresAt: "2020-01-01T00:00:00Z" }), // critical, expired
      makeItem({ approvalId: "expiring-early", expiresAt: "2026-09-21T00:00:00Z" }), // warning, 24h
    ];

    vi.stubGlobal("Date", class extends Date {
      constructor() { super(); }
      static now() { return now; }
    });

    render(
      <ApprovalQueue
        items={items}
        defaultFilter="pending"
        onApprove={noop}
        onDeny={noop}
      />
    );

    const cards = screen.getAllByTestId(/approval-card-/);
    expect(cards).toHaveLength(3); // critical is expired, so filtered out from pending
    expect(cards[0]).toHaveAttribute("data-approval-id", "expiring-early");
    expect(cards[1]).toHaveAttribute("data-approval-id", "expiring-late");
    expect(cards[2]).toHaveAttribute("data-approval-id", "normal");

    vi.unstubAllGlobals();
  });

  it("sorts decided items by decision time (most recent first)", () => {
    const items = [
      makeItem({
        approvalId: "old-decision",
        decision: { kind: "granted", scope: "once", decidedAt: "2026-09-18T00:00:00Z" },
      }),
      makeItem({
        approvalId: "new-decision",
        decision: { kind: "denied", decidedAt: "2026-09-20T00:00:00Z" },
      }),
      makeItem({
        approvalId: "mid-decision",
        decision: { kind: "granted", scope: "once", decidedAt: "2026-09-19T00:00:00Z" },
      }),
    ];

    render(
      <ApprovalQueue
        items={items}
        defaultFilter="decided"
        onApprove={noop}
        onDeny={noop}
      />
    );

    const cards = screen.getAllByTestId(/approval-card-/);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveAttribute("data-approval-id", "new-decision");
    expect(cards[1]).toHaveAttribute("data-approval-id", "mid-decision");
    expect(cards[2]).toHaveAttribute("data-approval-id", "old-decision");
  });
});

describe("ApprovalQueue onViewTurn", () => {
  it("renders View turn button when onViewTurn is provided and item has turnId", () => {
    const onViewTurn = vi.fn();
    const items = [
      makeItem({
        approvalId: "with-turn",
        source: { kind: "session", positionId: "p", conversationId: "c", turnId: "turn-123", runId: "r", engine: "qoder" },
      }),
    ];

    render(
      <ApprovalQueue
        items={items}
        onApprove={noop}
        onDeny={noop}
        onViewTurn={onViewTurn}
      />
    );

    const button = screen.getByRole("button", { name: "查看回合" });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    expect(onViewTurn).toHaveBeenCalledWith("turn-123");
  });

  it("does not render View turn button when onViewTurn is not provided", () => {
    const items = [
      makeItem({
        approvalId: "with-turn",
        source: { kind: "session", positionId: "p", conversationId: "c", turnId: "turn-123", runId: "r", engine: "qoder" },
      }),
    ];

    render(
      <ApprovalQueue
        items={items}
        onApprove={noop}
        onDeny={noop}
      />
    );

    expect(screen.queryByRole("button", { name: "查看回合" })).toBeNull();
  });

  it("does not render View turn button when item has no turnId", () => {
    const onViewTurn = vi.fn();
    const items = [makeItem({ approvalId: "no-turn" })];

    render(
      <ApprovalQueue
        items={items}
        onApprove={noop}
        onDeny={noop}
        onViewTurn={onViewTurn}
      />
    );

    expect(screen.queryByRole("button", { name: "查看回合" })).toBeNull();
  });
});

describe("ApprovalQueue dataState", () => {
  it("shows disconnected empty state when dataState is not-connected and no items", () => {
    render(
      <ApprovalQueue
        items={[]}
        dataState="not-connected"
        onApprove={noop}
        onDeny={noop}
      />
    );

    expect(screen.getByText("审批中心已断开")).toBeInTheDocument();
    expect(screen.getByText("数据源未接入，无法读取审批记录。请检查工作区连接或返回组织页。")).toBeInTheDocument();
  });

  it("shows pending empty state when dataState is ready and no items", () => {
    render(
      <ApprovalQueue
        items={[]}
        dataState="ready"
        onApprove={noop}
        onDeny={noop}
      />
    );

    expect(screen.getByText("暂无待处理的审批")).toBeInTheDocument();
  });
});

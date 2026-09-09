import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../src/approvals/ApprovalQueue";
import type { ApprovalQueueItem } from "../src/approvals/types";

function makeItem(over: Partial<ApprovalQueueItem> = {}): ApprovalQueueItem {
  return {
    approvalId: "appr-abc",
    positionId: "writer-1",
    positionName: "\u5185\u5bb9\u5199\u4f5c\u5458",
    positionMode: "approval_required",
    category: "write",
    description: "\u8bf7\u6c42\u5199\u5165 ./positions/ops-lead/report.md",
    target: "./positions/ops-lead/report.md",
    expiresAt: "2026-08-27T14:32:00.000Z",
    toolDeny: ["fs.write"],
    decision: { kind: "pending" },
    ...over,
  };
}

const noop = () => {};

describe("P0 \u5ba1\u6279\u961f\u5217 (\u2461)", () => {
  it("数据未接入时不把 0 误报成安全结论，并提供回到组织模块的入口", () => {
    const onNavigateToOrg = vi.fn();
    render(
      <ApprovalQueue
        items={[]}
        dataState="not-connected"
        onNavigateToOrg={onNavigateToOrg}
        onApprove={noop}
        onDeny={noop}
      />,
    );
    expect(screen.getByText("审批列表还未接入回合数据")).toBeInTheDocument();
    expect(screen.getByText("审批数据尚未接入，当前不能据此确认是否有待处理事项。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回组织模块" }));
    expect(onNavigateToOrg).toHaveBeenCalledTimes(1);
  });

  it("\u7a7a\u6001\uff1a\u5f85\u88c1\u51b3\u4e3a 0 \u6e32\u67d3 Empty \u6b63\u5411\u6587\u6848\uff0c\u4e0d\u7ed9\u7ea2\u70b9", () => {
    render(<ApprovalQueue items={[]} onApprove={noop} onDeny={noop} />);
    expect(
      screen.getByText(/\u6ca1\u6709\u7b49\u5f85\u5ba1\u6279\u7684\u52a8\u4f5c/),
    ).toBeInTheDocument();
  });

  it("\u6e32\u67d3 pending \u5217\u8868\uff1a\u5c97\u4f4d\u540d\u3001\u63cf\u8ff0\u3001\u76ee\u6807\u5747\u5230\u4f4d", () => {
    render(
      <ApprovalQueue items={[makeItem()]} onApprove={noop} onDeny={noop} />,
    );
    expect(screen.getByText("\u5185\u5bb9\u5199\u4f5c\u5458")).toBeInTheDocument();
    expect(
      screen.getByText(/\u8bf7\u6c42\u5199\u5165 \.\/positions\/ops-lead\/report\.md/),
    ).toBeInTheDocument();
    // The card carries the pending state marker.
    const card = screen.getByTestId("approval-card-appr-abc");
    expect(card.getAttribute("data-decision-state")).toBe("pending");
  });

  it("展示层会修复被多编码一层的中文，不修改审批契约字段", () => {
    render(
      <ApprovalQueue
        items={[makeItem({
          positionName: "\\u5185\\u5bb9\\u5199\\u4f5c\\u5458",
          description: "\\u8bf7\\u6c42\\u5199\\u5165 report.md",
          target: "\\u76ee\\u6807/report.md",
        })]}
        onApprove={noop}
        onDeny={noop}
      />,
    );
    expect(screen.getByText("内容写作员")).toBeInTheDocument();
    expect(screen.getByText("请求写入 report.md")).toBeInTheDocument();
    expect(screen.getByText("目标/report.md")).toBeInTheDocument();
  });

  it("\u8d8a\u6743\u5f90\u6807\uff1aread_only \u5c97\u4f4d\u53d1\u8d77 write \u547d\u4e2d\uff0c\u666e\u901a\u5c97\u4f4d\u4e0d\u547d\u4e2d", () => {
    const overreachItem = makeItem({
      approvalId: "appr-hit",
      positionId: "reader",
      positionMode: "read_only",
      category: "write",
    });
    const safeItem = makeItem({
      approvalId: "appr-safe",
      positionId: "writer-2",
      positionMode: "approval_required",
      category: "tool",
      toolDeny: [],
      requestedTool: undefined,
    });
    render(
      <ApprovalQueue
        items={[overreachItem, safeItem]}
        onApprove={noop}
        onDeny={noop}
      />,
    );
    const hit = screen.getByTestId("approval-card-appr-hit");
    const safe = screen.getByTestId("approval-card-appr-safe");
    expect(hit.getAttribute("data-overreach")).toBe("true");
    expect(within(hit).getByTestId("approval-overreach-tag")).toBeInTheDocument();
    expect(safe.getAttribute("data-overreach")).toBe("false");
    expect(within(safe).queryByTestId("approval-overreach-tag")).toBeNull();
  });

  it("\u70b9\u5361\u5c55\u5f00\u62bd\u5c49\uff1b\u6279\u51c6/\u62d2\u7edd \u56de\u8c03\u643a\u5e26 approvalId \u4e0e reason", async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(
      <ApprovalQueue
        items={[makeItem()]}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    // Row click opens the drawer.
    fireEvent.click(screen.getByTestId("approval-card-appr-abc"));
    const approveBtn = await screen.findByTestId("approval-approve-button");
    const denyBtn = await screen.findByTestId("approval-deny-button");
    expect(approveBtn).not.toBeDisabled();
    // Approve without reason -> reason argument is undefined.
    fireEvent.click(approveBtn);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith("appr-abc", undefined);
    // Fill in the reason textarea, then deny.
    const reason = (await screen.findByTestId("approval-reason-input")) as HTMLTextAreaElement;
    fireEvent.change(reason, { target: { value: "\u8d85\u51fa Context Scope" } });
    fireEvent.click(denyBtn);
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledWith("appr-abc", "\u8d85\u51fa Context Scope");
  });

  it("\u5df2\u88c1\u51b3\u9879\u9501\u5b9a\uff1a\u4e0d\u80fd\u91cd\u590d\u88c1\u51b3\uff0c\u62d2\u7edd\u8bc1\u636e\u63d0\u793a\u4fdd\u7559", async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const decided = makeItem({
      approvalId: "appr-done",
      decision: { kind: "denied", reason: "\u5df2\u6709\u62d2\u7edd\u8bc1\u636e" },
    });
    render(
      <ApprovalQueue
        items={[decided]}
        defaultFilter="all"
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByTestId("approval-card-appr-done"));
    const approveBtn = await screen.findByTestId("approval-approve-button");
    const denyBtn = await screen.findByTestId("approval-deny-button");
    expect(approveBtn).toBeDisabled();
    expect(denyBtn).toBeDisabled();
    fireEvent.click(approveBtn);
    fireEvent.click(denyBtn);
    expect(onApprove).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
    // Denial reason is surfaced (evidence-never-disappears rule).
    expect(
      screen.getByText(/\u62d2\u7edd\u7406\u7531\uff1a\u5df2\u6709\u62d2\u7edd\u8bc1\u636e/),
    ).toBeInTheDocument();
  });

  it("\u8fc7\u6ee4\u5668\uff1a\u5df2\u88c1\u51b3\u9879\u9ed8\u8ba4\u4e0d\u73b0\u8eab\u5728\u5f85\u88c1\u51b3\u5217\u8868", () => {
    const items: ApprovalQueueItem[] = [
      makeItem({ approvalId: "appr-1" }),
      makeItem({
        approvalId: "appr-2",
        decision: { kind: "granted", scope: "once" },
      }),
    ];
    render(<ApprovalQueue items={items} onApprove={noop} onDeny={noop} />);
    expect(screen.queryByTestId("approval-card-appr-1")).toBeInTheDocument();
    expect(screen.queryByTestId("approval-card-appr-2")).toBeNull();
  });
});

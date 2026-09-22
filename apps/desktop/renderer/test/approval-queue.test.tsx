import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../src/approvals/ApprovalQueue";
import type { ApprovalQueueItem } from "../src/approvals/types";
import { pickSelectOption } from "./select-helper";

function makeItem(over: Partial<ApprovalQueueItem> = {}): ApprovalQueueItem {
  return {
    approvalId: "appr-abc",
    positionId: "writer-1",
    positionName: "\u5185\u5bb9\u5199\u4f5c\u5458",
    positionMode: "approval_required",
    category: "write",
    description: "\u8bf7\u6c42\u5199\u5165 ./positions/ops-lead/report.md",
    target: "./positions/ops-lead/report.md",
    expiresAt: "2099-08-27T14:32:00.000Z",
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
        defaultFilter="all"
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

  it("only offers server-eligible run scope and records the selected boundary", async () => {
    const onApprove = vi.fn();
    render(<ApprovalQueue items={[makeItem({ scopeAllowed: ["once", "run"] })]} onApprove={onApprove} onDeny={noop} />);
    fireEvent.click(screen.getByTestId("approval-card-appr-abc"));
    expect(await screen.findByTestId("approval-scope-choice")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "仅本回合" }));
    fireEvent.click(screen.getByTestId("approval-approve-button"));
    expect(onApprove).toHaveBeenCalledWith("appr-abc", undefined, "run");
  });

  it("#403 shows the exact same-source restricted-tool selection before one batch callback", () => {
    const onApproveBatch = vi.fn();
    const source = { kind: "session" as const, positionId: "writer-1", conversationId: "session-1", turnId: "turn-1", runId: "run-1", engine: "qoder" as const };
    render(<ApprovalQueue items={[
      makeItem({ approvalId: "batch-a", category: "tool", source, batchMaxItems: 3, canDecide: true }),
      makeItem({ approvalId: "batch-b", category: "tool", source, batchMaxItems: 3, canDecide: true }),
      makeItem({ approvalId: "other-source", category: "tool", source: { ...source, runId: "run-2" }, batchMaxItems: 3, canDecide: true }),
    ]} onApprove={noop} onDeny={noop} onApproveBatch={onApproveBatch} />);
    const selectors = screen.getAllByRole("checkbox", { name: "选择加入策略受控批量批准" });
    fireEvent.click(selectors[0]!); fireEvent.click(selectors[1]!);
    expect(screen.getByText(/已从 writer-1 · session-1 选择 2 项受限工具审批/)).toBeInTheDocument();
    expect(selectors[2]).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "批准所选项" }));
    expect(onApproveBatch).toHaveBeenCalledWith(["batch-a", "batch-b"]);
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

  it("filters approval history by keyword and request date", () => {
    render(
      <ApprovalQueue
        defaultFilter="all"
        items={[
          makeItem({ approvalId: "appr-write", requestedAt: "2026-09-18T08:00:00.000Z" }),
          makeItem({ approvalId: "appr-exec", positionId: "operator-2", positionName: "Operations", category: "exec", description: "Run the audit command", requestedAt: "2026-09-17T08:00:00.000Z", decision: { kind: "granted", scope: "once" } }),
        ]}
        onApprove={noop}
        onDeny={noop}
      />,
    );
    expect(screen.getByTestId("approval-card-appr-write")).toBeInTheDocument();
    expect(screen.getByTestId("approval-card-appr-exec")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("approval-filter-keyword"), { target: { value: "audit command" } });
    expect(screen.queryByTestId("approval-card-appr-write")).toBeNull();
    expect(screen.getByTestId("approval-card-appr-exec")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("approval-filter-keyword"), { target: { value: "" } });
    fireEvent.change(screen.getByTestId("approval-filter-from"), { target: { value: "2026-09-18" } });
    expect(screen.getByTestId("approval-card-appr-write")).toBeInTheDocument();
    expect(screen.queryByTestId("approval-card-appr-exec")).toBeNull();
  });

  it("filters decision history by the separate recovery execution phase", () => {
    render(
      <ApprovalQueue
        defaultFilter="all"
        items={[
          makeItem({ approvalId: "appr-completed", decision: { kind: "granted", scope: "once" }, executionPhase: "completed" }),
          makeItem({ approvalId: "appr-failed", decision: { kind: "granted", scope: "once" }, executionPhase: "failed", executionErrorCode: "approval_execution_unknown" }),
          makeItem({ approvalId: "appr-pending" }),
        ]}
        onApprove={noop}
        onDeny={noop}
      />,
    );
    expect(screen.getByTestId("approval-card-appr-failed")).toHaveAttribute("data-execution-phase", "failed");
    expect(screen.getByText("裁决已保存，后续执行失败")).toBeInTheDocument();

    pickSelectOption("按执行状态过滤", "裁决已保存，后续执行失败");
    expect(screen.queryByTestId("approval-card-appr-completed")).toBeNull();
    expect(screen.getByTestId("approval-card-appr-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("approval-card-appr-pending")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "清除过滤" }));
    expect(screen.getByTestId("approval-card-appr-completed")).toBeInTheDocument();
    expect(screen.getByTestId("approval-card-appr-failed")).toBeInTheDocument();
    expect(screen.getByTestId("approval-card-appr-pending")).toBeInTheDocument();
  });

  it("shows lifecycle and traceability fields and routes supported sources", async () => {
    const onOpenSource = vi.fn();
    const onOpenEvidence = vi.fn();
    render(
      <ApprovalQueue
        defaultFilter="all"
        items={[makeItem({
          target: "https://alice:secret@example.com/upload?token=top-secret",
          source: { kind: "session", positionId: "writer-1", conversationId: "session-1", turnId: "turn-1", runId: "run-1", engine: "qoder" },
          context: {
            risk: "high", requestedCapability: "write", parameterSummary: "https://[redacted]@example.com/upload?token=[redacted]",
            impact: "workspace_write", permissions: { mode: "approval_required", allowedTools: ["fs.read"], deniedTools: ["fs.write"] },
            preview: { status: "unavailable", reason: "engine_preview_not_supplied" },
          },
          executionPhase: "completed",
          executionTurnId: "recovery-1",
          requestReason: "The requested write changes a shared report.",
          decision: { kind: "granted", scope: "once", decidedAt: "2026-09-18T09:00:00.000Z", decidedBy: "operator" },
        })]}
        onApprove={noop}
        onDeny={noop}
        onOpenSource={onOpenSource}
        onOpenEvidence={onOpenEvidence}
      />,
    );
    fireEvent.click(screen.getByTestId("approval-card-appr-abc"));
    expect(await screen.findByTestId("approval-lifecycle")).toBeInTheDocument();
    expect(screen.getByTestId("approval-context")).toBeInTheDocument();
    expect(screen.getByText("裁决与执行")).toBeInTheDocument();
    expect(screen.getByText("高风险")).toBeInTheDocument();
    expect(screen.getByText("引擎未提供")).toBeInTheDocument();
    expect(screen.getByText("session-1")).toBeInTheDocument();
    expect(screen.queryByText("top-secret")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开原会话" }));
    fireEvent.click(screen.getByRole("button", { name: "打开执行证据" }));
    expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "appr-abc" }));
    expect(onOpenEvidence).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "appr-abc" }));
  });

  it("renders a server-projected change preview without exposing secrets", async () => {
    render(
      <ApprovalQueue
        defaultFilter="all"
        items={[makeItem({
          context: {
            risk: "high", requestedCapability: "write", impact: "workspace_write",
            permissions: { mode: "approval_required", allowedTools: ["fs.read"], deniedTools: ["fs.write"] },
            preview: {
              status: "available", version: "approval-change-preview.v1", previewId: "preview-1", previewFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              files: [{ path: "reports/summary.md", change: "modify", before: "token=[redacted]", after: "published=true" }],
            },
          },
        })]}
        onApprove={noop}
        onDeny={noop}
      />,
    );
    fireEvent.click(screen.getByTestId("approval-card-appr-abc"));
    const preview = await screen.findByTestId("approval-change-preview");
    expect(preview).toHaveTextContent("修改");
    expect(preview).toHaveTextContent("reports/summary.md");
    expect(preview).toHaveTextContent("published=true");
    expect(preview).not.toHaveTextContent("top-secret");
  });

  it("keeps unsupported group sources visibly unavailable", async () => {
    render(
      <ApprovalQueue
        items={[makeItem({ source: { kind: "group", positionId: "writer-1", conversationId: "group-1", turnId: "turn-1", runId: "run-1", engine: "qoder" } })]}
        onApprove={noop}
        onDeny={noop}
        onOpenSource={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("approval-card-appr-abc"));
    expect(await screen.findByText("当前桌面端暂不支持打开此来源。"));
    expect(screen.getByRole("button", { name: "打开原会话" })).toBeDisabled();
  });

  it("shows an in-app reminder and supports the expiring filter", () => {
    render(
      <ApprovalQueue
        defaultFilter="all"
        items={[
          makeItem({ approvalId: "expiring", expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
          makeItem({ approvalId: "expired", expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), decision: { kind: "expired" } }),
        ]}
        onApprove={noop}
        onDeny={noop}
      />,
    );
    expect(screen.getByText("有 1 条待审批将在 24 小时内过期")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看即将过期" }));
    expect(screen.getByTestId("approval-card-expiring")).toBeInTheDocument();
    expect(screen.queryByTestId("approval-card-expired")).toBeNull();
  });

  it("locks a stale pending approval in the drawer on the shared minute tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T14:00:00.000Z"));
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    try {
      render(
        <ApprovalQueue
          items={[makeItem({ expiresAt: new Date(Date.now() + 60_000).toISOString() })]}
          onApprove={onApprove}
          onDeny={onDeny}
        />,
      );
      expect(screen.getByText("即将过期")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("approval-card-appr-abc"));
      expect(screen.getByTestId("approval-approve-button")).not.toBeDisabled();
      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.queryByText("即将过期")).toBeNull();
      // The stale item is no longer actionable, so it leaves the Pending tab
      // while the already-open drawer continues to show its terminal state.
      expect(screen.queryByTestId("approval-card-appr-abc")).toBeNull();
      expect(screen.getByText("已过期——如需放行请发起新回合")).toBeInTheDocument();
      const approve = screen.getByTestId("approval-approve-button");
      const deny = screen.getByTestId("approval-deny-button");
      expect(approve).toBeDisabled();
      expect(deny).toBeDisabled();
      fireEvent.click(approve);
      fireEvent.click(deny);
      expect(onApprove).not.toHaveBeenCalled();
      expect(onDeny).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a locally expired pending approval from actionable metrics and the Pending tab", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T14:00:00.000Z"));
    try {
      render(
        <ApprovalQueue
          items={[makeItem({ expiresAt: new Date(Date.now() + 60_000).toISOString() })]}
          onApprove={noop}
          onDeny={noop}
        />,
      );
      expect(screen.getByLabelText("待裁决 1")).toBeInTheDocument();
      expect(screen.getByTestId("approval-card-appr-abc")).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.getByLabelText("待裁决 0")).toBeInTheDocument();
      expect(screen.queryByTestId("approval-card-appr-abc")).toBeNull();

      fireEvent.click(screen.getByRole("radio", { name: "全部" }));
      expect(screen.getByTestId("approval-card-appr-abc")).toHaveAttribute("data-expiry-state", "expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a privacy-safe desktop alert when permission is granted", async () => {
    const previous = window.Notification;
    const notify = vi.fn();
    class TestNotification {
      static permission: NotificationPermission = "granted";
      static requestPermission = vi.fn(async () => "granted" as NotificationPermission);
      constructor(title: string, options?: NotificationOptions) { notify(title, options); }
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: TestNotification });
    try {
      const { rerender } = render(<ApprovalQueue items={[]} onApprove={noop} onDeny={noop} />);
      rerender(<ApprovalQueue items={[makeItem({ target: "https://alice:secret@example.com/?token=top-secret" })]} onApprove={noop} onDeny={noop} />);
      await waitFor(() => expect(notify).toHaveBeenCalledWith(
        "有新的待审批请求",
        expect.objectContaining({ body: expect.not.stringContaining("top-secret") }),
      ));
    } finally {
      Object.defineProperty(window, "Notification", { configurable: true, value: previous });
    }
  });

  it("requests desktop-notification permission only from the enable action", async () => {
    const previous = window.Notification;
    class TestNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = vi.fn(async () => "granted" as NotificationPermission);
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: TestNotification });
    try {
      render(<ApprovalQueue items={[]} onApprove={noop} onDeny={noop} />);
      expect(TestNotification.requestPermission).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "开启桌面提醒" }));
      await waitFor(() => expect(TestNotification.requestPermission).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("button", { name: "开启桌面提醒" })).toBeNull();
    } finally {
      Object.defineProperty(window, "Notification", { configurable: true, value: previous });
    }
  });
});

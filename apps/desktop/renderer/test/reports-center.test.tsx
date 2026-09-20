import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportsCenter } from "../src/reports/ReportsCenter";
import type { ReportsResponse } from "@roleweave/shared";

const report: ReportsResponse = {
  schemaVersion: "reports.v1",
  budgets: [{ positionId: "alice", declared: { perTask: { tokens: 100 }, perDay: { tokens: 1000 } }, recorded: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, latestTurn: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, state: "within" }],
  streams: { audits: [], escalations: [{ schemaVersion: "turn-escalation.v1", positionId: "alice", turnId: "failed-1", status: "failed", at: "2026-09-13T00:00:00Z", code: "engine.failed", reportingChain: ["alice"], budgetRelated: false }], evidence: [
    { schemaVersion: "turn-evidence.v1", positionId: "alice", turnId: "failed-1", runId: "run-failed", conversationId: "session", engine: "codex-local", status: "failed", createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:01Z", envelopeDigest: "sha256:hidden", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } },
    { schemaVersion: "turn-evidence.v1", positionId: "alice", turnId: "running-1", conversationId: "session", engine: "qoder", status: "running", createdAt: "2026-09-13T00:01:00Z", updatedAt: "2026-09-13T00:01:00Z", envelopeDigest: "sha256:hidden", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
  ] }, page: { cursor: null, hasMore: false },
};

const audit = {
  schemaVersion: "org-audit.v1" as const,
  at: "2026-09-18T00:00:00Z",
  actor: "owner",
  workspace: "ws",
  bootstrapped: true,
  changes: { hired: [], moved: [{ id: "alice", from: null, to: "boss" }], dismissed: [], budgetUpdated: [] },
  positionCount: 2,
};

describe("consolidated reports", () => {
  it("counts executions and exceptions without counting timeline events twice", () => {
    render(<ReportsCenter reports={report} loading={false} positionNames={{ alice: "Alice" }} />);
    expect(screen.getByRole("button", { name: "执行次数" })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: "异常执行" })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "已记录 Token" })).toHaveTextContent("30");
    expect(document.querySelector(".owb-budget-deck")).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "上报数据流" })).getAllByRole("button")).toHaveLength(5);
  });
  it("searches sanitized execution rows and opens a scoped timeline", () => {
    render(<ReportsCenter reports={report} loading={false} positionNames={{ alice: "Alice" }} />);
    fireEvent.click(screen.getByRole("button", { name: /执行记录/ }));
    fireEvent.change(screen.getByPlaceholderText("搜索员工或 Agent"), { target: { value: "codex" } });
    expect(screen.getByText("1 条记录")).toBeInTheDocument();
    expect(screen.queryByText("sha256:hidden")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /查看时间线/ }));
    expect(screen.getByLabelText("执行时间线")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看全部员工" })).toBeInTheDocument();
    expect(screen.getByText("共 4 条")).toBeInTheDocument();
  });
  it("expands audit rows into concrete change details and traces escalations to the timeline", () => {
    const withAudit: ReportsResponse = { ...report, streams: { ...report.streams, audits: [audit] } };
    render(<ReportsCenter reports={withAudit} loading={false} positionNames={{ alice: "Alice", boss: "Boss" }} />);
    // 默认落在失败/升级：行内追溯按钮直接跳带范围的时间线。
    fireEvent.click(screen.getByRole("button", { name: "追溯这次执行" }));
    expect(screen.getByRole("button", { name: "查看全部员工" })).toBeInTheDocument();
    // 组织审计：chips 只留非零组，展开后能看到"谁从哪调到哪"。
    fireEvent.click(screen.getByRole("button", { name: /组织审计/ }));
    expect(screen.getByText("调岗 1")).toBeInTheDocument();
    expect(screen.queryByText(/招聘 0/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开变更明细" }));
    expect(screen.getByText(/无上级 → Boss/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起变更明细" }));
    expect(screen.queryByText(/无上级 → Boss/)).toBeNull();
  });
  it("does not offer an empty expand panel when an audit has no substantive changes", () => {
    const emptyAudit = {
      ...audit,
      changes: { hired: [], moved: [], dismissed: [], budgetUpdated: [] },
    };
    const withEmpty: ReportsResponse = { ...report, streams: { ...report.streams, audits: [emptyAudit], escalations: [] } };
    render(<ReportsCenter reports={withEmpty} loading={false} />);
    fireEvent.click(screen.getByRole("button", { name: /组织审计/ }));
    expect(screen.getByText("无实质变更")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "展开变更明细" })).toBeNull();
  });
  it("does not display a fabricated zero when there is no usage observation, and refresh is explicit", () => {
    const onRefresh = vi.fn();
    render(<ReportsCenter reports={{ ...report, budgets: [{ ...report.budgets[0]!, latestTurn: null, state: "unobserved", recorded: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }], streams: { evidence: [], audits: [], escalations: [] } }} loading={false} onRefresh={onRefresh} />);
    expect(screen.getByRole("button", { name: "已记录 Token" })).toHaveTextContent("—");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("focuses execution evidence on the requested turn and fails closed when it is absent", () => {
    const { rerender } = render(<ReportsCenter reports={report} loading={false} focusTurnId="failed-1" />);
    expect(screen.getByText("回合 failed-1 的执行证据")).toBeInTheDocument();
    expect(screen.getByText("1 条记录")).toBeInTheDocument();
    expect(screen.queryByText("running-1")).toBeNull();

    rerender(<ReportsCenter reports={report} loading={false} focusTurnId="missing-turn" />);
    expect(screen.getByText("回合 missing-turn 暂无执行证据")).toBeInTheDocument();
    expect(screen.queryByText("1 条记录")).toBeNull();
  });
});

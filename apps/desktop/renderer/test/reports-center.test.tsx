import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OwbI18nProvider } from "@roleweave/ui";
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
  it("shows evidence-only failures as exceptions and preserves the exact source link", () => {
    const onOpenTurn = vi.fn();
    const failedOnly = { ...report, streams: { ...report.streams, escalations: [] } };
    render(<ReportsCenter reports={failedOnly} loading={false} onOpenTurn={onOpenTurn} />);
    expect(screen.getByRole("button", { name: "异常执行" })).toHaveTextContent("1");
    expect(screen.getByRole("complementary", { name: "异常详情" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开回合对话：failed-1" }));
    expect(onOpenTurn).toHaveBeenCalledWith({ positionId: "alice", conversationId: "session", turnId: "failed-1" });
  });
  it("changes the evidence inspector with filters instead of retaining an unrelated source", () => {
    render(<ReportsCenter reports={report} loading={false} />);
    fireEvent.click(screen.getByRole("button", { name: /执行记录/ }));
    expect(screen.getByRole("complementary", { name: "执行证据" })).toHaveTextContent("running-1");
    fireEvent.change(screen.getByLabelText("搜索任务或运行编号"), { target: { value: "run-failed" } });
    expect(screen.getByRole("complementary", { name: "执行证据" })).toHaveTextContent("failed-1");
    expect(screen.queryByText("running-1")).toBeNull();
  });
  it("keeps a timestamped report snapshot visible after a refresh failure", () => {
    const onRefresh = vi.fn();
    render(<ReportsCenter reports={report} loading={false} errorMessage="offline" updatedAt="2026-09-30T08:00:00Z" onRefresh={onRefresh} />);
    expect(screen.getByText("连接中断 · 显示上次加载的记录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "执行次数" })).toHaveTextContent("2");
    expect(document.querySelector('time[datetime="2026-09-30T08:00:00Z"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
  it("projects timestamped approval audit references into the exact request link", () => {
    const onOpenApproval = vi.fn();
    render(<ReportsCenter reports={report} loading={false} approvals={[{ approvalId: "request-verified", positionId: "alice", category: "write", description: "Update inbox routing", decision: { kind: "granted", scope: "once", decidedAt: "2026-09-30T00:00:00Z", decidedBy: "operator" } }]} onOpenApproval={onOpenApproval} />);
    fireEvent.click(screen.getByRole("button", { name: /组织审计/ }));
    fireEvent.click(screen.getByRole("button", { name: "Update inbox routing" }));
    expect(onOpenApproval).toHaveBeenCalledWith("request-verified");
    expect(screen.getByText("operator")).toBeInTheDocument();
  });
  it("keeps same-named turns isolated by role in exception evidence and source actions", () => {
    const onOpenTurn = vi.fn();
    const duplicate = { ...report.streams.evidence[0]!, positionId: "bob", conversationId: "bob-session", runId: "bob-run" };
    render(<ReportsCenter reports={{ ...report, streams: { ...report.streams, evidence: [...report.streams.evidence, duplicate] } }} loading={false} onOpenTurn={onOpenTurn} />);
    expect(screen.getByRole("button", { name: "异常执行" })).toHaveTextContent("2");
    fireEvent.click(screen.getByRole("button", { name: "打开回合对话：failed-1" }));
    expect(onOpenTurn).toHaveBeenLastCalledWith({ positionId: "bob", conversationId: "bob-session", turnId: "failed-1" });
    fireEvent.click(within(screen.getByRole("region", { name: "失败 / 升级" })).getByRole("button", { name: /alice · failed-1/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开回合对话：failed-1" }));
    expect(onOpenTurn).toHaveBeenCalledWith({ positionId: "alice", conversationId: "session", turnId: "failed-1" });
    fireEvent.click(screen.getByRole("button", { name: "追溯这次执行" }));
    expect(document.querySelector(".owb-timeline__count")).toHaveTextContent("3");
    fireEvent.click(screen.getByRole("button", { name: "打开执行证据" }));
    expect(screen.getByRole("complementary", { name: "执行证据" })).toHaveTextContent("run-failed");
    expect(screen.getByRole("complementary", { name: "执行证据" })).not.toHaveTextContent("bob-run");
  });
  it("counts executions and exceptions without counting timeline events twice", () => {
    render(<ReportsCenter reports={report} loading={false} positionNames={{ alice: "Alice" }} />);
    expect(screen.getByRole("button", { name: "执行次数" })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: "异常执行" })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "已记录 Token" })).toHaveTextContent("30");
    expect(document.querySelector(".owb-budget-deck")).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "上报数据流" })).getAllByRole("button")).toHaveLength(5);
  });
  it("searches sanitized execution rows and traces only the selected run", () => {
    render(<ReportsCenter reports={report} loading={false} positionNames={{ alice: "Alice" }} />);
    fireEvent.click(screen.getByRole("button", { name: /执行记录/ }));
    fireEvent.change(screen.getByPlaceholderText("搜索任务或运行编号"), { target: { value: "codex" } });
    expect(screen.getByText("1 条记录")).toBeInTheDocument();
    expect(screen.queryByText("sha256:hidden")).toBeNull();
    fireEvent.click(within(screen.getByRole("row", { name: /run-failed/ })).getByRole("button", { name: /查看时间线/ }));
    expect(screen.getByLabelText("执行时间线")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看全部员工" })).toBeInTheDocument();
    expect(document.querySelector(".owb-timeline__count")).toHaveTextContent("3");

    fireEvent.click(screen.getByRole("button", { name: "查看全部员工" }));
    expect(document.querySelector(".owb-timeline__count")).toHaveTextContent("4");

    fireEvent.click(screen.getByRole("button", { name: /时间线/ }));
    expect(document.querySelector(".owb-timeline__count")).toHaveTextContent("4");
  });
  it("expands audit rows into concrete change details and traces escalations to the timeline", () => {
    const withAudit: ReportsResponse = { ...report, streams: { ...report.streams, audits: [audit] } };
    render(<ReportsCenter reports={withAudit} loading={false} positionNames={{ alice: "Alice", boss: "Boss" }} />);
    // 默认落在失败/升级：行内追溯按钮直接跳带范围的时间线。
    fireEvent.click(screen.getByRole("button", { name: "追溯这次执行" }));
    expect(screen.getByRole("button", { name: "查看全部员工" })).toBeInTheDocument();
    expect(document.querySelector(".owb-timeline__count")).toHaveTextContent("3");
    // 组织审计：chips 只留非零组，展开后能看到"谁从哪调到哪"。
    fireEvent.click(screen.getByRole("button", { name: /组织审计/ }));
    expect(screen.getByText("调岗 1")).toBeInTheDocument();
    expect(screen.queryByText(/招聘 0/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开变更明细" }));
    expect(screen.getByText(/无上级 → Boss/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起变更明细" }));
    expect(screen.queryByText(/无上级 → Boss/)).toBeNull();
  });
  it("keeps audit chips and expanded move details localized in English", () => {
    const withAudit: ReportsResponse = { ...report, streams: { ...report.streams, audits: [audit] } };
    render(
      <OwbI18nProvider locale="en">
        <ReportsCenter reports={withAudit} loading={false} positionNames={{ alice: "Alice", boss: "Boss" }} />
      </OwbI18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Org audits/ }));
    expect(screen.getByText("Moved 1")).toBeInTheDocument();
    expect(screen.queryByText(/Hired 0/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show change details" }));
    expect(screen.getByText(/No parent → Boss/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide change details" }));
    expect(screen.queryByText(/No parent → Boss/)).toBeNull();
  });

  it("falls back to the turn ID when an escalation has no evidence run ID", () => {
    const [failed, ...remaining] = report.streams.evidence;
    const { runId: _runId, ...failedWithoutRunId } = failed!;
    const withoutRunId: ReportsResponse = { ...report, streams: { ...report.streams, evidence: [failedWithoutRunId, ...remaining] } };
    render(<ReportsCenter reports={withoutRunId} loading={false} positionNames={{ alice: "Alice" }} />);

    fireEvent.click(screen.getByRole("button", { name: "追溯这次执行" }));
    expect(document.querySelector(".owb-timeline__count")).toHaveTextContent("3");
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

  it("opens the exact conversation and turn from escalation and evidence rows", () => {
    const onOpenTurn = vi.fn();
    render(
      <ReportsCenter
        reports={report}
        loading={false}
        onOpenTurn={onOpenTurn}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "打开回合对话：failed-1" }),
    );
    expect(onOpenTurn).toHaveBeenLastCalledWith({
      positionId: "alice",
      conversationId: "session",
      turnId: "failed-1",
    });

    fireEvent.click(screen.getByRole("button", { name: /执行记录/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "打开回合对话：running-1" }),
    );
    expect(onOpenTurn).toHaveBeenLastCalledWith({
      positionId: "alice",
      conversationId: "session",
      turnId: "running-1",
    });
  });

  it("shows an explicit unavailable state when an escalation has no conversation backlink", () => {
    const missingEvidence: ReportsResponse = {
      ...report,
      streams: {
        ...report.streams,
        escalations: [
          {
            ...report.streams.escalations[0]!,
            turnId: "missing-turn",
          },
        ],
      },
    };
    render(
      <ReportsCenter
        reports={missingEvidence}
        loading={false}
        onOpenTurn={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /missing-turn/ }));
    expect(screen.getByText("回合对话入口不可用")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "打开回合对话：missing-turn" }),
    ).toBeNull();
  });
});

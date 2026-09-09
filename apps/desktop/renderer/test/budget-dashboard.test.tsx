import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BudgetDashboard, budgetPercentText, stateLabel } from "../src/reports/BudgetDashboard";
import type { BudgetReport, EscalationEntry } from "@roleweave/shared";

/** Fixture: three positions covering all three `state` values plus one
 * approaching-cap (>=80%) row, so ordering and filters have real inputs. */
const budgets: BudgetReport[] = [
  {
    // 声明期 (unobserved): no latestTurn, state="unobserved". Should sort last.
    positionId: "intern",
    declared: { perTask: { tokens: 80000 }, perDay: { tokens: 200000 } },
    recorded: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    latestTurn: null,
    state: "unobserved",
  },
  {
    // >100% exceeded — must sort to top and carry is-exceeded class.
    positionId: "writer-1",
    declared: { perTask: { tokens: 200000 }, perDay: { tokens: 400000 } },
    recorded: { inputTokens: 300000, outputTokens: 181220, totalTokens: 481220 },
    latestTurn: { inputTokens: 140000, outputTokens: 92000, totalTokens: 232000 },
    state: "exceeded",
  },
  {
    // 82% — 逼近 (approaching, still "within"). Should sort right after exceeded.
    positionId: "ops-lead",
    declared: { perTask: { tokens: 200000 }, perDay: { tokens: 400000 } },
    recorded: { inputTokens: 200000, outputTokens: 110008, totalTokens: 310008 },
    latestTurn: { inputTokens: 100000, outputTokens: 64000, totalTokens: 164000 },
    state: "within",
  },
  {
    // 38% — plain within, below the 80% approaching threshold.
    positionId: "researcher",
    declared: { perTask: { tokens: 200000 }, perDay: { tokens: 400000 } },
    recorded: { inputTokens: 60000, outputTokens: 36410, totalTokens: 96410 },
    latestTurn: { inputTokens: 45000, outputTokens: 31000, totalTokens: 76000 },
    state: "within",
  },
];

const escalations: EscalationEntry[] = [
  {
    schemaVersion: "turn-escalation.v1",
    positionId: "writer-1",
    turnId: "turn-42",
    at: "2026-08-27T10:02:55.000Z",
    status: "failed",
    code: "engine.position_budget_exceeded",
    reportingChain: ["ops-lead", "owner"],
    budgetRelated: true,
  },
];

function firstDataRow(container: HTMLElement): HTMLElement {
  const row = container.querySelector<HTMLElement>("tbody .ant-table-row");
  if (!row) throw new Error("no table rows rendered");
  return row;
}

describe("BudgetDashboard — 摘要/表格/超限/详情", () => {
  it("加载态渲染骨架而不是数据表", () => {
    render(<BudgetDashboard budgets={[]} loading />);
    expect(screen.getByLabelText("预算成本看板")).toBeInTheDocument();
    // Skeleton renders no table rows and no summary Alert.
    expect(document.querySelector("tbody .ant-table-row")).toBeNull();
    expect(screen.queryByTestId("budget-summary-alert")).not.toBeInTheDocument();
  });

  it("空态：`budgets` 为空时展示 Empty 文案而不是空表", () => {
    render(<BudgetDashboard budgets={[]} />);
    expect(screen.getByText(/尚无预算记录/)).toBeInTheDocument();
    expect(document.querySelector("tbody .ant-table-row")).toBeNull();
  });

  it("摘要四数与汇总 Alert 存在（有超限时）", () => {
    render(<BudgetDashboard budgets={budgets} escalations={escalations} />);
    // Summary group present.
    const summary = screen.getByRole("group", { name: "预算摘要" });
    expect(summary).toBeInTheDocument();
    // Exceeded stat = 1 (writer-1).
    expect(within(summary).getByText("超限")).toBeInTheDocument();
    // The summary Alert appears because summary.exceeded > 0.
    const alert = screen.getByTestId("budget-summary-alert");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent("1 个岗位已超出单任务声明");
  });

  it("摘要 Alert 在无超限时不渲染", () => {
    const withoutExceeded = budgets.filter((b) => b.state !== "exceeded");
    render(<BudgetDashboard budgets={withoutExceeded} />);
    expect(screen.queryByTestId("budget-summary-alert")).not.toBeInTheDocument();
  });

  it("exceeded 行置顶 + 红条 (is-exceeded class)", () => {
    const { container } = render(<BudgetDashboard budgets={budgets} />);
    const rows = container.querySelectorAll<HTMLElement>("tbody .ant-table-row");
    expect(rows.length).toBe(budgets.length);
    // First row = writer-1 (exceeded), carries is-exceeded class.
    expect(rows[0]).toHaveClass("is-exceeded");
    expect(rows[0].getAttribute("data-position-id")).toBe("writer-1");
    // Approaching row (ops-lead, 82%) sorts second.
    expect(rows[1]).toHaveClass("is-approaching");
    expect(rows[1].getAttribute("data-position-id")).toBe("ops-lead");
    // Intern (unobserved) sorts last.
    expect(rows[rows.length - 1].getAttribute("data-position-id")).toBe("intern");
  });

  it("点击行触发 Drawer 打开并展示岗位名", () => {
    const { container } = render(
      <BudgetDashboard
        budgets={budgets}
        positionNames={{ "writer-1": "内容写作员" }}
      />,
    );
    // Drawer starts closed → no dialog in the doc.
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(firstDataRow(container));
    // antd Drawer renders with role="dialog"; its title includes the display name.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent("内容写作员");
  });

  it("Drawer「查看时间线」按钮触发 onOpenTimeline", () => {
    const onOpenTimeline = vi.fn();
    const { container } = render(
      <BudgetDashboard budgets={budgets} onOpenTimeline={onOpenTimeline} />,
    );
    fireEvent.click(firstDataRow(container));
    fireEvent.click(screen.getByRole("button", { name: /查看时间线/ }));
    expect(onOpenTimeline).toHaveBeenCalledWith("writer-1");
  });

  it("预算相关 escalation 单独成组，非预算相关不入", () => {
    render(
      <BudgetDashboard
        budgets={budgets}
        escalations={[
          ...escalations,
          {
            schemaVersion: "turn-escalation.v1",
            positionId: "ops-lead",
            turnId: "turn-99",
            at: "2026-08-27T09:00:00.000Z",
            status: "failed",
            code: "engine.doom_loop",
            reportingChain: ["owner"],
            budgetRelated: false,
          },
        ]}
      />,
    );
    const section = screen.getByLabelText("预算相关失败");
    expect(section).toBeInTheDocument();
    expect(section).not.toHaveTextContent("engine.position_budget_exceeded");
    expect(section).not.toHaveTextContent("engine.doom_loop");
  });
});

describe("budget helpers (声明期不伪造百分比)", () => {
  it("budgetPercentText: null → 「声明期」，数值走四舍五入百分比", () => {
    expect(budgetPercentText(null)).toBe("声明期");
    expect(budgetPercentText(0.38)).toBe("38%");
    expect(budgetPercentText(1.16)).toBe("116%");
  });

  it("stateLabel 映射三态", () => {
    expect(stateLabel("exceeded")).toBe("已超出");
    expect(stateLabel("within")).toBe("声明内");
    expect(stateLabel("unobserved")).toBe("无事实");
  });
});

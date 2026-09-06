import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AuditTimeline,
  buildCostDashboardHref,
  classifyAuditEvent,
  groupEventsByRun,
  isBudgetRelatedEvent,
  isEventVisible,
  isRedDotEvent,
  type AuditTimelineEvent,
} from "../src/reports/AuditTimeline";

const makeEvent = (overrides: Partial<AuditTimelineEvent>): AuditTimelineEvent => ({
  id: overrides.id ?? `${overrides.runId ?? "run"}:${overrides.type ?? "run.started"}:${overrides.at ?? "0"}`,
  at: overrides.at ?? "2026-08-27T09:00:00.000Z",
  runId: overrides.runId ?? "run-A",
  type: overrides.type ?? "run.started",
  ...overrides,
});

const sample: AuditTimelineEvent[] = [
  makeEvent({ id: "A:start", runId: "run-A", at: "2026-08-27T09:12:03.000Z", positionId: "writer-1", engine: "qoder", type: "run.started", task: "生成周报" }),
  makeEvent({ id: "A:usage", runId: "run-A", at: "2026-08-27T09:12:41.000Z", positionId: "writer-1", engine: "qoder", type: "usage", totalTokens: 8214 }),
  // model.delta must be filtered out even when injected via props.
  makeEvent({ id: "A:delta", runId: "run-A", at: "2026-08-27T09:12:42.000Z", positionId: "writer-1", engine: "qoder", type: "model.delta" as unknown as AuditTimelineEvent["type"] }),
  makeEvent({ id: "A:done", runId: "run-A", at: "2026-08-27T09:13:10.000Z", positionId: "writer-1", engine: "qoder", type: "run.completed", totalTokens: 26410, envelopeDigest: "sha256:abcd" }),
  makeEvent({ id: "B:fail", runId: "run-B", at: "2026-08-27T10:02:55.000Z", positionId: "writer-1", engine: "qoder", type: "run.failed", terminalReason: "position_budget_exceeded", errorCode: "engine.position_budget_exceeded" }),
  makeEvent({ id: "B:esc",  runId: "run-B", at: "2026-08-27T10:03:01.000Z", positionId: "writer-1", type: "escalation.created", budgetRelated: true, reportingChain: ["ops-lead", "owner"] }),
  makeEvent({ id: "C:ind",  runId: "run-C", at: "2026-08-27T10:20:00.000Z", positionId: "researcher", engine: "qoder", type: "turn.indeterminate", terminalReason: "engine_internal_error" }),
  makeEvent({ id: "AUD:1",  runId: "audit-1", at: "2026-08-27T11:00:00.000Z", type: "org.audit", summary: "招聘 1 · 应用后 12 岗位" }),
];

describe("P0 Turn / 审计时间线（AuditTimeline）", () => {
  it("按 runId 分组：同 runId 的事件收成一个可展开卡片，组头显示岗位/引擎", () => {
    const { container } = render(<AuditTimeline events={sample} />);
    // 4 个组：run-A / run-B / run-C / audit-1（model.delta 被过滤，不构成新组）
    const groupHeaders = container.querySelectorAll(".ant-collapse-item");
    expect(groupHeaders.length).toBe(4);
    // 没有岗位名称映射时不把内部 ID 泄露到界面。
    expect(screen.queryByText(/writer-1/)).not.toBeInTheDocument();
    expect(screen.getAllByText("未命名岗位").length).toBeGreaterThanOrEqual(2);
  });

  it("展开一个组后可以看到该组的事件行", () => {
    const { container } = render(<AuditTimeline events={sample} />);
    const headers = container.querySelectorAll(".ant-collapse-header");
    // 展开 run-A 组（第一个）
    fireEvent.click(headers[0]!);
    // run-A 组展开后应能看到三条可读事件
    // （model.delta 已被过滤）
    const groupA = screen.getByTestId("timeline-group-run-A");
    expect(within(groupA).getByText("开始执行")).toBeInTheDocument();
    expect(within(groupA).getByText("记录用量")).toBeInTheDocument();
    expect(within(groupA).getByText("执行完成")).toBeInTheDocument();
    expect(within(groupA).queryByText("model.delta")).not.toBeInTheDocument();
  });

  it("model.delta 事件被无条件过滤（即使 props 里存在）", () => {
    // 单独构造一批只有 delta 与 started 的事件，验证 delta 不进入分组
    const events: AuditTimelineEvent[] = [
      makeEvent({ id: "X:start", runId: "run-X", type: "run.started" }),
      makeEvent({ id: "X:delta", runId: "run-X", type: "model.delta" as unknown as AuditTimelineEvent["type"] }),
    ];
    render(<AuditTimeline events={events} />);
    // count 中只算 1 条
    expect(screen.getByText("共 1 条")).toBeInTheDocument();
  });

  it("turn_budget_exceeded / position_budget_exceeded → 红点 + 「预算相关」Tag + 成本看板深链", () => {
    render(<AuditTimeline events={sample} />);
    // run-B 是超限组：组头有红点、预算相关 tag、成本看板深链
    const bDot = screen.getByTestId("timeline-dot-run-B");
    expect(bDot.className).toContain("is-danger");
    const bTag = screen.getByTestId("timeline-budget-tag-run-B");
    expect(bTag).toBeInTheDocument();
    expect(bTag.textContent).toContain("预算相关");
    const bLink = screen.getByTestId("timeline-cost-link-run-B") as HTMLAnchorElement;
    expect(bLink.getAttribute("href")).toMatch(/#\/reports\/cost\?runId=run-B/);
    expect(bLink.getAttribute("href")).toMatch(/positionId=writer-1/);
  });

  it("indeterminate 状态用琥珀色，绝不渲染为绿色", () => {
    render(<AuditTimeline events={sample} />);
    const dot = screen.getByTestId("timeline-dot-run-C");
    expect(dot.className).toContain("is-warning");
    expect(dot.className).not.toContain("is-success");
  });

  it("空状态：无任何事件时渲染 Empty 引导文案", () => {
    render(<AuditTimeline events={[]} />);
    expect(screen.getByTestId("timeline-empty")).toBeInTheDocument();
    expect(screen.getByText(/尚无可追溯事件/)).toBeInTheDocument();
  });

  it("空状态：过滤后无结果时渲染另一条空态文案", () => {
    render(
      <AuditTimeline
        events={sample}
        filters={{ positionIds: ["not-exist"] }}
        onFiltersChange={() => {}}
      />,
    );
    expect(screen.getByTestId("timeline-empty")).toBeInTheDocument();
    expect(screen.getByText(/该组合下没有事件/)).toBeInTheDocument();
  });

  it("分页：点击「加载更多」触发 onCursorChange 传递当前 cursor", () => {
    const onCursorChange = vi.fn();
    render(
      <AuditTimeline
        events={sample}
        page={{ cursor: "cursor-xyz", hasMore: true, total: 214, pageSize: 4 }}
        onCursorChange={onCursorChange}
      />,
    );
    const loadMore = screen.getByTestId("timeline-load-more");
    fireEvent.click(loadMore);
    expect(onCursorChange).toHaveBeenCalledWith("cursor-xyz");
  });

  it("只读纪律：时间线上不出现「重试」/「裁决」按钮", () => {
    render(<AuditTimeline events={sample} />);
    expect(screen.queryByRole("button", { name: /重试/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /裁决/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /批准/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /拒绝/ })).toBeNull();
  });
});

describe("预算/分类/深链 纯函数（导出以便策略层测试）", () => {
  it("classifyAuditEvent 覆盖四类事件", () => {
    expect(classifyAuditEvent(makeEvent({ type: "run.started" }))).toBe("turn");
    expect(classifyAuditEvent(makeEvent({ type: "run.failed" }))).toBe("turn");
    expect(classifyAuditEvent(makeEvent({ type: "approval.requested" }))).toBe("approval");
    expect(classifyAuditEvent(makeEvent({ type: "approval.granted" }))).toBe("approval");
    expect(classifyAuditEvent(makeEvent({ type: "approval.denied" }))).toBe("approval");
    expect(classifyAuditEvent(makeEvent({ type: "escalation.created" }))).toBe("escalation");
    expect(classifyAuditEvent(makeEvent({ type: "org.audit" }))).toBe("org");
  });

  it("isBudgetRelatedEvent 命中终态词 / escalation.budgetRelated / 错误码", () => {
    expect(isBudgetRelatedEvent(makeEvent({ type: "run.failed", terminalReason: "position_budget_exceeded" }))).toBe(true);
    expect(isBudgetRelatedEvent(makeEvent({ type: "run.failed", terminalReason: "turn_budget_exceeded" }))).toBe(true);
    expect(isBudgetRelatedEvent(makeEvent({ type: "escalation.created", budgetRelated: true }))).toBe(true);
    expect(isBudgetRelatedEvent(makeEvent({ type: "run.failed", errorCode: "engine.position_budget_exceeded" }))).toBe(true);
    expect(isBudgetRelatedEvent(makeEvent({ type: "run.completed", terminalReason: "goal_met" }))).toBe(false);
  });

  it("isRedDotEvent：失败 / 升级 / 预算相关 → 红点；成功与不确定不红", () => {
    expect(isRedDotEvent(makeEvent({ type: "run.failed" }))).toBe(true);
    expect(isRedDotEvent(makeEvent({ type: "escalation.created" }))).toBe(true);
    expect(isRedDotEvent(makeEvent({ type: "run.completed" }))).toBe(false);
    // indeterminate 单独测：不属于「红」，是「琥珀」
    expect(isRedDotEvent(makeEvent({ type: "turn.indeterminate" }))).toBe(false);
  });

  it("isEventVisible：岗位 / 类别 / 时间范围 组合过滤", () => {
    const e = makeEvent({
      positionId: "writer-1",
      type: "run.failed",
      at: "2026-08-27T10:00:00.000Z",
    });
    // 位置过滤：命中/不命中
    expect(isEventVisible(e, { positionIds: ["writer-1"] })).toBe(true);
    expect(isEventVisible(e, { positionIds: ["other"] })).toBe(false);
    // 类别过滤（run.failed → turn 类）
    expect(isEventVisible(e, { classes: ["turn"] })).toBe(true);
    expect(isEventVisible(e, { classes: ["approval"] })).toBe(false);
    // 时间范围
    expect(isEventVisible(e, { from: "2026-08-27T00:00:00.000Z", to: "2026-08-27T23:59:59.999Z" })).toBe(true);
    expect(isEventVisible(e, { from: "2026-08-28T00:00:00.000Z" })).toBe(false);
    expect(isEventVisible(e, { to: "2026-08-27T09:00:00.000Z" })).toBe(false);
    // 空过滤器 → 全通过
    expect(isEventVisible(e, undefined)).toBe(true);
    expect(isEventVisible(e, {})).toBe(true);
  });

  it("groupEventsByRun：保持首次出现顺序、同 runId 收成一组", () => {
    const events: AuditTimelineEvent[] = [
      makeEvent({ id: "1", runId: "A", type: "run.started" }),
      makeEvent({ id: "2", runId: "B", type: "run.started" }),
      makeEvent({ id: "3", runId: "A", type: "run.completed" }),
    ];
    const grouped = groupEventsByRun(events);
    expect(grouped.map((g) => g.runId)).toEqual(["A", "B"]);
    expect(grouped[0]!.events.map((e) => e.id)).toEqual(["1", "3"]);
    expect(grouped[1]!.events.map((e) => e.id)).toEqual(["2"]);
  });

  it("buildCostDashboardHref 生成 hash-router 深链，携带 runId 与可选 positionId", () => {
    expect(buildCostDashboardHref("run-B")).toBe("#/reports/cost?runId=run-B");
    expect(buildCostDashboardHref("run-B", "writer-1")).toBe(
      "#/reports/cost?runId=run-B&positionId=writer-1",
    );
  });
});

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwbI18nProvider } from "@roleweave/ui";
import { WORKBENCH_PROGRESS_STEPS, type TaskProgressEvent, type TaskProgressSnapshot } from "@roleweave/shared";
import type { GoalDetail, GoalTaskExecution, GoalWorkItem } from "@roleweave/shared/goals";
import type { OwbBridge } from "../src/owb";
import { ProjectBoard } from "../src/goals/ProjectBoard";
import { ProjectTaskProgress } from "../src/goals/ProjectTaskProgress";

const item: GoalWorkItem = { taskId: "task-one", title: "Ship feature", status: "todo", priority: "normal", assigneePositionId: "engineer" };
const snapshot: TaskProgressSnapshot = {
  schemaVersion: "turn-progress.v1", taskId: "turn-one", employeeId: "engineer", positionId: "engineer", workspacePath: "/workspace-a",
  progress: 40, currentStep: 2, overallStatus: "running", startedAt: Date.now() - 5000, updatedAt: 1000,
  steps: WORKBENCH_PROGRESS_STEPS.map((step, index) => ({ ...step, status: index < 2 ? "success" : index === 2 ? "running" : "pending" })),
};
const run: GoalTaskExecution = { turnId: snapshot.taskId, positionId: "engineer", status: "running", progress: snapshot };
function detail(execution: GoalTaskExecution = run): GoalDetail {
  return { goal: { schemaVersion: "goal.v1", goalId: "goal-one", title: "Release", description: "", acceptanceCriteria: [], branches: [],
    status: "open", health: "unknown", workItems: [item], createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z" },
    activity: [], taskExecutions: { [item.taskId]: execution } };
}
function event(fields: Partial<TaskProgressEvent> = {}) {
  return { type: "turn.progress", payload: { taskId: snapshot.taskId, positionId: "engineer", employeeId: "engineer", stepIndex: 3,
    stepName: "Persist turn record", stepStatus: "running", totalSteps: 5, progress: 60, timestamp: 2000, ...fields } };
}

describe("project task progress", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    [undefined, undefined, "idle", "未开始"],
    [run, snapshot, "running", "Agent 执行中"],
    [{ ...run, status: "completed" as const }, snapshot, "review", "执行结束 · 待验收"],
    [{ ...run, status: "failed" as const }, snapshot, "failed", "执行失败"],
    [{ ...run, status: "failed" as const, errorCode: "turn_cancelled" }, snapshot, "cancelled", "执行已取消"],
    [{ ...run, status: "indeterminate" as const }, snapshot, "indeterminate", "执行结果待核实"],
  ])("renders %s as %s without estimating business completion", (execution, progress, state, label) => {
    const { container } = render(<ProjectTaskProgress item={item} run={execution} snapshot={progress} now={Date.now()} />);
    expect(container.firstChild).toHaveAttribute("data-state", state);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: `执行进度：${item.title}` })).toHaveAttribute("aria-valuetext", label);
  });

  it("keeps unknown progress indeterminate and requires acceptance for green completion", () => {
    const context = render(<ProjectTaskProgress item={{ ...item, status: "done" }} run={{ ...run, status: "completed" }} now={0} />);
    expect(context.container.firstChild).toHaveAttribute("data-state", "review");
    context.rerender(<ProjectTaskProgress item={item} run={{ ...run, status: "completed" }} accepted now={0} />);
    expect(context.container.firstChild).toHaveAttribute("data-state", "accepted");
    context.rerender(<ProjectTaskProgress item={item} run={run} now={0} />);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
    context.rerender(<ProjectTaskProgress item={item} run={run} snapshot={snapshot} unavailable now={0} />);
    expect(screen.getByText("进度暂不可用")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
    context.rerender(<ProjectTaskProgress item={{ ...item, status: "blocked" }} run={run} snapshot={snapshot} now={0} />);
    expect(context.container.firstChild).toHaveAttribute("data-state", "blocked");
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "40");
  });

  it("shows localized stage counts and never calls a stale phase proof of a stuck Agent", () => {
    render(<OwbI18nProvider locale="en"><ProjectTaskProgress item={item} run={run} snapshot={{ ...snapshot, overallStatus: "stuck" }} now={0} /></OwbI18nProvider>);
    expect(screen.getByText("Agent working")).toBeInTheDocument();
    expect(screen.getByText("Execution stages 2/5")).toBeInTheDocument();
    expect(screen.queryByText(/stuck|40%/i)).toBeNull();
  });

  it("shares live progress between board, schedule, and editor, keeping only the latest matching run", () => {
    let listener: ((event: unknown) => void) | undefined;
    window.owb = { onEvent: vi.fn((callback) => { listener = callback; return vi.fn(); }) } as unknown as OwbBridge;
    const props = { detail: detail(), workspaceKey: "/workspace-a", positionNames: { engineer: "Engineer" }, onRefresh: vi.fn() };
    const context = render(<ProjectBoard {...props} />);
    const meter = () => screen.getAllByRole("progressbar", { name: `执行进度：${item.title}` })[0]!;
    expect(meter()).toHaveAttribute("value", "40");
    act(() => listener?.(event()));
    expect(meter()).toHaveAttribute("value", "60");
    context.rerender(<ProjectBoard {...props} detail={detail()} />);
    expect(meter()).toHaveAttribute("value", "60");
    fireEvent.click(screen.getByRole("button", { name: item.title }));
    expect(within(screen.getByRole("dialog")).getByRole("progressbar", { name: `执行进度：${item.title}` })).toHaveAttribute("value", "60");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "排期" }));
    expect(meter()).toHaveAttribute("value", "60");
    const next = { ...run, turnId: "turn-two", progress: { ...snapshot, taskId: "turn-two", progress: 20, currentStep: 1 } };
    context.rerender(<ProjectBoard {...props} detail={detail(next)} />);
    act(() => listener?.(event({ progress: 100 })));
    expect(meter()).toHaveAttribute("value", "20");
    act(() => listener?.(event({ taskId: "turn-two", positionId: "another", progress: 80 })));
    expect(meter()).toHaveAttribute("value", "20");
    act(() => listener?.(event({ taskId: "turn-two", progress: 60 })));
    expect(meter()).toHaveAttribute("value", "60");
    const oldListener = listener;
    context.rerender(<ProjectBoard {...props} workspaceKey="/workspace-b" detail={detail({ ...run, progress: { ...snapshot, workspacePath: "/workspace-b" } })} />);
    act(() => oldListener?.(event({ progress: 100 })));
    expect(meter()).toHaveAttribute("value", "40");
    expect(window.owb.onEvent).toHaveBeenCalledTimes(2);
  });
});

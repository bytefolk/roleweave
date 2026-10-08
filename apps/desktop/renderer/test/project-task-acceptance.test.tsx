import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GoalDetail, GoalTaskAcceptanceRecord, GoalTaskDelivery, GoalWorkItem } from "@roleweave/shared/goals";
import type { OwbBridge } from "../src/owb";
import { TaskAcceptanceDrawer } from "../src/goals/TaskAcceptanceDrawer";
import { ProjectBoard } from "../src/goals/ProjectBoard";
import { visibleSelectOptions } from "./select-helper";

const workspaceKey = "/workspaces/release";
const task: GoalWorkItem = {
  taskId: "task-one", title: "Ship delivery", status: "review", priority: "normal", assigneePositionId: "engineer",
};
const delivery: GoalTaskDelivery = {
  source: { positionId: "engineer", turnId: "turn-one", sessionId: "session-one", outputDigest: `sha256:${"a".repeat(64)}` },
  output: "Real delivered result <script>untrusted()</script>", completedAt: "2026-10-07T00:00:00.000Z",
};
const version = "2026-10-07T00:00:00.000Z";
function detail(): GoalDetail {
  return {
    goal: {
      schemaVersion: "goal.v1", goalId: "goal-one", title: "Release", description: "Ship the project",
      acceptanceCriteria: ["The build works", "The handoff is documented"], status: "in_progress", health: "unknown",
      branches: [], workItems: [task], createdAt: version, updatedAt: version,
    },
    activity: [],
    taskExecutions: { "task-one": { turnId: "turn-one", positionId: "engineer", sessionId: "session-one", status: "completed" } },
    taskDeliveries: { "task-one": delivery },
  };
}
function record(decision: "accepted" | "rejected" = "accepted"): GoalTaskAcceptanceRecord {
  return {
    schemaVersion: "goal-task-acceptance.v1", scope: "goal-task", acceptanceId: "acceptance-one",
    goalId: "goal-one", taskId: "task-one", planUpdatedAt: version,
    criteriaSnapshot: detail().goal.acceptanceCriteria, source: delivery.source,
    decision, verdicts: [{ criteriaIndex: 0, passed: decision === "accepted" }, { criteriaIndex: 1, passed: decision === "accepted" }],
    decidedBy: "operator", decidedAt: version, idempotencyKey: "operation-one", requestDigest: `sha256:${"b".repeat(64)}`,
    ...(decision === "rejected" ? { note: "Missing handoff evidence" } : {}),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(value = detail(), overrides: Partial<OwbBridge> = {}) {
  const createGoalTaskAcceptance = vi.fn().mockResolvedValue({ status: 201, body: { record: record() } });
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  window.owb = { createGoalTaskAcceptance, goal: vi.fn().mockResolvedValue({ status: 200, body: value }), ...overrides } as unknown as OwbBridge;
  const props = { detail: value, item: task, workspaceKey, onRefresh, onClose };
  return { createGoalTaskAcceptance, onRefresh, onClose, props, ...render(<TaskAcceptanceDrawer {...props} />) };
}
function confirmCriteria() {
  fireEvent.click(screen.getByRole("checkbox", { name: "The build works" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "The handoff is documented" }));
}
function choose(control: HTMLElement, name: string) {
  fireEvent.mouseDown(control);
  const option = visibleSelectOptions().find((candidate) => candidate.textContent?.trim() === name);
  if (!option) throw new Error(`Missing option ${name}`);
  fireEvent.click(option);
}

describe("project task delivery acceptance", () => {
  it("shows the real output safely and persists all criterion confirmations bound to the exact source and workspace", async () => {
    const context = setup();
    expect(screen.getByLabelText("Agent 真实产出")).toHaveTextContent(delivery.output as string);
    expect(document.querySelector("script")).toBeNull();
    const accept = screen.getByRole("button", { name: "验收通过" });
    expect(accept).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "The build works" }));
    expect(accept).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "The handoff is documented" }));
    fireEvent.click(accept);
    await screen.findByText("验收已保存，任务已完成。");
    expect(context.createGoalTaskAcceptance).toHaveBeenCalledWith({
      goalId: "goal-one", taskId: "task-one", expectedWorkspacePath: workspaceKey, expectedUpdatedAt: version,
      idempotencyKey: expect.any(String), source: delivery.source, decision: "accepted",
      verdicts: [{ criteriaIndex: 0, passed: true }, { criteriaIndex: 1, passed: true }],
    });
    expect(context.onRefresh).toHaveBeenCalledOnce();
  });

  it("requires a reason for rejection and preserves unconfirmed criteria as failed verdicts", async () => {
    const createGoalTaskAcceptance = vi.fn().mockResolvedValue({ status: 201, body: { record: record("rejected") } });
    setup(detail(), { createGoalTaskAcceptance });
    const reject = screen.getByRole("button", { name: "退回修改" });
    expect(reject).toBeDisabled();
    fireEvent.change(screen.getByLabelText("验收说明 / 退回原因"), { target: { value: "   " } });
    expect(reject).toBeDisabled();
    fireEvent.change(screen.getByLabelText("验收说明 / 退回原因"), { target: { value: " Missing handoff evidence " } });
    fireEvent.click(reject);
    await screen.findByText("退回决定和原因已保存，任务保持待验收。");
    expect(createGoalTaskAcceptance).toHaveBeenCalledWith(expect.objectContaining({
      decision: "rejected", note: "Missing handoff evidence",
      verdicts: [{ criteriaIndex: 0, passed: false }, { criteriaIndex: 1, passed: false }],
    }));
  });

  it("does not accept zero criteria but can return the real delivery with a reason", () => {
    const value = detail();
    value.goal.acceptanceCriteria = [];
    setup(value);
    expect(screen.getByText("请先在项目中设置验收标准，再验收此交付。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "验收通过" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "退回修改" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("验收说明 / 退回原因"), { target: { value: "Define acceptance criteria first" } });
    expect(screen.getByRole("button", { name: "退回修改" })).toBeEnabled();
  });

  it("guards duplicate decisions and keeps retries of the unchanged payload idempotent", async () => {
    const pending = deferred<{ status: number; body: { message: string } }>();
    const createGoalTaskAcceptance = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ status: 500, body: { message: "Failed" } });
    setup(detail(), { createGoalTaskAcceptance });
    confirmCriteria();
    const accept = screen.getByRole("button", { name: "验收通过" });
    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(createGoalTaskAcceptance).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve({ status: 500, body: { message: "Failed" } }); });
    await screen.findByRole("alert");
    fireEvent.click(accept);
    await waitFor(() => expect(createGoalTaskAcceptance).toHaveBeenCalledTimes(2));
    expect(createGoalTaskAcceptance.mock.calls[1]?.[0]).toEqual(createGoalTaskAcceptance.mock.calls[0]?.[0]);
  });

  it("retains the review draft on conflict without retrying or changing the version", async () => {
    const createGoalTaskAcceptance = vi.fn().mockResolvedValue({ status: 409, body: { message: "Changed" } });
    setup(detail(), { createGoalTaskAcceptance });
    confirmCriteria();
    fireEvent.change(screen.getByLabelText("验收说明 / 退回原因"), { target: { value: "Keep this review note" } });
    fireEvent.click(screen.getByRole("button", { name: "验收通过" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("验收说明 / 退回原因")).toHaveValue("Keep this review note");
    expect(screen.getByRole("checkbox", { name: "The build works" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "The handoff is documented" })).toBeChecked();
    expect(screen.getByRole("button", { name: "验收通过" })).toBeDisabled();
    expect(createGoalTaskAcceptance).toHaveBeenCalledOnce();
    expect(createGoalTaskAcceptance.mock.calls[0]?.[0].expectedUpdatedAt).toBe(version);
  });

  it("uses a new idempotency key when a failed acceptance changes into a rejection", async () => {
    const createGoalTaskAcceptance = vi.fn().mockResolvedValue({ status: 500, body: { message: "Failed" } });
    setup(detail(), { createGoalTaskAcceptance });
    confirmCriteria();
    fireEvent.change(screen.getByLabelText("验收说明 / 退回原因"), { target: { value: "Review changed" } });
    fireEvent.click(screen.getByRole("button", { name: "验收通过" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "退回修改" }));
    await waitFor(() => expect(createGoalTaskAcceptance).toHaveBeenCalledTimes(2));
    expect(createGoalTaskAcceptance.mock.calls[1]?.[0].decision).toBe("rejected");
    expect(createGoalTaskAcceptance.mock.calls[1]?.[0].idempotencyKey).not.toBe(createGoalTaskAcceptance.mock.calls[0]?.[0].idempotencyKey);
  });

  it("locks the opening review snapshot when fresh output arrives in the background", () => {
    const context = setup();
    confirmCriteria();
    fireEvent.change(screen.getByLabelText("验收说明 / 退回原因"), { target: { value: "Keep my draft" } });
    const fresh = detail();
    fresh.taskDeliveries = { "task-one": { ...delivery, source: { ...delivery.source, outputDigest: `sha256:${"c".repeat(64)}` }, output: "New output" } };
    context.rerender(<TaskAcceptanceDrawer {...context.props} detail={fresh} />);
    expect(screen.getByLabelText("Agent 真实产出")).toHaveTextContent(delivery.output as string);
    expect(screen.getByRole("button", { name: "验收通过" })).toBeDisabled();
    expect(screen.getByLabelText("验收说明 / 退回原因")).toHaveValue("Keep my draft");
    expect(screen.getByRole("button", { name: "刷新交付并重新核对" })).toBeInTheDocument();
    expect(context.createGoalTaskAcceptance).not.toHaveBeenCalled();
  });

  it("reloads a changed delivery explicitly, retains the reason and requires fresh confirmations", async () => {
    const value = detail();
    const fresh = detail();
    fresh.goal.updatedAt = "2026-10-07T01:00:00.000Z";
    fresh.taskDeliveries = { "task-one": { ...delivery, source: { ...delivery.source, turnId: "turn-two", outputDigest: `sha256:${"c".repeat(64)}` }, output: "Revised real output" } };
    const createGoalTaskAcceptance = vi.fn().mockResolvedValueOnce({ status: 409, body: { message: "Changed" } }).mockResolvedValue({ status: 201, body: { record: record() } });
    const context = setup(value, { createGoalTaskAcceptance, goal: vi.fn().mockResolvedValue({ status: 200, body: fresh }) });
    context.onRefresh.mockImplementation(async () => { context.rerender(<TaskAcceptanceDrawer {...context.props} detail={fresh} />); });
    confirmCriteria();
    fireEvent.change(screen.getByLabelText("验收说明 / 退回原因"), { target: { value: "Retain my note" } });
    fireEvent.click(screen.getByRole("button", { name: "验收通过" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "刷新交付并重新核对" }));
    await screen.findByText("Revised real output");
    expect(screen.getByLabelText("验收说明 / 退回原因")).toHaveValue("Retain my note");
    expect(screen.getByRole("checkbox", { name: "The build works" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "验收通过" })).toBeDisabled();
    expect(createGoalTaskAcceptance).toHaveBeenCalledOnce();
    confirmCriteria();
    fireEvent.click(screen.getByRole("button", { name: "验收通过" }));
    await waitFor(() => expect(createGoalTaskAcceptance).toHaveBeenCalledTimes(2));
    expect(createGoalTaskAcceptance.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ expectedUpdatedAt: fresh.goal.updatedAt, source: fresh.taskDeliveries["task-one"]!.source, note: "Retain my note" }));
    expect(createGoalTaskAcceptance.mock.calls[1]?.[0].idempotencyKey).not.toBe(createGoalTaskAcceptance.mock.calls[0]?.[0].idempotencyKey);
  });

  it("reads persisted historical criteria and rejection notes after closing and reopening", () => {
    const value = detail();
    value.goal.taskAcceptances = [record("rejected")];
    value.goal.acceptanceCriteria = ["A newer criterion"];
    const first = setup(value);
    const history = within(screen.getByRole("region", { name: "验收记录" }));
    expect(history.getByText("The build works")).toBeInTheDocument();
    expect(history.getByText("Missing handoff evidence")).toBeInTheDocument();
    first.unmount();
    const reopened = setup(value);
    expect(screen.getByText("Missing handoff evidence")).toBeInTheDocument();
    expect(reopened.createGoalTaskAcceptance).not.toHaveBeenCalled();
  });

  it("makes legacy executions and an older bridge explicitly read-only for acceptance", () => {
    const value = detail();
    delete value.taskDeliveries;
    value.taskDeliveryUnavailable = { "task-one": "session_required" };
    setup(value, { createGoalTaskAcceptance: undefined });
    expect(screen.getByText("该旧版执行没有真实会话关联，请重新执行任务后再验收交付。")).toBeInTheDocument();
    expect(screen.getByText("当前应用会话无法保存验收，请在当前版本中重新打开工作区。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "验收通过" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "退回修改" })).toBeDisabled();
  });

  it("routes Done through review for executed tasks and leaves manual plans on the original update path", async () => {
    const value = detail();
    const updateGoal = vi.fn().mockResolvedValue({ status: 200, body: { goalId: "goal-one" } });
    window.owb = { updateGoal } as unknown as OwbBridge;
    const props = { detail: value, workspaceKey, positionNames: { engineer: "Engineer" }, onRefresh: vi.fn() };
    const context = render(<ProjectBoard {...props} />);
    choose(screen.getByRole("combobox", { name: "变更任务状态：Ship delivery" }), "已完成");
    expect(await screen.findByRole("dialog")).toHaveTextContent("验收交付：Ship delivery");
    expect(updateGoal).not.toHaveBeenCalled();
    context.unmount();
    const manual = detail();
    delete manual.taskExecutions;
    delete manual.taskDeliveries;
    render(<ProjectBoard {...props} detail={manual} />);
    choose(screen.getByRole("combobox", { name: "变更任务状态：Ship delivery" }), "已完成");
    await waitFor(() => expect(updateGoal).toHaveBeenCalledWith(expect.objectContaining({ workItems: [{ ...task, status: "done" }] })));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("prevents the task editor from bypassing delivery acceptance", () => {
    const updateGoal = vi.fn();
    window.owb = { updateGoal } as unknown as OwbBridge;
    render(<ProjectBoard detail={detail()} workspaceKey={workspaceKey} positionNames={{ engineer: "Engineer" }} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Ship delivery" }));
    const drawer = within(screen.getByRole("dialog"));
    fireEvent.mouseDown(drawer.getByRole("combobox", { name: "任务状态" }));
    const done = visibleSelectOptions().find((candidate) => candidate.textContent?.trim() === "已完成");
    expect(done).toHaveClass("ant-select-item-option-disabled");
    expect(updateGoal).not.toHaveBeenCalled();
  });

  it("keeps reassigned tasks with an older execution on the acceptance path", async () => {
    const value = detail();
    value.goal.workItems = [{ ...task, assigneePositionId: "designer" }];
    value.taskExecutions = {};
    value.taskDeliveries = {};
    value.taskDeliveryUnavailable = { "task-one": "execution_incomplete" };
    const updateGoal = vi.fn();
    window.owb = { updateGoal } as unknown as OwbBridge;
    render(<ProjectBoard detail={value} workspaceKey={workspaceKey} positionNames={{ designer: "Designer" }} onRefresh={vi.fn()} />);
    choose(screen.getByRole("combobox", { name: "变更任务状态：Ship delivery" }), "已完成");
    expect(await screen.findByRole("dialog")).toHaveTextContent("仅已完成的 Agent 执行可以验收");
    expect(updateGoal).not.toHaveBeenCalled();
  });

  it("keeps the open review draft visible when a background update removes the task", async () => {
    window.owb = { createGoalTaskAcceptance: vi.fn() } as unknown as OwbBridge;
    const props = { detail: detail(), workspaceKey, positionNames: { engineer: "Engineer" }, onRefresh: vi.fn() };
    const context = render(<ProjectBoard {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "验收交付：Ship delivery" }));
    confirmCriteria();
    fireEvent.change(screen.getByLabelText("验收说明 / 退回原因"), { target: { value: "Keep this note" } });
    const fresh = detail();
    fresh.goal.workItems = [];
    fresh.goal.updatedAt = "2026-10-07T01:00:00.000Z";
    context.rerender(<ProjectBoard {...props} detail={fresh} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("验收说明 / 退回原因")).toHaveValue("Keep this note");
    expect(screen.getByText("此任务已不存在，已保留你的验收草稿。请关闭面板并刷新项目。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "验收通过" })).toBeDisabled();
  });

  it("drops late decision results when the review panel is unmounted for a workspace switch", async () => {
    const pending = deferred<{ status: number; body: { record: GoalTaskAcceptanceRecord } }>();
    const context = setup(detail(), { createGoalTaskAcceptance: vi.fn().mockReturnValue(pending.promise) });
    confirmCriteria();
    fireEvent.click(screen.getByRole("button", { name: "验收通过" }));
    context.unmount();
    const other = setup(detail());
    await act(async () => { pending.resolve({ status: 201, body: { record: record() } }); });
    expect(context.onRefresh).not.toHaveBeenCalled();
    expect(other.onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByText("验收已保存，任务已完成。")).not.toBeInTheDocument();
  });
});

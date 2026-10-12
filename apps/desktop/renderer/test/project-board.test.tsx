import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalDetail, GoalWorkItem } from "@roleweave/shared/goals";
import type { OwbBridge } from "../src/owb";
import { ProjectBoard } from "../src/goals/ProjectBoard";
import { visibleSelectOptions } from "./select-helper";
import { enterPickerDate } from "./date-picker-helper";

const task: GoalWorkItem = {
  taskId: "task-one",
  title: "Ship board",
  description: "Build a working board",
  status: "todo",
  priority: "high",
  assigneePositionId: "engineer",
};
const activeSessionId = "11111111-1111-4111-8111-111111111111";
function detail(items: GoalWorkItem[] = [task]): GoalDetail {
  return {
    goal: {
      schemaVersion: "goal.v1",
      goalId: "goal-one",
      title: "Release",
      description: "Launch",
      acceptanceCriteria: [],
      status: "open",
      health: "unknown",
      branches: [],
      workItems: items,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    activity: [],
  };
}
/** The schedule view renders a 28-day window anchored at the current week's
 * Monday, so fixed calendar dates drift out of the window over time and their
 * bars disappear (CI failure on 2026-09-28). Window-sensitive fixtures must
 * derive their dates from today instead. */
function isoFromToday(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
function setup(
  value = detail(),
  overrides: Partial<OwbBridge> = {},
  propsOverrides: Partial<React.ComponentProps<typeof ProjectBoard>> = {},
) {
  const updateGoal = vi
    .fn()
    .mockResolvedValue({ status: 200, body: { goalId: "goal-one" } });
  const createTurn = vi.fn();
  const sessions = vi.fn().mockResolvedValue({ status: 200, body: { positionId: "engineer", activeSessionId, sessions: [] } });
  const createSession = vi.fn();
  const createSessionTurn = vi
    .fn()
    .mockResolvedValue({
      status: 200,
      body: {
        turnId: "turn-one",
        positionId: "engineer",
        status: "running",
        createdAt: "2026-09-22T00:00:00.000Z",
      },
    });
  window.owb = { updateGoal, createTurn, sessions, createSession, createSessionTurn, ...overrides } as unknown as OwbBridge;
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const onOpenBoundSession = vi.fn();
  const props = {
    detail: value,
    positionNames: { engineer: "Engineer", designer: "Designer" },
    positionEngines: { engineer: "codex" as const },
    onRefresh,
    onOpenBoundSession,
    ...propsOverrides,
  };
  return {
    updateGoal,
    createTurn,
    sessions,
    createSession,
    createSessionTurn,
    onRefresh,
    onOpenBoundSession,
    props,
    ...render(<ProjectBoard {...props} />),
  };
}
function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function chooseOption(control: HTMLElement, name: string) {
  fireEvent.mouseDown(control);
  const option = visibleSelectOptions().find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!option) {
    throw new Error(`Select has no visible option named "${name}"`);
  }
  fireEvent.click(option);
}

describe("ProjectBoard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows creation guidance without empty board columns or a zero-total progress meter", () => {
    const { container } = setup(detail([]));
    expect(screen.getByText("把项目拆成可跟进的任务")).toBeInTheDocument();
    expect(screen.getByText("分配责任岗位")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(container.querySelector(".owb-project-columns")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "排期" }));
    expect(container.querySelector(".owb-project-schedule")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("replaces filtered-out tasks with a recoverable empty state in both views", () => {
    const { container } = setup();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索任务" }), { target: { value: "missing" } });
    expect(container.querySelector(".owb-project-columns")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "排期" }));
    expect(container.querySelector(".owb-project-schedule")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("button", { name: "Ship board" })).toBeInTheDocument();
    expect(container.querySelector(".owb-project-schedule")).not.toBeNull();
  });

  it("names the missing date for a task with only a start or due date", () => {
    setup(detail([
      { ...task, taskId: "start-only", startDate: "2026-10-08" },
      { ...task, taskId: "due-only", dueDate: "2026-10-09" },
    ]));
    expect(screen.getByText("开始：2026-10-08 · 截止未定")).toBeInTheDocument();
    expect(screen.getByText("截止：2026-10-09 · 开始未定")).toBeInTheDocument();
  });

  it("creates an assigned task with dates and guards duplicate submission until refresh", async () => {
    const saved = defer<{ status: number; body: { goalId: string } }>();
    const updateGoal = vi.fn().mockReturnValue(saved.promise);
    const context = setup(detail([]), { updateGoal });
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    const drawer = within(screen.getByRole("dialog"));
    fireEvent.change(drawer.getByLabelText("任务标题"), {
      target: { value: "  Ship schedule  " },
    });
    fireEvent.change(drawer.getByLabelText("任务说明"), {
      target: { value: "Make plans visible" },
    });
    chooseOption(drawer.getByLabelText("负责人"), "Engineer");
    enterPickerDate(drawer.getByLabelText("开始日期"), "2026-09-22");
    enterPickerDate(drawer.getByLabelText("截止日期"), "2026-09-25");
    const saveButton = drawer.getByRole("button", { name: "保存任务" });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);
    expect(updateGoal).toHaveBeenCalledTimes(1);
    expect(updateGoal).toHaveBeenCalledWith({
      goalId: "goal-one",
      expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
      workItems: [
        expect.objectContaining({
          taskId: expect.any(String),
          title: "Ship schedule",
          assigneePositionId: "engineer",
          startDate: "2026-09-22",
          dueDate: "2026-09-25",
          priority: "normal",
          status: "todo",
        }),
      ],
    });
    await act(async () =>
      saved.resolve({ status: 200, body: { goalId: "goal-one" } }),
    );
    await waitFor(() => expect(context.onRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("retains failed edits and sends the opening version after a background refresh", async () => {
    const updateGoal = vi
      .fn()
      .mockResolvedValue({
        status: 409,
        body: { message: "Version conflict" },
      });
    const context = setup(detail(), { updateGoal });
    fireEvent.click(screen.getByRole("button", { name: "Ship board" }));
    const drawer = within(screen.getByRole("dialog"));
    fireEvent.change(drawer.getByLabelText("任务标题"), {
      target: { value: "Keep my draft" },
    });
    const fresh = detail([{ ...task, title: "Someone else edited" }]);
    fresh.goal.updatedAt = "2026-09-22T00:00:00.000Z";
    context.rerender(<ProjectBoard {...context.props} detail={fresh} />);
    fireEvent.click(drawer.getByRole("button", { name: "保存任务" }));
    await screen.findByText("Version conflict");
    expect(drawer.getByLabelText("任务标题")).toHaveValue("Keep my draft");
    expect(updateGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    expect(context.onRefresh).not.toHaveBeenCalled();
  });

  it("keeps manual status on a rejected transition", async () => {
    const updateGoal = vi
      .fn()
      .mockResolvedValue({ status: 500, body: { message: "Save failed" } });
    setup(detail(), { updateGoal });
    const control = screen.getByRole("combobox", {
      name: "变更任务状态：Ship board",
    });
    chooseOption(control, "阻塞");
    await screen.findByText("Save failed");
    expect(control.closest(".ant-select")).toHaveTextContent("待办");
    expect(updateGoal).toHaveBeenCalledWith(
      expect.objectContaining({ workItems: [{ ...task, status: "blocked" }] }),
    );
  });

  it("rejects inverted date input and omits cleared dates in the edited task", async () => {
    const context = setup(
      detail([{ ...task, startDate: "2026-09-22", dueDate: "2026-09-25" }]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ship board" }));
    const drawer = within(screen.getByRole("dialog"));
    enterPickerDate(drawer.getByLabelText("截止日期"), "2026-09-01");
    fireEvent.blur(drawer.getByLabelText("截止日期"));
    await waitFor(() => expect(drawer.getByLabelText("截止日期")).toHaveValue("2026-09-25"));
    expect(context.updateGoal).not.toHaveBeenCalled();
    fireEvent.click(drawer.getByLabelText("开始日期").closest(".ant-picker")!.querySelector(".ant-picker-clear")!);
    fireEvent.click(drawer.getByLabelText("截止日期").closest(".ant-picker")!.querySelector(".ant-picker-clear")!);
    expect(drawer.getByLabelText("开始日期")).toHaveValue("");
    expect(drawer.getByLabelText("截止日期")).toHaveValue("");
    fireEvent.click(drawer.getByRole("button", { name: "保存任务" }));
    await waitFor(() =>
      expect(context.updateGoal).toHaveBeenCalledWith(
        expect.objectContaining({ workItems: [task] }),
      ),
    );
  });

  it("blocks saving already stored inverted dates until they are corrected", () => {
    setup(detail([{ ...task, startDate: "2026-09-22", dueDate: "2026-09-01" }]));
    fireEvent.click(screen.getByRole("button", { name: "Ship board" }));
    const drawer = within(screen.getByRole("dialog"));
    expect(drawer.getByRole("button", { name: "保存任务" })).toBeDisabled();
    expect(drawer.getByRole("alert")).toHaveTextContent("截止日期不能早于开始日期");
    fireEvent.click(drawer.getByLabelText("截止日期").closest(".ant-picker")!.querySelector(".ant-picker-clear")!);
    expect(drawer.getByRole("button", { name: "保存任务" })).toBeEnabled();
  });

  it("links execution to the goal and task, guards duplicate runs, and preserves acceptance state", async () => {
    const pending = defer<{
      status: number;
      body: { turnId: string; status: string };
    }>();
    const createSessionTurn = vi.fn().mockReturnValue(pending.promise);
    const context = setup(detail(), { createSessionTurn });
    const run = screen.getByRole("button", { name: "执行任务：Ship board" });
    fireEvent.click(run);
    fireEvent.click(run);
    await waitFor(() => expect(createSessionTurn).toHaveBeenCalledTimes(1));
    expect(createSessionTurn).toHaveBeenCalledWith({
      sessionId: activeSessionId,
      engine: "codex",
      input: "Ship board\n\nBuild a working board",
      goalId: "goal-one",
      branchId: "task-one",
    });
    expect(context.createTurn).not.toHaveBeenCalled();
    expect(context.createSession).not.toHaveBeenCalled();
    await act(async () =>
      pending.resolve({
        status: 200,
        body: { turnId: "turn-one", status: "running" },
      }),
    );
    expect(run).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "查看任务执行：Ship board" }));
    expect(context.onOpenBoundSession).toHaveBeenCalledWith("engineer", activeSessionId, "turn-one");
    const complete = {
      ...detail(),
      taskExecutions: {
        "task-one": {
          turnId: "turn-one",
          positionId: "engineer",
          status: "completed" as const,
        },
      },
    };
    context.rerender(<ProjectBoard {...context.props} detail={complete} />);
    await screen.findByText("Agent 执行完成");
    expect(
      screen
        .getByRole("combobox", { name: "变更任务状态：Ship board" })
        .closest(".ant-select"),
    ).toHaveTextContent("待办");
    expect(context.updateGoal).not.toHaveBeenCalled();
  });

  it("starts work in the newly created session when the assignee has no conversation", async () => {
    const sessions = vi.fn().mockResolvedValue({ status: 200, body: { activeSessionId: null, sessions: [] } });
    const createSession = vi.fn().mockResolvedValue({ status: 201, body: { sessionId: activeSessionId } });
    const context = setup(detail(), { sessions, createSession });
    fireEvent.click(screen.getByRole("button", { name: "执行任务：Ship board" }));
    await waitFor(() => expect(context.createSessionTurn).toHaveBeenCalledOnce());
    expect(createSession).toHaveBeenCalledOnce();
    expect(context.createSessionTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: activeSessionId, goalId: "goal-one", branchId: "task-one" }));
  });

  it("creates only a missing session and reuses a concurrently opened conversation", async () => {
    const sessions = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { activeSessionId: null, sessions: [] } })
      .mockResolvedValueOnce({ status: 200, body: { activeSessionId, sessions: [] } });
    const createSession = vi.fn().mockResolvedValue({ status: 409, body: { message: "position already has an active session" } });
    const context = setup(detail(), { sessions, createSession });
    fireEvent.click(screen.getByRole("button", { name: "执行任务：Ship board" }));
    await waitFor(() => expect(context.createSessionTurn).toHaveBeenCalledOnce());
    expect(createSession).toHaveBeenCalledWith({ positionId: "engineer" });
    expect(context.createSessionTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: activeSessionId }));
    expect(context.createTurn).not.toHaveBeenCalled();
  });

  it("does not dispatch after a workspace switch while resolving the session", async () => {
    const pending = defer<Awaited<ReturnType<OwbBridge["sessions"]>>>();
    const sessions = vi.fn().mockReturnValue(pending.promise);
    const context = setup(detail(), { sessions }, { workspaceKey: "workspace-a" });
    fireEvent.click(screen.getByRole("button", { name: "执行任务：Ship board" }));
    context.rerender(<ProjectBoard {...context.props} workspaceKey="workspace-b" />);
    await act(async () => pending.resolve({ status: 200, body: { schemaVersion: "workbench-session-list.v1", positionId: "engineer", activeSessionId, sessions: [] } }));
    expect(context.createSessionTurn).not.toHaveBeenCalled();
    expect(context.createSession).not.toHaveBeenCalled();
    expect(screen.getByText("Agent 未执行")).toBeInTheDocument();
  });

  it("discards a previous workspace's completed run without changing its new task", async () => {
    const pending = defer<Awaited<ReturnType<OwbBridge["createSessionTurn"]>>>();
    const createSessionTurn = vi.fn().mockReturnValue(pending.promise);
    const context = setup(detail(), { createSessionTurn }, { workspaceKey: "workspace-a" });
    fireEvent.click(screen.getByRole("button", { name: "执行任务：Ship board" }));
    await waitFor(() => expect(createSessionTurn).toHaveBeenCalledOnce());
    context.rerender(<ProjectBoard {...context.props} workspaceKey="workspace-b" />);
    await act(async () => pending.resolve({ status: 200, body: { turnId: "old-turn", status: "completed" } as Awaited<ReturnType<OwbBridge["createSessionTurn"]>>["body"] }));
    expect(context.onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByText("Agent 执行完成")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "执行任务：Ship board" })).toBeEnabled();
  });

  it("does not present unavailable execution evidence as idle, or run an unconfigured owner", () => {
    setup({
      ...detail([
        task,
        {
          ...task,
          taskId: "two",
          title: "Design board",
          assigneePositionId: "designer",
        },
      ]),
      executionUnavailable: true,
    });
    expect(screen.queryByText("Agent 未执行")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "执行任务：Ship board" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "执行任务：Design board" }),
    ).toBeDisabled();
  });

  it("handles a task ID that matches an object prototype key as an unstarted task", () => {
    setup(detail([{ ...task, taskId: "constructor" }]));
    expect(screen.getByText("Agent 未执行")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "执行任务：Ship board" }),
    ).toBeEnabled();
  });

  it.each(["all", "unassigned"])(
    "filters the supported position ID %s separately from special filter options",
    async (positionId) => {
      setup(
        detail([
          {
            ...task,
            taskId: "reserved-owner",
            title: "Assigned work",
            assigneePositionId: positionId,
          },
          {
            ...task,
            taskId: "other-owner",
            title: "Other employee work",
            assigneePositionId: "engineer",
          },
          {
            ...task,
            taskId: "no-owner",
            title: "Unassigned work",
            assigneePositionId: undefined,
          },
        ]),
      );
      const filter = screen.getByRole("combobox", { name: "筛选负责人" });
      chooseOption(filter, positionId);
      expect(
        screen.getByRole("article", { name: "Assigned work" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("article", { name: "Other employee work" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("article", { name: "Unassigned work" }),
      ).not.toBeInTheDocument();

      chooseOption(filter, "未分配");
      expect(
        screen.getByRole("article", { name: "Unassigned work" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("article", { name: "Assigned work" }),
      ).not.toBeInTheDocument();

      chooseOption(filter, "全部负责人");
      expect(screen.getAllByRole("article")).toHaveLength(3);
    },
  );

  it("filters tasks and shows partial dates without inventing a duration", async () => {
    setup(
      detail([
        task,
        {
          ...task,
          taskId: "two",
          title: "Design board",
          assigneePositionId: "designer",
          startDate: "2026-09-22",
        },
      ]),
    );
    const ownerFilter = screen.getByRole("combobox", { name: "筛选负责人" });
    chooseOption(ownerFilter, "Designer");
    expect(
      screen.queryByRole("article", { name: "Ship board" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "Design board" }),
    ).toBeInTheDocument();
    chooseOption(
      screen.getByRole("combobox", { name: "筛选负责人" }),
      "全部负责人",
    );
    fireEvent.click(screen.getByRole("button", { name: "排期" }));
    expect(screen.getByText("开始：2026-09-22 · 截止未定")).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "Ship board" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
  });

  it("deletes an existing task after confirmation and refreshes the board", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const updateGoal = vi
      .fn()
      .mockResolvedValue({ status: 200, body: { goalId: "goal-one" } });
    const context = setup(
      detail([task, { ...task, taskId: "task-two", title: "Second task" }]),
      { updateGoal },
    );
    fireEvent.click(screen.getByRole("button", { name: "Ship board" }));
    const drawer = within(screen.getByRole("dialog"));
    const deleteBtn = drawer.getByRole("button", { name: "删除任务" });
    fireEvent.click(deleteBtn);
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Ship board"));
    expect(updateGoal).toHaveBeenCalledWith({
      goalId: "goal-one",
      expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
      workItems: [expect.objectContaining({ taskId: "task-two", title: "Second task" })],
    });
    await waitFor(() => expect(context.onRefresh).toHaveBeenCalledTimes(1));
    confirmSpy.mockRestore();
  });

  it("cancels task deletion when confirm is rejected", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const updateGoal = vi.fn();
    setup(detail([task]), { updateGoal });
    fireEvent.click(screen.getByRole("button", { name: "Ship board" }));
    const drawer = within(screen.getByRole("dialog"));
    fireEvent.click(drawer.getByRole("button", { name: "删除任务" }));
    expect(updateGoal).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("allows jumping to the turn session when an execution exists", async () => {
    const onOpenBoundSession = vi.fn();
    const runningDetail = {
      ...detail([task]),
      taskExecutions: {
        "task-one": {
          turnId: "turn-abc",
          positionId: "engineer",
          status: "running" as const,
        },
      },
    };
    setup(runningDetail, {}, { onOpenBoundSession });
    const viewBtn = screen.getByRole("button", { name: "查看任务执行：Ship board" });
    expect(viewBtn).toBeInTheDocument();
    fireEvent.click(viewBtn);
    expect(onOpenBoundSession).toHaveBeenCalledWith("engineer", undefined, "turn-abc");
  });

  it("filters tasks by status and priority, and via interactive summary metrics", async () => {
    setup(
      detail([
        { ...task, taskId: "t1", title: "Task 1", status: "todo", priority: "low" },
        { ...task, taskId: "t2", title: "Task 2", status: "in_progress", priority: "high" },
        { ...task, taskId: "t3", title: "Task 3", status: "blocked", priority: "high" },
      ]),
    );
    // Filter by status dropdown
    const statusFilter = screen.getByRole("combobox", { name: "筛选状态" });
    chooseOption(statusFilter, "进行中");
    expect(screen.getByRole("article", { name: "Task 2" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Task 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Task 3" })).not.toBeInTheDocument();

    // Filter by priority dropdown
    chooseOption(statusFilter, "全部状态");
    const priorityFilter = screen.getByRole("combobox", { name: "筛选优先级" });
    chooseOption(priorityFilter, "高优先级");
    expect(screen.getByRole("article", { name: "Task 2" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Task 3" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Task 1" })).not.toBeInTheDocument();

    // Interactive summary metric toggle
    chooseOption(priorityFilter, "全部优先级");
    const inProgressMetric = screen.getByRole("button", { name: /进行中/ });
    fireEvent.click(inProgressMetric);
    expect(screen.getByRole("article", { name: "Task 2" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Task 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Task 3" })).not.toBeInTheDocument();
  });

  it("triggers refresh on 409 conflict and allows syncing to latest version to retry save", async () => {
    let currentDetail = detail();
    const freshDetail = detail([{ ...task, title: "Ship board (updated elsewhere)" }]);
    freshDetail.goal.updatedAt = "2026-09-23T00:00:00.000Z";

    const updateGoal = vi
      .fn()
      .mockResolvedValueOnce({
        status: 409,
        body: { message: "Goal was modified by another user" },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { goalId: "goal-one" },
      });

    let rerenderFn: (ui: React.ReactElement) => void;
    const onRefresh = vi.fn().mockImplementation(async () => {
      currentDetail = freshDetail;
      rerenderFn(<ProjectBoard {...context.props} detail={freshDetail} />);
    });

    const context = setup(currentDetail, { updateGoal }, { onRefresh });
    rerenderFn = context.rerender;

    fireEvent.click(screen.getByRole("button", { name: "Ship board" }));
    const drawer = within(screen.getByRole("dialog"));

    // Modify the draft title
    fireEvent.change(drawer.getByLabelText("任务标题"), {
      target: { value: "Ship board (my draft edits)" },
    });

    // Attempt save which fails with 409
    fireEvent.click(drawer.getByRole("button", { name: "保存任务" }));

    // Verify error and conflict resolution bar appear, but uncommitted draft is preserved
    expect(await drawer.findByText("Goal was modified by another user")).toBeInTheDocument();
    expect(drawer.getByLabelText("任务标题")).toHaveValue("Ship board (my draft edits)");

    const syncBtn = await drawer.findByRole("button", { name: "同步最新版本" });
    fireEvent.click(syncBtn);

    // Verify clicking sync triggers onRefresh
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));

    // Conflict error should be cleared
    expect(drawer.queryByText("Goal was modified by another user")).not.toBeInTheDocument();

    // Now save again with synced version
    fireEvent.click(drawer.getByRole("button", { name: "保存任务" }));

    await waitFor(() =>
      expect(updateGoal).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedUpdatedAt: "2026-09-23T00:00:00.000Z",
          workItems: [
            expect.objectContaining({
              taskId: "task-one",
              title: "Ship board (my draft edits)",
            }),
          ],
        }),
      ),
    );
  });

  it("safely groups malformed or invalid dates into unscheduled section", () => {
    const validStart = isoFromToday(1);
    const validDue = isoFromToday(4);
    setup(
      detail([
        { ...task, taskId: "bad-date", title: "Corrupted date task", startDate: "not-a-date" },
        { ...task, taskId: "valid-date", title: "Valid date task", startDate: validStart, dueDate: validDue },
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "排期" }));

    // Valid date task is in timeline
    expect(screen.getByText(`${validStart} → ${validDue}`)).toBeInTheDocument();

    // Malformed date task is safely placed in unscheduled
    const unscheduledSection = screen.getByRole("heading", { name: /未排期/ });
    expect(unscheduledSection).toBeInTheDocument();
    expect(within(unscheduledSection.parentElement!).getByRole("article", { name: "Corrupted date task" })).toBeInTheDocument();
  });

  it("displays limit notice and disables creation when task limit is reached", () => {
    const sixtyFourTasks = Array.from({ length: 64 }, (_, i) => ({
      ...task,
      taskId: `t-${i}`,
      title: `Task ${i}`,
    }));
    setup(detail(sixtyFourTasks));
    const createBtn = screen.getByRole("button", { name: "新建任务" });
    expect(createBtn).toBeDisabled();
    expect(screen.getByText("项目已达到最大任务数上限（64个）")).toBeInTheDocument();
  });

  it("clamps schedule bar calculations for inverted dates, window-edge spans, and partially invalid dates", () => {
    const invertedStart = isoFromToday(1);
    const invertedDue = isoFromToday(0);
    const partialDue = isoFromToday(5);
    setup(
      detail([
        {
          ...task,
          taskId: "inverted-task",
          title: "Inverted dates task",
          startDate: invertedStart,
          dueDate: invertedDue,
        },
        {
          ...task,
          taskId: "span-task",
          title: "Span task across window",
          startDate: "2025-01-01",
          dueDate: "2027-01-01",
        },
        {
          ...task,
          taskId: "partial-date-task",
          title: "Partially invalid date task",
          startDate: "malformed-date",
          dueDate: partialDue,
        },
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "排期" }));

    // Inverted task bar is clamped chronologically without negative width
    const invBar = screen.getByRole("button", { name: /^Inverted dates task: / });
    expect(invBar).toBeInTheDocument();
    const invLeft = parseFloat(invBar.style.left.match(/([\d.]+)%/)![1]);
    const invWidth = parseFloat(invBar.style.width.match(/([\d.]+)%/)![1]);
    expect(invLeft).toBeGreaterThanOrEqual(0);
    expect(invWidth).toBeGreaterThan(0);

    // Span task covering beyond the window boundaries is clamped to [0%, 100%]
    const spanBar = screen.getByRole("button", { name: /^Span task across window: / });
    expect(spanBar).toBeInTheDocument();
    expect(spanBar.style.left).toBe("0%");
    expect(spanBar.style.width).toBe("100%");

    // Partially invalid date task uses the valid date safely without NaN
    const partialBar = screen.getByRole("button", { name: /^Partially invalid date task: / });
    expect(partialBar).toBeInTheDocument();
    const partialLeft = parseFloat(partialBar.style.left.match(/([\d.]+)%/)![1]);
    const partialWidth = parseFloat(partialBar.style.width.match(/([\d.]+)%/)![1]);
    expect(Number.isFinite(partialLeft)).toBe(true);
    expect(Number.isFinite(partialWidth)).toBe(true);
    expect(partialLeft).toBeGreaterThanOrEqual(0);
    expect(partialWidth).toBeGreaterThan(0);
    expect(screen.getByText(`截止：${partialDue} · 开始未定`)).toBeInTheDocument();
  });

  it("surfaces project.deleteTaskFail error message when deletion fails", async () => {
    const updateGoal = vi.fn().mockResolvedValue({ status: 500, body: {} });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    setup(detail([task]), { updateGoal });

    fireEvent.click(screen.getByRole("button", { name: "Ship board" }));
    const drawer = within(screen.getByRole("dialog"));
    fireEvent.click(drawer.getByRole("button", { name: "删除任务" }));

    expect(await drawer.findByText("删除任务失败，请重试。")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("handles 409 conflict during task deletion and allows syncing to retry deletion", async () => {
    let currentDetail = detail([{ ...task, title: "Task to delete" }]);
    const freshDetail = detail([{ ...task, title: "Task to delete" }]);
    freshDetail.goal.updatedAt = "2026-09-24T00:00:00.000Z";

    const updateGoal = vi
      .fn()
      .mockResolvedValueOnce({
        status: 409,
        body: { message: "Version conflict during delete" },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { goalId: "goal-one" },
      });

    let rerenderFn: (ui: React.ReactElement) => void;
    const onRefresh = vi.fn().mockImplementation(async () => {
      currentDetail = freshDetail;
      rerenderFn(<ProjectBoard {...context.props} detail={freshDetail} />);
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const context = setup(currentDetail, { updateGoal }, { onRefresh });
    rerenderFn = context.rerender;

    fireEvent.click(screen.getByRole("button", { name: "Task to delete" }));
    const drawer = within(screen.getByRole("dialog"));

    // Attempt delete which encounters 409
    fireEvent.click(drawer.getByRole("button", { name: "删除任务" }));

    expect(await drawer.findByText("Version conflict during delete")).toBeInTheDocument();
    const syncBtn = await drawer.findByRole("button", { name: "同步最新版本" });
    expect(syncBtn).toBeInTheDocument();

    // Click sync
    fireEvent.click(syncBtn);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));

    // Retry delete with synced version
    fireEvent.click(drawer.getByRole("button", { name: "删除任务" }));

    await waitFor(() =>
      expect(updateGoal).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedUpdatedAt: "2026-09-24T00:00:00.000Z",
          workItems: [],
        }),
      ),
    );

    confirmSpy.mockRestore();
  });
});

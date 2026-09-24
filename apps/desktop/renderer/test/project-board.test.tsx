import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GoalDetail, GoalWorkItem } from "@roleweave/shared/goals";
import type { OwbBridge } from "../src/owb";
import { ProjectBoard } from "../src/goals/ProjectBoard";

const task: GoalWorkItem = {
  taskId: "task-one",
  title: "Ship board",
  description: "Build a working board",
  status: "todo",
  priority: "high",
  assigneePositionId: "engineer",
};
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
function setup(
  value = detail(),
  overrides: Partial<OwbBridge> = {},
  propsOverrides: Partial<React.ComponentProps<typeof ProjectBoard>> = {},
) {
  const updateGoal = vi
    .fn()
    .mockResolvedValue({ status: 200, body: { goalId: "goal-one" } });
  const createTurn = vi
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
  window.owb = { updateGoal, createTurn, ...overrides } as unknown as OwbBridge;
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

describe("ProjectBoard", () => {
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
    fireEvent.change(drawer.getByLabelText("负责人"), {
      target: { value: "engineer" },
    });
    fireEvent.change(drawer.getByLabelText("开始日期"), {
      target: { value: "2026-09-22" },
    });
    fireEvent.change(drawer.getByLabelText("截止日期"), {
      target: { value: "2026-09-25" },
    });
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
    fireEvent.change(control, { target: { value: "blocked" } });
    await screen.findByText("Save failed");
    expect(control).toHaveValue("todo");
    expect(updateGoal).toHaveBeenCalledWith(
      expect.objectContaining({ workItems: [{ ...task, status: "blocked" }] }),
    );
  });

  it("rejects inverted dates and omits cleared dates in the edited task", async () => {
    const context = setup(
      detail([{ ...task, startDate: "2026-09-22", dueDate: "2026-09-25" }]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ship board" }));
    const drawer = within(screen.getByRole("dialog"));
    fireEvent.change(drawer.getByLabelText("截止日期"), {
      target: { value: "2026-09-01" },
    });
    expect(drawer.getByRole("button", { name: "保存任务" })).toBeDisabled();
    expect(drawer.getByRole("alert")).toHaveTextContent(
      "截止日期不能早于开始日期",
    );
    fireEvent.change(drawer.getByLabelText("开始日期"), {
      target: { value: "" },
    });
    fireEvent.change(drawer.getByLabelText("截止日期"), {
      target: { value: "" },
    });
    fireEvent.click(drawer.getByRole("button", { name: "保存任务" }));
    await waitFor(() =>
      expect(context.updateGoal).toHaveBeenCalledWith(
        expect.objectContaining({ workItems: [task] }),
      ),
    );
  });

  it("links execution to the goal and task, guards duplicate runs, and preserves acceptance state", async () => {
    const pending = defer<{
      status: number;
      body: { turnId: string; status: string };
    }>();
    const createTurn = vi.fn().mockReturnValue(pending.promise);
    const context = setup(detail(), { createTurn });
    const run = screen.getByRole("button", { name: "执行任务：Ship board" });
    fireEvent.click(run);
    fireEvent.click(run);
    expect(createTurn).toHaveBeenCalledTimes(1);
    expect(createTurn).toHaveBeenCalledWith({
      positionId: "engineer",
      engine: "codex",
      input: "Ship board\n\nBuild a working board",
      goalId: "goal-one",
      branchId: "task-one",
    });
    await act(async () =>
      pending.resolve({
        status: 200,
        body: { turnId: "turn-one", status: "running" },
      }),
    );
    expect(run).toBeDisabled();
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
      screen.getByRole("combobox", { name: "变更任务状态：Ship board" }),
    ).toHaveValue("todo");
    expect(context.updateGoal).not.toHaveBeenCalled();
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
    (positionId) => {
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
      const assignedOption = within(filter).getByRole("option", {
        name: positionId,
        exact: true,
      }) as HTMLOptionElement;
      fireEvent.change(filter, { target: { value: assignedOption.value } });
      expect(
        screen.getByRole("article", { name: "Assigned work" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("article", { name: "Other employee work" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("article", { name: "Unassigned work" }),
      ).not.toBeInTheDocument();

      const unassignedOption = within(filter).getByRole("option", {
        name: "未分配",
        exact: true,
      }) as HTMLOptionElement;
      fireEvent.change(filter, { target: { value: unassignedOption.value } });
      expect(
        screen.getByRole("article", { name: "Unassigned work" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("article", { name: "Assigned work" }),
      ).not.toBeInTheDocument();

      const allOption = within(filter).getByRole("option", {
        name: "全部负责人",
        exact: true,
      }) as HTMLOptionElement;
      fireEvent.change(filter, { target: { value: allOption.value } });
      expect(screen.getAllByRole("article")).toHaveLength(3);
    },
  );

  it("filters tasks and shows partial dates without inventing a duration", () => {
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
    const designerOption = within(ownerFilter).getByRole("option", {
      name: "Designer",
      exact: true,
    }) as HTMLOptionElement;
    fireEvent.change(ownerFilter, { target: { value: designerOption.value } });
    expect(
      screen.queryByRole("article", { name: "Ship board" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "Design board" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "筛选负责人" }), {
      target: { value: "all" },
    });
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
    fireEvent.change(statusFilter, { target: { value: "in_progress" } });
    expect(screen.getByRole("article", { name: "Task 2" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Task 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Task 3" })).not.toBeInTheDocument();

    // Filter by priority dropdown
    fireEvent.change(statusFilter, { target: { value: "all" } });
    const priorityFilter = screen.getByRole("combobox", { name: "筛选优先级" });
    fireEvent.change(priorityFilter, { target: { value: "high" } });
    expect(screen.getByRole("article", { name: "Task 2" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Task 3" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Task 1" })).not.toBeInTheDocument();

    // Interactive summary metric toggle
    fireEvent.change(priorityFilter, { target: { value: "all" } });
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
    setup(
      detail([
        { ...task, taskId: "bad-date", title: "Corrupted date task", startDate: "not-a-date" },
        { ...task, taskId: "valid-date", title: "Valid date task", startDate: "2026-09-22", dueDate: "2026-09-25" },
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "排期" }));

    // Valid date task is in timeline
    expect(screen.getByText("2026-09-22 → 2026-09-25")).toBeInTheDocument();

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
    setup(
      detail([
        {
          ...task,
          taskId: "inverted-task",
          title: "Inverted dates task",
          startDate: "2026-09-28",
          dueDate: "2026-09-22",
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
          dueDate: "2026-09-22",
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
    expect(screen.getByText("截止：2026-09-22 · 开始未定")).toBeInTheDocument();
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

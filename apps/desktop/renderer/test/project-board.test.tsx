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
function setup(value = detail(), overrides: Partial<OwbBridge> = {}) {
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
  const props = {
    detail: value,
    positionNames: { engineer: "Engineer", designer: "Designer" },
    positionEngines: { engineer: "codex" as const },
    onRefresh,
  };
  return {
    updateGoal,
    createTurn,
    onRefresh,
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
});

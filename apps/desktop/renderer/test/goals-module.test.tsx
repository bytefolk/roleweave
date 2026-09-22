import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GoalDetail, GoalSummary, AgentTask } from "@roleweave/shared";
import { GoalsModule } from "../src/goals/GoalsModule";
import type { OwbBridge } from "../src/owb";

const goalSummary: GoalSummary = {
  schemaVersion: "goal.v1",
  goalId: "test-goal-001",
  title: "Ship v1.0",
  description: "Release the first stable version",
  acceptanceCriteria: ["All tests pass"],
  status: "open",
  health: "unknown",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  branchCount: 0,
};

const goalDetail: GoalDetail = {
  goal: {
    schemaVersion: "goal.v1",
    goalId: "test-goal-001",
    title: "Ship v1.0",
    description: "Release the first stable version",
    acceptanceCriteria: ["All tests pass"],
    status: "open",
    health: "unknown",
    branches: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  activity: [
    {
      schemaVersion: "goal-activity.v1",
      activityId: "act-001",
      goalId: "test-goal-001",
      kind: "created",
      detail: 'Goal "Ship v1.0" created',
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ],
};

function installBridge(overrides: Partial<OwbBridge> = {}) {
  const bridge: Partial<OwbBridge> = {
    goals: vi.fn().mockResolvedValue({ status: 200, body: { goals: [goalSummary] } }),
    goal: vi.fn().mockResolvedValue({ status: 200, body: goalDetail }),
    createGoal: vi.fn().mockResolvedValue({ status: 201, body: { goalId: "new-goal-id" } }),
    updateGoal: vi.fn().mockResolvedValue({ status: 200, body: { goalId: "test-goal-001" } }),
    deleteGoal: vi.fn().mockResolvedValue({ status: 200, body: { goalId: "test-goal-001", deleted: true } }),
    onEvent: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
  window.owb = bridge as unknown as OwbBridge;
  return bridge;
}

describe("GoalsModule", () => {
  it("shows empty state when no goals exist", async () => {
    installBridge({
      goals: vi.fn().mockResolvedValue({ status: 200, body: { goals: [] } }),
    });
    render(<GoalsModule workspaceOpen />);

    expect(screen.getByText("目标")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("还没有目标")).toBeInTheDocument());
  });

  it("renders goal list and detail on selection", async () => {
    installBridge();
    render(<GoalsModule workspaceOpen />);

    await screen.findByRole("option", { name: /Ship v1.0/ });

    fireEvent.click(screen.getByRole("option", { name: /Ship v1.0/ }));
    await waitFor(() => expect(screen.getByText("Release the first stable version")).toBeInTheDocument());
  });

  it("opens create dialog on button click", async () => {
    installBridge();
    render(<GoalsModule workspaceOpen />);

    await waitFor(() => expect(screen.getByText("目标")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /新建目标/i }));
    expect(screen.getByText("新建目标")).toBeInTheDocument();
  });

  it("renders a Jira-style Agent board with urgent, collaboration, and contractor semantics", async () => {
    const tasks: AgentTask[] = [
      { schemaVersion: "task-board.v1", taskId: "urgent", title: "紧急修复", description: "", assigneePositionId: "worker", requestedByPositionId: "owner", budgetOwnerPositionId: "owner", kind: "direct", mainline: true, priority: "urgent", status: "queued", queueOrder: -1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
      { schemaVersion: "task-board.v1", taskId: "peer", title: "跨组协作", description: "", assigneePositionId: "lead", requestedByPositionId: "worker", budgetOwnerPositionId: "worker", kind: "collaboration", mainline: true, priority: "normal", status: "waiting", queueOrder: 0, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
      { schemaVersion: "task-board.v1", taskId: "edge", title: "边缘调研", description: "", assigneePositionId: "worker", requestedByPositionId: "lead", budgetOwnerPositionId: "lead", kind: "contractor", mainline: false, priority: "normal", status: "active", queueOrder: 1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
    ];
    installBridge({ tasks: vi.fn().mockResolvedValue({ status: 200, body: { tasks } }) } as any);
    render(<GoalsModule workspaceOpen ownerPositionId="owner" positionNames={{ owner: "老板", lead: "组长", worker: "工程师" }} positionAvatars={{ worker: "researcher" }} />);
    fireEvent.click(screen.getByRole("tab", { name: "Agent 看板" }));
    expect(await screen.findByText("紧急修复")).toBeInTheDocument();
    expect(screen.getByText("等待接收方确认")).toBeInTheDocument();
    expect(screen.getByText("不进入主线历史 · 预算由 组长 承担")).toBeInTheDocument();
    expect(document.querySelectorAll(".owb-task-card .owb-avatar img").length).toBeGreaterThan(0);
  });

  it("shows workspace-not-opened message when workspace is closed", () => {
    installBridge();
    render(<GoalsModule workspaceOpen={false} />);
    expect(screen.getByText("目标")).toBeInTheDocument();
  });

  it("offers collaboration decisions only until acceptance, including while execution is waiting", async () => {
    const pending: AgentTask = {
      schemaVersion: "task-board.v1",
      taskId: "pending-collaboration",
      title: "等待接收的协作",
      description: "",
      assigneePositionId: "lead",
      requestedByPositionId: "worker",
      budgetOwnerPositionId: "worker",
      kind: "collaboration",
      mainline: true,
      priority: "normal",
      status: "waiting",
      queueOrder: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const accepted: AgentTask = {
      ...pending,
      taskId: "accepted-collaboration",
      title: "已接收并暂停的协作",
      acceptedAt: "2026-09-01T01:00:00.000Z",
    };
    const bridge = installBridge({
      tasks: vi.fn().mockResolvedValue({ status: 200, body: { tasks: [pending, accepted] } }),
      decideTask: vi.fn().mockResolvedValue({ status: 200, body: { ...pending, status: "queued", acceptedAt: accepted.acceptedAt } }),
    });
    render(<GoalsModule workspaceOpen />);
    fireEvent.click(screen.getByRole("tab", { name: "Agent 看板" }));

    const pendingCard = within((await screen.findByText(pending.title)).closest("article")!);
    expect(pendingCard.getByText("等待接收方确认")).toBeInTheDocument();
    expect(pendingCard.getByRole("button", { name: "接受" })).toBeInTheDocument();
    expect(pendingCard.getByRole("button", { name: "拒绝" })).toBeInTheDocument();

    const acceptedCard = within(screen.getByText(accepted.title).closest("article")!);
    expect(acceptedCard.queryByText("等待接收方确认")).not.toBeInTheDocument();
    expect(acceptedCard.queryByRole("button", { name: "接受" })).not.toBeInTheDocument();
    expect(acceptedCard.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();

    fireEvent.click(pendingCard.getByRole("button", { name: "接受" }));
    await waitFor(() => expect(bridge.decideTask).toHaveBeenCalledWith({
      taskId: pending.taskId,
      decision: "accept",
    }));
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const secondSummary = { ...goalSummary, goalId: "goal-two", title: "Second goal", description: "Second description" };
const secondDetail = { goal: { ...goalDetail.goal, ...secondSummary, branches: [] }, activity: [] };

describe("Goal state integrity (#294)", () => {
  it("uses one global empty state without a stale selection prompt", async () => {
    installBridge({ goals: vi.fn().mockResolvedValue({ status: 200, body: { goals: [] } }) });
    render(<GoalsModule workspaceOpen />);
    await screen.findByText("还没有目标");
    expect(screen.queryByRole("listbox", { name: "目标列表" })).not.toBeInTheDocument();
    expect(screen.queryByText("选择一个目标查看详情。")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "新建目标" })).toHaveLength(1);
  });

  it("discards late goal detail after selection and exposes read failure with retry", async () => {
    const old = deferred<{ status: number; body: GoalDetail }>();
    const goal = vi.fn().mockImplementation((id) => id === goalSummary.goalId ? old.promise : Promise.resolve({ status: 503, body: { message: "offline" } }));
    installBridge({ goals: vi.fn().mockResolvedValue({ status: 200, body: { goals: [goalSummary, secondSummary] } }), goal });
    render(<GoalsModule workspaceOpen />);
    await waitFor(() => expect(goal).toHaveBeenCalledWith(goalSummary.goalId));
    fireEvent.click(screen.getByRole("option", { name: /Second goal/ }));
    await screen.findByText("offline");
    await act(async () => old.resolve({ status: 200, body: goalDetail }));
    expect(screen.queryByText(goalDetail.goal.description)).not.toBeInTheDocument();
    goal.mockResolvedValue({ status: 200, body: secondDetail });
    fireEvent.click(screen.getByRole("button", { name: /重\s?试/ }));
    await screen.findByText("Second description");
  });

  it("isolates open workspaces and restores selection when returning to a module", async () => {
    const bridge = installBridge({ goals: vi.fn().mockResolvedValue({ status: 200, body: { goals: [goalSummary, secondSummary] } }), goal: vi.fn().mockImplementation((id) => Promise.resolve({ status: 200, body: id === goalSummary.goalId ? goalDetail : secondDetail })) });
    const view = render(<GoalsModule workspaceOpen workspaceKey="workspace-a" />);
    await screen.findByRole("option", { name: /Second goal/ });
    fireEvent.click(screen.getByRole("option", { name: /Second goal/ }));
    await screen.findByText("Second description");
    view.unmount();
    const next = render(<GoalsModule workspaceOpen workspaceKey="workspace-a" />);
    await screen.findByText("Second description");
    (bridge.goals as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 200, body: { goals: [] } });
    next.rerender(<GoalsModule workspaceOpen workspaceKey="workspace-b" />);
    expect(screen.queryByText("Second description")).not.toBeInTheDocument();
    await screen.findByText("还没有目标");
  });

  it("offers legal transitions and preserves the previous state on failed save", async () => {
    const bridge = installBridge({ updateGoal: vi.fn().mockResolvedValue({ status: 409, body: { message: "Transition rejected" } }) });
    render(<GoalsModule workspaceOpen />);
    await screen.findByText(goalDetail.goal.description);
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "变更状态" }));
    const options = Array.from(document.querySelectorAll<HTMLElement>(".ant-select-item-option"));
    expect(options.map((option) => option.textContent)).not.toContain("已完成");
    fireEvent.click(options.find((option) => option.textContent === "进行中")!);
    await screen.findByText("Transition rejected");
    expect(bridge.updateGoal).toHaveBeenCalledWith({ goalId: goalSummary.goalId, status: "in_progress" });
    expect(screen.getByRole("combobox", { name: "变更状态" }).closest(".ant-select-content")).toHaveTextContent("待开始");
  });

  it("refreshes explicitly after deleting the last goal and names the confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const goals = vi.fn().mockResolvedValueOnce({ status: 200, body: { goals: [goalSummary] } }).mockResolvedValue({ status: 200, body: { goals: [] } });
    const bridge = installBridge({ goals });
    render(<GoalsModule workspaceOpen />);
    await screen.findByText(goalDetail.goal.description);
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    await screen.findByText("还没有目标");
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(goalSummary.title));
    expect(bridge.deleteGoal).toHaveBeenCalledWith(goalSummary.goalId);
    expect(goals).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it("keeps filtered-empty separate from the create-empty state", async () => {
    installBridge();
    render(<GoalsModule workspaceOpen />);
    await screen.findByRole("option", { name: /Ship v1.0/ });
    fireEvent.change(screen.getByRole("textbox", { name: "搜索目标标题" }), { target: { value: "missing" } });
    expect(screen.getByText("没有符合条件的目标")).toBeInTheDocument();
    expect(screen.queryByText("还没有目标")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("option", { name: /Ship v1.0/ })).toBeInTheDocument();
  });

  it("keeps failed creation input and reads back the returned ID after one successful submission", async () => {
    const create = deferred<{ status: number; body: { goalId: string } }>();
    const goals = vi.fn().mockResolvedValueOnce({ status: 200, body: { goals: [] } }).mockResolvedValue({ status: 200, body: { goals: [secondSummary] } });
    const bridge = installBridge({ goals, createGoal: vi.fn().mockResolvedValueOnce({ status: 500, body: { message: "Create failed" } }).mockReturnValue(create.promise), goal: vi.fn().mockResolvedValue({ status: 200, body: secondDetail }) });
    render(<GoalsModule workspaceOpen />);
    await screen.findByText("还没有目标");
    fireEvent.click(screen.getByRole("button", { name: "新建目标" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("标题"), { target: { value: "Second goal" } });
    fireEvent.change(within(dialog).getByLabelText("描述"), { target: { value: "Second description" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建目标" }));
    await screen.findByText("Create failed");
    expect(within(dialog).getByLabelText("标题")).toHaveValue("Second goal");
    const submit = within(dialog).getByRole("button", { name: "创建目标" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(bridge.createGoal).toHaveBeenCalledTimes(2);
    await act(async () => create.resolve({ status: 201, body: { goalId: "goal-two" } }));
    await waitFor(() => expect(bridge.goal).toHaveBeenCalledWith("goal-two"));
    expect(goals).toHaveBeenCalledTimes(2);
    await screen.findByRole("heading", { name: "Second goal" });
  });
});

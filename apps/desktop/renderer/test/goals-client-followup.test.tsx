import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OwbI18nProvider } from "@roleweave/ui";
import type { AgentTask, GoalDetail, GoalTaskAcceptanceRecord } from "@roleweave/shared";
import type { OwbBridge } from "../src/owb";
import { GoalsModule } from "../src/goals/GoalsModule";
import { GoalCriteriaDialog } from "../src/goals/GoalCriteriaDialog";

const at = "2026-10-01T00:00:00.000Z";
const later = "2026-10-02T00:00:00.000Z";
function detail(): GoalDetail {
  return { goal: { schemaVersion: "goal.v1", goalId: "followup-goal", title: "Review project", description: "Project description",
    acceptanceCriteria: [], status: "open", health: "unknown", branches: [], createdAt: at, updatedAt: at }, activity: [] };
}
function install(value = detail(), overrides: Partial<OwbBridge> = {}) {
  const bridge = {
    goals: vi.fn().mockResolvedValue({ status: 200, body: { goals: [{ ...value.goal, branchCount: value.goal.branches.length }] } }),
    goal: vi.fn().mockResolvedValue({ status: 200, body: value }),
    onEvent: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
  window.owb = bridge as unknown as OwbBridge;
  return bridge;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function branch(sessionId?: string) {
  return { branchId: `branch-${sessionId ?? "unbound"}`, title: `Branch ${sessionId ?? "unbound"}`, positionId: "engineer",
    sessionId, status: "in_progress" as const, createdAt: at, updatedAt: at };
}

describe("blocked goal navigation (#579)", () => {
  it.each([undefined, ""])("hides a shortcut for an unbound branch (%s)", async (sessionId) => {
    const value = detail(); value.goal.branches = [branch(sessionId)]; value.healthOverlay = "blocked";
    install(value);
    render(<GoalsModule workspaceOpen onOpenBoundSession={vi.fn()} />);
    await screen.findByText(value.goal.branches[0].title.trim());
    expect(screen.queryByTestId("goals-health-open-turn")).not.toBeInTheDocument();
    expect(screen.getByTestId("goals-health-blocked-empty")).toBeInTheDocument();
  });
  it("skips role-only branches and opens the exact later bound session", async () => {
    const value = detail(); value.goal.branches = [branch(), branch("bound-session")]; value.healthOverlay = "blocked";
    install(value);
    const open = vi.fn();
    render(<GoalsModule workspaceOpen onOpenBoundSession={open} />);
    fireEvent.click(await screen.findByTestId("goals-health-open-turn"));
    expect(open).toHaveBeenCalledWith("engineer", "bound-session");
  });
  it("hides a nonfunctional shortcut when no session callback is provided", async () => {
    const value = detail(); value.goal.branches = [branch("bound-session")]; value.healthOverlay = "blocked";
    install(value);
    render(<GoalsModule workspaceOpen />);
    await screen.findByText("Branch bound-session");
    expect(screen.queryByTestId("goals-health-open-turn")).not.toBeInTheDocument();
    expect(screen.getByTestId("goals-health-blocked-empty")).toBeInTheDocument();
  });
});

const task = (title: string): AgentTask => ({ schemaVersion: "task-board.v1", taskId: title, title, description: "", status: "queued",
  assigneePositionId: "engineer", requestedByPositionId: "owner", budgetOwnerPositionId: "owner", kind: "direct", mainline: true,
  priority: "normal", createdAt: at, updatedAt: at });
describe("live task board (#580)", () => {
  it("refreshes after task events and reconnect, ignoring older responses", async () => {
    const old = deferred<{ status: number; body: { tasks: AgentTask[] } }>();
    const tasks = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ status: 200, body: { tasks: [task("Newest task")] } });
    let event: (value: unknown) => void = () => {};
    let sse: (value: "connected" | "connecting") => void = () => {};
    install(detail(), { tasks, onEvent: vi.fn((fn) => { event = fn; return () => {}; }), onSseStatus: vi.fn((fn) => { sse = fn; return () => {}; }) });
    render(<GoalsModule workspaceOpen />);
    fireEvent.click(screen.getByRole("tab", { name: "Agent 看板" }));
    await waitFor(() => expect(tasks).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("正在读取任务…");
    await act(async () => event({ type: "goal.updated", taskId: "Newest task" }));
    await screen.findByText("Newest task");
    await act(async () => old.resolve({ status: 200, body: { tasks: [task("Stale task")] } }));
    expect(screen.queryByText("Stale task")).not.toBeInTheDocument();
    await act(async () => sse("connected"));
    expect(tasks).toHaveBeenCalledTimes(3);
  });
  it("preserves the last snapshot after failure and lets the user retry", async () => {
    const tasks = vi.fn().mockResolvedValueOnce({ status: 200, body: { tasks: [task("Cached task")] } })
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue({ status: 200, body: { tasks: [task("Recovered task")] } });
    let event: (value: unknown) => void = () => {};
    install(detail(), { tasks, onEvent: vi.fn((fn) => { event = fn; return () => {}; }) });
    render(<GoalsModule workspaceOpen />);
    fireEvent.click(screen.getByRole("tab", { name: "Agent 看板" }));
    await screen.findByText("Cached task");
    await act(async () => event({ type: "goal.updated", taskId: "Cached task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    expect(screen.getByText("Cached task")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重\s*试/ }));
    await screen.findByText("Recovered task");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("discards requests from a previous workspace with identical task identities", async () => {
    const old = deferred<{ status: number; body: { tasks: AgentTask[] } }>();
    install(detail(), { tasks: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ status: 200, body: { tasks: [task("Workspace B task")] } }) });
    const view = render(<GoalsModule workspaceOpen workspaceKey="workspace-a" />);
    fireEvent.click(screen.getByRole("tab", { name: "Agent 看板" }));
    view.rerender(<GoalsModule workspaceOpen workspaceKey="workspace-b" />);
    fireEvent.click(screen.getByRole("tab", { name: "Agent 看板" }));
    await screen.findByText("Workspace B task");
    await act(async () => old.resolve({ status: 200, body: { tasks: [task("Workspace A task")] } }));
    expect(screen.queryByText("Workspace A task")).not.toBeInTheDocument();
  });
});

describe("acceptance criteria repair (#578)", () => {
  it("preserves a conflicting draft, explicitly reloads current criteria and retries with the new version", async () => {
    const latest = detail(); latest.goal.acceptanceCriteria = ["Server criterion"]; latest.goal.updatedAt = later;
    const updateGoal = vi.fn().mockResolvedValueOnce({ status: 409, body: {} }).mockResolvedValue({ status: 200, body: {} });
    install(latest, { updateGoal });
    const onClose = vi.fn();
    render(<GoalCriteriaDialog goal={detail().goal} onClose={onClose} onSaved={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "添加标准" }));
    fireEvent.change(screen.getByLabelText("验收标准 1"), { target: { value: "My draft" } });
    fireEvent.click(screen.getByRole("button", { name: "保存验收标准" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("验收标准 1")).toHaveValue("My draft");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "加载最新验收标准" }));
    await waitFor(() => expect(screen.getByLabelText("验收标准 1")).toHaveValue("Server criterion"));
    fireEvent.change(screen.getByLabelText("验收标准 1"), { target: { value: "Reviewed latest criterion" } });
    fireEvent.click(screen.getByRole("button", { name: "保存验收标准" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(updateGoal).toHaveBeenLastCalledWith({ goalId: "followup-goal", acceptanceCriteria: ["Reviewed latest criterion"], expectedUpdatedAt: later });
  });
  it("keeps an unsuccessful save retryable, locks duplicate submissions and supports English", async () => {
    const pending = deferred<{ status: number; body: object }>();
    const updateGoal = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ status: 200, body: {} });
    install(detail(), { updateGoal });
    const onClose = vi.fn();
    render(<OwbI18nProvider locale="en"><GoalCriteriaDialog goal={detail().goal} onClose={onClose} onSaved={vi.fn().mockResolvedValue(undefined)} /></OwbI18nProvider>);
    expect(screen.getByRole("button", { name: "Save acceptance criteria" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add criterion" }));
    fireEvent.change(screen.getByLabelText("Acceptance criterion 1"), { target: { value: "  Build works  " } });
    const save = screen.getByRole("button", { name: "Save acceptance criteria" });
    fireEvent.click(save); fireEvent.click(save);
    expect(updateGoal).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ status: 500, body: {} }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your draft is preserved");
    fireEvent.click(save);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(updateGoal).toHaveBeenLastCalledWith({ goalId: "followup-goal", acceptanceCriteria: ["Build works"], expectedUpdatedAt: at });
  });
  it("lets a project with no criteria add a criterion and accept its real delivery", async () => {
    const value = detail();
    const item = { taskId: "delivery-task", title: "Delivery", priority: "normal" as const, status: "review" as const, assigneePositionId: "engineer" };
    const source = { positionId: "engineer", turnId: "delivery-turn", sessionId: "delivery-session", outputDigest: `sha256:${"a".repeat(64)}` };
    value.goal.workItems = [item];
    value.taskExecutions = { [item.taskId]: { ...source, status: "completed" } };
    value.taskDeliveries = { [item.taskId]: { source, output: "Delivered implementation", completedAt: at } };
    const updateGoal = vi.fn(async (request) => {
      value.goal.acceptanceCriteria = request.acceptanceCriteria; value.goal.updatedAt = later;
      return { status: 200, body: { goalId: value.goal.goalId } };
    });
    const createGoalTaskAcceptance = vi.fn(async (request) => {
      const record: GoalTaskAcceptanceRecord = { schemaVersion: "goal-task-acceptance.v1", scope: "goal-task", acceptanceId: "accepted",
        goalId: value.goal.goalId, taskId: item.taskId, planUpdatedAt: later, workspacePath: "/workspace", criteriaSnapshot: ["Build works"], source,
        decision: "accepted", verdicts: request.verdicts, decidedBy: "operator", decidedAt: later,
        idempotencyKey: request.idempotencyKey, requestDigest: `sha256:${"b".repeat(64)}` };
      value.goal.workItems = [{ ...item, status: "done" }]; value.goal.taskAcceptances = [record];
      return { status: 201, body: { record } };
    });
    install(value, { updateGoal: updateGoal as OwbBridge["updateGoal"], createGoalTaskAcceptance: createGoalTaskAcceptance as OwbBridge["createGoalTaskAcceptance"] });
    render(<GoalsModule workspaceOpen workspaceKey="/workspace" presentation="projects" positionNames={{ engineer: "Engineer" }} />);
    await screen.findByRole("button", { name: "Delivery", exact: true });
    fireEvent.click(document.querySelector(".owb-project-overview > summary")!);
    fireEvent.click(screen.getByRole("button", { name: "编辑验收标准" }));
    fireEvent.click(screen.getByRole("button", { name: "添加标准" }));
    fireEvent.change(screen.getByLabelText("验收标准 1"), { target: { value: "Build works" } });
    fireEvent.click(screen.getByRole("button", { name: "保存验收标准" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "验收交付：Delivery" }));
    const drawer = within(await screen.findByRole("dialog"));
    expect(drawer.getByLabelText("Agent 真实产出")).toHaveTextContent("Delivered implementation");
    fireEvent.click(drawer.getByRole("checkbox", { name: "Build works" }));
    fireEvent.click(drawer.getByRole("button", { name: "验收通过" }));
    await screen.findByText("验收已保存，任务已完成。");
    expect(createGoalTaskAcceptance).toHaveBeenCalledWith(expect.objectContaining({ source, expectedUpdatedAt: later, decision: "accepted", verdicts: [{ criteriaIndex: 0, passed: true }] }));
    expect(value.goal.workItems[0].status).toBe("done");
  });
});

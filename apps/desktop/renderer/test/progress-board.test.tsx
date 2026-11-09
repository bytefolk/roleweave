import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskProgressEvent, TaskProgressSnapshot } from "@roleweave/shared";
import { ProgressBoard } from "../src/progress/ProgressBoard";
import { applyProgressEvent } from "../src/progress/useTaskProgress";
import { OwbI18nProvider } from "@roleweave/ui";
import type { OwbBridge } from "../src/owb";

const snapshot: TaskProgressSnapshot = {
  schemaVersion: "turn-progress.v1",
  taskId: "turn-1",
  employeeId: "repo-owner",
  positionId: "repo-owner",
  employeeName: "Repo Owner",
  taskTitle: "summarize open issues",
  progress: 40,
  currentStep: 2,
  overallStatus: "running",
  startedAt: Date.now() - 5000,
  updatedAt: Date.now(),
  workspacePath: "/tmp/ws",
  steps: [
    { id: "thread-context", name: "Assemble thread context", status: "success", durationMs: 12 },
    { id: "spawn", name: "Reserve and spawn", status: "success", durationMs: 8 },
    { id: "streaming", name: "Engine streaming", status: "running" },
    { id: "persist", name: "Persist turn record", status: "pending" },
    { id: "terminal", name: "Publish terminal", status: "pending" },
  ],
};

function installBridge(overrides: Partial<OwbBridge> = {}) {
  window.owb = {
    turnProgress: vi.fn().mockResolvedValue({ status: 200, body: { snapshots: [snapshot] } }),
    onEvent: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as unknown as OwbBridge;
}

function renderBoard() {
  return render(
    <OwbI18nProvider locale="zh">
      <ProgressBoard workspaceOpen positionNames={{ "repo-owner": "Repo Owner" }} />
    </OwbI18nProvider>,
  );
}

describe("ProgressBoard", () => {
  it("sorts latest first and follows up only failed/stuck snapshots", async () => {
    const items = [snapshot, { ...snapshot, taskId: "failed", taskTitle: "Failed run", overallStatus: "failed" as const, updatedAt: snapshot.updatedAt + 10 }, { ...snapshot, taskId: "success", taskTitle: "Successful run", overallStatus: "success" as const }];
    installBridge({ turnProgress: vi.fn().mockResolvedValue({ status: 200, body: { snapshots: items } }) });
    renderBoard();
    const timeline = within(await screen.findByRole("region", { name: "执行时间线" }));
    expect(timeline.getAllByRole("button")[0]).toHaveTextContent("Failed run");
    const followUp = within(screen.getByRole("complementary", { name: "待跟进" }));
    expect(followUp.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(followUp.getByRole("button", { name: /Failed run/ }));
    await screen.findByText("Assemble thread context");
  });

  it("distinguishes failed reads from empty data and retries", async () => {
    const turnProgress = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: 200, body: { snapshots: [] } });
    installBridge({ turnProgress });
    renderBoard();
    await screen.findByRole("alert");
    expect(screen.queryByText("还没有进行中或刚结束的回合。")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /刷新/ }));
    await screen.findByText("还没有进行中或刚结束的回合。");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("preserves the last snapshot and selection after a failed refresh", async () => {
    const turnProgress = vi.fn().mockResolvedValueOnce({ status: 200, body: { snapshots: [snapshot] } }).mockResolvedValue({ status: 503, body: {} });
    installBridge({ turnProgress });
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: /summarize open issues/ }));
    fireEvent.click(screen.getByRole("button", { name: /刷新/ }));
    await screen.findByText("显示上次成功读取的快照。");
    expect(screen.getByText("Assemble thread context")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "执行时间线" })).getByText("summarize open issues")).toBeInTheDocument();
  });

  it("discards a late snapshot when the workspace changes", async () => {
    let resolve!: (value: unknown) => void;
    const oldRead = new Promise((done) => { resolve = done; });
    installBridge({ turnProgress: vi.fn().mockReturnValueOnce(oldRead).mockResolvedValue({ status: 200, body: { snapshots: [] } }) });
    const view = render(<ProgressBoard key="old-workspace" workspaceOpen />);
    view.rerender(<ProgressBoard key="new-workspace" workspaceOpen />);
    await screen.findByText("还没有进行中或刚结束的回合。");
    await act(async () => resolve({ status: 200, body: { snapshots: [snapshot] } }));
    expect(screen.queryByText("summarize open issues")).not.toBeInTheDocument();
  });

  it("renders a live row and opens the step timeline", async () => {
    installBridge();
    renderBoard();
    await screen.findByText("summarize open issues");
    expect(screen.getByText("Repo Owner")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("region", { name: "执行时间线" })).getByRole("button", { name: /summarize open issues/ }));
    await waitFor(() => expect(screen.getByText("Assemble thread context")).toBeInTheDocument());
  });

  it("keeps overall failed when a later step event is success", () => {
    const failed: TaskProgressSnapshot = {
      ...snapshot,
      overallStatus: "failed",
      progress: 40,
      steps: snapshot.steps.map((step, index) => index === 2 ? { ...step, status: "failed" } : step),
    };
    const event: TaskProgressEvent = {
      taskId: "turn-1",
      employeeId: "repo-owner",
      positionId: "repo-owner",
      stepIndex: 3,
      stepName: "Persist turn record",
      stepStatus: "success",
      totalSteps: 5,
      progress: 80,
      timestamp: Date.now(),
    };
    const next = applyProgressEvent([failed], event);
    expect(next[0]?.overallStatus).toBe("failed");
    expect(next[0]?.steps[2]?.status).toBe("failed");
  });

  it("reloads the snapshot when SSE seq skips", async () => {
    const turnProgress = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { snapshots: [snapshot] } })
      .mockResolvedValue({ status: 200, body: { snapshots: [{ ...snapshot, progress: 100, overallStatus: "success" }] } });
    let send: ((raw: unknown) => void) | undefined;
    installBridge({
      turnProgress,
      onEvent: vi.fn((listener) => {
        send = listener;
        return () => {};
      }),
    });
    renderBoard();
    await screen.findByText("summarize open issues");
    send?.({ seq: 1, type: "turn.progress", payload: { taskId: "turn-1", stepIndex: 2, stepStatus: "running", progress: 40, totalSteps: 5, stepName: "Engine streaming", employeeId: "repo-owner", positionId: "repo-owner", timestamp: Date.now() } });
    send?.({ seq: 4, type: "turn.progress", payload: { taskId: "turn-1", stepIndex: 4, stepStatus: "success", progress: 100, totalSteps: 5, stepName: "Publish terminal", employeeId: "repo-owner", positionId: "repo-owner", timestamp: Date.now() } });
    await waitFor(() => expect(turnProgress.mock.calls.length).toBeGreaterThan(1));
  });

  it("shows an empty state when there are no snapshots", async () => {
    installBridge({
      turnProgress: vi.fn().mockResolvedValue({ status: 200, body: { snapshots: [] } }),
    });
    renderBoard();
    await screen.findByText("还没有进行中或刚结束的回合。");
  });

  it("marks a stale row stuck and keeps reserved abort/retry in the drawer", async () => {
    installBridge({
      turnProgress: vi.fn().mockResolvedValue({
        status: 200,
        body: { snapshots: [{ ...snapshot, overallStatus: "stuck", steps: snapshot.steps.map((step, index) => index === 2 ? { ...step, message: "waiting on engine" } : step) }] },
      }),
    });
    renderBoard();
    await screen.findByText("疑似卡住");
    fireEvent.click(within(screen.getByRole("region", { name: "执行时间线" })).getByRole("button", { name: /summarize open issues/ }));
    await waitFor(() => expect(screen.getByText("步骤摘要")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "中止" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重试" })).toBeDisabled();
    expect(screen.getAllByText("waiting on engine").length).toBeGreaterThan(0);
  });

  it("unsticks when a later progress event arrives", () => {
    const stuck: TaskProgressSnapshot = { ...snapshot, overallStatus: "stuck" };
    const event: TaskProgressEvent = {
      taskId: "turn-1",
      employeeId: "repo-owner",
      positionId: "repo-owner",
      stepIndex: 2,
      stepName: "Engine streaming",
      stepStatus: "running",
      totalSteps: 5,
      progress: 40,
      timestamp: Date.now(),
    };
    expect(applyProgressEvent([stuck], event)[0]?.overallStatus).toBe("running");
  });
});

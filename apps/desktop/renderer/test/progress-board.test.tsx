import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("renders a live row and opens the step timeline", async () => {
    installBridge();
    renderBoard();
    await screen.findByText("summarize open issues");
    expect(screen.getByText("Repo Owner")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /summarize open issues/ }));
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
});

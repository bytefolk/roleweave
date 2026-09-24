import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskProgressSnapshot } from "@roleweave/shared";
import { ProgressBoard } from "../src/progress/ProgressBoard";
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

  it("shows an empty state when there are no snapshots", async () => {
    installBridge({
      turnProgress: vi.fn().mockResolvedValue({ status: 200, body: { snapshots: [] } }),
    });
    renderBoard();
    await screen.findByText("还没有进行中或刚结束的回合。");
  });
});

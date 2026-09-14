import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GoalDetail, GoalSummary } from "@roleweave/shared";
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
    await waitFor(() => expect(screen.getByText("暂无目标。")).toBeInTheDocument());
  });

  it("renders goal list and detail on selection", async () => {
    installBridge();
    render(<GoalsModule workspaceOpen />);

    await waitFor(() => expect(screen.getByText("Ship v1.0")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Ship v1.0"));
    await waitFor(() => expect(screen.getByText("Release the first stable version")).toBeInTheDocument());
  });

  it("opens create dialog on button click", async () => {
    installBridge();
    render(<GoalsModule workspaceOpen />);

    await waitFor(() => expect(screen.getByText("目标")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /新建目标/i }));
    expect(screen.getByText("新建目标")).toBeInTheDocument();
  });

  it("shows workspace-not-opened message when workspace is closed", () => {
    installBridge();
    render(<GoalsModule workspaceOpen={false} />);
    expect(screen.getByText("目标")).toBeInTheDocument();
  });
});

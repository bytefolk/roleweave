import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { TaskCollaborationContext } from "@roleweave/shared/task-collaboration";
import { TaskCollaborationDetails } from "../src/goals/TaskCollaborationDetails";
import { TaskBriefingDetails } from "../src/turns/TaskBriefingDetails";

const context: TaskCollaborationContext = { schemaVersion: "task-collaboration.v1", goalId: "goal-one", taskId: "downstream", capturedAt: "2026-10-21T00:00:00Z",
  participants: [{ positionId: "reviewer", role: "reviewer", responsibility: "Check interface compatibility <script>attack()</script>" }],
  dependencies: [{ taskId: "upstream", title: "API contract", assigneePositionId: "engineer", status: "done", readiness: "accepted", executionStatus: "completed",
    acceptanceId: "acceptance-one", acceptedAt: "2026-10-20T00:00:00Z", delivery: { positionId: "engineer", turnId: "source-turn", sessionId: "source-session",
      outputDigest: `sha256:${"a".repeat(64)}`, excerptDigest: `sha256:${"b".repeat(64)}`, outputExcerpt: "Stable API contract", completedAt: "2026-10-20T00:00:00Z", truncated: true, redacted: true } }],
  dependents: [{ taskId: "release", title: "Release the client", assigneePositionId: "publisher" }], omittedDependentCount: 2, redacted: true };

it("shows actual collaborators, readiness and public source evidence safely and opens the exact source session", async () => {
  const open = vi.fn();
  render(<TaskCollaborationDetails context={context} positionNames={{ reviewer: "Reviewer", engineer: "Engineer" }} onOpenBoundSession={open} />);
  expect(screen.queryByText("Stable API contract")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("协作者与依赖"));
  expect(await screen.findByText("Stable API contract")).toBeInTheDocument();
  expect(screen.getByText("最新产出已人工验收")).toBeInTheDocument();
  expect(screen.getByText("source-turn")).toBeInTheDocument();
  expect(screen.getByText("另有 2 个直接下游未纳入此视图。")).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看来源执行" }));
  expect(open).toHaveBeenCalledWith("engineer", "source-session", "source-turn");
  fireEvent.click(screen.getByText("协作者与依赖"));
  await waitFor(() => expect(screen.queryByText("Stable API contract")).not.toBeInTheDocument());
});

it("displays collaboration from the saved execution briefing without inventing participants for independent tasks", async () => {
  const payload = { schemaVersion: "task-briefing.v1" as const, generatedAt: context.capturedAt, planUpdatedAt: context.capturedAt,
    goalId: context.goalId, taskId: context.taskId, turnId: "turn", sessionId: "session", positionId: "owner",
    goalTitle: "Project", goalDescription: "Goal", taskTitle: "Build", taskDescription: "Assigned work", acceptanceCriteria: [], redacted: true, collaboration: context };
  const rendered = render(<TaskBriefingDetails snapshot={{ payload, payloadBytes: 0, payloadDigest: "fixture" }} />);
  fireEvent.click(screen.getByText(/执行时的任务说明/));
  expect(await screen.findByText("Stable API contract")).toBeInTheDocument();
  rendered.unmount();
  render(<TaskCollaborationDetails context={{ ...context, participants: [], dependencies: [], dependents: [], omittedDependentCount: 0, redacted: false }} />);
  fireEvent.click(screen.getByText("协作者与依赖"));
  expect(await screen.findByText("未指定额外协作者。")).toBeInTheDocument();
  expect(screen.getByText("没有上游依赖。")).toBeInTheDocument();
});

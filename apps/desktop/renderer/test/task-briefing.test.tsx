import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import type { TaskBriefingSnapshot } from "@roleweave/shared";
import { TaskBriefingDetails } from "../src/turns/TaskBriefingDetails";
import { TurnThread } from "../src/turns/TurnThread";
import { adaptTurnRecord } from "../src/turns/adapter";

const snapshot: TaskBriefingSnapshot = {
  payload: { schemaVersion: "task-briefing.v1", generatedAt: "2026-10-21T00:00:00Z", planUpdatedAt: "2026-10-20T00:00:00Z",
    goalId: "goal-one", taskId: "task-one", turnId: "turn-one", sessionId: "session-one", positionId: "engineer",
    goalTitle: "Release", goalDescription: "Verified release", taskTitle: "Prepare report", taskDescription: "Separate facts and assumptions",
    acceptanceCriteria: ["Include reproducible evidence", "<script>untrusted()</script>"], redacted: true },
  payloadBytes: 0, payloadDigest: "sha256:fixture",
};
it("expands actual execution requirements safely, reports a changed plan and collapses lazily", async () => {
  render(<TaskBriefingDetails snapshot={snapshot} currentPlanVersion="2026-10-21T00:00:00Z" />);
  expect(screen.queryByText("Include reproducible evidence")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText(/执行时的任务说明/));
  expect(await screen.findByText("Include reproducible evidence")).toBeInTheDocument();
  expect(screen.getByText("Separate facts and assumptions")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("当前项目计划已更新");
  expect(screen.getByText("可识别的敏感内容已过滤。")).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByText(/执行时的任务说明/));
  await waitFor(() => expect(screen.queryByText("Include reproducible evidence")).not.toBeInTheDocument());
});
it("does not invent unspecified acceptance criteria", async () => {
  render(<TaskBriefingDetails snapshot={{ ...snapshot, payload: { ...snapshot.payload, acceptanceCriteria: [], redacted: false } }} />);
  fireEvent.click(screen.getByText(/执行时的任务说明/));
  expect(await screen.findByText("未指定验收标准。")).toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
it("keeps the saved briefing through the personal conversation adapter", async () => {
  const record = adaptTurnRecord({ schemaVersion: "turn-record.v1", conversationId: "session-one", conversationRef: "session-one",
    turnId: "turn-one", positionId: "engineer", engine: "qoder", status: "completed", input: "Prepare report", output: "Delivered report",
    envelopeDigest: `sha256:${"a".repeat(64)}`, createdAt: snapshot.payload.generatedAt, updatedAt: snapshot.payload.generatedAt,
    events: [], taskBriefing: snapshot }, "Engineer");
  render(<TurnThread turns={[record]} />);
  fireEvent.click(screen.getByText(/执行时的任务说明/));
  expect(await screen.findByText("Include reproducible evidence")).toBeInTheDocument();
  expect(screen.getByText("Delivered report")).toBeInTheDocument();
});

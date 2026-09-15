import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SessionMemory } from "../src/memory/SessionMemory";
import { DocsModule } from "../src/docs/DocsModule";
import type { OwbBridge } from "../src/owb";

it("reads durable conversation receipts and continues the exact active employee session", async () => {
  const onContinue = vi.fn();
  window.owb = {
    sessions: vi.fn().mockResolvedValue({ status: 200, body: { activeSessionId: "session-a", sessions: [{ sessionId: "session-a", positionId: "alice", status: "active", createdAt: "2026-09-12T00:00:00Z" }] } }),
    sessionTurnHistory: vi.fn().mockResolvedValue({ status: 200, body: { turns: [{ turnId: "turn-a", input: "Remember the release plan", output: "Release on Friday", status: "completed", model: "efficient", createdAt: "2026-09-12T00:00:00Z", threadContext: { sourceTurnCount: 2, contextBytes: 512 } }] } }),
  } as unknown as OwbBridge;
  render(<SessionMemory positionId="alice" onContinue={onContinue} />);
  expect(await screen.findByText("Remember the release plan")).toBeVisible();
  expect(screen.getByText(/512/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "继续对话" }));
  expect(onContinue).toHaveBeenCalledWith("alice", "session-a");
  expect(window.owb.sessionTurnHistory).toHaveBeenCalledWith("session-a");
});

it("shows failed history honestly instead of inventing memory", async () => {
  window.owb = { sessions: vi.fn().mockRejectedValue(new Error("offline")) } as unknown as OwbBridge;
  render(<SessionMemory positionId="alice" />);
  expect(await screen.findByText("会话记录读取失败，请重新进入此页面重试。")).toBeVisible();
});

it("creates employee knowledge with authored content under knowledge", async () => {
  const create = vi.fn().mockResolvedValue({ status: 201, body: { path: "knowledge/lesson.md" } });
  window.owb = { positionDocs: vi.fn().mockResolvedValue({ status: 200, body: { files: [] } }), createPositionDoc: create } as unknown as OwbBridge;
  render(<DocsModule embedded surface="position" workspaceOpen positions={[{ id: "alice", name: "Alice" }]} selectedPositionId="alice" />);
  fireEvent.click(screen.getByRole("button", { name: "新建文档" }));
  fireEvent.change(screen.getByPlaceholderText("handbook.md"), { target: { value: "lesson.md" } });
  fireEvent.change(screen.getByLabelText("文档内容"), { target: { value: "# Release conventions" } });
  fireEvent.click(screen.getByRole("button", { name: /创\s*建$/ }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ positionId: "alice", path: "knowledge/lesson.md", content: "# Release conventions" }));
});

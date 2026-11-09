import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { OwbI18nProvider } from "@roleweave/ui";
import { SessionMemory } from "../src/memory/SessionMemory";
import { DocsModule } from "../src/docs/DocsModule";
import type { OwbBridge } from "../src/owb";
import { pickSelectOption } from "./select-helper";

it("reads durable conversation receipts and continues the exact active employee session", async () => {
  const onContinue = vi.fn();
  window.owb = {
    sessions: vi.fn().mockResolvedValue({ status: 200, body: { activeSessionId: "session-a", sessions: [
      { sessionId: "session-a", positionId: "alice", status: "active", createdAt: "2026-09-12T00:00:00Z", threadContextEnabled: true },
      { sessionId: "session-old", positionId: "alice", status: "rotated", createdAt: "2026-09-11T00:00:00Z", threadContextEnabled: false },
    ] } }),
    sessionTurnHistory: vi.fn().mockImplementation((sessionId: string) => Promise.resolve({ status: 200, body: { turns: sessionId === "session-a"
      ? [{ turnId: "turn-a", input: "Remember the release plan", output: "Release on Friday", status: "completed", model: "efficient", createdAt: "2026-09-12T00:00:00Z", threadContext: { enabled: true, sourceTurnCount: 2, contextBytes: 512 } }]
      : [{ turnId: "turn-old", input: "Earlier question", output: " \n\t", status: "failed", model: "performance", createdAt: "2026-09-11T00:00:00Z", threadContext: { enabled: false, sourceTurnCount: 0, contextBytes: 0 } }] } })),
  } as unknown as OwbBridge;
  render(<SessionMemory positionId="alice" onContinue={onContinue} />);
  expect(await screen.findByText("Remember the release plan")).toBeVisible();
  expect(screen.getByText(/512/)).toBeVisible();
  expect(screen.queryByText(/最多 12 轮、64 KB/)).not.toBeInTheDocument();
  const reply = screen.getByText("查看回复").closest("details")!;
  expect(reply).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("查看回复"));
  expect(reply).toHaveAttribute("open");
  expect(screen.getByText("Release on Friday")).toBeVisible();
  fireEvent.focus(screen.getByRole("button", { name: "上下文状态" }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent("已启用会话历史");
  expect(screen.getByRole("tooltip")).toHaveTextContent("最多 12 轮、64 KB");
  fireEvent.blur(screen.getByRole("button", { name: "上下文状态" }));
  fireEvent.click(screen.getByRole("button", { name: "继续对话" }));
  expect(onContinue).toHaveBeenCalledWith("alice", "session-a");
  expect(window.owb.sessionTurnHistory).toHaveBeenCalledWith("session-a");
  pickSelectOption("选择会话", "会话 2 · 2026/9/11");
  expect(await screen.findByText("Earlier question")).toBeVisible();
  expect(screen.getByText("未保存回复")).toBeVisible();
  expect(screen.queryByText("查看回复")).not.toBeInTheDocument();
  expect(screen.queryByText(/0 条会话记录|0 字节/)).not.toBeInTheDocument();
  const receipt = screen.getByRole("button", { name: "上下文使用记录" });
  fireEvent.focus(receipt);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("附带 0 条会话记录 · 0 字节");
  fireEvent.blur(receipt);
  const continuation = screen.getByRole("button", { name: "继续对话" });
  expect(continuation).toBeDisabled();
  fireEvent.click(continuation);
  expect(onContinue).toHaveBeenCalledTimes(1);
});

it("keeps loading through the history request and rejects old employee continuation and late records", async () => {
  let finishAlice!: (value: unknown) => void;
  let finishBobList!: (value: unknown) => void;
  let finishBobHistory!: (value: unknown) => void;
  const onContinue = vi.fn();
  window.owb = {
    sessions: vi.fn((positionId: string) => positionId === "alice"
      ? Promise.resolve({ status: 200, body: { activeSessionId: "session-a", sessions: [{ sessionId: "session-a", positionId: "alice", status: "active", createdAt: "2026-09-12T00:00:00Z" }] } })
      : new Promise(resolve => { finishBobList = resolve; })),
    sessionTurnHistory: vi.fn((sessionId: string) => new Promise(resolve => {
      if (sessionId === "session-a") finishAlice = resolve; else finishBobHistory = resolve;
    })),
  } as unknown as OwbBridge;
  const { rerender } = render(<SessionMemory positionId="alice" onContinue={onContinue} />);
  await waitFor(() => expect(window.owb.sessionTurnHistory).toHaveBeenCalledWith("session-a"));
  expect(screen.getByRole("status", { name: "正在读取会话记录…" })).toBeInTheDocument();
  expect(screen.queryByText(/暂无会话记录/)).not.toBeInTheDocument();
  const oldContinue = screen.getByRole("button", { name: "继续对话" });
  rerender(<SessionMemory positionId="bob" onContinue={onContinue} />);
  expect(oldContinue).toBeDisabled();
  fireEvent.click(oldContinue);
  expect(onContinue).not.toHaveBeenCalled();
  await act(async () => finishAlice({ status: 200, body: { turns: [{ turnId: "late-a", input: "Alice private record" }] } }));
  expect(screen.queryByText("Alice private record")).not.toBeInTheDocument();
  await act(async () => finishBobList({ status: 200, body: { activeSessionId: "session-b", sessions: [{ sessionId: "session-b", positionId: "bob", status: "active", createdAt: "2026-09-12T00:00:00Z" }] } }));
  expect(screen.getByRole("status", { name: "正在读取会话记录…" })).toBeInTheDocument();
  expect(screen.queryByText(/暂无会话记录/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "继续对话" }));
  expect(onContinue).toHaveBeenCalledExactlyOnceWith("bob", "session-b");
  await act(async () => finishBobHistory({ status: 503, body: {} }));
  expect(await screen.findByText("会话记录读取失败，请重新进入此页面重试。")).toBeVisible();
  expect(screen.queryByText("Alice private record")).not.toBeInTheDocument();
  expect(screen.queryByText(/暂无会话记录/)).not.toBeInTheDocument();
});

it("preserves structured replies while hiding blank replies and localizes receipt information", async () => {
  const outputs = [undefined, "", " \n", null, 0, false, [], { answer: "Saved" }];
  window.owb = {
    sessions: vi.fn().mockResolvedValue({ status: 200, body: { activeSessionId: "session-a", sessions: [{ sessionId: "session-a", positionId: "alice", status: "active", createdAt: "2026-09-12T00:00:00Z" }] } }),
    sessionTurnHistory: vi.fn().mockResolvedValue({ status: 200, body: { turns: outputs.map((output, index) => ({ turnId: `turn-${index}`, input: `Question ${index}`, output, status: "completed", engine: "qoder", createdAt: "2026-09-12T00:00:00Z",
      threadContext: index === 0 ? { enabled: true, sourceTurnCount: 0, contextBytes: 0, truncated: true, omittedTurnCount: 3 } : undefined })) } }),
  } as unknown as OwbBridge;
  const { container } = render(<OwbI18nProvider locale="en"><SessionMemory positionId="alice" /></OwbI18nProvider>);
  expect(await screen.findByText("Question 0")).toBeVisible();
  expect(screen.getAllByText("No saved response")).toHaveLength(3);
  expect(screen.getAllByText("View response")).toHaveLength(5);
  expect(screen.getByText("Context shortened · 3 records omitted")).toBeVisible();
  for (const index of [3, 4, 5, 6, 7]) {
    const article = screen.getByText(`Question ${index}`).closest("article")!;
    fireEvent.click(within(article).getByText("View response"));
    expect(article.querySelector("pre")?.textContent).toBe(JSON.stringify(outputs[index], null, 2));
  }
  const missingReceipt = screen.getAllByRole("button", { name: "Context receipt" })[1]!;
  fireEvent.focus(missingReceipt);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("No context receipt yet.");
  expect(container.querySelectorAll("article")).toHaveLength(8);
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

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TurnPanel, type TurnPanelProps } from "../src/turns/TurnPanel";
import { TurnThread } from "../src/turns/TurnThread";
import { ConversationOptions } from "../src/turns/ConversationOptions";
import { createConversationMemory } from "../src/turns/conversation-memory";
import { OrgWorkspaceSplit } from "../src/org/OrgWorkspaceSplit";
import type { TurnRecord } from "../src/turns/types";
import type { EmployeeModelConfig, WorkbenchSession } from "@roleweave/shared";
import { pickSelectOption } from "./select-helper";

const availability = Object.fromEntries(["qoder", "claude-code", "claude-local", "codex", "codex-local", "workbuddy"].map(id => [id, { configured: true, ready: true }])) as TurnPanelProps["engineAvailability"];
const finished: TurnRecord = { id: "turn-1", positionId: "owner", positionName: "Owner", input: "Original task", output: "**Done**", status: "completed", engine: "codex-local", createdAt: "2026-09-01T10:00:00Z" };
function props(overrides: Partial<TurnPanelProps> = {}): TurnPanelProps {
  return { workspaceOpen: true, positions: [{ id: "owner", name: "Owner" }], selectedPositionId: "owner", engine: "codex-local", engineLocked: true, engineAvailability: availability, turns: [finished], onCreateTurn: vi.fn(), ...overrides };
}

describe("conversation interaction refinements without a frame redesign", () => {
  it.each([true, undefined])("shows a noninteractive branded Agent for engineLocked=%s without changing the employee or draft", (engineLocked) => {
    const selectEngine = vi.fn();
    const { container } = render(<TurnPanel {...props({ engineLocked, onSelectEngine: selectEngine })} />);
    const header = container.querySelector(".owb-turn-panel__header")!;
    const badge = header.querySelector(".owb-engine-badge")!;
    expect(badge).toHaveTextContent("Codex");
    expect(badge.querySelector("img")).toHaveAttribute("alt", "");
    expect(badge.querySelector("img")).toHaveAttribute("aria-hidden", "true");
    expect(badge.closest("button, [role=button], [tabindex]")).toBeNull();
    expect(within(header as HTMLElement).queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "Keep draft" } });
    fireEvent.click(badge);
    expect(selectEngine).not.toHaveBeenCalled();
    expect(screen.getByLabelText("下达任务")).toHaveValue("Keep draft");
  });
  it("shows an interactive EngineSelect when engineLocked=false", () => {
    const selectEngine = vi.fn();
    const { container } = render(<TurnPanel {...props({ engineLocked: false, onSelectEngine: selectEngine })} />);
    const header = container.querySelector(".owb-turn-panel__header")!;
    expect(within(header as HTMLElement).getByRole("combobox", { name: "选择 Agent Host" })).toBeInTheDocument();
    expect(header.querySelector(".owb-engine-badge")).toBeNull();
  });
  it("moves the submitted text into the conversation immediately and restores it only when acceptance fails", async () => {
    let finish!: (value: boolean) => void;
    const create = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(<TurnPanel {...props({ turns: [], onCreateTurn: create })} />);
    const input = screen.getByLabelText("下达任务");
    fireEvent.change(input, { target: { value: "当前什么进度了？" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(create).toHaveBeenCalledExactlyOnceWith({ positionId: "owner", engine: "codex-local", input: "当前什么进度了？" });
    expect(input).toHaveValue("");
    finish(false);
    await waitFor(() => expect(input).toHaveValue("当前什么进度了？"));
    expect(screen.getByRole("alert")).toHaveTextContent("发送失败，已保留草稿。");
  });

  it("does not overwrite a new draft when an earlier submission is rejected", async () => {
    let finish!: (value: boolean) => void;
    const create = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(<TurnPanel {...props({ turns: [], onCreateTurn: create })} />);
    const input = screen.getByLabelText("下达任务");
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "next draft" } });
    finish(false);
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(input).toHaveValue("next draft");
  });

  it("protects an existing draft and re-edits into a new task without changing history", async () => {
    const create = vi.fn().mockResolvedValue(true);
    render(<TurnPanel {...props({ onCreateTurn: create })} />);
    const input = screen.getByLabelText("下达任务");
    fireEvent.change(input, { target: { value: "Existing draft" } });
    fireEvent.click(screen.getByRole("button", { name: "重新编辑" }));
    expect(screen.getByRole("dialog", { name: "替换当前草稿？" })).toBeInTheDocument();
    expect(input).toHaveValue("Existing draft");
    fireEvent.click(screen.getByRole("button", { name: "保留草稿" }));
    expect(input).toHaveValue("Existing draft");
    fireEvent.click(screen.getByRole("button", { name: "重新编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "替换草稿" }));
    expect(input).toHaveValue("Original task");
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Edited task" } });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
    await waitFor(() => expect(create).toHaveBeenCalledExactlyOnceWith({ positionId: "owner", engine: "codex-local", input: "Edited task" }));
    expect(screen.getByText("Original task")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "选择 Agent Host" })).not.toBeInTheDocument();
  });
  it("retains drafts across remounts and isolates workspaces with identical employee/session IDs", () => {
    const memory = createConversationMemory();
    const first = render(<TurnPanel {...props({ memory, workspaceKey: "workspace-A", selectedSessionId: "same" })} />);
    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "A draft" } });
    first.unmount();
    const second = render(<TurnPanel {...props({ memory, workspaceKey: "workspace-B", selectedSessionId: "same" })} />);
    expect(screen.getByLabelText("下达任务")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "B draft" } });
    second.unmount();
    render(<TurnPanel {...props({ memory, workspaceKey: "workspace-A", selectedSessionId: "same" })} />);
    expect(screen.getByLabelText("下达任务")).toHaveValue("A draft");
  });
  it("allows running drafts, prevents queuing and keeps stopping pending until a true terminal state", async () => {
    const create = vi.fn(); const cancel = vi.fn().mockResolvedValue(true);
    const running = { ...finished, status: "running" as const };
    const { rerender } = render(<TurnPanel {...props({ onCreateTurn: create, onCancelTurn: cancel, turns: [running], employeeBusy: true })} />);
    const input = screen.getByLabelText("下达任务");
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "Next draft" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.submit(input.closest("form")!);
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "中断回合" }));
    await act(async () => {});
    expect(screen.getByText("正在停止这个任务…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "中断回合" })).toBeDisabled();
    expect(cancel).toHaveBeenCalledExactlyOnceWith("owner");
    rerender(<TurnPanel {...props({ onCreateTurn: create, onCancelTurn: cancel })} />);
    expect(screen.getByLabelText("下达任务")).toHaveValue("Next draft");
    expect(screen.getByRole("button", { name: "发送任务" })).toBeEnabled();
  });
  it("re-enables stop after a rejected request without claiming the execution ended", async () => {
    render(<TurnPanel {...props({ onCancelTurn: vi.fn().mockResolvedValue(false), turns: [{ ...finished, status: "running" }] })} />);
    fireEvent.click(screen.getByRole("button", { name: "中断回合" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "中断回合" })).toBeEnabled());
    expect(screen.getByText("运行中")).toBeInTheDocument();
  });
  it("honors modifier-Enter and IME composition, and preserves draft on send rejection", async () => {
    const create = vi.fn().mockRejectedValue(new Error("offline"));
    render(<TurnPanel {...props({ turns: [], sendShortcut: "mod-enter", onCreateTurn: create })} />);
    const input = screen.getByLabelText("下达任务");
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(create).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("发送失败，已保留草稿。"));
    expect(input).toHaveValue("你好");
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("blocks retry while a model save is unresolved and preserves its original input after saving", async () => {
    let finishSave!: () => void;
    const save = new Promise<void>(resolve => { finishSave = resolve; });
    const create = vi.fn().mockResolvedValue(true);
    const failed = { ...finished, status: "failed" as const, error: "Task failed" };
    const panelProps = props({ turns: [failed], onCreateTurn: create });
    const { rerender } = render(<TurnPanel {...panelProps} modelSaving />);
    const saved = save.then(() => rerender(<TurnPanel {...panelProps} modelSaving={false} />));
    const retry = screen.getByRole("button", { name: "重新执行" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(create).not.toHaveBeenCalled();
    await act(async () => { finishSave(); await saved; });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(create).toHaveBeenCalledExactlyOnceWith({
      positionId: "owner", engine: "codex-local", input: "Original task", retryOf: "turn-1",
    }));
    expect(screen.getByText("Original task")).toBeInTheDocument();
  });
  it.each(["saving", "running", "read-only"])("blocks model changes while %s without replacing the draft, history, or session context", async state => {
    const change = vi.fn();
    const setContext = vi.fn();
    const selectSession = vi.fn();
    const config: EmployeeModelConfig = {
      selected: "efficient", recommended: "efficient", editable: true, source: "provider-tiers",
      options: [{ id: "efficient", name: "Efficient", tier: "economy" }, { id: "performance", name: "Performance", tier: "balanced" }],
    };
    const session: WorkbenchSession = {
      schemaVersion: "workbench-session.v1", sessionId: "session-1", workspaceInstanceId: "workspace-1",
      positionId: "owner", principal: "position.owner", status: "active", rotatedFrom: null, rotatedTo: null,
      createdAt: "2026-09-13T00:00:00Z", rotatedAt: null, threadContextEnabled: false,
    };
    const panelProps = props({ modelConfig: config, onSelectModel: change, onSetSessionContext: setContext,
      sessions: [session], selectedSessionId: session.sessionId, onSelectSession: selectSession });
    const { rerender } = render(<TurnPanel {...panelProps} />);
    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "Keep this draft" } });
    rerender(<TurnPanel {...panelProps} modelSaving={state === "saving"} employeeBusy={state === "running"}
      modelConfig={{ ...config, editable: state !== "read-only" }} />);
    const select = screen.getByRole("combobox", { name: "员工模型" });
    expect(select).toBeDisabled();
    fireEvent.mouseDown(select);
    expect(select).toHaveAttribute("aria-expanded", "false");
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByLabelText("下达任务")).toHaveValue("Keep this draft");
    expect(screen.getByText("Original task")).toBeInTheDocument();

    rerender(<TurnPanel {...panelProps} />);
    expect(screen.getByRole("combobox", { name: "员工模型" })).toBeEnabled();
    pickSelectOption("员工模型", "Performance");
    expect(change).toHaveBeenCalledExactlyOnceWith("performance");
    expect(screen.getByLabelText("下达任务")).toHaveValue("Keep this draft");
    expect(screen.getByText("Original task")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "上下文详情" }));
    expect(await screen.findByRole("switch", { name: "携带会话历史" })).toHaveAttribute("aria-checked", "false");
    expect(setContext).not.toHaveBeenCalled();
    expect(selectSession).not.toHaveBeenCalled();
  });
  it.each(["sessionBusy", "historyLoading"] as const)("blocks retry while %s keeps session state incomplete", async (pending) => {
    const create = vi.fn();
    render(<TurnPanel {...props({ turns: [{ ...finished, status: "failed", error: "Task failed" }], onCreateTurn: create, [pending]: true })} />);
    const retry = screen.getByRole("button", { name: "重新执行" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(create).not.toHaveBeenCalled();
  });
  it("keeps the same thread and splitter geometry while manually focusing", () => {
    const create = vi.fn();
    const panel = <TurnPanel {...props({ onCreateTurn: create })} />;
    const { rerender, container } = render(<OrgWorkspaceSplit ariaLabel="Resize" left={<p>Profile</p>} right={panel} resetTitle="Reset" valueText={String} />);
    const splitter = screen.getByRole("separator");
    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    const width = splitter.getAttribute("aria-valuenow");
    const input = screen.getByLabelText("下达任务");
    fireEvent.change(input, { target: { value: "Keep draft" } });
    rerender(<OrgWorkspaceSplit focused ariaLabel="Resize" left={<p>Profile</p>} right={panel} resetTitle="Reset" valueText={String} />);
    expect(container.querySelector(".owb-org-module")).toHaveClass("is-conversation-focused");
    expect(screen.getByLabelText("下达任务")).toBe(input);
    rerender(<OrgWorkspaceSplit ariaLabel="Resize" left={<p>Profile</p>} right={panel} resetTitle="Reset" valueText={String} />);
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", width);
    expect(input).toHaveValue("Keep draft"); expect(create).not.toHaveBeenCalled();
  });
  it("keeps historical reading in place and only follows new output when already at the bottom", () => {
    const { rerender } = render(<TurnThread turns={[finished]} scrollKey="history" />);
    const log = screen.getByRole("log");
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    log.scrollTop = 300; fireEvent.scroll(log);
    rerender(<TurnThread turns={[finished, { ...finished, id: "next", output: "More" }]} scrollKey="history" />);
    expect(log.scrollTop).toBe(300);
    fireEvent.click(screen.getByRole("button", { name: "有新消息 · 回到最新" }));
    expect(log.scrollTop).toBe(800);
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1200 });
    rerender(<TurnThread turns={[finished, { ...finished, id: "next", output: "More content" }]} scrollKey="history" />);
    expect(log.scrollTop).toBe(1000);
  });
  it("shows loading, load errors with retry, unsupported and running model states in place", () => {
    const reload = vi.fn();
    const base = { saving: false, disabled: false, session: null, turns: [], onReload: reload };
    const { rerender } = render(<ConversationOptions {...base} loading />);
    expect(screen.getByText("模型")).toBeInTheDocument();
    expect(screen.getAllByText("正在加载模型…").length).toBeGreaterThan(0);
    rerender(<ConversationOptions {...base} error="加载模型失败" />);
    fireEvent.click(screen.getByRole("button", { name: "重新加载模型" }));
    expect(reload).toHaveBeenCalledTimes(1);
    const config = { selected: "provider-default", recommended: "provider-default", editable: false, source: "default" as const, options: [{ id: "provider-default", name: "Default", tier: "default" as const }] };
    rerender(<ConversationOptions {...base} config={config} />);
    expect(screen.getByText("此 Host 不支持选择模型")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "员工模型" })).toBeDisabled();
    rerender(<ConversationOptions {...base} config={{ ...config, editable: true }} onModel={vi.fn()} running disabled />);
    expect(screen.getByText("任务结束后可切换")).toBeInTheDocument();
  });
  it("offers full message expansion and copies original Markdown separately from readable text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const long = Array.from({ length: 15 }, (_, index) => `Line ${index}`).join("\n");
    const { container } = render(<TurnThread turns={[{ ...finished, input: long }]} />);
    fireEvent.click(screen.getByRole("button", { name: "展开全文" }));
    expect(container.querySelector(".owb-bubble__text")).not.toHaveClass("owb-message-collapsible");
    const reply = container.querySelector(".owb-bubble--employee") as HTMLElement;
    fireEvent.click(within(reply).getByRole("button", { name: "复制" }));
    fireEvent.click(await screen.findByText("复制原始 Markdown"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("**Done**"));
    fireEvent.click(within(reply).getByRole("button", { name: "复制" }));
    fireEvent.click(await screen.findByText("复制纯文本"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Done"));
  });
});

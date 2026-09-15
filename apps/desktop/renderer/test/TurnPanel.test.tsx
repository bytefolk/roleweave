import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TurnPanel, TurnThread } from "../src/turns";
import type { CreateTurnRequest, TurnPanelProps, TurnRecord } from "../src/turns";

const positions = [
  { id: "repo-owner", name: "代码库负责人" },
  { id: "release-manager", name: "发布负责人" },
];

const availability: TurnPanelProps["engineAvailability"] = {
  qoder: { configured: true, ready: true },
  "claude-code": { configured: true, ready: true },
  "claude-local": { configured: true, ready: true },
  codex: { configured: true, ready: true },
  "codex-local": { configured: true, ready: true },
};

function ControlledPanel({ onCreateTurn }: { onCreateTurn: (request: CreateTurnRequest) => void }) {
  return (
    <TurnPanel
      workspaceOpen
      positions={positions}
      selectedPositionId="repo-owner"
      engine="qoder"
      engineAvailability={availability}
      turns={[]}
      onCreateTurn={onCreateTurn}
    />
  );
}

function turn(overrides: Partial<TurnRecord>): TurnRecord {
  return {
    id: "turn-1",
    positionId: "repo-owner",
    positionName: "代码库负责人",
    engine: "qoder",
    input: "检查发布门禁",
    status: "completed",
    createdAt: "2026-08-24T04:00:00.000Z",
    output: "门禁已检查。",
    ...overrides,
  };
}

describe("TurnPanel Issue #5 D3 behavior", () => {
  it("keeps execution details out of a direct employee conversation", () => {
    const active = {
      schemaVersion: "workbench-session.v1" as const,
      sessionId: "11111111-1111-4111-8111-111111111111",
      positionId: "repo-owner",
      workspaceInstanceId: "workspace-1",
      principal: "position.repo-owner",
      status: "active" as const,
      rotatedFrom: null,
      rotatedTo: null,
      createdAt: "2026-09-08T00:00:00Z",
      rotatedAt: null,
    };
    const historic = {
      ...active,
      sessionId: "22222222-2222-4222-8222-222222222222",
      status: "rotated" as const,
      rotatedTo: active.sessionId,
    };
    render(
      <TurnPanel
        workspaceOpen
        positions={positions}
        selectedPositionId="repo-owner"
        engine="qoder"
        engineAvailability={availability}
        turns={[]}
        sessions={[active, historic]}
        selectedSessionId={active.sessionId}
        onCreateTurn={vi.fn()}
      />,
    );

    expect(document.querySelector(".owb-conversation-controls")).toBeNull();
    expect(screen.queryByLabelText("选择对话岗位")).toBeNull();
    expect(screen.queryByLabelText("选择本地会话")).toBeNull();
    expect(screen.queryByLabelText("选择 Agent Host")).toBeNull();
    expect(screen.queryByRole("button", { name: "轮换当前会话" })).toBeNull();
    expect(screen.getByLabelText("下达任务")).toBeEnabled();
  });

  it("sends directly to the employee selected in the organization tree", async () => {
    const createTurn = vi.fn();
    render(<TurnPanel workspaceOpen positions={positions} selectedPositionId="release-manager" engine="claude-local"
      engineAvailability={availability} turns={[]} onCreateTurn={createTurn} />);

    expect(screen.getByRole("heading", { name: "发布负责人" })).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.queryByLabelText("选择 Agent Host")).toBeNull();

    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "准备发布说明" } });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));

    await waitFor(() => {
      expect(createTurn).toHaveBeenCalledWith({
        positionId: "release-manager",
        engine: "claude-local",
        input: "准备发布说明",
      });
    });
  });

  it("sends with plain Enter and keeps Shift+Enter available for multiline input", async () => {
    const createTurn = vi.fn();
    render(<ControlledPanel onCreateTurn={createTurn} />);

    expect(screen.getByText("当前还没有回合记录，输入任务即可开始")).toBeInTheDocument();

    const input = screen.getByLabelText("下达任务");
    fireEvent.change(input, { target: { value: "跑一次发布检查" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(createTurn).toHaveBeenCalledWith({
        positionId: "repo-owner",
        engine: "qoder",
        input: "跑一次发布检查",
      });
    });

    // #167：空闲不再挂提示行；Enter 行为由 createTurn 断言守住。
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.change(input, { target: { value: "保留换行" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(createTurn).toHaveBeenCalledTimes(1);
  });

  it("#128 AC-003: ignores Enter while a Chinese IME is composing (keyCode 229) then sends after composition ends", async () => {
    const createTurn = vi.fn();
    render(<ControlledPanel onCreateTurn={createTurn} />);

    const input = screen.getByLabelText("下达任务");
    fireEvent.change(input, { target: { value: "你好" } });

    // Legacy WebKit / Firefox report keyCode 229 while an IME is composing,
    // and modern browsers set nativeEvent.isComposing. Either signal must
    // suppress Enter so committing a Chinese candidate never
    // dispatches a turn.
    fireEvent.keyDown(input, { key: "Enter", metaKey: true, keyCode: 229 });
    expect(createTurn).not.toHaveBeenCalled();

    // Composition ended: the very next Enter must fire.
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(createTurn).toHaveBeenCalledWith({
        positionId: "repo-owner",
        engine: "qoder",
        input: "你好",
      });
    });
  });

  it("#128 AC-002: empty state names the concrete prerequisite instead of a disconnected 'start from a clear task'", () => {
    render(
      <TurnPanel
        workspaceOpen={false}
        positions={positions}
        selectedPositionId={null}
        engine="qoder"
        engineAvailability={availability}
        turns={[]}
        onSelectPosition={vi.fn()}
        onSelectEngine={vi.fn()}
        onCreateTurn={vi.fn()}
      />,
    );

    // The conversation area has one stable empty-state message; the composer
    // still names the concrete blocker beside the disabled input.
    expect(screen.getByText("选择岗位后输入任务即可开始")).toBeInTheDocument();
    expect(screen.getAllByText("打开工作区后才能开始对话").length).toBeGreaterThan(0);
  });

  it("honestly disables idle states when the workspace or selected Host is unavailable", () => {
    const { rerender } = render(
      <TurnPanel
        workspaceOpen={false}
        positions={positions}
        selectedPositionId="repo-owner"
        engine="qoder"
        engineAvailability={availability}
        turns={[]}
        onSelectPosition={vi.fn()}
        onSelectEngine={vi.fn()}
        onCreateTurn={vi.fn()}
      />,
    );

    expect(screen.getAllByText("打开工作区后才能开始对话").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("下达任务")).toBeDisabled();

    rerender(
      <TurnPanel
        workspaceOpen
        positions={positions}
        selectedPositionId={null}
        engine="qoder"
        engineAvailability={availability}
        turns={[]}
        onSelectPosition={vi.fn()}
        onSelectEngine={vi.fn()}
        onCreateTurn={vi.fn()}
      />,
    );

    expect(screen.getAllByText("先从左侧组织树选择人员").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("下达任务")).toBeDisabled();

    rerender(
      <TurnPanel
        workspaceOpen
        positions={positions}
        selectedPositionId="repo-owner"
        engine="qoder"
        engineAvailability={{
          ...availability,
          qoder: { configured: false, ready: false, reason: "Qoder 凭据未配置" },
        }}
        turns={[]}
        onSelectPosition={vi.fn()}
        onSelectEngine={vi.fn()}
        onCreateTurn={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Qoder 凭据未配置").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("下达任务")).toBeDisabled();
  });

  it("renders readable states without exposing internal evidence or boundaries", () => {
    render(
      <TurnPanel
        workspaceOpen
        positions={positions}
        selectedPositionId="repo-owner"
        engine="qoder"
        engineAvailability={availability}
        turns={[
          turn({ id: "running", status: "running", output: undefined }),
          turn({ id: "completed", status: "completed" }),
          turn({ id: "failed", status: "failed", output: undefined, error: "模型执行失败" }),
          turn({
            id: "unknown",
            status: "indeterminate",
            output: undefined,
            error: "进程退出码 1",
            envelopeDigest: "sha256:1234567890abcdefghijklmnopqrstuv",
            evidenceDigest: "sha256:abcdefghijklmnopqrstuvwxyz123456",
          }),
        ]}
        onSelectPosition={vi.fn()}
        onSelectEngine={vi.fn()}
        onCreateTurn={vi.fn()}
      />,
    );

    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getByText("状态未知")).toBeInTheDocument();
    expect(screen.queryByText("sha256:1234567890abcdefghijklmnopqrstuv")).not.toBeInTheDocument();
    expect(screen.queryByText("sha256:abcdefghijklmnopqrstuvwxyz123456")).not.toBeInTheDocument();
    expect(document.querySelector(".owb-boundary")).toBeNull();
    expect(screen.queryByText(/researcher|worker|已召回|已委派/i)).not.toBeInTheDocument();
  });

  it("does not auto-retry an indeterminate turn and explicit retry creates a new request", async () => {
    const createTurn = vi.fn();
    render(
      <TurnPanel
        workspaceOpen
        positions={positions}
        selectedPositionId="repo-owner"
        engine="qoder"
        engineAvailability={availability}
        turns={[
          turn({
            id: "turn-uncertain",
            status: "indeterminate",
            output: undefined,
            error: "runner_lost",
          }),
        ]}
        onSelectPosition={vi.fn()}
        onSelectEngine={vi.fn()}
        onCreateTurn={createTurn}
      />,
    );

    expect(createTurn).not.toHaveBeenCalled();
    expect(screen.getByText(/系统不会自动重试/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "创建新回合重试" }));
    await waitFor(() => {
      expect(createTurn).toHaveBeenCalledTimes(1);
      expect(createTurn).toHaveBeenCalledWith({
        positionId: "repo-owner",
        engine: "qoder",
        input: "检查发布门禁",
        retryOf: "turn-uncertain",
      });
    });
    expect(document.querySelector('[data-turn-id="turn-uncertain"]')).toBeInTheDocument();
  });
});
describe("TurnPanel Issue #25 Slice A — operator interrupt", () => {
  it("replaces the send button with an interrupt while a turn is running", async () => {
    const cancelTurn = vi.fn();
    render(
      <TurnPanel
        workspaceOpen
        positions={positions}
        selectedPositionId="repo-owner"
        engine="qoder"
        engineAvailability={availability}
        turns={[turn({ id: "turn-live", status: "running", output: undefined })]}
        onSelectPosition={vi.fn()}
        onSelectEngine={vi.fn()}
        onCreateTurn={vi.fn()}
        onCancelTurn={cancelTurn}
      />,
    );

    expect(screen.queryByRole("button", { name: "发送任务" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "中断回合" }));
    await waitFor(() => {
      expect(cancelTurn).toHaveBeenCalledWith("repo-owner");
    });
  });

  it("triggers the same cancel via the ⌘. shortcut and disables while cancelling", () => {
    const cancelTurn = vi.fn();
    render(
      <TurnPanel
        workspaceOpen
        positions={positions}
        selectedPositionId="repo-owner"
        engine="qoder"
        engineAvailability={availability}
        turns={[turn({ id: "turn-live", status: "running", output: undefined })]}
        cancelling
        onSelectPosition={vi.fn()}
        onSelectEngine={vi.fn()}
        onCreateTurn={vi.fn()}
        onCancelTurn={cancelTurn}
      />,
    );

    expect(screen.getByText("正在停止这个任务…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "中断回合" })).toBeDisabled();
    fireEvent.keyDown(window, { key: ".", metaKey: true });
    expect(cancelTurn).not.toHaveBeenCalled();
  });

  it("fires the cancel from ⌘. when a turn is running", () => {
    const cancelTurn = vi.fn();
    render(
      <TurnPanel
        workspaceOpen
        positions={positions}
        selectedPositionId="repo-owner"
        engine="qoder"
        engineAvailability={availability}
        turns={[turn({ id: "turn-live", status: "running", output: undefined })]}
        onSelectPosition={vi.fn()}
        onSelectEngine={vi.fn()}
        onCreateTurn={vi.fn()}
        onCancelTurn={cancelTurn}
      />,
    );

    fireEvent.keyDown(window, { key: ".", metaKey: true });
    expect(cancelTurn).toHaveBeenCalledWith("repo-owner");
  });

  it("shows the compact status line with engine badge and token usage only while running", () => {
    render(
      <TurnPanel
        workspaceOpen
        positions={positions}
        selectedPositionId="repo-owner"
        engine="qoder"
        engineAvailability={availability}
        turns={[
          turn({ id: "turn-live", status: "running", output: undefined, totalTokens: 1280 }),
          turn({ id: "turn-done", status: "completed", totalTokens: 999 }),
        ]}
        onSelectPosition={vi.fn()}
        onSelectEngine={vi.fn()}
        onCreateTurn={vi.fn()}
      />,
    );

    expect(screen.getByText("回合运行中：点击中断或按 ⌘. 终止该岗位的在途回合")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发送任务" })).not.toBeInTheDocument();
    expect(screen.getAllByText("运行中").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
    expect(screen.queryByText("1,280 tokens")).not.toBeInTheDocument();
    expect(screen.queryByText("999 tokens")).not.toBeInTheDocument();
  });
});

it("preserves each employee/session draft and lets B send while A's promise is pending", async () => {
  const resolvers: Array<(value: boolean) => void> = [];
  const create = vi.fn(() => new Promise<boolean>((resolve) => resolvers.push(resolve)));
  const props = { workspaceOpen: true, positions, engine: "qoder" as const, engineAvailability: availability,
    turns: [], onSelectPosition: vi.fn(), onSelectEngine: vi.fn(), onCreateTurn: create };
  const { rerender } = render(<TurnPanel {...props} selectedPositionId="repo-owner" selectedSessionId="session-A" />);
  fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "A task" } });
  fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
  rerender(<TurnPanel {...props} selectedPositionId="release-manager" selectedSessionId="session-B" />);
  expect(screen.getByLabelText("下达任务")).toBeEnabled();
  fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "B draft" } });
  resolvers[0]!(true);
  await waitFor(() => expect(screen.getByLabelText("下达任务")).toHaveValue("B draft"));
  fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  rerender(<TurnPanel {...props} selectedPositionId="repo-owner" selectedSessionId="session-other" />);
  fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "other session draft" } });
  rerender(<TurnPanel {...props} selectedPositionId="repo-owner" selectedSessionId="session-A" />);
  expect(screen.getByLabelText("下达任务")).toHaveValue("");
  resolvers[1]!(false);
  rerender(<TurnPanel {...props} selectedPositionId="release-manager" selectedSessionId="session-B" />);
  await waitFor(() => expect(screen.getByLabelText("下达任务")).toBeEnabled());
  expect(screen.getByLabelText("下达任务")).toHaveValue("B draft");
});
describe("TurnThread #234 — preserve conversation viewport on employee switch", () => {
  function makeTurns(count: number, positionId: string): TurnRecord[] {
    return Array.from({ length: count }, (_, i) =>
      turn({
        id: `${positionId}-turn-${i}`,
        positionId,
        positionName: positionId,
        input: `task ${i}`,
        output: `output ${i}`,
      }),
    );
  }

  it("restores the prior viewport when switching A → B → A", () => {
    const turnsA = makeTurns(5, "pos-A");
    const turnsB = makeTurns(3, "pos-B");
    const { rerender } = render(
      <TurnThread turns={turnsA} scrollKey="pos-A:sess-1" />,
    );

    const ol = document.querySelector("ol.owb-turn-thread") as HTMLOListElement;
    expect(ol).not.toBeNull();
    ol.scrollTop = 420;
    ol.dispatchEvent(new Event("scroll"));

    rerender(<TurnThread turns={[]} scrollKey="pos-B:sess-1" />);
    rerender(<TurnThread turns={turnsB} scrollKey="pos-B:sess-1" />);

    rerender(<TurnThread turns={[]} scrollKey="pos-A:sess-1" />);
    rerender(<TurnThread turns={turnsA} scrollKey="pos-A:sess-1" />);
    const olAfterRestore = document.querySelector("ol.owb-turn-thread") as HTMLOListElement;
    expect(olAfterRestore.scrollTop).toBe(420);
  });

  it("starts at the default position for an employee with no stored viewport", () => {
    const turnsA = makeTurns(3, "pos-A");
    const turnsC = makeTurns(2, "pos-C");
    const { rerender } = render(
      <TurnThread turns={turnsA} scrollKey="pos-A:sess-1" />,
    );

    const ol = document.querySelector("ol.owb-turn-thread") as HTMLOListElement;
    ol.scrollTop = 300;
    ol.dispatchEvent(new Event("scroll"));

    rerender(<TurnThread turns={[]} scrollKey="pos-C:sess-1" />);
    rerender(<TurnThread turns={turnsC} scrollKey="pos-C:sess-1" />);
    const olC = document.querySelector("ol.owb-turn-thread") as HTMLOListElement;
    expect(olC.scrollTop).toBe(0);
  });
});

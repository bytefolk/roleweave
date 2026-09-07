import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { pickSelectOption, visibleSelectOptions } from "./select-helper";
import { TurnPanel } from "../src/turns";
import type { CreateTurnRequest, TurnEngine, TurnPanelProps, TurnRecord } from "../src/turns";

const positions = [
  { id: "repo-owner", name: "代码库负责人" },
  { id: "release-manager", name: "发布负责人" },
];

const availability: TurnPanelProps["engineAvailability"] = {
  qoder: { configured: true, ready: true },
  "claude-code": { configured: true, ready: true },
  "claude-local": { configured: true, ready: true },
  codex: { configured: true, ready: true },
};

function ControlledPanel({ onCreateTurn }: { onCreateTurn: (request: CreateTurnRequest) => void }) {
  const [positionId, setPositionId] = useState<string | null>("repo-owner");
  const [engine, setEngine] = useState<TurnEngine>("qoder");
  return (
    <TurnPanel
      workspaceOpen
      positions={positions}
      selectedPositionId={positionId}
      engine={engine}
      engineAvailability={availability}
      turns={[]}
      onSelectPosition={setPositionId}
      onSelectEngine={setEngine}
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
  it("addresses a position, switches between the four supported Hosts, and creates a turn", async () => {
    const createTurn = vi.fn();
    render(<ControlledPanel onCreateTurn={createTurn} />);

    // #248 R2 ③：对话岗位 / Agent Host 已降级进默认收起的「会话设置」，先展开。
    fireEvent.click(screen.getByText("会话设置"));

    pickSelectOption("选择对话岗位", "发布负责人");
    // #73: 面板标题改为设计稿的「本地对话 · <岗位 id>」，仍然唯一标定收件岗位。
    expect(screen.getByRole("heading", { name: /本地对话 · release-manager/ })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "选择 Agent Host" }));
    // #206 added Codex as a fourth selectable Host.
    expect(visibleSelectOptions().map((option) => option.textContent)).toEqual([
      "Qoder · Configured",
      "Claude Code · Configured",
      "Claude Code · 本地登录 · Configured",
      "Codex · Configured",
    ]);
    pickSelectOption("选择 Agent Host", "Claude Code · Configured");

    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "准备发布说明" } });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));

    await waitFor(() => {
      expect(createTurn).toHaveBeenCalledWith({
        positionId: "release-manager",
        engine: "claude-code",
        input: "准备发布说明",
      });
    });
  });

  // 提示条写着「⌘↵ 发送」，那它就必须真的能发——文案与行为不许脱节。
  it("sends with ⌘↵ / Ctrl+↵ as the composer hint advertises", async () => {
    const createTurn = vi.fn();
    render(<ControlledPanel onCreateTurn={createTurn} />);

    const input = screen.getByLabelText("下达任务");
    fireEvent.change(input, { target: { value: "跑一次发布检查" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    await waitFor(() => {
      expect(createTurn).toHaveBeenCalledWith({
        positionId: "repo-owner",
        engine: "qoder",
        input: "跑一次发布检查",
      });
    });

    // #167：空闲不再挂提示行（描述语精简）；⌘↵ 行为由 createTurn 断言守住。
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("#128 AC-003: ignores ⌘↵ while a Chinese IME is composing (keyCode 229) then sends after composition ends", async () => {
    const createTurn = vi.fn();
    render(<ControlledPanel onCreateTurn={createTurn} />);

    const input = screen.getByLabelText("下达任务");
    fireEvent.change(input, { target: { value: "你好" } });

    // Legacy WebKit / Firefox report keyCode 229 while an IME is composing,
    // and modern browsers set nativeEvent.isComposing. Either signal must
    // suppress the ⌘↵ shortcut so committing a Chinese candidate never
    // dispatches a turn.
    fireEvent.keyDown(input, { key: "Enter", metaKey: true, keyCode: 229 });
    expect(createTurn).not.toHaveBeenCalled();

    // Composition ended: the very next ⌘↵ must fire.
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
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

    // Previously the empty state read "从一个明确任务开始" while the composer
    // hint below simultaneously forbade any input — the two lines
    // contradicted each other. The empty state must now surface the same
    // concrete precondition as `disabledReason`.
    expect(screen.queryByText("从一个明确任务开始")).not.toBeInTheDocument();
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

    expect(screen.getAllByText("先从组织树或 @ 选择器选择岗位").length).toBeGreaterThan(0);
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

  it("renders local status and digest evidence without inventing delegation or recall", () => {
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
    // 证据默认折叠（气泡规格⑤）：展开后全量 digest 可见（审计红线）
    fireEvent.click(screen.getByRole("button", { name: /证据/ }));
    expect(screen.getByTitle("sha256:1234567890abcdefghijklmnopqrstuv")).toBeInTheDocument();
    expect(screen.getByTitle("sha256:abcdefghijklmnopqrstuvwxyz123456")).toBeInTheDocument();
    // #73: 边界 chip 改为设计稿的 host / mode / budget 实况三枚；委派链与长期
    // Context 的「Planned」占位随之退场，但仍不得凭空宣称委派/召回能力。
    const boundaries = Array.from(document.querySelectorAll(".owb-boundary")).map(
      (node) => node.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(boundaries).toHaveLength(3);
    expect(boundaries[0]).toMatch(/^host/);
    expect(boundaries[1]).toMatch(/^mode/);
    expect(boundaries[2]).toMatch(/^budget/);
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
    expect(screen.getByText("turn-uncertain")).toBeInTheDocument();
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

    expect(screen.getByText("正在请求控制面中断引擎进程…")).toBeInTheDocument();
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
    // #73: 状态行统一承载 engine · 耗时 · tokens · 终态词（千分位，tabular-nums），
    // 在途与已结算回合都走同一行，不再分裂到气泡下 meta。
    const statusLine = screen.getByText("1,280 tokens").closest("p");
    expect(statusLine).toHaveClass("owb-turn__statusline");
    expect(statusLine?.textContent).toContain("running");
    const settled = screen.getByText("999 tokens").closest("p");
    expect(settled).toHaveClass("owb-turn__statusline");
    expect(settled?.textContent).toContain("可信终态");
  });
});

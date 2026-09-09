import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TurnPanel } from "../src/turns";
import type { TurnEngine, TurnPanelProps, TurnRecord } from "../src/turns";

const positions = [{ id: "repo-owner", name: "代码库负责人" }];

const availability: TurnPanelProps["engineAvailability"] = {
  qoder: { configured: true, ready: true },
  "claude-code": { configured: true, ready: true },
  "claude-local": { configured: true, ready: true },
  codex: { configured: true, ready: true },
  "codex-local": { configured: true, ready: true },
};

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

function renderWithTurns(turns: TurnRecord[]) {
  return render(
    <TurnPanel
      workspaceOpen
      positions={positions}
      selectedPositionId="repo-owner"
      engine="qoder"
      engineAvailability={availability}
      turns={turns}
      onSelectPosition={vi.fn()}
      onSelectEngine={vi.fn()}
      onCreateTurn={vi.fn()}
    />,
  );
}

describe("provisional output (#142 AC-002)", () => {
  it("marks a running turn with streamed text as provisional", () => {
    renderWithTurns([turn({ id: "live", status: "running", output: "正在分析代码…" })]);

    const article = screen.getByText("正在分析代码…").closest("article");
    expect(article).toHaveClass("owb-tc--provisional");
    expect(screen.getByText("临时输出")).toBeInTheDocument();
    expect(screen.getByText("临时输出").closest("span")).toHaveAttribute(
      "aria-label",
      "临时输出，未经验证",
    );
  });

  it("does not mark a running turn without output as provisional", () => {
    renderWithTurns([turn({ id: "live", status: "running", output: undefined })]);

    const articles = document.querySelectorAll("article.owb-tc");
    expect(articles.length).toBeGreaterThan(0);
    for (const article of articles) {
      expect(article).not.toHaveClass("owb-tc--provisional");
    }
    expect(screen.queryByText("临时输出")).not.toBeInTheDocument();
  });

  it("does not mark a completed turn as provisional even with output", () => {
    renderWithTurns([turn({ id: "done", status: "completed", output: "最终结果" })]);

    const article = screen.getByText("最终结果").closest("article");
    expect(article).not.toHaveClass("owb-tc--provisional");
    expect(screen.queryByText("临时输出")).not.toBeInTheDocument();
  });

  it("swaps provisional to terminal output when the turn completes", () => {
    const { rerender } = renderWithTurns([
      turn({ id: "live", status: "running", output: "流式文本" }),
    ]);

    expect(screen.getByText("流式文本").closest("article")).toHaveClass("owb-tc--provisional");

    rerender(
      <TurnPanel
        workspaceOpen
        positions={positions}
        selectedPositionId="repo-owner"
        engine="qoder"
        engineAvailability={availability}
        turns={[turn({ id: "live", status: "completed", output: "验证后的最终输出" })]}
        onSelectPosition={vi.fn()}
        onSelectEngine={vi.fn()}
        onCreateTurn={vi.fn()}
      />,
    );

    expect(screen.getByText("验证后的最终输出")).toBeInTheDocument();
    expect(screen.queryByText("流式文本")).not.toBeInTheDocument();
    expect(screen.queryByText("临时输出")).not.toBeInTheDocument();
    expect(screen.getByText("验证后的最终输出").closest("article")).not.toHaveClass(
      "owb-tc--provisional",
    );
  });

  it("freezes provisional text on indeterminate and shows no-retry notice", () => {
    renderWithTurns([
      turn({
        id: "interrupted",
        status: "indeterminate",
        output: "中断前的流式文本",
        error: "turn_cancelled: 进程被中断",
      }),
    ]);

    expect(screen.getByText("中断前的流式文本")).toBeInTheDocument();
    expect(screen.getByText("中断前的流式文本").closest("article")).not.toHaveClass(
      "owb-tc--provisional",
    );
    expect(screen.queryByText("临时输出")).not.toBeInTheDocument();
    expect(screen.getByText(/系统不会自动重试/)).toBeInTheDocument();
  });
});

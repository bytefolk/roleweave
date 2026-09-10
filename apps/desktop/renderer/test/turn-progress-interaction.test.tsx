import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnThread } from "../src/turns/TurnThread";
import type { TurnRecord } from "../src/turns/types";

const started = "2026-09-10T06:00:00.000Z";
const ended = "2026-09-10T06:00:12.000Z";
function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return { id: "progress-example", positionId: "owner", positionName: "负责人", engine: "qoder",
    input: "检查项目", status: "running", createdAt: started,
    output: "正在整理可公开的检查结果。",
    progress: [{ kind: "received", at: started }, { kind: "working", at: "2026-09-10T06:00:01.000Z" }],
    ...overrides };
}
function disclosure() {
  return within(screen.getByRole("group", { name: "执行进展" })).getByRole("button");
}
afterEach(() => vi.useRealTimers());

describe("conversation progress disclosure", () => {
  it("opens a live run, shows its elapsed time, and marks only the current milestone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T06:00:08.000Z"));
    render(<TurnThread turns={[turn()]} />);
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("timer")).toHaveTextContent("8s");
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(screen.getByRole("region", { name: "实时进展" })).toHaveTextContent("公开的检查结果");
    expect(screen.queryByText(/执行工具/)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole("timer")).toHaveTextContent("10s");
  });

  it("preserves a user's closed disclosure while streamed output changes", () => {
    const { rerender } = render(<TurnThread turns={[turn()]} />);
    fireEvent.click(disclosure());
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    rerender(<TurnThread turns={[turn({ output: "追加了新的公开结果。" })]} />);
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("追加了新的公开结果。")).toBeVisible();
    expect(screen.getByText("任务已接收")).not.toBeVisible();
  });

  it("collapses on completion and freezes the clock, but can reopen the recorded milestones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T06:00:08.000Z"));
    const { rerender } = render(<TurnThread turns={[turn()]} />);
    const complete = turn({ status: "completed", completedAt: ended, output: "检查完成。",
      progress: [...turn().progress!, { kind: "completed", at: ended }] });
    rerender(<TurnThread turns={[complete]} />);
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    expect(disclosure()).toHaveTextContent("已完成");
    expect(screen.getByRole("timer")).toHaveTextContent("12s");
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.getByRole("timer")).toHaveTextContent("12s");
    fireEvent.click(disclosure());
    expect(screen.getByText("任务已接收")).toBeVisible();
    rerender(<TurnThread turns={[{ ...complete }]} />);
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "最终结论" })).toHaveTextContent("检查完成。");
  });

  it("releases its running timer when the conversation leaves the screen", () => {
    vi.useFakeTimers();
    const { unmount } = render(<TurnThread turns={[turn()]} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps approval actions visible and distinguishes waiting from a submitted decision", () => {
    const pending = turn({ status: "failed", completedAt: ended, output: undefined,
      error: "等待操作确认", approvalRequest: { approvalId: "approve-1", kind: "write", description: "保存检查结果" },
      progress: [...turn().progress!, { kind: "awaiting_approval", at: ended }] });
    const onVerdict = vi.fn();
    const { rerender } = render(<TurnThread turns={[pending]} onVerdict={onVerdict} />);
    expect(disclosure()).toHaveTextContent("等待审批");
    expect(screen.getByRole("button", { name: "批准并继续" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "批准并继续" }));
    expect(onVerdict).toHaveBeenCalledWith(pending, "granted");
    rerender(<TurnThread turns={[pending]} onVerdict={onVerdict} decidedApprovalIds={new Set(["approve-1"])} />);
    expect(disclosure()).toHaveTextContent("已裁决");
    expect(screen.queryByRole("button", { name: "批准并继续" })).not.toBeInTheDocument();
  });

  it("never presents interrupted output as a final conclusion or hides the warning in the disclosure", () => {
    render(<TurnThread turns={[turn({ status: "indeterminate", completedAt: ended, error: "连接中断" })]} />);
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    expect(disclosure()).toHaveTextContent("状态未知");
    expect(screen.getByRole("region", { name: "未确认的输出" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "最终结论" })).not.toBeInTheDocument();
    expect(screen.getByText("连接中断")).toBeVisible();
    expect(screen.getByText(/系统不会自动重试/)).toBeVisible();
  });

  it("does not fabricate elapsed time for a terminal record with no finish timestamp", () => {
    render(<TurnThread turns={[turn({ status: "completed", completedAt: undefined, progress: undefined })]} />);
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    fireEvent.click(disclosure());
    expect(document.querySelector(".owb-turn-progress__step.is-completed time")).toBeNull();
  });

  it("omits an invalid or reversed duration instead of rendering NaN or a negative counter", () => {
    const { rerender } = render(<TurnThread turns={[turn({ createdAt: "invalid", status: "completed", completedAt: ended })]} />);
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    rerender(<TurnThread turns={[turn({ createdAt: ended, status: "completed", completedAt: started })]} />);
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  });
});

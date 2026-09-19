import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  it("moves the animated milestone from acceptance to processing and stops it on completion", () => {
    const received = turn({ output: undefined, progress: [{ kind: "received", at: started }] });
    const { rerender } = render(<TurnThread turns={[received]} />);
    const acceptedStep = screen.getByText("任务已接收").closest("li");
    expect(acceptedStep).toHaveAttribute("aria-current", "step");
    expect(acceptedStep?.querySelector(".owb-turn-progress__spinner")).not.toBeNull();
    expect(screen.queryByText("处理请求")).not.toBeInTheDocument();

    rerender(<TurnThread turns={[turn()]} />);
    const workingStep = screen.getByText("处理请求").closest("li");
    expect(screen.getByText("任务已接收").closest("li")).not.toHaveAttribute("aria-current");
    expect(screen.getByText("任务已接收").closest("li")?.querySelector(".owb-turn-progress__spinner")).toBeNull();
    expect(workingStep).toHaveAttribute("aria-current", "step");
    expect(workingStep?.querySelector(".owb-turn-progress__spinner")).not.toBeNull();
    expect(document.querySelectorAll(".owb-turn-progress__spinner")).toHaveLength(1);

    rerender(<TurnThread turns={[turn({ status: "completed", completedAt: ended, output: "检查完成。",
      progress: [...turn().progress!, { kind: "completed", at: ended }] })]} />);
    expect(disclosure()).toHaveTextContent("已完成");
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
    expect(document.querySelector(".owb-turn-progress__spinner")).toBeNull();
    fireEvent.click(disclosure());
    expect(screen.getByText("任务已接收")).toBeVisible();
    expect(screen.getByText("处理请求")).toBeVisible();
    expect(screen.getByText("回合已完成")).toBeVisible();
    expect(screen.getByRole("region", { name: "最终结论" })).toHaveTextContent("检查完成。");
  });

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

  it("exposes real live motion hooks and removes them when the turn completes", () => {
    const { rerender } = render(<TurnThread turns={[turn()]} />);
    const progress = screen.getByRole("group", { name: "执行进展" });
    const liveStep = document.querySelector('[aria-current="step"]');
    expect(progress).toHaveAttribute("data-motion", "live");
    expect(liveStep).toHaveClass("is-current");
    expect(liveStep).toHaveAttribute("data-motion", "active");
    expect(liveStep?.querySelector(".owb-turn-progress__activity")).toBeInTheDocument();

    rerender(<TurnThread turns={[turn({ status: "completed", completedAt: ended,
      progress: [...turn().progress!, { kind: "completed", at: ended }] })]} />);
    expect(progress).not.toHaveAttribute("data-motion");
    expect(document.querySelector(".owb-turn-progress__activity")).toBeNull();
  });

  it("ships state-driven motion with a complete reduced-motion fallback", () => {
    const css = readFileSync(join(process.cwd(), "apps/desktop/renderer/src/roleweave-conversation.css"), "utf8");
    expect(css).toContain("@keyframes owb-progress-step-in");
    expect(css).toContain("@keyframes owb-progress-activity");
    expect(css).toContain("@keyframes owb-progress-rail");
    expect(css).toMatch(/\[data-motion="live"\][^{]*::after/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*:is\(\[data-theme="light"\], \[data-theme="dark"\]\) \.owb-app \.owb-turn-progress__spinner,[\s\S]*:is\(\[data-theme="light"\], \[data-theme="dark"\]\) \.owb-app \.owb-turn-progress__step[\s\S]*animation:\s*none/);
  });

  it("does not animate a running record that is waiting for approval", () => {
    render(<TurnThread turns={[turn({ approvalRequest: {
      approvalId: "approve-live", kind: "write", description: "保存检查结果",
    }, progress: [...turn().progress!, { kind: "awaiting_approval", at: ended }] })]} />);
    expect(screen.getByRole("group", { name: "执行进展" })).not.toHaveAttribute("data-motion");
    expect(document.querySelector(".owb-turn-progress__activity")).toBeNull();
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
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
    expect(document.querySelector(".owb-turn-progress__spinner")).toBeNull();
    expect(screen.getByRole("button", { name: "批准并继续" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "批准并继续" }));
    expect(onVerdict).toHaveBeenCalledWith(pending, "granted");
    rerender(<TurnThread turns={[pending]} onVerdict={onVerdict} decidedApprovalIds={new Set(["approve-1"])} />);
    expect(disclosure()).toHaveTextContent("已裁决");
    expect(screen.queryByRole("button", { name: "批准并继续" })).not.toBeInTheDocument();
  });

  it.each([
    { status: "failed" as const, kind: "failed" as const, summary: "失败" },
    { status: "indeterminate" as const, kind: "unknown" as const, summary: "状态未知" },
  ])("stops processing animation and its clock when a run becomes $status", ({ status, kind, summary }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T06:00:08.000Z"));
    const { rerender } = render(<TurnThread turns={[turn()]} />);
    expect(document.querySelector(".owb-turn-progress__spinner")).not.toBeNull();
    rerender(<TurnThread turns={[turn({ status, completedAt: ended, error: "执行未完成",
      progress: [...turn().progress!, { kind, at: ended }] })]} />);
    expect(disclosure()).toHaveTextContent(summary);
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
    expect(document.querySelector(".owb-turn-progress__spinner")).toBeNull();
    expect(screen.getByRole("timer")).toHaveTextContent("12s");
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.queryByRole("region", { name: "最终结论" })).not.toBeInTheDocument();
    expect(screen.getByText("执行未完成")).toBeVisible();
    fireEvent.click(disclosure());
    expect(screen.getByText("处理请求")).toBeVisible();
    expect(document.querySelector(".owb-turn-progress__spinner")).toBeNull();
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

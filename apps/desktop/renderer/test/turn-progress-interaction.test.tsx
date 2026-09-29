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
    trace: [{ activityId: "t1", kind: "tool", status: "running", title: "Glob", detail: "src/**", at: started }],
    ...overrides };
}
function disclosure() {
  return within(screen.getByRole("group", { name: "执行进展" })).getByRole("button");
}
afterEach(() => vi.useRealTimers());

describe("conversation activity line (Qoder-style)", () => {
  it("runs expanded on the generic running copy and names the live tool once folded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T06:00:08.000Z"));
    render(<TurnThread turns={[turn()]} />);
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
    expect(disclosure()).toHaveTextContent("正在执行中");
    expect(screen.getByRole("timer")).toHaveTextContent("· 8s");
    const row = screen.getByText("Glob").closest("li");
    expect(row?.querySelector(".owb-turn-progress__spinner")).not.toBeNull();
    expect(row?.querySelector(".owb-activity-trace__status")?.className).toContain("is-running");
    // A running tool is the live element; no extra thinking row beside it.
    expect(screen.queryByText("继续推理…")).not.toBeInTheDocument();
    fireEvent.click(disclosure());
    expect(disclosure()).toHaveTextContent("正在调用 Glob");
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole("timer")).toHaveTextContent("· 10s");
  });

  it("falls back to the generic running copy and a thinking row without a live tool", () => {
    render(<TurnThread turns={[turn({ trace: [
      { activityId: "t1", kind: "tool", status: "completed", title: "Read", detail: "src/App.tsx", at: started },
    ] })]} />);
    expect(disclosure()).toHaveTextContent("正在执行中");
    const thinking = screen.getByText("继续推理…").closest("li");
    expect(thinking).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Read").closest("li")?.querySelector(".owb-activity-trace__status")?.className).toContain("is-completed");
  });

  it("interleaves bounded thought narration with tool activity in event order", () => {
    render(<TurnThread turns={[turn({ status: "completed", completedAt: ended, output: "结论", trace: [
      { activityId: "thought-1", kind: "thought", status: "completed", text: "先读这份表，然后查群和人。", at: started },
      { activityId: "t1", kind: "tool", status: "completed", title: "Terminal", detail: "dws aitable field list", at: "2026-09-10T06:00:02.000Z" },
      { activityId: "thought-2", kind: "thought", status: "completed", text: "JSON 结构不同，换个方式取。", at: "2026-09-10T06:00:04.000Z" },
      { activityId: "t2", kind: "tool", status: "failed", title: "Terminal", detail: "dws aitable record list", at: "2026-09-10T06:00:06.000Z" },
    ] })]} />);
    expect(disclosure()).toHaveTextContent("执行工具 2 次，其中 1 次失败");
    fireEvent.click(disclosure());
    const items = document.querySelectorAll(".owb-activity-trace__item, .owb-activity-trace__agent");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveClass("is-thought");
    expect(items[0]).toHaveTextContent("已思考");
    expect(items[0]).toHaveTextContent("先读这份表，然后查群和人。");
    expect(items[1]).toHaveTextContent("已执行");
    expect(items[3]).toHaveClass("is-failed");
    expect(items[3]).toHaveTextContent("运行失败");
  });

  it("names a running turn's open narration as the live element instead of a second thinking row", () => {
    render(<TurnThread turns={[turn({ trace: [
      { activityId: "t1", kind: "tool", status: "completed", title: "Read", detail: "src/App.tsx", at: started },
      { activityId: "thought-1", kind: "thought", status: "running", text: "Now query all records", at: "2026-09-10T06:00:05.000Z" },
    ] })]} />);
    const item = document.querySelector(".owb-activity-trace__item.is-thought.is-running");
    expect(item).not.toBeNull();
    expect(item).toHaveTextContent("思考中");
    expect(item).toHaveTextContent("Now query all records");
    expect(screen.queryByText("继续推理…")).not.toBeInTheDocument();
  });

  it("prefers the open narration in the fold title when narration streams beside a still-running tool", () => {
    render(<TurnThread turns={[turn({ trace: [
      { activityId: "t1", kind: "tool", status: "running", title: "Glob", detail: "src/**", at: started },
      { activityId: "thought-1", kind: "thought", status: "running", text: "等待匹配期间先整理分组", at: "2026-09-10T06:00:05.000Z" },
    ] })]} />);
    // While expanded the title is the generic running copy; folding reveals
    // the live element — and the running thought is the trail tail, so it
    // names the title, not the still-running tool.
    expect(disclosure()).toHaveTextContent("正在执行中");
    fireEvent.click(disclosure());
    expect(disclosure()).toHaveTextContent("思考中");
    expect(disclosure()).not.toHaveTextContent("正在调用 Glob");
    const thought = document.querySelector(".owb-activity-trace__item.is-thought.is-running");
    expect(thought).not.toBeNull();
    expect(thought).toHaveTextContent("思考中");
    expect(thought).toHaveTextContent("等待匹配期间先整理分组");
    expect(screen.getByText("Glob").closest("li")?.querySelector(".owb-activity-trace__status")?.className).toContain("is-running");
    expect(screen.queryByText("继续推理…")).not.toBeInTheDocument();
  });

  it("folds into its tool-count summary and collapses once settled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T06:00:08.000Z"));
    const { rerender } = render(<TurnThread turns={[turn()]} />);
    rerender(<TurnThread turns={[turn({ status: "completed", completedAt: ended, output: "检查完成。", trace: [
      { activityId: "t1", kind: "tool", status: "completed", title: "Glob", detail: "src/**", at: started },
      { activityId: "t2", kind: "tool", status: "completed", title: "Read", detail: "src/App.tsx", at: "2026-09-10T06:00:02.000Z" },
    ] })]} />);
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    expect(disclosure()).toHaveTextContent("执行工具 2 次");
    expect(screen.getByRole("timer")).toHaveTextContent("耗时 12 秒");
    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelector(".owb-turn-progress__spinner")).toBeNull();
    fireEvent.click(disclosure());
    expect(screen.getByText("Glob").closest("li")?.querySelector(".owb-activity-trace__status")?.className).toContain("is-completed");
    expect(screen.queryByText("继续推理…")).not.toBeInTheDocument();
  });

  it("counts failed tools in the settled summary", () => {
    render(<TurnThread turns={[turn({ status: "completed", completedAt: ended, output: "done", trace: [
      { activityId: "t1", kind: "tool", status: "completed", title: "Read", at: started },
      { activityId: "t2", kind: "tool", status: "failed", title: "Terminal", detail: "npm test", at: "2026-09-10T06:00:02.000Z" },
    ] })]} />);
    expect(disclosure()).toHaveTextContent("执行工具 2 次，其中 1 次失败");
    const failedRow = screen.getByText("Terminal").closest("li");
    expect(failedRow?.querySelector(".owb-activity-trace__status")?.className).toContain("is-failed");
  });

  it("turns workspace file paths in execution details into icon links that open the exact employee resource", () => {
    const openResource = vi.fn();
    render(<TurnThread turns={[turn({ trace: [
      { activityId: "read-1", kind: "tool", status: "completed", title: "Read", detail: "apps/server/src/routes/docs.ts · packages/ui/src/locales/zh.ts", at: started },
    ] })]} onOpenResource={openResource} />);
    const source = screen.getByRole("link", { name: "文档链接：apps/server/src/routes/docs.ts" });
    expect(source.querySelector('[data-link-icon="code"]')).toBeInTheDocument();
    fireEvent.click(source);
    expect(openResource).toHaveBeenCalledWith("owner", "apps/server/src/routes/docs.ts");
  });

  it("settles without tools as a plain processed line with no disclosure", () => {
    render(<TurnThread turns={[turn({ status: "completed", completedAt: ended, output: "done", trace: [] })]} />);
    expect(screen.getByRole("group", { name: "执行进展" }).textContent).toContain("已处理");
    expect(within(screen.getByRole("group", { name: "执行进展" })).queryByRole("button")).toBeNull();
  });

  it("keeps a user's closed disclosure while streamed output changes, then collapses the settled phase", () => {
    const { rerender } = render(<TurnThread turns={[turn()]} />);
    fireEvent.click(disclosure());
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    rerender(<TurnThread turns={[turn({ output: "追加了新的公开结果。" })]} />);
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("追加了新的公开结果。")).toBeVisible();
    rerender(<TurnThread turns={[turn({ status: "completed", completedAt: ended, output: "检查完成。", trace: [
      { activityId: "t1", kind: "tool", status: "completed", title: "Glob", at: started },
    ] })]} />);
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure());
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Glob")).toBeVisible();
  });

  it("exposes live motion hooks on the header and removes them when settled", () => {
    const { rerender } = render(<TurnThread turns={[turn()]} />);
    const progress = screen.getByRole("group", { name: "执行进展" });
    expect(progress).toHaveAttribute("data-motion", "live");
    expect(progress.querySelector(".owb-turn-progress__header .owb-turn-progress__activity")).toBeInTheDocument();
    rerender(<TurnThread turns={[turn({ status: "completed", completedAt: ended, output: "done", trace: [] })]} />);
    expect(progress).not.toHaveAttribute("data-motion");
    expect(document.querySelector(".owb-turn-progress__activity")).toBeNull();
  });

  it("ships state-driven motion with a complete reduced-motion fallback", () => {
    const css = readFileSync(join(process.cwd(), "apps/desktop/renderer/src/roleweave-conversation.css"), "utf8");
    expect(css).toContain("@keyframes owb-progress-spin");
    expect(css).toContain("@keyframes owb-progress-activity");
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*\.owb-turn-progress__spinner,[\s\S]*\.owb-turn-progress__activity-orbit[\s\S]*animation:\s*none/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*\.owb-activity-trace__continuing svg \{ animation: none; \}/);
  });

  it("does not animate a running record that is waiting for approval", () => {
    render(<TurnThread turns={[turn({ approvalRequest: {
      approvalId: "approve-live", kind: "write", description: "保存检查结果",
    } })]} />);
    expect(screen.getByRole("group", { name: "执行进展" })).not.toHaveAttribute("data-motion");
    expect(document.querySelector(".owb-turn-progress__activity")).toBeNull();
    expect(screen.getByRole("group", { name: "执行进展" }).textContent).toContain("等待审批");
  });

  it.each([
    { status: "failed" as const, summary: "失败" },
    { status: "indeterminate" as const, summary: "状态未知" },
  ])("settles a $status run onto its truthful summary and stops the clock", ({ status, summary }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T06:00:08.000Z"));
    const { rerender } = render(<TurnThread turns={[turn()]} />);
    expect(document.querySelector(".owb-turn-progress__spinner")).not.toBeNull();
    rerender(<TurnThread turns={[turn({ status, completedAt: ended, error: "执行未完成", trace: [] })]} onRetry={vi.fn()} />);
    expect(screen.getByRole("group", { name: "执行进展" }).textContent).toContain(summary);
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
    expect(document.querySelector(".owb-turn-progress__spinner")).toBeNull();
    expect(screen.getByRole("timer")).toHaveTextContent("耗时 12 秒");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the structured timeout failure visible beside the folded activity", () => {
    const trace = Array.from({ length: 18 }, (_, index) => ({
      activityId: `tool-${index}`, kind: "tool" as const, status: index === 17 ? "failed" as const : "completed" as const,
      title: index % 2 === 0 ? "Read" : "Terminal", detail: index === 0 ? "src/App.tsx" : `command-${index}`,
      at: `2026-09-10T06:00:${String(index).padStart(2, "0")}.000Z`,
    }));
    render(<TurnThread turns={[turn({ status: "indeterminate", completedAt: "2026-09-10T06:02:00.000Z",
      errorCode: "turn_timeout", error: "the turn exceeded its time budget", trace })]} onRetry={vi.fn()} />);
    expect(disclosure()).toHaveTextContent("状态未知");
    fireEvent.click(disclosure());
    const failedRow = screen.getByText(/command-17/).closest("li");
    expect(failedRow?.querySelector(".owb-activity-trace__status")?.className).toContain("is-failed");
    expect(screen.getByText(/src\/App\.tsx/)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("执行超时");
    expect(screen.getByRole("alert")).toHaveTextContent("已保留本次收到的内容");
    expect(screen.getByRole("button", { name: "重新执行" })).toBeVisible();
  });

  it("does not fabricate elapsed time for a terminal record with no finish timestamp", () => {
    render(<TurnThread turns={[turn({ status: "completed", completedAt: undefined, trace: [] })]} />);
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  });

  it("omits an invalid or reversed duration instead of rendering NaN or a negative counter", () => {
    const { rerender } = render(<TurnThread turns={[turn({ createdAt: "invalid", status: "completed", completedAt: ended, trace: [] })]} />);
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    rerender(<TurnThread turns={[turn({ createdAt: ended, status: "completed", completedAt: started, trace: [] })]} />);
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  });

  it("releases its running timer when the conversation leaves the screen", () => {
    vi.useFakeTimers();
    const { unmount } = render(<TurnThread turns={[turn()]} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

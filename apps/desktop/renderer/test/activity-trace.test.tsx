import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OwbI18nProvider } from "@roleweave/ui";
import { describe, expect, it, vi } from "vitest";
import { TurnThread } from "../src/turns/TurnThread";
import { putTrailItem, visibleTrail } from "../src/turns/trail";
import type { TurnRecord, TurnTraceActivity } from "../src/turns/types";

const started = "2026-10-01T06:00:00.000Z";
const tool: TurnTraceActivity = { activityId: "glob-1", kind: "tool", title: "Glob", status: "running", detail: "pattern: **/*.tsx · apps/desktop", at: started };
function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return { id: "activity-example", positionId: "owner", positionName: "负责人", engine: "qoder", input: "检查项目", status: "running", createdAt: started, trace: [tool], ...overrides };
}

describe("readable public activity", () => {
  it("names file search as an action and shows its actual pattern and directory", () => {
    render(<TurnThread turns={[turn()]} />);
    const row = screen.getByText("查找文件").closest("li");
    expect(row).toHaveTextContent("Glob");
    expect(row).toHaveTextContent("**/*.tsx");
    expect(row).toHaveTextContent("apps/desktop");
    expect(row).toHaveTextContent("执行中");
    expect(row).not.toHaveTextContent("找到");
  });

  it.each([["Read", "读取文件"], ["Grep", "搜索内容"], ["Bash", "执行命令"]])("uses a concrete action for %s", (title, action) => {
    render(<TurnThread turns={[turn({ trace: [{ ...tool, title, detail: undefined }] })]} />);
    expect(screen.getByText(action).closest("li")).toHaveTextContent("此步骤未提供参数详情");
  });

  it("uses English actions when the conversation locale is English", () => {
    render(<OwbI18nProvider locale="en"><TurnThread turns={[turn()]} /></OwbI18nProvider>);
    expect(screen.getByText("Find files").closest("li")).toHaveTextContent("In progress");
  });

  it("renders glob patterns literally without interpreting Markdown emphasis", () => {
    const pattern = "**/foo*bar*/[ab].tsx";
    render(<TurnThread turns={[turn({ trace: [{ ...tool, detail: `pattern: ${pattern} · files: *.tsx · offset: 12 · limit: 40` }] })]} />);
    const value = screen.getByText(pattern);
    expect(value.tagName).toBe("CODE");
    expect(value.textContent).toBe(pattern);
    const parameters = value.closest(".owb-activity-trace__parameters");
    expect(parameters?.querySelector("em, strong, .owb-markdown")).toBeNull();
    expect(parameters).toHaveTextContent("匹配规则");
    expect(parameters).toHaveTextContent("文件范围");
    expect(parameters).toHaveTextContent("起始行");
    expect(parameters).toHaveTextContent("读取上限");
  });

  it.each(["/home/huyz/data/bytefolk/roleweave/apps/server/src/routes/docs.ts", "C:\\Users\\huyz\\rw-clone\\roleweave\\apps\\server\\src\\routes\\docs.ts"])("opens the complete absolute source path %s", (path) => {
    const openResource = vi.fn();
    render(<TurnThread turns={[turn({ trace: [{ ...tool, title: "Read", detail: `path: ${path}` }] })]} onOpenResource={openResource} />);
    const source = screen.getByRole("link", { name: `文档链接：${path}` });
    expect(source.querySelector('[data-link-icon="code"]')).toBeInTheDocument();
    expect(source.querySelector("code")?.textContent).toBe(path);
    fireEvent.click(source);
    expect(openResource).toHaveBeenCalledWith("owner", path);
  });

  it("keeps a source path as literal text when no resource callback is available", () => {
    const path = "/home/huyz/project/src/index.ts";
    render(<TurnThread turns={[turn({ trace: [{ ...tool, title: "Read", detail: `path: ${path}` }] })]} />);
    expect(screen.getByText(path).tagName).toBe("CODE");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("offers the full detail through an expandable row instead of losing its end", () => {
    const detail = `pattern: **/*.tsx · ${"nested-directory/".repeat(20)}final-target.tsx`;
    render(<TurnThread turns={[turn({ trace: [{ ...tool, detail }] })]} />);
    const summary = screen.getByText("展开详情").closest("summary");
    expect(summary).toHaveAttribute("title", detail);
    fireEvent.click(summary!);
    expect(summary?.closest("details")).toHaveAttribute("open");
    expect(summary?.closest("details")?.querySelector(".owb-activity-trace__detail-body")).toHaveTextContent("final-target.tsx");
  });

  it("keeps an explicitly opened detail open when its tool completes during streaming", async () => {
    const detail = `pattern: **/*.tsx · ${"nested-directory/".repeat(20)}final-target.tsx`;
    const { rerender } = render(<TurnThread turns={[turn({ trace: [{ ...tool, detail }] })]} />);
    const summary = screen.getByText("展开详情").closest("summary")!;
    fireEvent.click(summary);
    await waitFor(() => expect(summary).toHaveTextContent("收起详情"));
    rerender(<TurnThread turns={[turn({ trace: [{ ...tool, detail, status: "completed" }] })]} />);
    expect(summary.closest("details")).toHaveAttribute("open");
    expect(summary.closest("li")).toHaveTextContent("已完成");
    expect(summary.closest("details")).toHaveTextContent("final-target.tsx");
    fireEvent.click(summary);
    await waitFor(() => expect(summary).toHaveTextContent("展开详情"));
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });

  it("keeps full streamed output while removing its duplicate narration excerpt", () => {
    const output = "正在整理项目文件。完整的后续说明保留在回复正文。";
    render(<TurnThread turns={[turn({ output, trace: [tool, { activityId: "thought-1", kind: "thought", status: "running", text: "正在整理项目文件。" }] })]} />);
    expect(document.querySelector(".owb-activity-trace__item.is-thought")).toBeNull();
    expect(screen.getByText(output)).toBeVisible();
    expect(screen.getByText("查找文件")).toBeVisible();
  });

  it("preserves separate public progress notes that are not included in the answer", () => {
    const narration: TurnTraceActivity = { activityId: "thought-1", kind: "thought", status: "completed", text: "先检查目录。" };
    expect(visibleTrail([narration, tool], "检查完成。")).toEqual([narration, tool]);
  });

  it("retains known parameters when the completion event has none", () => {
    const completed = putTrailItem([tool], { ...tool, detail: undefined, status: "completed" });
    expect(completed).toHaveLength(1);
    expect(completed[0]?.detail).toBe(tool.detail);
    expect(completed[0]?.status).toBe("completed");
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Markdown, markdownHeadings, markdownToPlainText, safeMarkdownUrl } from "../src/markdown/Markdown";

describe("shared Markdown reading contract", () => {
  it("renders the reported CJK emphasis safely while preserving escaped and code source", () => {
    const raw = "一个**仓库负责人（Repo Owner） **角色\n\n一个**仓库负责人（Repo Owner）**角色\n\n`**代码内容 **`\n\n\\*\\*转义内容 \\*\\*\n\n```md\n**代码内容 **\n```";
    const { container } = render(<Markdown content={raw} />);
    expect([...container.querySelectorAll("strong")].map(node => node.textContent)).toEqual(["仓库负责人（Repo Owner）", "仓库负责人（Repo Owner）"]);
    expect(container.querySelector("pre code")).toHaveTextContent("**代码内容 **");
    expect(container.textContent).toContain("**转义内容 **");
    expect(markdownToPlainText(raw)).toContain("一个仓库负责人（Repo Owner）角色");
    expect(markdownToPlainText(raw)).toContain("**代码内容 **");
  });
  it("renders GFM tables and read-only task lists, nested lists, headings and quotes", () => {
    const { container } = render(<Markdown headingPrefix="rw-heading" content={"# Title\n\n> Quote\n\n- [x] finished\n- [ ] pending\n  - nested\n\n| a | b |\n|---|---|\n| one | two |"} />);
    expect(screen.getByRole("heading", { name: "Title" })).toHaveAttribute("id", "rw-heading-1");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox").every(input => input.hasAttribute("disabled"))).toBe(true);
    expect(container.querySelector("blockquote")).toHaveTextContent("Quote");
    expect(markdownHeadings("# One\n\n## Two\n\n# One")).toEqual([{ id: "rw-heading-1", text: "One", level: 1 }, { id: "rw-heading-2", text: "Two", level: 2 }, { id: "rw-heading-3", text: "One", level: 1 }]);
  });
  it("copies code exactly and reports unavailable clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Markdown content={'```js\nconst example = "**raw **";\n```'} />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const example = "**raw **";'));
    expect(screen.getByText("已复制")).toBeInTheDocument();
    writeText.mockRejectedValueOnce(new Error("unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(screen.getByText("复制失败")).toBeInTheDocument());
  });
  it("renders safe deterministic icons before final-answer links without remote favicon requests", () => {
    const { container } = render(<Markdown content={'[GitHub](https://github.com/bytefolk/roleweave) [Docs](https://docs.google.com/document/d/1) [Site](https://example.com) [Mail](mailto:team@example.com) [Section](#rw-heading-1)'} />);
    expect(screen.getByRole("link", { name: "GitHub" }).querySelector('[data-link-icon="github"]')).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Docs" }).querySelector('[data-link-icon="document"]')).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Site" }).querySelector('[data-link-icon="website"]')).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Mail" }).querySelector('[data-link-icon="mail"]')).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Section" }).querySelector('[data-link-icon]')).toBeNull();
    expect(container.querySelectorAll('.owb-markdown-link__icon img')).toHaveLength(0);
  });
  it("blocks dangerous protocols, local paths, raw HTML and authenticated URLs", () => {
    const { container } = render(<Markdown content={'[bad](javascript:alert%281%29)\n\n[local](file:///etc/passwd)\n\n[good](https://example.com)\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>'} />);
    expect(screen.queryByRole("link", { name: "bad" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "local" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "good" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(container.querySelector("script,img")).toBeNull();
    expect(safeMarkdownUrl("https://user:secret@example.com")).toBe("");
    expect(safeMarkdownUrl("data:text/html,hi")).toBe("");
    expect(safeMarkdownUrl("#rw-heading-1")).toBe("#rw-heading-1");
  });
  it("recovers when an image fails and reparses a finished streaming block independently", () => {
    const { rerender, container } = render(<Markdown content={'![diagram](https://example.com/a.png)\n\n```js\nconst value = 1;'} />);
    fireEvent.error(screen.getByRole("img", { name: "diagram" }));
    expect(screen.getByText("图片加载失败 · diagram")).toBeInTheDocument();
    rerender(<Markdown content={'```js\nconst value = 1;\n```\n\n**Finished**'} />);
    expect(container.querySelector("strong")).toHaveTextContent("Finished");
    expect(container.querySelector("pre")).not.toHaveTextContent("Finished");
  });
});

it("isolates heading anchors between simultaneous messages", () => {
  render(<><Markdown content="# One" /><Markdown content="# Two" /></>);
  const headings = screen.getAllByRole("heading");
  expect(headings[0]!.id).not.toBe(headings[1]!.id);
});

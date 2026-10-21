import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Markdown, markdownHeadings, markdownToPlainText, safeMarkdownUrl } from "../src/markdown/Markdown";

describe("shared Markdown reading contract", () => {
  it("links bare and inline-code URLs without swallowing Chinese punctuation or indexing URL paths as files", () => {
    const navigate = vi.fn();
    const { container } = render(<Markdown conversation onNavigateDoc={navigate} content={"参考 https://example.com/a.ts。然后访问 www.example.org，查看说明。\n\n`https://github.com/bytefolk/roleweave` 和 `https://example.com/a.ts`\n\n```sh\ncurl https://example.com/a.ts\n```"} />);
    const links = screen.getAllByRole("link");
    expect(links.map(link => link.getAttribute("href"))).toEqual([
      "https://example.com/a.ts", "https://www.example.org", "https://github.com/bytefolk/roleweave", "https://example.com/a.ts",
    ]);
    expect(links[0]).toHaveTextContent("https://example.com/a.ts");
    expect(links[1]).toHaveTextContent("www.example.org");
    expect(links[3]?.querySelector("code")).toHaveTextContent("https://example.com/a.ts");
    expect(container).toHaveTextContent("。然后访问");
    expect(container).toHaveTextContent("，查看说明。");
    expect(container.querySelector("pre a")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens actual link destinations through the desktop bridge and reports failures", async () => {
    const original = window.owb;
    const openExternalUrl = vi.fn().mockResolvedValue({ ok: true });
    window.owb = { openExternalUrl } as unknown as typeof window.owb;
    try {
      render(<Markdown content="[文档](https://example.com/docs?q=1#install) `https://example.com/status`" />);
      expect(fireEvent.click(screen.getByRole("link", { name: "文档" }))).toBe(false);
      await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/docs?q=1#install"));
      openExternalUrl.mockResolvedValueOnce({ ok: false });
      fireEvent.click(screen.getByRole("link", { name: "https://example.com/status" }));
      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
      openExternalUrl.mockRejectedValueOnce(new Error("offline"));
      fireEvent.click(screen.getByRole("link", { name: "文档" }));
      await waitFor(() => expect(openExternalUrl).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("link", { name: "文档" }));
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    } finally { window.owb = original; }
  });

  it("keeps browser fallback links accessible and avoids inert internal links when navigation is unavailable", () => {
    const original = window.owb;
    window.owb = undefined as unknown as typeof window.owb;
    try {
      render(<Markdown content="https://example.com [文档](docs/guide.md) [[Roadmap]] `apps/main.ts`" />);
      expect(screen.getAllByRole("link")).toHaveLength(1);
      expect(screen.getByRole("link")).toHaveAttribute("target", "_blank");
      expect(screen.getByText("文档")).toBeInTheDocument();
      expect(screen.getByText("Roadmap")).toBeInTheDocument();
      expect(screen.getByText("apps/main.ts").tagName).toBe("CODE");
    } finally { window.owb = original; }
  });

  it("retains balanced URL parentheses, query strings and explicit destinations containing Chinese punctuation", () => {
    render(<Markdown content="https://example.com/a(b)?one=1&two=2#part。 [原链接](https://example.com/中文，目录)" />);
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", "https://example.com/a(b)?one=1&two=2#part");
    expect(decodeURI(links[1]!.getAttribute("href")!)).toBe("https://example.com/中文，目录");
  });

  it("preserves terse reply lines and emphasizes field labels without rewriting document prose or code", () => {
    const raw = "岗位：Codex 产品研发\n汇报对象：Claude\n状态：**连接正常**\n\n```txt\n状态：原样复制\n```";
    const { container, rerender } = render(<Markdown conversation content={raw} />);
    expect([...container.querySelectorAll("strong")].map(node => node.textContent)).toEqual(["岗位：", "汇报对象：", "状态：", "连接正常"]);
    expect(container.querySelectorAll("br")).toHaveLength(2);
    expect(container.querySelector("pre strong")).toBeNull();
    rerender(<Markdown content={raw} />);
    expect(container.querySelectorAll("br")).toHaveLength(0);
    expect(container.querySelectorAll("strong")).toHaveLength(1);
  });
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

  it("resets code-copy feedback when streaming changes the code and copies the latest contents", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { rerender } = render(<Markdown content={"```js\nconst value = 1;\n```"} />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(screen.getByText("已复制")).toBeInTheDocument());
    rerender(<Markdown content={"```js\nconst value = 2;\n```"} />);
    expect(screen.queryByText("已复制")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("const value = 2;"));
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
  it("routes wikilinks and safe relative Markdown links as accessible note targets", () => {
    const navigate = vi.fn();
    const { container } = render(
      <Markdown
        content={"[[Roadmap|Road map]] [Sibling](./sibling.md) [Escape](../../SKILL.md)"}
        onNavigateDoc={navigate}
      />,
    );

    const wiki = screen.getByRole("link", { name: "文档链接：Road map" });
    const relative = screen.getByRole("link", { name: "文档链接：Sibling" });
    expect(wiki.querySelector('[data-link-icon="markdown"]')).toBeInTheDocument();
    expect(relative.querySelector('[data-link-icon="markdown"]')).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Escape/ })).not.toBeInTheDocument();
    expect(container.textContent).toContain("Escape");

    expect(fireEvent.click(wiki)).toBe(false);
    expect(fireEvent.click(relative)).toBe(false);
    expect(navigate).toHaveBeenNthCalledWith(1, "Roadmap", "wikilink");
    expect(navigate).toHaveBeenNthCalledWith(2, "./sibling.md", "relative");
  });

  it("indexes bare and inline-code workspace file paths as typed icon links", () => {
    const navigate = vi.fn();
    render(<Markdown content="已更新 apps/desktop/renderer/src/App.tsx、`packages/ui/src/locales/zh.ts` 和 docs/guide.md。" onNavigateDoc={navigate} />);
    const code = screen.getByRole("link", { name: "文档链接：apps/desktop/renderer/src/App.tsx" });
    const inlineCode = screen.getByRole("link", { name: "文档链接：packages/ui/src/locales/zh.ts" });
    const markdown = screen.getByRole("link", { name: "文档链接：docs/guide.md" });
    expect(code.querySelector('[data-link-icon="code"]')).toBeInTheDocument();
    expect(inlineCode.querySelector('[data-link-icon="code"]')).toBeInTheDocument();
    expect(markdown.querySelector('[data-link-icon="markdown"]')).toBeInTheDocument();
    fireEvent.click(code);
    expect(navigate).toHaveBeenCalledWith("apps/desktop/renderer/src/App.tsx", "relative");
  });

  it("blocks dangerous protocols, local paths, raw HTML and authenticated URLs", () => {
    const { container } = render(<Markdown content={'[bad](javascript:alert%281%29)\n\n[local](file:///etc/passwd)\n\n[good](https://example.com)\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>'} />);
    expect(screen.queryByRole("link", { name: "bad" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "local" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "good" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(container.querySelector("script,img")).toBeNull();
    expect(safeMarkdownUrl("https://user:secret@example.com")).toBe("");
    expect(safeMarkdownUrl("data:text/html,hi")).toBe("");
    expect(safeMarkdownUrl("javascript:bad.ts")).toBe("");
    expect(safeMarkdownUrl("file:secret.md")).toBe("");
    expect(safeMarkdownUrl("https://user:secret@example.com/a.ts")).toBe("");
    expect(safeMarkdownUrl("https://example.com/\nfile.ts")).toBe("");
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

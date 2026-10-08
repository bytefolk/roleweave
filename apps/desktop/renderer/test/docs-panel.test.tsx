import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OwbI18nProvider } from "@roleweave/ui";
import { DocsPanel } from "../src/docs/DocsPanel";
import type { DocsFileListResponse, DocsFileResponse } from "@roleweave/shared";

const LIST: DocsFileListResponse = {
  schemaVersion: "docs-file-list.v1",
  positionId: "repo-owner",
  files: [
    { path: "SKILL.md", kind: "file", size: 42, modifiedAt: "2026-08-27T00:00:00.000Z" },
    { path: "knowledge/README.md", kind: "file", size: 7, modifiedAt: "2026-08-27T00:00:01.000Z" },
  ],
};

const DOC: DocsFileResponse = {
  schemaVersion: "docs-file.v1",
  positionId: "repo-owner",
  path: "SKILL.md",
  content: "---\nname: repo-owner\n---\n\n# Repo Owner\n\nOwns the repository.",
  version: "2026-08-27T00:00:00.000Z",
  size: 42,
  modifiedAt: "2026-08-27T00:00:00.000Z",
};

describe("DocsPanel (#35 S2 file routing surface)", () => {
  it.each([
    { locale: "zh-CN" as const, tree: "文档目录", location: "文件位置：schemas/input.schema.json" },
    { locale: "en" as const, tree: "Document explorer", location: "File location: schemas/input.schema.json" },
  ])("shows actual directories, complete filenames and locations in $locale", async ({ locale, tree, location }) => {
    const schemaPath = "schemas/input.schema.json";
    const list = { ...LIST, files: [...LIST.files,
      { ...LIST.files[0]!, path: schemaPath, size: 19 },
      { ...LIST.files[0]!, path: "attachments/reference.txt" },
    ] };
    const readDoc = vi.fn().mockResolvedValue({ ...DOC, path: schemaPath });
    render(<OwbI18nProvider locale={locale}><DocsPanel positionId="repo-owner" listDocs={vi.fn().mockResolvedValue(list)} readDoc={readDoc} /></OwbI18nProvider>);
    const knowledgeFile = await screen.findByRole("button", { name: "knowledge/README.md" });
    expect(screen.getByRole("tree", { name: tree })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "knowledge", exact: true })).toHaveAttribute("aria-expanded", "true");
    expect(within(knowledgeFile).getByText("README.md")).toBeInTheDocument();
    expect(knowledgeFile.querySelector(".owb-docs-panel__file-parent")).toBeNull();
    expect(screen.getByRole("button", { name: "SKILL.md" }).querySelector(".owb-docs-panel__file-parent")).toBeNull();
    expect(screen.getByRole("treeitem", { name: "attachments", exact: true })).toHaveAttribute("aria-expanded", "true");
    const schemaFile = screen.getByRole("button", { name: schemaPath });
    expect(within(schemaFile).getByText("input.schema.json")).toBeInTheDocument();
    expect(schemaFile.querySelector(".owb-docs-panel__file-parent")).toBeNull();
    act(() => schemaFile.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(location);
    fireEvent.click(schemaFile);
    await waitFor(() => expect(readDoc).toHaveBeenCalledWith("repo-owner", schemaPath));
  });

  it("preserves the original directory and archive location when reading archived files", async () => {
    const listDocs = vi.fn().mockResolvedValueOnce(LIST).mockResolvedValue({ ...LIST, files: [LIST.files[1]] });
    const readDoc = vi.fn().mockResolvedValue({ ...DOC, path: "knowledge/README.md" });
    render(<DocsPanel positionId="repo-owner" listDocs={listDocs} readDoc={readDoc} restoreDoc={vi.fn()} />);
    await screen.findByRole("button", { name: "knowledge/README.md" });
    fireEvent.click(screen.getByText("归档"));
    await waitFor(() => expect(listDocs).toHaveBeenLastCalledWith("repo-owner", { archived: true }));
    const archivedFile = await screen.findByRole("button", { name: "knowledge/README.md" });
    expect(screen.getByRole("treeitem", { name: "knowledge", exact: true })).toBeInTheDocument();
    expect(archivedFile.querySelector(".owb-docs-panel__file-parent")).toBeNull();
    act(() => archivedFile.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("归档位置：knowledge/README.md");
    fireEvent.click(archivedFile);
    await waitFor(() => expect(readDoc).toHaveBeenCalledWith("repo-owner", "knowledge/README.md", { archived: true }));
  });

  it("temporarily reveals search matches and preserves collapsed folders through clearing and list refresh", async () => {
    const listDocs = vi.fn().mockResolvedValue(LIST);
    const props = { positionId: "repo-owner", listDocs, readDoc: vi.fn().mockResolvedValue(DOC) };
    const view = render(<DocsPanel {...props} />);
    await screen.findByRole("button", { name: "knowledge/README.md" });
    fireEvent.click(screen.getByRole("button", { name: "knowledge", exact: true }));
    expect(screen.queryByRole("button", { name: "knowledge/README.md" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索文件" }), { target: { value: "README" } });
    expect(await screen.findByRole("button", { name: "knowledge/README.md" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "SKILL.md" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索文件" }), { target: { value: "" } });
    expect(screen.queryByRole("button", { name: "knowledge/README.md" })).toBeNull();
    view.rerender(<DocsPanel {...props} reloadToken={1} />);
    await waitFor(() => expect(listDocs).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("treeitem", { name: "knowledge", exact: true })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "knowledge", exact: true }));
    expect(screen.getByRole("button", { name: "knowledge/README.md" })).toBeInTheDocument();
  });

  it("navigates nested folders with arrows and opens the exact file and its keyboard context menu", async () => {
    const nestedPath = "knowledge/guides/README.md";
    const listDocs = vi.fn().mockResolvedValue({ ...LIST, files: [...LIST.files, { ...LIST.files[0]!, path: nestedPath }] });
    const readDoc = vi.fn().mockResolvedValue({ ...DOC, path: nestedPath });
    render(<DocsPanel positionId="repo-owner" listDocs={listDocs} readDoc={readDoc} />);
    const knowledge = await screen.findByRole("treeitem", { name: "knowledge", exact: true });
    act(() => knowledge.focus());
    fireEvent.keyDown(knowledge, { key: "ArrowRight" });
    const guides = screen.getByRole("treeitem", { name: "knowledge/guides", exact: true });
    expect(document.activeElement).toBe(guides);
    fireEvent.keyDown(guides, { key: "ArrowRight" });
    const file = screen.getByRole("treeitem", { name: nestedPath, exact: true });
    expect(document.activeElement).toBe(file);
    expect(file).toHaveAttribute("tabindex", "0");
    expect(knowledge).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(file, { key: "Enter" });
    await waitFor(() => expect(readDoc).toHaveBeenCalledWith("repo-owner", nestedPath));
    fireEvent.keyDown(file, { key: "F10", shiftKey: true });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "复制引用" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape", keyCode: 27 });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.keyDown(screen.getByRole("button", { name: nestedPath }), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(guides);
    fireEvent.keyDown(guides, { key: "ArrowLeft" });
    expect(guides).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: nestedPath })).toBeNull();
    fireEvent.keyDown(guides, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "SKILL.md", exact: true }));
  });

  it("suppresses the more-actions tooltip while its menu is open", async () => {
    render(<DocsPanel positionId="repo-owner" listDocs={vi.fn().mockResolvedValue(LIST)} readDoc={vi.fn().mockResolvedValue(DOC)} />);
    fireEvent.click(await screen.findByRole("button", { name: "SKILL.md" }));
    const moreActions = await screen.findByRole("button", { name: "更多文档操作" });
    act(() => moreActions.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("更多文档操作");
    fireEvent.click(moreActions);
    await screen.findByRole("menu");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    fireEvent.keyDown(window, { key: "Escape", keyCode: 27 });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(moreActions);
  });

  it.each([
    { key: "F10", shiftKey: true },
    { key: "ContextMenu" },
  ])("opens a file context menu from $key and returns focus after Escape", async (keyboardEvent) => {
    render(<DocsPanel positionId="repo-owner" listDocs={vi.fn().mockResolvedValue(LIST)} readDoc={vi.fn()} />);
    const file = await screen.findByRole("button", { name: "knowledge/README.md" });
    act(() => file.focus());
    fireEvent.keyDown(file, keyboardEvent);
    const menu = await screen.findByRole("menu");
    const copyReference = within(menu).getByRole("menuitem", { name: "复制引用" });
    act(() => copyReference.focus());
    expect(document.activeElement).toBe(copyReference);
    // Menu items may consume Escape before the dropdown's bubbling handler.
    copyReference.addEventListener("keydown", (event) => event.stopPropagation(), { once: true });
    fireEvent.keyDown(copyReference, { key: "Escape", keyCode: 27 });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(file);
    expect(file).toHaveAttribute("aria-expanded", "false");
  });

  it("asks for a position before routing anything", () => {
    const listDocs = vi.fn();
    render(<DocsPanel positionId={null} listDocs={listDocs} readDoc={vi.fn()} />);
    expect(screen.getByText("先从组织树选择岗位")).toBeTruthy();
    expect(listDocs).not.toHaveBeenCalled();
  });

  it("lists position documents and routes the selected file into the DocViewer with its file-level version", async () => {
    const listDocs = vi.fn().mockResolvedValue(LIST);
    const version = "2026-08-27T00:05:00.000Z";
    const readDoc = vi.fn().mockResolvedValue({ ...DOC, version });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<DocsPanel positionId="repo-owner" listDocs={listDocs} readDoc={readDoc} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "SKILL.md" })).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "knowledge/README.md" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "SKILL.md" }));
    await waitFor(() => {
      expect(readDoc).toHaveBeenCalledWith("repo-owner", "SKILL.md");
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Repo Owner" })).toBeTruthy();
    });
    expect(document.querySelector(".owb-docs-panel__list-pane")).toBeTruthy();
    expect(document.querySelector(".owb-docs-panel__reader-pane")).toBeTruthy();
    expect(screen.getByText("Owns the repository.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更多文档操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制引用" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify({ uri: "owb-doc://repo-owner/SKILL.md", version })));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "更多文档操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "快捷键" }));
    const shortcutsDialog = await screen.findByRole("dialog", { name: "快捷键" });
    expect(within(shortcutsDialog).getByText("加粗")).toBeTruthy();
    expect(within(shortcutsDialog).getByText("链接")).toBeTruthy();
    expect(shortcutsDialog.querySelectorAll("tbody tr")).toHaveLength(18);
    fireEvent.click(shortcutsDialog.querySelector(".ant-modal-close")!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "快捷键" })).toBeNull());
  });

  it("shows an honest empty state and never invents documents", async () => {
    const listDocs = vi.fn().mockResolvedValue({ ...LIST, files: [] });
    render(<DocsPanel positionId="repo-owner" listDocs={listDocs} readDoc={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("该岗位暂无文档")).toBeTruthy();
    });
  });

  it("surfaces read failures instead of retrying or hiding them", async () => {
    const listDocs = vi.fn().mockResolvedValue(LIST);
    const readDoc = vi.fn().mockRejectedValue(new Error("读取失败（403 · docs_forbidden）"));
    render(<DocsPanel positionId="repo-owner" listDocs={listDocs} readDoc={readDoc} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "SKILL.md" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "SKILL.md" }));
    await waitFor(() => {
      expect(screen.getByText("读取失败（403 · docs_forbidden）")).toBeTruthy();
    });
    expect(readDoc).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "Repo Owner" })).toBeNull();
  });
});

describe("Document reader integrity (#294)", () => {
  it("discards stale reads, keeps per-file scroll and list state through refresh", async () => {
    let finishOld!: (doc: DocsFileResponse) => void;
    const old = new Promise<DocsFileResponse>((resolve) => { finishOld = resolve; });
    const second = { ...DOC, path: "knowledge/README.md", content: "# Second document" };
    const readDoc = vi.fn().mockReturnValueOnce(old).mockResolvedValue(second);
    const listDocs = vi.fn().mockResolvedValue(LIST);
    const { rerender } = render(<DocsPanel positionId="repo-owner" listDocs={listDocs} readDoc={readDoc} />);
    fireEvent.click(await screen.findByRole("button", { name: "SKILL.md" }));
    fireEvent.click(screen.getByRole("button", { name: "knowledge/README.md" }));
    await screen.findByRole("heading", { name: "Second document" });
    await act(async () => finishOld(DOC));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Repo Owner" })).not.toBeInTheDocument());
    const reader = screen.getByLabelText("文档阅读区");
    reader.scrollTop = 320;
    fireEvent.scroll(reader);
    readDoc.mockResolvedValueOnce(DOC);
    fireEvent.click(screen.getByRole("button", { name: "SKILL.md" }));
    await screen.findByRole("heading", { name: "Repo Owner" });
    readDoc.mockResolvedValueOnce(second);
    fireEvent.click(screen.getByRole("button", { name: "knowledge/README.md" }));
    await screen.findByRole("heading", { name: "Second document" });
    expect(reader.scrollTop).toBe(320);
    rerender(<DocsPanel positionId="repo-owner" listDocs={listDocs} readDoc={readDoc} reloadToken={1} />);
    await waitFor(() => expect(listDocs).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "Second document" })).toBeInTheDocument();
    expect(reader.scrollTop).toBe(320);
  });

  it("rejects old employee reads and retries the failed new employee list", async () => {
    let finish!: (doc: DocsFileResponse) => void;
    const readDoc = vi.fn().mockReturnValue(new Promise<DocsFileResponse>((resolve) => { finish = resolve; }));
    const listDocs = vi.fn().mockResolvedValueOnce(LIST).mockRejectedValueOnce(new Error("Forbidden")).mockResolvedValue(LIST);
    const view = render(<DocsPanel positionId="repo-owner" listDocs={listDocs} readDoc={readDoc} />);
    fireEvent.click(await screen.findByRole("button", { name: "SKILL.md" }));
    view.rerender(<DocsPanel positionId="second-owner" listDocs={listDocs} readDoc={readDoc} />);
    await screen.findByText("Forbidden");
    await act(async () => finish(DOC));
    expect(screen.queryByRole("heading", { name: "Repo Owner" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重\s?试/ }));
    await screen.findByRole("button", { name: "SKILL.md" });
    expect(listDocs).toHaveBeenLastCalledWith("second-owner");
  });

  it("separates search-empty from no documents and retries failed reads on request", async () => {
    const listDocs = vi.fn().mockResolvedValue(LIST);
    const readDoc = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(DOC);
    render(<DocsPanel positionId="repo-owner" listDocs={listDocs} readDoc={readDoc} />);
    fireEvent.click(await screen.findByRole("button", { name: "SKILL.md" }));
    await screen.findByText("offline");
    fireEvent.click(screen.getByRole("button", { name: /重\s?试/ }));
    await screen.findByRole("heading", { name: "Repo Owner" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "not-found" } });
    expect(screen.getByText("未找到包含“not-found”的文档")).toBeInTheDocument();
    expect(screen.queryByText("该岗位暂无文档")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("button", { name: "SKILL.md" })).toBeInTheDocument();
  });
});

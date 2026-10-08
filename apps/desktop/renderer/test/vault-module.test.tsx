import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { MemoryModule } from "../src/memory/MemoryModule";
import { VaultModule } from "../src/memory/VaultModule";
import { Markdown } from "../src/markdown/Markdown";
import { TurnNoteAction } from "../src/turns/TurnNoteAction";
import type { VaultNote } from "@roleweave/shared";
import { pickSelectOption } from "./select-helper";

const luteScript = document.createElement("script");
const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
const originalInnerText = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText");
beforeAll(() => {
  createRequire(import.meta.url)("vditor/dist/js/lute/lute.min.js");
  window.Lute = (globalThis as unknown as { Lute: typeof window.Lute }).Lute;
  luteScript.id = "vditorLuteScript"; document.head.appendChild(luteScript);
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
  if (!originalInnerText) Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true, get() { return this.textContent ?? ""; }, set(value: string) { this.textContent = value; },
  });
});
afterAll(() => {
  luteScript.remove(); if (!originalInnerText) Reflect.deleteProperty(HTMLElement.prototype, "innerText");
  if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
  else Reflect.deleteProperty(document, "execCommand");
});

const note: VaultNote = { noteId: "note-a", path: "项目约定.md", title: "项目约定", size: 50, version: "sha256:abc",
  modifiedAt: "2026-10-07T12:00:00Z", archived: false, readOnly: false, positionIds: [], ref: { uri: "vault://notes/note-a", version: "sha256:abc" } };
const noteBody = (entry = note, content = "# 项目约定\n使用中文标题。") => ({ schemaVersion: "vault-note.v1", note: entry, content });
const response = <T,>(body: T, status = 200) => ({ status, body });
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
let vault: Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  vault = {
    list: vi.fn().mockResolvedValue(response({ schemaVersion: "vault-list.v1", notes: [note] })),
    source: vi.fn().mockResolvedValue(response({ vaultId: "fixture-vault", title: "笔记库" })),
    read: vi.fn().mockResolvedValue(response(noteBody())),
    create: vi.fn().mockImplementation(async (request) => response(noteBody({ ...note, path: request.path, title: request.path.replace(/\.md$/, "") }, request.content), 201)),
    write: vi.fn().mockImplementation(async (request) => response(noteBody({ ...note, version: "sha256:def" }, request.content))),
    rename: vi.fn(), archive: vi.fn(), restore: vi.fn(), delete: vi.fn(),
    bindings: vi.fn().mockResolvedValue(response({ bindings: [{ positionId: "employee-a", noteIds: ["note-a"] }] })),
    bind: vi.fn().mockResolvedValue(response({ bindings: [] })),
    resolve: vi.fn().mockResolvedValue(response(noteBody())),
    image: vi.fn().mockResolvedValue(response({ preview: { path: "assets/图.png", mime: "image/png", dataUrl: pixel } })),
    attach: vi.fn().mockResolvedValue(response({ path: "assets/图.png", mime: "image/png", name: "图.png" })),
    targets: vi.fn().mockResolvedValue(response({ vaults: [] })),
    sync: vi.fn().mockResolvedValue(response({ status: "synced", pushed: 1, pulled: 0, conflicts: [] })),
    fromTurn: vi.fn().mockResolvedValue(response(noteBody(), 201)),
    history: vi.fn().mockResolvedValue(response({ versions: [{ version: "sha256:old", path: "项目约定.md", createdAt: "2026-10-06T12:00:00Z", content: "# 历史内容\n保留的旧版本。" }] })),
  };
  Object.defineProperty(window, "owb", { configurable: true, value: { vault, drive: {
    list: vi.fn().mockResolvedValue(response({ schemaVersion: "drive-object-list.v1", objects: [], mocked: false })), detail: vi.fn(),
  } } });
});

describe("统一笔记库", () => {
  it.each(["notes", "docs", "shared", "sessions"] as const)("routes %s to the same notes surface with only two navigation choices", async (initialSource) => {
    render(<MemoryModule workspaceOpen workspaceKey="workspace-a" positions={[]} selectedPositionId={null} initialSource={initialSource} />);
    const navigation = screen.getByRole("navigation", { name: "笔记库导航" });
    expect(within(navigation).getAllByRole("button")).toHaveLength(2);
    expect(within(navigation).getByRole("button", { name: "笔记" })).toHaveAttribute("aria-pressed", "true");
    expect(within(navigation).getByRole("button", { name: "网盘" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "项目约定" })).toBeVisible();
  });
  it("creates an independent Unicode note without selecting an employee", async () => {
    render(<VaultModule workspaceKey="new-workspace" positions={[]} selectedPositionId={null} />);
    await screen.findByRole("heading", { name: "项目约定" });
    vault.read.mockResolvedValue(response(noteBody({ ...note, path: "项目资料/中文 笔记.md" }, "# 中文标题\n共同约定。")));
    fireEvent.click(await screen.findByRole("button", { name: "新建笔记" }));
    fireEvent.change(screen.getByRole("textbox", { name: "笔记名称" }), { target: { value: "项目资料/中文 笔记" } });
    fireEvent.change(screen.getByRole("textbox", { name: "文档内容" }), { target: { value: "# 中文标题\n共同约定。" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /创.*建/ }));
    await waitFor(() => expect(vault.create).toHaveBeenCalledWith({ path: "项目资料/中文 笔记.md", content: "# 中文标题\n共同约定。" }));
    expect(await screen.findByRole("heading", { name: "中文标题" })).toBeVisible();
  });
  it("uses server full-text search without filtering matching notes by file name", async () => {
    render(<VaultModule workspaceKey="search-workspace" positions={[]} selectedPositionId={null} />);
    await screen.findByRole("heading", { name: "项目约定" });
    fireEvent.change(screen.getByRole("textbox", { name: "搜索笔记正文" }), { target: { value: "正文关键字" } });
    await waitFor(() => expect(vault.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "正文关键字" })));
    expect(screen.getByRole("treeitem", { name: "项目约定.md" })).toBeVisible();
  });
  it("keeps legacy materials read-only without moving them", async () => {
    const legacy = { ...note, path: "positions/employee-a/knowledge/旧资料.md", readOnly: true, legacy: { positionId: "employee-a", path: "knowledge/旧资料.md" } };
    vault.list.mockResolvedValue(response({ notes: [legacy] })); vault.read.mockResolvedValue(response(noteBody(legacy, "# 旧资料\n原始内容。")));
    render(<VaultModule workspaceKey="legacy-workspace" positions={[]} selectedPositionId={null} />);
    expect(await screen.findByRole("heading", { name: "旧资料" })).toBeVisible();
    expect(screen.getByRole("status", { name: "旧资料 · 只读" })).toBeVisible();
    expect(vault.write).not.toHaveBeenCalled();
    expect(vault.rename).not.toHaveBeenCalled();
  });
  it("loads a local attachment as safe pixels without changing its relative Markdown source", async () => {
    const content = "# 图片笔记\n![示意图](assets/图.png)";
    vault.read.mockResolvedValue(response(noteBody(note, content)));
    render(<VaultModule workspaceKey="image-workspace" positions={[]} selectedPositionId={null} />);
    expect(await screen.findByRole("img", { name: "示意图" })).toHaveAttribute("src", pixel);
    expect(vault.image).toHaveBeenCalledWith({ path: "assets/图.png", notePath: "项目约定.md" });
    expect(vault.write).not.toHaveBeenCalled();
  });
  it("chooses multiple notes for an employee while retaining a single library", async () => {
    const second = { ...note, noteId: "note-b", path: "另一篇.md", title: "另一篇" };
    vault.list.mockResolvedValue(response({ notes: [note, second] }));
    render(<VaultModule workspaceKey="binding-workspace" positions={[{ id: "employee-a", name: "员工甲" }]} selectedPositionId="employee-a" />);
    fireEvent.click(await screen.findByRole("button", { name: "员工取用范围" }));
    await waitFor(() => expect(vault.bindings).toHaveBeenCalledWith("employee-a"));
    const save = within(screen.getByRole("dialog")).getByRole("button", { name: /保.*存/ });
    await waitFor(() => expect(save).toBeEnabled());
    pickSelectOption("员工可取用的笔记", "另一篇");
    fireEvent.click(save);
    await waitFor(() => expect(vault.bind).toHaveBeenCalledWith({ positionId: "employee-a", noteIds: ["note-a", "note-b"] }));
    expect(vault.create).not.toHaveBeenCalled();
  });
  it("inserts a drive image into the current note using a portable attachment path", async () => {
    window.owb.drive.list = vi.fn().mockResolvedValue(response({ objects: [{ id: "image-a", name: "图.png", mime: "image/png", size: 80, createdAt: "2026-10-07T12:00:00Z" }] }));
    render(<VaultModule workspaceKey="insert-workspace" positions={[]} selectedPositionId={null} />);
    await screen.findByRole("heading", { name: "项目约定" });
    fireEvent.click(screen.getByRole("button", { name: "插入网盘图片" }));
    await waitFor(() => expect(window.owb.drive.list).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("combobox", { name: "选择图片" })).toBeEnabled());
    pickSelectOption("选择图片", "图.png");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /插.*入/ }));
    await waitFor(() => expect(vault.attach).toHaveBeenCalledWith({ fileId: "image-a" }));
    expect(await screen.findByRole("img", { name: "图.png" })).toHaveAttribute("src", pixel);
    await waitFor(() => expect(vault.write).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("![图.png](<assets/图.png>)") })));
    const request = vault.write.mock.calls.at(-1)![0];
    expect(request.content).not.toContain("data:image");
  });
  it("disables sync while the editor has changes or an unfinished write", async () => {
    let resolveWrite!: (body: ReturnType<typeof response>) => void;
    vault.write.mockImplementation(() => new Promise((resolve) => { resolveWrite = resolve; }));
    render(<VaultModule workspaceKey="dirty-workspace" positions={[]} selectedPositionId={null} />);
    await screen.findByRole("heading", { name: "项目约定" });
    fireEvent.click(screen.getByRole("button", { name: "更多文档操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /源.*码/ }));
    fireEvent.change(await screen.findByRole("textbox", { name: "文档内容" }), { target: { value: "# 修改后的笔记" } });
    expect(screen.getByRole("button", { name: "同步笔记库" })).toBeDisabled();
    await waitFor(() => expect(vault.write).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "同步笔记库" })).toBeDisabled();
    await act(async () => resolveWrite(response(noteBody({ ...note, version: "sha256:next" }, "# 修改后的笔记"))));
    await waitFor(() => expect(screen.getByRole("button", { name: "同步笔记库" })).toBeEnabled());
    expect(vault.sync).not.toHaveBeenCalled();
  });
  it("preserves attachment source paths when live editing nearby text", async () => {
    vault.read.mockResolvedValue(response(noteBody(note, "# 标题\n\n![示意图](assets/图.png)\n")));
    render(<VaultModule workspaceKey="live-image-workspace" positions={[]} selectedPositionId={null} />);
    await screen.findByRole("img", { name: "示意图" });
    fireEvent.click(screen.getByRole("button", { name: "更多文档操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "即时编辑" }));
    const editor = await screen.findByRole("textbox", { name: "文档内容" });
    await waitFor(() => expect(editor.querySelector("h1")).not.toBeNull());
    const heading = editor.querySelector("h1")!; heading.lastChild!.textContent = "更新后的标题";
    editor.focus(); const selection = document.createRange(); selection.selectNodeContents(heading); selection.collapse(false);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(selection);
    fireEvent.input(editor, { inputType: "insertText", data: "更新后的标题" });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    await waitFor(() => expect(vault.write).toHaveBeenCalled());
    expect(vault.write.mock.calls.at(-1)![0].content).toContain("assets/图.png");
    expect(vault.write.mock.calls.at(-1)![0].content).not.toContain("data:image");
    expect(editor.querySelector("img[src]" )).toBeNull();
  });
  it.each(["[[中文笔记|查看指南]]", "[查看指南](../指南/中文笔记.md)"])("navigates a Unicode note link across folders: %s", async (linkSyntax) => {
    const first = { ...note, path: "项目/约定.md" };
    const second = { ...note, noteId: "note-b", path: "指南/中文笔记.md", title: "中文笔记" };
    vault.list.mockResolvedValue(response({ notes: [first, second] }));
    vault.read.mockImplementation(async (id) => response(id === "note-a" ? noteBody(first, `# 初始笔记\n${linkSyntax}`) : noteBody(second, "# 中文指南\n跨文件夹链接。")));
    render(<VaultModule workspaceKey="wiki-workspace" positions={[]} selectedPositionId={null} />);
    await screen.findByRole("link", { name: /查看指南/ });
    const link = screen.getByRole("link", { name: /查看指南/ });
    expect(link).toHaveClass("owb-markdown-link");
    expect(link.closest(".owb-doc-viewer__editor")).toBeNull();
    expect(link).toHaveAttribute("href", expect.stringContaining(linkSyntax.startsWith("[[") ? "owb-wiki:" : "../"));
    expect(link.isConnected).toBe(true);
    expect(fireEvent.click(link)).toBe(false);
    await waitFor(() => expect(vault.read).toHaveBeenLastCalledWith("note-b"));
    expect(await screen.findByRole("heading", { name: "中文指南" })).toBeVisible();
    expect(vault.read).toHaveBeenLastCalledWith("note-b");
    expect(vault.create).not.toHaveBeenCalled();
  });
  it("keeps draft and dirty state isolated when a vault is replaced at the same workspace path", async () => {
    vault.source.mockResolvedValueOnce(response({ vaultId: "vault-a" })).mockResolvedValueOnce(response({ vaultId: "vault-b" }));
    const first = render(<VaultModule workspaceKey="same-workspace" positions={[]} selectedPositionId={null} />);
    await screen.findByRole("heading", { name: "项目约定" });
    fireEvent.click(screen.getByRole("button", { name: "更多文档操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /源.*码/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "文档内容" }), { target: { value: "# A 的未保存内容" } });
    first.unmount();
    render(<VaultModule workspaceKey="same-workspace" positions={[]} selectedPositionId={null} />);
    expect(await screen.findByRole("heading", { name: "项目约定" })).toBeVisible();
    expect(screen.queryByText("A 的未保存内容")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "同步笔记库" })).toBeEnabled();
  });
  it("reports sync conflicts without overwriting or dismissing the local note", async () => {
    vault.sync.mockResolvedValue(response({ status: "conflict", pushed: 1, pulled: 1, conflicts: [{ path: "项目约定.md", copyPath: "项目约定-conflict.md" }] }));
    render(<VaultModule workspaceKey="sync-workspace" positions={[]} selectedPositionId={null} />);
    await screen.findByRole("heading", { name: "项目约定" });
    fireEvent.click(screen.getByRole("button", { name: "同步笔记库" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "同步笔记库" }));
    await waitFor(() => expect(screen.getByText("同步完成，存在需要比较的冲突副本")).toBeVisible());
    expect(screen.getByText("项目约定.md · 冲突副本：项目约定-conflict.md")).toBeVisible();
    expect(vault.write).not.toHaveBeenCalled();
  });
  it("restores selected history through a fresh read and version-checked write", async () => {
    render(<VaultModule workspaceKey="history-workspace" positions={[]} selectedPositionId={null} />);
    await screen.findByRole("heading", { name: "项目约定" });
    fireEvent.click(screen.getByRole("button", { name: "版本历史" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "历史内容" })).toBeVisible());
    vault.read.mockResolvedValue(response(noteBody({ ...note, version: "sha256:latest" }, "最新保存的正文。")));
    vault.write.mockImplementation(async (request) => {
      const result = response(noteBody({ ...note, version: "sha256:restored" }, request.content));
      vault.read.mockResolvedValue(result); return result;
    });
    fireEvent.click(screen.getByRole("button", { name: "恢复此版本" }));
    await waitFor(() => expect(vault.write).toHaveBeenCalledWith({ noteId: "note-a", content: "# 历史内容\n保留的旧版本。", expectedVersion: "sha256:latest" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("heading", { name: "历史内容" })).toBeVisible();
  });
  it("keeps a failed history restoration visible when another writer wins the compare-and-swap", async () => {
    render(<VaultModule workspaceKey="history-conflict-workspace" positions={[]} selectedPositionId={null} />);
    await screen.findByRole("heading", { name: "项目约定" });
    fireEvent.click(screen.getByRole("button", { name: "版本历史" }));
    await screen.findByRole("heading", { name: "历史内容" });
    vault.write.mockResolvedValue(response({ message: "changed elsewhere" }, 409));
    fireEvent.click(screen.getByRole("button", { name: "恢复此版本" }));
    expect(await screen.findByText("笔记已在其他地方更新，请关闭历史窗口并刷新后重试。")).toBeVisible();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复此版本" })).toBeDisabled();
  });
});

it("rejects remote URLs returned by the image resource loader", async () => {
  const loader = vi.fn().mockResolvedValue("https://unsafe.example/picture.png");
  render(<Markdown content="![图](assets/图.png)" imageResourceLoader={loader} />);
  await waitFor(() => expect(screen.getByRole("img", { name: "图" }).tagName).toBe("SPAN"));
  expect(document.querySelector('img[src^="https:"]')).toBeNull();
});

it("opens a vault citation through the note callback without treating it as an external URL", () => {
  const onNavigateDoc = vi.fn();
  render(<Markdown content="[项目约定](vault://notes/note-a)" onNavigateDoc={onNavigateDoc} />);
  fireEvent.click(screen.getByRole("link", { name: /项目约定/ }));
  expect(onNavigateDoc).toHaveBeenCalledWith("vault://notes/note-a", "relative");
});

it("saves an edited turn note through the verified source endpoint and opens that note", async () => {
  const onCreated = vi.fn();
  render(<TurnNoteAction turn={{ id: "turn-123", positionId: "employee-a", positionName: "员工甲", engine: "qoder", input: "项目结论", output: "可复用结论。", status: "completed", createdAt: "2026-10-07T12:00:00Z" }} onCreated={onCreated} />);
  fireEvent.click(screen.getByRole("button", { name: "沉淀为笔记" }));
  fireEvent.change(screen.getByRole("textbox", { name: "笔记名称" }), { target: { value: "确认结论" } });
  fireEvent.change(screen.getByRole("textbox", { name: "文档内容" }), { target: { value: "人工修订的结论。" } });
  fireEvent.click(screen.getByRole("button", { name: "保存笔记" }));
  await waitFor(() => expect(vault.fromTurn).toHaveBeenCalledWith({ positionId: "employee-a", turnId: "turn-123", path: "确认结论.md", content: "人工修订的结论。" }));
  expect(onCreated).toHaveBeenCalledWith("vault://notes/note-a");
});

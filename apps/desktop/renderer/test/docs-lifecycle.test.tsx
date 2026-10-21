import { createRequire } from "node:module";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DocsPanel } from "../src/docs/DocsPanel";
import type { DocsFileListResponse, DocsFileResponse } from "@roleweave/shared";

const luteScript = document.createElement("script");
const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
const originalInnerText = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText");
beforeAll(() => {
  createRequire(import.meta.url)("vditor/dist/js/lute/lute.min.js");
  window.Lute = (globalThis as unknown as { Lute: typeof window.Lute }).Lute;
  luteScript.id = "vditorLuteScript";
  document.head.appendChild(luteScript);
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
  if (!originalInnerText) Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() { return this.textContent ?? ""; },
    set(value: string) { this.textContent = value; },
  });
});
afterAll(() => {
  luteScript.remove();
  if (!originalInnerText) Reflect.deleteProperty(HTMLElement.prototype, "innerText");
  if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
  else Reflect.deleteProperty(document, "execCommand");
});

const LIST: DocsFileListResponse = {
  schemaVersion: "docs-file-list.v1",
  positionId: "repo-owner",
  files: [
    { path: "SKILL.md", kind: "file", size: 42, modifiedAt: "2026-08-27T00:00:00.000Z" },
    { path: "knowledge/README.md", kind: "file", size: 7, modifiedAt: "2026-08-27T00:00:01.000Z" },
  ],
};

const KNOWLEDGE: DocsFileResponse = {
  schemaVersion: "docs-file.v1",
  positionId: "repo-owner",
  path: "knowledge/README.md",
  content: "# Knowledge\n",
  version: "2026-08-27T00:00:01.000Z",
  size: 7,
  modifiedAt: "2026-08-27T00:00:01.000Z",
};

const SKILL: DocsFileResponse = {
  schemaVersion: "docs-file.v1",
  positionId: "repo-owner",
  path: "SKILL.md",
  content: "---\nname: repo-owner\n---\n\n# Repo Owner\n",
  version: "2026-08-27T00:00:00.000Z",
  size: 42,
  modifiedAt: "2026-08-27T00:00:00.000Z",
};

async function documentAction(name: string | RegExp) {
  const trigger = await screen.findByRole("button", { name: "更多文档操作" });
  await waitFor(() => expect(trigger).toBeEnabled());
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

async function sourceEditor(): Promise<HTMLTextAreaElement> {
  await documentAction(/源\s?码/);
  return await screen.findByLabelText("文档内容") as HTMLTextAreaElement;
}

async function readingMode() {
  await documentAction(/阅\s?读/);
}

describe("DocsPanel knowledge lifecycle (#347)", () => {
  it("uses one compact toolbar and supports title and menu rename", async () => {
    const renameDoc = vi.fn().mockResolvedValue({ to: "knowledge/RENAMED.md" });
    const deleteDoc = vi.fn().mockResolvedValue(undefined);
    render(<DocsPanel knowledgeFirst positionId="compact-toolbar" listDocs={vi.fn().mockResolvedValue(LIST)}
      readDoc={vi.fn(async (_id, path) => ({ ...KNOWLEDGE, path }))} writeDoc={vi.fn().mockResolvedValue(KNOWLEDGE)}
      renameDoc={renameDoc} archiveDoc={vi.fn()} deleteDoc={deleteDoc} />);
    await screen.findByRole("textbox", { name: "文档内容" });
    const toolbar = screen.getByRole("toolbar", { name: "文档工具栏" });
    expect(within(toolbar).getAllByRole("button")).toHaveLength(2);
    expect(within(toolbar).getByRole("status", { name: "已保存" })).toBeInTheDocument();
    for (const name of ["源码", "即时编辑", "阅读", "重命名", "归档", "删除", "复制引用"]) {
      expect(within(toolbar).queryByRole("button", { name })).toBeNull();
    }
    fireEvent.click(within(toolbar).getByRole("button", { name: "更多文档操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("新文档文件名")).toHaveValue("README.md");
    fireEvent.click(within(dialog).getByRole("button", { name: /取\s?消/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.doubleClick(within(toolbar).getByRole("button", { name: "README" }));
    fireEvent.change(await screen.findByLabelText("新文档文件名"), { target: { value: "RENAMED.md" } });
    fireEvent.keyDown(screen.getByLabelText("新文档文件名"), { key: "Enter", code: "Enter", keyCode: 13 });
    await waitFor(() => expect(renameDoc).toHaveBeenCalledWith("compact-toolbar", KNOWLEDGE.path, "knowledge/RENAMED.md"));
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it("keeps bound documents read-only and requires confirmation for menu deletion", async () => {
    const deleteDoc = vi.fn().mockResolvedValue(undefined);
    const renameDoc = vi.fn();
    render(<DocsPanel knowledgeFirst positionId="compact-readonly" listDocs={vi.fn().mockResolvedValue(LIST)}
      readDoc={vi.fn(async (_id, path) => path === "SKILL.md" ? SKILL : KNOWLEDGE)}
      writeDoc={vi.fn().mockResolvedValue(KNOWLEDGE)} renameDoc={renameDoc} archiveDoc={vi.fn()} deleteDoc={deleteDoc} />);
    await screen.findByRole("textbox", { name: "文档内容" });
    fireEvent.click(screen.getByRole("button", { name: "更多文档操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("确定永久删除");
    expect(deleteDoc).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /取\s?消/ }));
    fireEvent.click(screen.getByRole("button", { name: "SKILL.md" }));
    await screen.findByRole("heading", { name: "Repo Owner" });
    fireEvent.click(screen.getByRole("button", { name: "更多文档操作" }));
    expect(await screen.findByRole("menuitem", { name: "复制引用" })).toBeInTheDocument();
    for (const name of ["重命名", "归档", "删除", "源码", "即时编辑", "阅读"]) {
      expect(screen.queryByRole("menuitem", { name })).toBeNull();
    }
    expect(renameDoc).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it("shows knowledge file metadata on focus and keeps SKILL.md bound read-only", async () => {
    render(<DocsPanel knowledgeFirst positionId="lifecycle-metadata"
      listDocs={vi.fn().mockResolvedValue(LIST)}
      readDoc={vi.fn(async (_id, path) => path === "SKILL.md" ? SKILL : KNOWLEDGE)}
      writeDoc={vi.fn()} renameDoc={vi.fn()} archiveDoc={vi.fn()} deleteDoc={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "knowledge/README.md" }));
    await screen.findByRole("heading", { name: /Knowledge$/ });
    const fileRow = screen.getByRole("button", { name: "knowledge/README.md" });
    fireEvent.focus(fileRow);
    const fileDetails = await screen.findByRole("tooltip");
    expect(fileDetails).toHaveTextContent("knowledge/README.md");
    expect(fileDetails).toHaveTextContent("Markdown 文档");
    expect(fileDetails).toHaveTextContent("7 字节");
    fireEvent.blur(fileRow);
    expect(screen.getByRole("button", { name: "README", exact: true })).toBeTruthy();
    expect(within(fileRow).getByText("README.md")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "SKILL.md" }));
    await screen.findByRole("heading", { name: "Repo Owner" });
    expect(screen.getByText("绑定期间只读")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /编\s?辑/ })).toBeNull();
  });

  it("autosaves knowledge edits against the read version before renaming the file", async () => {
    const listDocs = vi.fn().mockResolvedValue(LIST);
    const readDoc = vi.fn().mockImplementation((_id: string, path: string) =>
      Promise.resolve(path === "SKILL.md" ? SKILL : KNOWLEDGE),
    );
    const writeDoc = vi.fn().mockResolvedValue({ ...KNOWLEDGE, content: "# Edited\n" });
    const renameDoc = vi.fn().mockResolvedValue({ to: "knowledge/handbook.md" });
    const archiveDoc = vi.fn().mockResolvedValue(undefined);
    const deleteDoc = vi.fn().mockResolvedValue(undefined);

    render(
      <DocsPanel
        knowledgeFirst
        positionId="lifecycle-edit"
        listDocs={listDocs}
        readDoc={readDoc}
        writeDoc={writeDoc}
        renameDoc={renameDoc}
        archiveDoc={archiveDoc}
        deleteDoc={deleteDoc}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "knowledge/README.md" }));
    await screen.findByRole("heading", { name: /Knowledge$/ });
    const editor = await sourceEditor();
    fireEvent.change(editor, { target: { value: "# Edited\n" } });
    await waitFor(() =>
      expect(writeDoc).toHaveBeenCalledWith(
        "lifecycle-edit",
        "knowledge/README.md",
        "# Edited\n",
        "2026-08-27T00:00:01.000Z",
      ),
    );

    await readingMode();
    await documentAction(/重\s?命\s?名/);
    const renameInput = await screen.findByLabelText("新文档文件名");
    fireEvent.change(renameInput, { target: { value: "handbook.md" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /重\s?命\s?名/ }));
    await waitFor(() =>
      expect(renameDoc).toHaveBeenCalledWith("lifecycle-edit", "knowledge/README.md", "knowledge/handbook.md"),
    );
    expect(archiveDoc).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it("deletes a knowledge file only after explicit confirmation", async () => {
    const deleteDoc = vi.fn().mockResolvedValue(undefined);
    render(<DocsPanel knowledgeFirst positionId="lifecycle-delete"
      listDocs={vi.fn().mockResolvedValue(LIST)} readDoc={vi.fn().mockResolvedValue(KNOWLEDGE)}
      writeDoc={vi.fn()} deleteDoc={deleteDoc} />);
    fireEvent.click(await screen.findByRole("button", { name: "knowledge/README.md" }));
    await screen.findByRole("heading", { name: /Knowledge$/ });
    await documentAction(/删\s?除/);
    expect(await screen.findByText(/确定永久删除/)).toBeTruthy();
    expect(deleteDoc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /永久删除/ }));
    await waitFor(() =>
      expect(deleteDoc).toHaveBeenCalledWith("lifecycle-delete", "knowledge/README.md"),
    );
  });

  it("keeps explicit save and cancel for non-Markdown files in the compact menu", async () => {
    const file = { ...KNOWLEDGE, path: "knowledge/config.json", content: '{"enabled":false}' };
    const writeDoc = vi.fn(async (_id: string, _path: string, content: string) => ({ ...file, content, version: "saved-json" }));
    render(<DocsPanel positionId="plain-edit" listDocs={vi.fn().mockResolvedValue({ ...LIST, files: [
      { path: file.path, kind: "file", size: file.size, modifiedAt: file.version },
    ] })} readDoc={vi.fn().mockResolvedValue(file)} writeDoc={writeDoc} />);
    fireEvent.click(await screen.findByRole("button", { name: file.path }));
    await documentAction("编辑");
    fireEvent.change(screen.getByRole("textbox", { name: "文档内容" }), { target: { value: '{"enabled":true}' } });
    expect(writeDoc).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "文档内容" }), { key: "s", ctrlKey: true });
    await waitFor(() => expect(writeDoc).toHaveBeenCalledWith("plain-edit", file.path, '{"enabled":true}', file.version));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "文档内容" })).toBeNull());
    await documentAction("编辑");
    fireEvent.change(screen.getByRole("textbox", { name: "文档内容" }), { target: { value: "discard me" } });
    await documentAction("取消");
    expect(screen.queryByRole("textbox", { name: "文档内容" })).toBeNull();
    expect(screen.getByText('{"enabled":true}')).toBeInTheDocument();
    expect(writeDoc).toHaveBeenCalledTimes(1);
  });

  it("autosaves source edits using the read version", async () => {
    const listDocs = vi.fn().mockResolvedValue(LIST);
    const readDoc = vi.fn().mockResolvedValue(KNOWLEDGE);
    const writeDoc = vi.fn().mockResolvedValue({
      ...KNOWLEDGE,
      content: "# Live note\n",
      version: "2026-08-27T00:00:02.000Z",
    });

    render(
      <DocsPanel
        knowledgeFirst
        positionId="repo-owner"
        listDocs={listDocs}
        readDoc={readDoc}
        writeDoc={writeDoc}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "knowledge/README.md" }));
    const editor = await sourceEditor();
    expect((editor as HTMLTextAreaElement).value).toBe("# Knowledge\n");
    expect(screen.getByRole("status", { name: "已保存" })).toBeTruthy();

    fireEvent.change(editor, { target: { value: "# Live note\n" } });
    expect(screen.getByRole("status", { name: "未保存" })).toBeTruthy();
    expect(writeDoc).not.toHaveBeenCalled();

    await waitFor(
      () =>
        expect(writeDoc).toHaveBeenCalledWith(
          "repo-owner",
          "knowledge/README.md",
          "# Live note\n",
          "2026-08-27T00:00:01.000Z",
        ),
      { timeout: 2_000 },
    );
    expect(screen.getByRole("status", { name: "已保存" })).toBeTruthy();
  });

  it("autosaves edits made directly inside a rendered heading", async () => {
    const writeDoc = vi.fn().mockResolvedValue({
      ...KNOWLEDGE,
      content: "# Live heading\n",
      version: "2026-08-27T00:00:02.000Z",
    });
    render(
      <DocsPanel
        knowledgeFirst
        positionId="inline-autosave"
        listDocs={vi.fn().mockResolvedValue(LIST)}
        readDoc={vi.fn().mockResolvedValue(KNOWLEDGE)}
        writeDoc={writeDoc}
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "文档内容" });
    const heading = within(editor).getByRole("heading", { name: /Knowledge$/ });
    heading.lastChild!.textContent = "Live heading";
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(heading);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.input(editor, { inputType: "insertText", data: "Live heading" });
    await waitFor(() => expect(writeDoc).toHaveBeenCalledWith(
      "inline-autosave", KNOWLEDGE.path, "# Live heading\n", KNOWLEDGE.version,
    ), { timeout: 2_000 });
    expect(screen.getByRole("status", { name: "已保存" })).toBeTruthy();
    expect((await sourceEditor()).value).toBe("# Live heading\n");
  });

  it("keeps the chosen source mode when a live composition flushes on unmount", async () => {
    const props = {
      knowledgeFirst: true,
      positionId: "inline-mode-flush",
      listDocs: vi.fn().mockResolvedValue(LIST),
      readDoc: vi.fn().mockResolvedValue(KNOWLEDGE),
      writeDoc: vi.fn(() => new Promise<DocsFileResponse>(() => undefined)),
    };
    const first = render(<DocsPanel {...props} />);
    const editor = await screen.findByRole("textbox", { name: "文档内容" });
    fireEvent.compositionStart(editor);
    const heading = within(editor).getByRole("heading", { name: /Knowledge$/ });
    heading.lastChild!.textContent = "最后输入";
    fireEvent.input(editor, { isComposing: true, inputType: "insertCompositionText" });
    await documentAction(/源\s?码/);
    expect((screen.getByLabelText("文档内容") as HTMLTextAreaElement).value).toContain("最后输入");
    first.unmount();
    render(<DocsPanel {...props} />);
    const restored = await screen.findByRole("textbox", { name: "文档内容" });
    expect(restored.tagName).toBe("TEXTAREA");
    expect((restored as HTMLTextAreaElement).value).toContain("最后输入");
    fireEvent.click(screen.getByRole("button", { name: "更多文档操作" }));
    expect(within(await screen.findByRole("menuitem", { name: "源码" })).getByText("源码")).toHaveAttribute("aria-current", "true");
  });

  it("serializes saves for a note across navigation and advances the write version", async () => {
    const second: DocsFileResponse = {
      ...KNOWLEDGE,
      path: "knowledge/SECOND.md",
      content: "# Second\n",
    };
    const list = {
      ...LIST,
      files: [
        ...LIST.files,
        { path: second.path, kind: "file" as const, size: second.size, modifiedAt: second.modifiedAt },
      ],
    };
    let finishFirst!: (doc: DocsFileResponse) => void;
    const writeDoc = vi
      .fn()
      .mockImplementationOnce(() => new Promise<DocsFileResponse>((resolve) => {
        finishFirst = resolve;
      }))
      .mockResolvedValue({
        ...KNOWLEDGE,
        content: "# Latest draft\n",
        version: "2026-08-27T00:00:03.000Z",
      });
    render(
      <DocsPanel
        knowledgeFirst
        positionId="serialized-saves"
        listDocs={vi.fn().mockResolvedValue(list)}
        readDoc={vi.fn().mockImplementation((_id: string, path: string) =>
          Promise.resolve(path === second.path ? second : KNOWLEDGE),
        )}
        writeDoc={writeDoc}
      />,
    );

    const editor = await sourceEditor();
    fireEvent.change(editor, { target: { value: "# First draft\n" } });
    await waitFor(() => expect(writeDoc).toHaveBeenCalledTimes(1), { timeout: 2_000 });

    fireEvent.click(screen.getByRole("button", { name: second.path }));
    expect((await sourceEditor()).value).toBe(second.content);
    fireEvent.click(screen.getByRole("button", { name: KNOWLEDGE.path }));
    await waitFor(() =>
      expect((screen.getByLabelText("文档内容") as HTMLTextAreaElement).value).toBe("# First draft\n"),
    );
    fireEvent.change(screen.getByLabelText("文档内容"), {
      target: { value: "# Latest draft\n" },
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 600));
    });
    expect(writeDoc).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishFirst({
        ...KNOWLEDGE,
        content: "# First draft\n",
        version: "2026-08-27T00:00:02.000Z",
      });
    });
    await waitFor(() => expect(writeDoc).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(writeDoc).toHaveBeenLastCalledWith(
      "serialized-saves",
      KNOWLEDGE.path,
      "# Latest draft\n",
      "2026-08-27T00:00:02.000Z",
    );
  });

  it("saves a dirty knowledge note immediately with Cmd/Ctrl+S", async () => {
    const writeDoc = vi.fn().mockResolvedValue({
      ...KNOWLEDGE,
      content: "# Shortcut\n",
      version: "2026-08-27T00:00:02.000Z",
    });
    render(
      <DocsPanel
        knowledgeFirst
        positionId="repo-owner"
        listDocs={vi.fn().mockResolvedValue(LIST)}
        readDoc={vi.fn().mockResolvedValue(KNOWLEDGE)}
        writeDoc={writeDoc}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "knowledge/README.md" }));
    const editor = await sourceEditor();
    fireEvent.change(editor, { target: { value: "# Shortcut\n" } });
    const dispatched = fireEvent.keyDown(editor, { key: "s", metaKey: true });

    expect(dispatched).toBe(false);
    await waitFor(() =>
      expect(writeDoc).toHaveBeenCalledWith(
        "repo-owner",
        "knowledge/README.md",
        "# Shortcut\n",
        KNOWLEDGE.version,
      ),
    );
  });

  it("preserves a dirty draft and cursor when switching between notes", async () => {
    const second: DocsFileResponse = {
      ...KNOWLEDGE,
      path: "knowledge/SECOND.md",
      content: "# Second\n",
    };
    const list = {
      ...LIST,
      files: [
        ...LIST.files,
        { path: second.path, kind: "file" as const, size: second.size, modifiedAt: second.modifiedAt },
      ],
    };
    render(
      <DocsPanel
        knowledgeFirst
        positionId="draft-preservation"
        listDocs={vi.fn().mockResolvedValue(list)}
        readDoc={vi.fn().mockImplementation((_id: string, path: string) =>
          Promise.resolve(path === second.path ? second : KNOWLEDGE),
        )}
        writeDoc={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "knowledge/README.md" }));
    const editor = (await sourceEditor()) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# Local draft\n" } });
    editor.setSelectionRange(7, 7);
    fireEvent.select(editor);

    fireEvent.click(screen.getByRole("button", { name: second.path }));
    expect((await sourceEditor() as HTMLTextAreaElement).value).toBe("# Second\n");
    fireEvent.click(screen.getByRole("button", { name: "knowledge/README.md" }));

    const restored = (await sourceEditor()) as HTMLTextAreaElement;
    expect(restored.value).toBe("# Local draft\n");
    expect(restored.selectionStart).toBe(7);
  });

  it("preserves draft, cursor, and scroll across module remounts", async () => {
    const props = {
      knowledgeFirst: true,
      positionId: "module-preservation",
      listDocs: vi.fn().mockResolvedValue(LIST),
      readDoc: vi.fn().mockResolvedValue(KNOWLEDGE),
      writeDoc: vi.fn(),
    };
    const first = render(<DocsPanel {...props} />);

    fireEvent.click(await screen.findByRole("button", { name: "knowledge/README.md" }));
    const editor = (await sourceEditor()) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# Across modules\n" } });
    editor.setSelectionRange(8, 8);
    fireEvent.select(editor);
    editor.scrollTop = 24;
    fireEvent.scroll(editor);
    const reader = screen.getByLabelText("文档阅读区");
    reader.scrollTop = 36;
    fireEvent.scroll(reader);
    first.unmount();

    render(<DocsPanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "knowledge/README.md" }));
    const restoredEditor = (await sourceEditor()) as HTMLTextAreaElement;
    const restoredReader = screen.getByLabelText("文档阅读区");
    expect(restoredEditor.value).toBe("# Across modules\n");
    expect(restoredEditor.selectionStart).toBe(8);
    expect(restoredEditor.scrollTop).toBe(24);
    expect(restoredReader.scrollTop).toBe(36);
  });

  it("refreshes a clean note when a newer external version is listed", async () => {
    const external = {
      ...KNOWLEDGE,
      content: "# External\n",
      version: "2026-08-27T00:00:03.000Z",
      modifiedAt: "2026-08-27T00:00:03.000Z",
    };
    const listDocs = vi
      .fn()
      .mockResolvedValueOnce(LIST)
      .mockResolvedValue({
        ...LIST,
        files: LIST.files.map((file) =>
          file.path === KNOWLEDGE.path ? { ...file, modifiedAt: external.version } : file,
        ),
      });
    const readDoc = vi.fn().mockResolvedValue(KNOWLEDGE);
    const view = render(
      <DocsPanel
        knowledgeFirst
        positionId="external-clean"
        listDocs={listDocs}
        readDoc={readDoc}
        writeDoc={vi.fn()}
        reloadToken={0}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: KNOWLEDGE.path }));
    expect((await sourceEditor() as HTMLTextAreaElement).value).toBe(KNOWLEDGE.content);
    readDoc.mockResolvedValue(external);
    view.rerender(
      <DocsPanel
        knowledgeFirst
        positionId="external-clean"
        listDocs={listDocs}
        readDoc={readDoc}
        writeDoc={vi.fn()}
        reloadToken={1}
      />,
    );

    await waitFor(() =>
      expect((screen.getByLabelText("文档内容") as HTMLTextAreaElement).value).toBe(external.content),
    );
    expect(screen.getByRole("status", { name: "已保存" })).toBeTruthy();
  });

  it("keeps external updates as conflicts while a live Chinese composition is pending", async () => {
    const external = {
      ...KNOWLEDGE,
      content: "# External changes\n",
      version: "2026-08-27T00:00:03.000Z",
      modifiedAt: "2026-08-27T00:00:03.000Z",
    };
    const listDocs = vi.fn().mockResolvedValueOnce(LIST).mockResolvedValue({
      ...LIST,
      files: LIST.files.map(file => file.path === KNOWLEDGE.path ? { ...file, modifiedAt: external.version } : file),
    });
    const readDoc = vi.fn().mockResolvedValue(KNOWLEDGE);
    const writeDoc = vi.fn().mockResolvedValue({ ...external, content: "# 中文编辑\n" });
    const props = { knowledgeFirst: true, positionId: "inline-ime-conflict", listDocs, readDoc, writeDoc };
    const view = render(<DocsPanel {...props} reloadToken={0} />);
    const editor = await screen.findByRole("textbox", { name: "文档内容" });
    const heading = within(editor).getByRole("heading", { name: /Knowledge$/ });
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(heading);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.compositionStart(editor);
    heading.lastChild!.textContent = "中文编辑";
    fireEvent.input(editor, { isComposing: true, inputType: "insertCompositionText" });
    readDoc.mockResolvedValue(external);
    view.rerender(<DocsPanel {...props} reloadToken={1} />);
    expect(await screen.findByText("文档已在外部更新")).toBeTruthy();
    expect(writeDoc).not.toHaveBeenCalled();
    fireEvent.compositionEnd(editor, { data: "中文编辑" });
    fireEvent.click(screen.getByRole("button", { name: /比\s?较/ }));
    expect(screen.getByRole("region", { name: "版本比较" })).toHaveTextContent("中文编辑");
    expect(screen.getByRole("region", { name: "版本比较" })).toHaveTextContent("External changes");
    expect(writeDoc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /保留我的版本/ }));
    await waitFor(() => expect(writeDoc).toHaveBeenCalledWith(
      props.positionId, KNOWLEDGE.path, "# 中文编辑\n", external.version,
    ));
  });

  it("shows compare and reload controls for a dirty external conflict", async () => {
    const external = {
      ...KNOWLEDGE,
      content: "# External conflict\n",
      version: "2026-08-27T00:00:04.000Z",
      modifiedAt: "2026-08-27T00:00:04.000Z",
    };
    const newerList = {
      ...LIST,
      files: LIST.files.map((file) =>
        file.path === KNOWLEDGE.path ? { ...file, modifiedAt: external.version } : file,
      ),
    };
    const listDocs = vi.fn().mockResolvedValueOnce(LIST).mockResolvedValue(newerList);
    const readDoc = vi.fn().mockResolvedValue(KNOWLEDGE);
    const view = render(
      <DocsPanel
        knowledgeFirst
        positionId="external-dirty-reload"
        listDocs={listDocs}
        readDoc={readDoc}
        writeDoc={vi.fn(() => new Promise<DocsFileResponse>(() => undefined))}
        reloadToken={0}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: KNOWLEDGE.path }));
    const editor = await sourceEditor();
    fireEvent.change(editor, { target: { value: "# Mine\n" } });
    readDoc.mockResolvedValue(external);
    view.rerender(
      <DocsPanel
        knowledgeFirst
        positionId="external-dirty-reload"
        listDocs={listDocs}
        readDoc={readDoc}
        writeDoc={vi.fn(() => new Promise<DocsFileResponse>(() => undefined))}
        reloadToken={1}
      />,
    );

    expect(await screen.findByText("文档已在外部更新")).toBeTruthy();
    expect((screen.getByLabelText("文档内容") as HTMLTextAreaElement).value).toBe("# Mine\n");
    fireEvent.click(screen.getByRole("button", { name: /比\s?较/ }));
    expect(screen.getByRole("region", { name: "版本比较" })).toHaveTextContent("# Mine");
    expect(screen.getByRole("region", { name: "版本比较" })).toHaveTextContent("# External conflict");

    fireEvent.click(screen.getByRole("button", { name: /重新加载/ }));
    await waitFor(() =>
      expect((screen.getByLabelText("文档内容") as HTMLTextAreaElement).value).toBe(external.content),
    );
    expect(screen.queryByText("文档已在外部更新")).toBeNull();
  });

  it("retries keep-mine against the external version after an autosave conflict", async () => {
    const external = {
      ...KNOWLEDGE,
      content: "# External winner\n",
      version: "2026-08-27T00:00:05.000Z",
      modifiedAt: "2026-08-27T00:00:05.000Z",
    };
    const conflict = Object.assign(new Error("document changed"), { name: "DocsConflictError" });
    const writeDoc = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValue({
        ...external,
        content: "# Keep mine\n",
        version: "2026-08-27T00:00:06.000Z",
      });
    const readDoc = vi.fn().mockResolvedValue(KNOWLEDGE);
    render(
      <DocsPanel
        knowledgeFirst
        positionId="external-dirty-keep"
        listDocs={vi.fn().mockResolvedValue(LIST)}
        readDoc={readDoc}
        writeDoc={writeDoc}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: KNOWLEDGE.path }));
    const editor = await sourceEditor();
    readDoc.mockResolvedValue(external);
    fireEvent.change(editor, { target: { value: "# Keep mine\n" } });

    expect(await screen.findByText("文档已在外部更新", {}, { timeout: 2_000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /保留我的版本/ }));
    await waitFor(() =>
      expect(writeDoc).toHaveBeenLastCalledWith(
        "external-dirty-keep",
        KNOWLEDGE.path,
        "# Keep mine\n",
        external.version,
      ),
    );
    expect(screen.getByRole("status", { name: "已保存" })).toBeTruthy();
  });

  it("edits rendered markdown in one surface and switches to source and reading modes", async () => {
    const writeDoc = vi.fn();
    render(
      <DocsPanel
        knowledgeFirst
        positionId="inline-mode-switch"
        listDocs={vi.fn().mockResolvedValue(LIST)}
        readDoc={vi.fn().mockResolvedValue(KNOWLEDGE)}
        writeDoc={writeDoc}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "knowledge/README.md" }));
    const editor = await screen.findByRole("textbox", { name: "文档内容" });
    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(within(editor).getByRole("heading", { name: /Knowledge$/ })).toBeTruthy();
    expect(screen.getAllByRole("textbox", { name: "文档内容" })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: /Knowledge$/ })).toHaveLength(1);
    expect(writeDoc).not.toHaveBeenCalled();

    await documentAction(/源\s?码/);
    expect(screen.getByLabelText("文档内容")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Knowledge$/ })).toBeNull();

    await readingMode();
    expect(screen.queryByRole("textbox", { name: "文档内容" })).toBeNull();
    expect(screen.getByRole("heading", { name: /Knowledge$/ })).toBeTruthy();

    await documentAction("即时编辑");
    const restored = await screen.findByRole("textbox", { name: "文档内容" });
    expect(restored).toHaveAttribute("contenteditable", "true");
    expect(within(restored).getByRole("heading", { name: /Knowledge$/ })).toBeTruthy();
    expect(writeDoc).not.toHaveBeenCalled();
  });

  // Renders the full DocsPanel editor and walks autosave plus two reading
  // mode round-trips; a macOS runner timeout was observed at the 5s default
  // (#529). 15s matches the other heavy component tests.
  it("preserves undo and redo history across reading mode after autosave", async () => {
    const writeDoc = vi.fn(async (_id: string, _path: string, content: string) => ({
      ...KNOWLEDGE, content, version: "2026-08-27T00:00:02.000Z",
    }));
    render(
      <DocsPanel
        knowledgeFirst
        positionId="reading-history"
        listDocs={vi.fn().mockResolvedValue(LIST)}
        readDoc={vi.fn().mockResolvedValue(KNOWLEDGE)}
        writeDoc={writeDoc}
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "文档内容" });
    const heading = within(editor).getByRole("heading", { name: /Knowledge$/ });
    heading.lastChild!.textContent = "Changed";
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(heading);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.input(editor, { inputType: "insertText", data: "Changed" });
    await waitFor(() => expect(writeDoc).toHaveBeenCalledTimes(1));
    await readingMode();
    expect(screen.queryByRole("textbox", { name: "文档内容" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Changed" })).toBeTruthy();
    await documentAction("即时编辑");
    fireEvent.keyDown(await screen.findByRole("textbox", { name: "文档内容" }), {
      key: "z", code: "KeyZ", ctrlKey: true,
    });
    await waitFor(() => expect(writeDoc).toHaveBeenLastCalledWith(
      "reading-history", KNOWLEDGE.path, "# Knowledge\n", "2026-08-27T00:00:02.000Z",
    ));
    await readingMode();
    await documentAction("即时编辑");
    fireEvent.keyDown(await screen.findByRole("textbox", { name: "文档内容" }), {
      key: "y", code: "KeyY", ctrlKey: true,
    });
    await waitFor(() => expect(writeDoc.mock.calls.map(call => call[2])).toEqual([
      "# Changed\n", "# Knowledge\n", "# Changed\n",
    ]));
  }, 15_000);

  it("navigates note links and explicitly creates a missing target", async () => {
    const linked = {
      ...KNOWLEDGE,
      content: "[[SECOND]] [[Missing]] [Relative](./SECOND.md)",
    };
    const second = {
      ...KNOWLEDGE,
      path: "knowledge/SECOND.md",
      content: "# Second target\n",
    };
    const list = {
      ...LIST,
      files: [
        ...LIST.files,
        { path: second.path, kind: "file" as const, size: second.size, modifiedAt: second.modifiedAt },
      ],
    };
    const createDoc = vi.fn().mockResolvedValue(undefined);
    const readDoc = vi.fn().mockImplementation((_id: string, path: string) =>
      Promise.resolve(path === second.path ? second : linked),
    );
    render(
      <DocsPanel
        knowledgeFirst
        positionId="note-navigation"
        listDocs={vi.fn().mockResolvedValue(list)}
        readDoc={readDoc}
        writeDoc={vi.fn()}
        createDoc={createDoc}
      />,
    );

    await readingMode();
    const secondLink = screen.getByRole("link", { name: "文档链接：Relative" });
    expect(secondLink).toHaveAttribute("href", "./SECOND.md");
    expect(fireEvent.click(secondLink)).toBe(false);
    await waitFor(() => expect(readDoc).toHaveBeenCalledWith("note-navigation", second.path));
    await waitFor(() => expect(screen.getByRole("button", { name: second.path })).toHaveAttribute("aria-pressed", "true"));
    expect(await screen.findByRole("heading", { name: /Second target$/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: KNOWLEDGE.path }));
    await readingMode();
    const missingLink = screen.getByRole("link", { name: "文档链接：Missing" });
    expect(missingLink).toBeInTheDocument();
    expect(fireEvent.click(missingLink)).toBe(false);
    expect(await screen.findByText("未找到 knowledge/Missing.md")).toBeTruthy();
    expect(createDoc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /创建文档/ }));
    await waitFor(() => expect(createDoc).toHaveBeenCalledWith("note-navigation", "knowledge/Missing.md"));
  });

  it("lists archived knowledge and restores it", async () => {
    const archived: DocsFileListResponse = {
      ...LIST,
      files: [{ path: "knowledge/README.md", kind: "file", size: 7, modifiedAt: "2026-08-27T00:00:01.000Z" }],
    };
    const listDocs = vi
      .fn()
      .mockResolvedValueOnce(LIST)
      .mockResolvedValue(archived);
    const readDoc = vi.fn().mockResolvedValue(KNOWLEDGE);
    const restoreDoc = vi.fn().mockResolvedValue(undefined);
    render(
      <DocsPanel
        knowledgeFirst
        positionId="repo-owner"
        listDocs={listDocs}
        readDoc={readDoc}
        restoreDoc={restoreDoc}
      />,
    );
    fireEvent.click(await screen.findByText("归档"));
    await waitFor(() => expect(listDocs).toHaveBeenLastCalledWith("repo-owner", { archived: true }));
    fireEvent.click(await screen.findByRole("button", { name: "knowledge/README.md" }));
    await screen.findByRole("heading", { name: /Knowledge$/ });
    await documentAction(/恢\s?复/);
    await waitFor(() => expect(restoreDoc).toHaveBeenCalledWith("repo-owner", "knowledge/README.md"));
  });

  it("discards a late live read after switching to the archived view", async () => {
    let finish!: (doc: DocsFileResponse) => void;
    const readDoc = vi
      .fn()
      .mockReturnValueOnce(new Promise<DocsFileResponse>((resolve) => {
        finish = resolve;
      }))
      .mockResolvedValue({ ...KNOWLEDGE, content: "# Archived copy\n" });
    const listDocs = vi.fn().mockResolvedValue(LIST);
    render(
      <DocsPanel
        knowledgeFirst
        positionId="repo-owner"
        listDocs={listDocs}
        readDoc={readDoc}
        restoreDoc={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "knowledge/README.md" });
    fireEvent.click(screen.getByText("归档"));
    await waitFor(() => expect(listDocs).toHaveBeenLastCalledWith("repo-owner", { archived: true }));
    await act(async () => finish(KNOWLEDGE));
    expect(screen.queryByRole("heading", { name: /Knowledge$/ })).toBeNull();
  });

  it("does not apply a late write onto another position", async () => {
    let finish!: (doc: DocsFileResponse) => void;
    const writeDoc = vi.fn().mockReturnValue(
      new Promise<DocsFileResponse>((resolve) => {
        finish = resolve;
      }),
    );
    const listDocs = vi.fn().mockResolvedValue(LIST);
    const readDoc = vi.fn().mockResolvedValue(KNOWLEDGE);
    const view = render(
      <DocsPanel
        knowledgeFirst
        positionId="alice"
        listDocs={listDocs}
        readDoc={readDoc}
        writeDoc={writeDoc}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "knowledge/README.md" }));
    const editor = await sourceEditor();
    fireEvent.change(editor, { target: { value: "# Alice private\n" } });
    await waitFor(() => expect(writeDoc).toHaveBeenCalledTimes(1));
    view.rerender(
      <DocsPanel
        knowledgeFirst
        positionId="bob"
        listDocs={listDocs}
        readDoc={readDoc}
        writeDoc={writeDoc}
      />,
    );
    await act(async () => finish({ ...KNOWLEDGE, content: "# Alice private\n" }));
    expect(screen.queryByText("Alice private")).toBeNull();
  });
});

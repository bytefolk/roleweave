import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

describe("DocsPanel knowledge lifecycle (#347)", () => {
  it("edits knowledge files, confirms delete, and keeps SKILL.md bound read-only", async () => {
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
        positionId="repo-owner"
        listDocs={listDocs}
        readDoc={readDoc}
        writeDoc={writeDoc}
        renameDoc={renameDoc}
        archiveDoc={archiveDoc}
        deleteDoc={deleteDoc}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "knowledge/README.md" }));
    await screen.findByRole("heading", { name: "Knowledge" });
    expect(screen.getAllByText("Markdown 文档").length).toBeGreaterThan(0);
    expect(screen.getByText("7 字节")).toBeTruthy();
    expect(screen.getByText("README")).toBeTruthy();
    expect(screen.queryByText("README.md")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /编\s?辑/ }));
    const editor = await screen.findByLabelText("文档内容");
    fireEvent.change(editor, { target: { value: "# Edited\n" } });
    fireEvent.click(screen.getByRole("button", { name: /保\s?存/ }));
    await waitFor(() =>
      expect(writeDoc).toHaveBeenCalledWith("repo-owner", "knowledge/README.md", "# Edited\n"),
    );

    fireEvent.click(await screen.findByRole("button", { name: /重\s?命\s?名/ }));
    const renameInput = await screen.findByLabelText("新文档文件名");
    fireEvent.change(renameInput, { target: { value: "handbook.md" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /重\s?命\s?名/ }));
    await waitFor(() =>
      expect(renameDoc).toHaveBeenCalledWith("repo-owner", "knowledge/README.md", "knowledge/handbook.md"),
    );

    fireEvent.click(await screen.findByRole("button", { name: "SKILL.md" }));
    await screen.findByRole("heading", { name: "Repo Owner" });
    expect(screen.getByText("绑定期间只读")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /编\s?辑/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "knowledge/README.md" }));
    await screen.findByRole("heading", { name: "Knowledge" });
    fireEvent.click(screen.getByRole("button", { name: /删\s?除/ }));
    expect(await screen.findByText(/确定永久删除/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /永久删除/ }));
    await waitFor(() =>
      expect(deleteDoc).toHaveBeenCalledWith("repo-owner", "knowledge/README.md"),
    );
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
    fireEvent.click(await screen.findByText("已归档"));
    await waitFor(() => expect(listDocs).toHaveBeenLastCalledWith("repo-owner", { archived: true }));
    fireEvent.click(await screen.findByRole("button", { name: "knowledge/README.md" }));
    await screen.findByRole("heading", { name: "Knowledge" });
    fireEvent.click(screen.getByRole("button", { name: /恢\s?复/ }));
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
    fireEvent.click(screen.getByText("已归档"));
    await waitFor(() => expect(listDocs).toHaveBeenLastCalledWith("repo-owner", { archived: true }));
    await act(async () => finish(KNOWLEDGE));
    expect(screen.queryByRole("heading", { name: "Knowledge" })).toBeNull();
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
    await screen.findByRole("heading", { name: "Knowledge" });
    fireEvent.click(screen.getByRole("button", { name: /编\s?辑/ }));
    fireEvent.click(screen.getByRole("button", { name: /保\s?存/ }));
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

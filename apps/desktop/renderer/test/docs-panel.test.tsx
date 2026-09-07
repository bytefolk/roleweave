import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("asks for a position before routing anything", () => {
    const listDocs = vi.fn();
    render(<DocsPanel positionId={null} listDocs={listDocs} readDoc={vi.fn()} />);
    expect(screen.getByText("先从组织树选择岗位")).toBeTruthy();
    expect(listDocs).not.toHaveBeenCalled();
  });

  it("lists position documents and routes the selected file into the DocViewer with its file-level version", async () => {
    const listDocs = vi.fn().mockResolvedValue(LIST);
    const readDoc = vi.fn().mockResolvedValue(DOC);
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
    expect(screen.getByText("版本 2026-08-27T00:00:00.000Z")).toBeTruthy();
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

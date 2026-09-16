import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(document.querySelector('time[datetime="2026-08-27T00:00:00.000Z"]')).toHaveTextContent("更新于");
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

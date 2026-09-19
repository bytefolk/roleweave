import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TreeRowMenu } from "../src/org/TreeManagement";
import { DocsPanel } from "../src/docs/DocsPanel";
import type { DocsFileListResponse, DocsFileResponse } from "@roleweave/shared";

describe("tree management and knowledge boundaries", () => {
  it("right-click targets that employee without triggering the left-click conversation", async () => {
    const action = vi.fn(); const select = vi.fn();
    render(<TreeRowMenu id="alice" name="Alice" busy={false} onAction={action}><div onClick={select}>Alice row</div></TreeRowMenu>);
    fireEvent.contextMenu(screen.getByText("Alice row"));
    fireEvent.click(await screen.findByText("员工设置"));
    expect(action).toHaveBeenCalledWith("alice", "settings");
    expect(select).not.toHaveBeenCalled();
  });
  it("puts creating a subordinate first in an employee context menu", async () => {
    const action = vi.fn();
    render(<TreeRowMenu id="alice" name="Alice" busy={false} onAction={action}><div>Alice row</div></TreeRowMenu>);
    fireEvent.contextMenu(screen.getByText("Alice row"));

    const items = await screen.findAllByRole("menuitem");
    expect(items[0]).toHaveTextContent("创建下属员工");
    fireEvent.click(items[0]);
    expect(action).toHaveBeenCalledWith("alice", "hire");
  });
  it("offers record editing for the right-clicked position from both menu triggers", async () => {
    const action = vi.fn();
    render(<TreeRowMenu id="alice" name="Alice" busy={false} onAction={action}><div>Alice row</div></TreeRowMenu>);
    fireEvent.contextMenu(screen.getByText("Alice row"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑" }));
    expect(action).toHaveBeenCalledWith("alice", "edit");
  });
  it("exposes the same edit entry from a position ellipsis, and never on the enterprise row", async () => {
    const action = vi.fn();
    render(<TreeRowMenu id="alice" name="Alice" busy={false} onAction={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Alice 的更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑" }));
    expect(action).toHaveBeenCalledWith("alice", "edit");
    render(<TreeRowMenu id={null} name="Project" busy={false} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Project 的更多操作" }));
    await waitFor(() => expect(screen.getByText("项目设置")).toBeVisible());
    expect(screen.queryByRole("menuitem", { name: "编辑" })).toBeNull();
  });
  it("ellipsis exposes the project menu, with structural mutation disabled while busy", async () => {
    const action = vi.fn();
    render(<TreeRowMenu id={null} name="Project" busy onAction={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Project 的更多操作" }));
    await waitFor(() => expect(screen.getByText("项目设置")).toBeVisible());
    expect(screen.getByRole("menuitem", { name: "创建员工" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByText("项目设置"));
    expect(action).toHaveBeenCalledWith(null, "settings");
  });
  it("hides package config from knowledge and allows searching all files", async () => {
    const files = ["SKILL.md", "knowledge/guide.md", "budget.json"].map((path) => ({ path, kind: "file" as const, size: 10, modifiedAt: "2026-09-01T00:00:00Z" }));
    const list = vi.fn().mockResolvedValue({ schemaVersion: "docs-file-list.v1", positionId: "alice", files } satisfies DocsFileListResponse);
    render(<DocsPanel knowledgeFirst positionId="alice" listDocs={list} readDoc={vi.fn().mockResolvedValue(null)} />);
    expect(await screen.findByRole("button", { name: "knowledge/guide.md" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "budget.json" })).toBeNull();
    fireEvent.click(screen.getByText("全部文件"));
    expect(screen.getByRole("button", { name: "budget.json" })).toBeVisible();
    fireEvent.change(screen.getByPlaceholderText("搜索文件"), { target: { value: "budget" } });
    expect(screen.queryByRole("button", { name: "SKILL.md" })).toBeNull();
  });
  it("discards a previous employee's late document response", async () => {
    let resolve!: (doc: DocsFileResponse) => void;
    const read = vi.fn().mockReturnValue(new Promise<DocsFileResponse>((done) => { resolve = done; }));
    const list = vi.fn().mockResolvedValue({ files: [{ path: "SKILL.md", size: 1, modifiedAt: "v1" }] });
    const { rerender } = render(<DocsPanel positionId="alice" listDocs={list} readDoc={read} />);
    fireEvent.click(await screen.findByRole("button", { name: "SKILL.md" }));
    rerender(<DocsPanel positionId="bob" listDocs={list} readDoc={read} />);
    await waitFor(() => expect(list).toHaveBeenCalledWith("bob"));
    resolve({ schemaVersion: "docs-file.v1", positionId: "alice", path: "SKILL.md", content: "Alice private knowledge", version: "v1", size: 1, modifiedAt: "v1" });
    await waitFor(() => expect(screen.queryByText("Alice private knowledge")).toBeNull());
  });
});

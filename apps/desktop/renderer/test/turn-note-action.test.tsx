import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TurnNoteAction } from "../src/turns/TurnNoteAction";
import type { TurnRecord } from "../src/turns/types";
const turn: TurnRecord = { id: "turn-a", positionId: "employee-a", positionName: "员工甲", engine: "qoder", input: "总结", output: "回复", status: "completed", createdAt: "2026-10-07T00:00:00Z" };
const sources = { status: 200, body: { notes: [{ noteId: "note-a", path: "项目约定.md", ref: "vault://notes/note-a", version: "sha256:abc", excerpt: "仅保留已确认的约定。" }] } };
describe("本次笔记引用", () => {
  it("shows real receipts and opens their source notes", async () => {
    const used = vi.fn().mockResolvedValue(sources); const onCreated = vi.fn();
    Object.defineProperty(window, "owb", { configurable: true, value: { vault: { used } } });
    render(<TurnNoteAction turn={turn} onCreated={onCreated} />);
    fireEvent.click(await screen.findByRole("button", { name: "本次引用 1 篇" }));
    await waitFor(() => expect(screen.getByText("仅保留已确认的约定。")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "项目约定.md" }));
    expect(used).toHaveBeenCalledWith({ positionId: "employee-a", turnId: "turn-a" });
    expect(onCreated).toHaveBeenCalledWith("vault://notes/note-a");
  });
  it("does not invent references when an older bridge lacks receipts", () => {
    Object.defineProperty(window, "owb", { configurable: true, value: { vault: {} } });
    render(<TurnNoteAction turn={turn} />);
    expect(screen.queryByRole("button", { name: /本次引用/ })).not.toBeInTheDocument();
  });
  it("keeps zero-reference receipts quiet", async () => {
    const used = vi.fn().mockResolvedValue({ status: 200, body: { notes: [] } });
    Object.defineProperty(window, "owb", { configurable: true, value: { vault: { used } } });
    render(<TurnNoteAction turn={turn} />);
    await waitFor(() => expect(used).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /本次引用/ })).not.toBeInTheDocument();
  });
  it("ignores a late receipt belonging to a previously displayed turn", async () => {
    let resolve!: (response: typeof sources) => void;
    const used = vi.fn().mockImplementation((request) => request.turnId === "turn-a" ? new Promise((done) => { resolve = done; }) : Promise.resolve({ status: 200, body: { notes: [] } }));
    Object.defineProperty(window, "owb", { configurable: true, value: { vault: { used } } });
    const { rerender } = render(<TurnNoteAction turn={turn} />);
    rerender(<TurnNoteAction turn={{ ...turn, id: "turn-b" }} />);
    await act(async () => resolve(sources));
    expect(screen.queryByRole("button", { name: /本次引用/ })).not.toBeInTheDocument();
  });
});

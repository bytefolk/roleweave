import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageActions } from "../src/turns/message-actions";

describe("contextual message actions", () => {
  it("explains icon actions on keyboard focus and edits the original text", async () => {
    const edit = vi.fn();
    render(<MessageActions raw="Original task" onEdit={edit} />);
    const button = screen.getByRole("button", { name: "重新编辑" });
    expect(button).not.toHaveAttribute("title");
    expect(button).toHaveTextContent("");
    fireEvent.focus(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("重新编辑");
    fireEvent.click(button);
    expect(edit).toHaveBeenCalledExactlyOnceWith("Original task");
  });

  it("copies the chosen format, closes its menu and clears old feedback for a changed message", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
    const { rerender } = render(<MessageActions raw="**Done**" plain="Done" />);
    const button = screen.getByRole("button", { name: "复制" });
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(await screen.findByText("复制纯文本"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已复制"));
    expect(write).toHaveBeenCalledExactlyOnceWith("Done");
    expect(button).toHaveAttribute("aria-expanded", "false");
    rerender(<MessageActions raw="New message" plain="New message" />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("reports a rejected clipboard write without claiming success", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<MessageActions raw="Original task" />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("复制失败"));
    expect(screen.queryByText("已复制")).not.toBeInTheDocument();
  });

  it("returns keyboard focus to the copy button when Escape closes the menu", async () => {
    render(<MessageActions raw="**Done**" plain="Done" />);
    const button = screen.getByRole("button", { name: "复制" });
    act(() => button.focus());
    fireEvent.click(button);
    const item = await screen.findByRole("menuitem", { name: "复制纯文本" });
    act(() => item.focus());
    expect(item).toHaveFocus();
    fireEvent.keyDown(item, { key: "Escape", keyCode: 27 });
    await waitFor(() => expect(button).toHaveAttribute("aria-expanded", "false"));
    expect(button).toHaveFocus();
  });

  it.each(["resolved", "rejected"])("ignores a %s clipboard result for a previous version of a streaming message", async result => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(() => pending) } });
    const { rerender } = render(<MessageActions raw="Partial answer" />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    rerender(<MessageActions raw="Partial answer with new text" />);
    await act(async () => { if (result === "resolved") resolve(); else reject(new Error("denied")); await pending.catch(() => {}); });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});

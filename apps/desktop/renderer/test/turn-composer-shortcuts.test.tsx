import { useState } from "react";
import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TurnComposer, type TurnComposerProps } from "../src/turns/TurnComposer";

function Composer({ initial = "before AFTER", ...overrides }: Partial<TurnComposerProps> & { initial?: string }) {
  const [value, onChange] = useState(initial);
  return <TurnComposer value={value} onChange={onChange} placeholder="Task" disabledReason={null}
    running={false} canCancel={false} onSend={vi.fn()} onCancel={vi.fn()} {...overrides} />;
}
function input() {
  const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
  act(() => textarea.focus());
  return textarea;
}
function enter(textarea: HTMLTextAreaElement, modifiers: KeyboardEventInit = {}) {
  const event = createEvent.keyDown(textarea, { key: "Enter", ...modifiers });
  fireEvent(textarea, event);
  return event;
}
const shortcuts = ["enter", "mod-enter"] as const;
const modifiers = [{ ctrlKey: true }, { metaKey: true }];

describe("conversation send shortcuts", () => {
  it("sends on Enter by default and leaves Shift+Enter to native multiline editing", () => {
    const send = vi.fn();
    render(<Composer onSend={send} />);
    const textarea = input();
    expect(enter(textarea, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(enter(textarea).defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByText(/Ctrl\/⌘ \+ Enter/)).toBeVisible();
  });

  describe.each(modifiers)("newline with %j in Enter mode", modifier => {
    it.each([
      [0, 0, "\nbefore AFTER", 1],
      [6, 6, "before\n AFTER", 7],
      [12, 12, "before AFTER\n", 13],
      [7, 12, "before \n", 8],
    ] as const)("replaces selection %s..%s and restores the caret", (start, end, expected, caret) => {
      const send = vi.fn();
      render(<Composer onSend={send} />);
      const textarea = input();
      textarea.setSelectionRange(start, end);
      expect(enter(textarea, modifier).defaultPrevented).toBe(true);
      expect(textarea).toHaveValue(expected);
      expect(textarea.selectionStart).toBe(caret);
      expect(textarea.selectionEnd).toBe(caret);
      expect(send).not.toHaveBeenCalled();
      // A second keystroke must use the restored caret, not append to the end.
      enter(textarea, modifier);
      expect(textarea).toHaveValue(`${expected.slice(0, caret)}\n${expected.slice(caret)}`);
      expect(textarea.selectionStart).toBe(caret + 1);
    });

    it("collapses a selected newline even when the controlled value is unchanged", () => {
      render(<Composer initial={"a\nb"} />);
      const textarea = input();
      textarea.setSelectionRange(1, 2);
      enter(textarea, modifier);
      expect(textarea).toHaveValue("a\nb");
      expect(textarea.selectionStart).toBe(2);
      expect(textarea.selectionEnd).toBe(2);
    });

    it("allows multiline drafting while a task runs without dispatching another task", () => {
      const send = vi.fn();
      render(<Composer running onSend={send} />);
      const textarea = input();
      textarea.setSelectionRange(12, 12);
      enter(textarea, modifier);
      expect(textarea).toHaveValue("before AFTER\n");
      enter(textarea);
      expect(send).not.toHaveBeenCalled();
    });
  });

  it.each(modifiers)("preserves configured modifier-Enter sending with %j", modifier => {
    const send = vi.fn();
    const { rerender } = render(<Composer sendShortcut="mod-enter" onSend={send} />);
    const textarea = input();
    expect(enter(textarea).defaultPrevented).toBe(false);
    expect(enter(textarea, { ...modifier, shiftKey: true }).defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(enter(textarea, modifier).defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    // Changing the preference immediately changes behavior on the same draft.
    rerender(<Composer sendShortcut="enter" onSend={send} />);
    textarea.setSelectionRange(12, 12);
    enter(textarea, modifier);
    expect(textarea).toHaveValue("before AFTER\n");
    expect(send).toHaveBeenCalledTimes(1);
  });

  describe.each(shortcuts)("IME safety with %s", sendShortcut => {
    it.each([{}, ...modifiers])("ignores composing Enter with %j", modifier => {
      const send = vi.fn();
      render(<Composer initial="你好" sendShortcut={sendShortcut} onSend={send} />);
      const textarea = input();
      expect(enter(textarea, { ...modifier, isComposing: true }).defaultPrevented).toBe(false);
      expect(enter(textarea, { ...modifier, keyCode: 229 }).defaultPrevented).toBe(false);
      fireEvent.compositionStart(textarea);
      expect(enter(textarea, modifier).defaultPrevented).toBe(false);
      fireEvent.compositionEnd(textarea);
      expect(textarea).toHaveValue("你好");
      expect(send).not.toHaveBeenCalled();
      enter(textarea, sendShortcut === "enter" ? {} : { ctrlKey: true });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it.each([
      { initial: " \n " },
      { running: true },
      { disabledReason: "Unavailable", draftDisabled: false },
    ])("keeps the send gate for %j", state => {
      const send = vi.fn();
      render(<Composer sendShortcut={sendShortcut} onSend={send} {...state} />);
      enter(input(), sendShortcut === "enter" ? {} : { ctrlKey: true });
      expect(send).not.toHaveBeenCalled();
    });
  });
});

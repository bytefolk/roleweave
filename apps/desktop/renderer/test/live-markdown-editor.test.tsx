import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "vditor/dist/js/lute/lute.min.js";
import { LiveMarkdownEditor } from "../src/docs/LiveMarkdownEditor";

// Run the real Lute/Vditor code. Only bridge browser APIs absent in jsdom;
// the loaded-script marker avoids waiting for jsdom to fetch the local asset.
let luteScript: HTMLScriptElement;
let originalExecCommand: typeof document.execCommand;
let originalInnerText: PropertyDescriptor | undefined;
let originalGetClientRects: typeof Range.prototype.getClientRects | undefined;
let originalGetBoundingClientRect: typeof Range.prototype.getBoundingClientRect | undefined;
let existingResources: Set<Element>;
beforeEach(() => {
  existingResources = new Set(document.head.querySelectorAll("script,link"));
  originalExecCommand = document.execCommand;
  document.execCommand = vi.fn((command: string, _ui?: boolean, value?: string) => {
    // jsdom lacks execCommand; bridge only the insertHTML Vditor's link action needs.
    if (command !== "insertHTML" || typeof value !== "string") return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const template = document.createElement("template");
    template.innerHTML = value;
    const lastNode = template.content.lastChild;
    range.insertNode(template.content);
    if (lastNode) {
      range.setStartAfter(lastNode);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  }) as unknown as typeof document.execCommand;
  originalInnerText = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText");
  // jsdom has no layout-backed innerText; these fixtures only require text.
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() { return this.textContent; },
    set(value: string) { this.textContent = value; },
  });
  // jsdom Ranges have no geometry; Vditor's hint popover only needs it to exist.
  originalGetClientRects = Range.prototype.getClientRects;
  originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;
  const emptyRect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => emptyRect;
  Object.assign(window, { Lute: (globalThis as unknown as { Lute: unknown }).Lute });
  luteScript = document.createElement("script");
  luteScript.id = "vditorLuteScript";
  document.head.append(luteScript);
});
afterEach(() => {
  cleanup();
  luteScript.remove();
  document.head.querySelectorAll("script,link").forEach((node) => {
    if (!existingResources.has(node)) node.remove();
  });
  document.execCommand = originalExecCommand;
  if (originalInnerText) Object.defineProperty(HTMLElement.prototype, "innerText", originalInnerText);
  else Reflect.deleteProperty(HTMLElement.prototype, "innerText");
  if (originalGetClientRects) Range.prototype.getClientRects = originalGetClientRects;
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
  if (originalGetBoundingClientRect) Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

function select(node: Node, offset: number, endOffset = offset) {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, endOffset);
  selection.addRange(range);
}

function typeText(editor: HTMLElement, text: string, selector = "p") {
  const block = editor.querySelector(selector)!;
  block.textContent = text;
  select(block.firstChild!, text.length);
  fireEvent.input(editor, { inputType: "insertText", data: text.slice(-1) });
}

function props(sessionId: string, value = "Original\n") {
  return { value, sessionId, ariaLabel: "文档内容", onChange: vi.fn(), onSave: vi.fn() };
}

async function getEditor() {
  return await screen.findByRole("textbox", { name: "文档内容" });
}

async function settleInput() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
}

describe("LiveMarkdownEditor (real Vditor IR)", () => {
  it("opens one rendered editable surface without reporting normalization as an edit", async () => {
    const initial = props("initial", "# Heading\n\n**Bold**\n\n- item\n\n| A | B |\n| - | - |\n| C | D |");
    const view = render(<LiveMarkdownEditor {...initial} />);
    const editor = await getEditor();
    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(editor).toHaveAttribute("aria-multiline", "true");
    expect(within(editor).getByRole("heading")).toHaveTextContent("Heading");
    expect(editor.querySelector("strong")).toHaveTextContent("Bold");
    expect(editor.querySelector("li")).toHaveTextContent("item");
    expect(editor.querySelector("td")).toHaveTextContent("C");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(view.container.querySelector("textarea")).not.toBeVisible();
    fireEvent.blur(editor);
    await settleInput();
    view.unmount();
    expect(initial.onChange).not.toHaveBeenCalled();
    expect(initial.onSave).not.toHaveBeenCalled();
  });

  it("converts real contenteditable input back to Markdown, including table edits", async () => {
    const initial = props("input", "# Heading\n\nOriginal\n\n| A | B |\n| - | - |\n| C | D |\n");
    render(<LiveMarkdownEditor {...initial} />);
    const editor = await getEditor();
    typeText(editor, "Changed **bold**");
    await waitFor(() => expect(initial.onChange).toHaveBeenCalled());
    expect(initial.onChange.mock.lastCall?.[0]).toContain("Changed **bold**");
    expect(editor.querySelector("strong")).toHaveTextContent("bold");
    typeText(editor, "Cell", "td");
    await waitFor(() => expect(initial.onChange.mock.lastCall?.[0]).toContain("Cell"));
    expect(initial.onChange.mock.lastCall?.[0]).toContain("# Heading");
    expect(initial.onChange.mock.lastCall?.[0]).toContain("|");
  });

  it("keeps native bold and undo shortcuts available without a visible toolbar", async () => {
    const initial = props("shortcuts");
    render(<LiveMarkdownEditor {...initial} />);
    const editor = await getEditor();
    select(editor.querySelector("p")!.firstChild!, 0, 8);
    fireEvent.keyDown(editor, { key: "b", code: "KeyB", ctrlKey: true });
    await waitFor(() => expect(initial.onChange).toHaveBeenLastCalledWith("**Original**\n"));
    fireEvent.keyDown(editor, { key: "z", code: "KeyZ", ctrlKey: true });
    await waitFor(() => expect(initial.onChange).toHaveBeenLastCalledWith("Original\n"));
    expect(editor.querySelector("strong")).toBeNull();
  });

  it.each([
    { modifier: "metaKey", platform: "MacIntel" },
    { modifier: "ctrlKey", platform: "Linux" },
  ])("$modifier+Shift+Z redoes the last undo without invoking browser history", async ({ modifier, platform }) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const initial = props(`redo-${modifier}`);
    render(<LiveMarkdownEditor {...initial} />);
    const editor = await getEditor();
    typeText(editor, "Changed");
    await settleInput();
    fireEvent.keyDown(editor, { key: "z", code: "KeyZ", [modifier]: true });
    await waitFor(() => expect(initial.onChange).toHaveBeenLastCalledWith("Original\n"));
    expect(fireEvent.keyDown(editor, { key: "Z", code: "KeyZ", [modifier]: true, shiftKey: true })).toBe(false);
    await waitFor(() => expect(initial.onChange).toHaveBeenLastCalledWith("Changed\n"));
    expect(editor).toHaveTextContent("Changed");
  });

  it("cannot switch to source or WYSIWYG mode through Vditor's built-in hotkeys", async () => {
    render(<LiveMarkdownEditor {...props("fixed-ir")} />);
    const editor = await getEditor();
    select(editor.querySelector("p")!.firstChild!, 0);
    for (const digit of ["7", "9"]) {
      fireEvent.keyDown(editor, { key: digit, code: `Digit${digit}`, ctrlKey: true, altKey: true });
      expect(editor).toBeVisible();
      expect(screen.getAllByRole("textbox")).toEqual([editor]);
    }
  });

  it("strikes through the selection with ⇧⌘X without relying on ⌘D", async () => {
    const initial = props("strike-alias");
    render(<LiveMarkdownEditor {...initial} />);
    const editor = await getEditor();
    select(editor.querySelector("p")!.firstChild!, 0, 8);
    expect(fireEvent.keyDown(editor, { key: "X", code: "KeyX", ctrlKey: true, shiftKey: true })).toBe(false);
    await waitFor(() => expect(initial.onChange).toHaveBeenLastCalledWith("~~Original~~\n"));
  });

  it("applies headings with Typora-style ⌘1-6 aliases", async () => {
    const initial = props("heading-alias");
    render(<LiveMarkdownEditor {...initial} />);
    const editor = await getEditor();
    select(editor.querySelector("p")!.firstChild!, 0);
    expect(fireEvent.keyDown(editor, { key: "2", code: "Digit2", ctrlKey: true })).toBe(false);
    await waitFor(() => expect(initial.onChange).toHaveBeenLastCalledWith("## Original\n"));
    expect(document.querySelector(".vditor-ir h2")).not.toBeNull();
  });

  it("registers link, code block, indent, outdent and rule hotkeys from the hidden toolbar", async () => {
    render(<LiveMarkdownEditor {...props("toolbar-hotkeys", "- one\n- two\n")} />);
    const editor = await getEditor();
    const items = editor.querySelectorAll("li");
    select(items[1].firstChild!, 1);
    for (const combo of [
      { key: "k", code: "KeyK", ctrlKey: true },
      { key: "u", code: "KeyU", ctrlKey: true },
      { key: "O", code: "KeyO", ctrlKey: true, shiftKey: true },
      { key: "I", code: "KeyI", ctrlKey: true, shiftKey: true },
      { key: "H", code: "KeyH", ctrlKey: true, shiftKey: true },
    ]) {
      expect(fireEvent.keyDown(editor, combo)).toBe(false);
    }
  });

  it("inserts a link around the selection with ⌘K", async () => {
    const initial = props("link-hotkey");
    render(<LiveMarkdownEditor {...initial} />);
    const editor = await getEditor();
    select(editor.querySelector("p")!.firstChild!, 0, 8);
    fireEvent.keyDown(editor, { key: "k", code: "KeyK", ctrlKey: true });
    await waitFor(() => expect(initial.onChange).toHaveBeenLastCalledWith("[Original](https://)\n"));
  });

  it("keeps a late-initialized inactive editor disabled without stealing focus", async () => {
    const initial = props("inactive-init");
    const view = render(<><button>Reading control</button><LiveMarkdownEditor {...initial} /></>);
    screen.getByRole("button", { name: "Reading control" }).focus();
    view.rerender(<><button>Reading control</button><LiveMarkdownEditor {...initial} active={false} /></>);
    const editor = await getEditor();
    expect(editor).toHaveAttribute("contenteditable", "false");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reading control" }));
    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    fireEvent.keyDown(editor, { key: "Z", metaKey: true, shiftKey: true });
    expect(initial.onSave).not.toHaveBeenCalled();
    expect(initial.onChange).not.toHaveBeenCalled();
  });

  it("flushes a composition once when deactivated and accepts typing after returning", async () => {
    const initial = props("inactive-ime");
    const onCompositionChange = vi.fn();
    const view = render(<LiveMarkdownEditor {...initial} onCompositionChange={onCompositionChange} />);
    const editor = await getEditor();
    select(editor.querySelector("p")!.firstChild!, 0);
    fireEvent.compositionStart(editor);
    typeText(editor, "中文末尾");
    view.rerender(<LiveMarkdownEditor {...initial} onCompositionChange={onCompositionChange} active={false} />);
    expect(initial.onChange).toHaveBeenCalledExactlyOnceWith("中文末尾\n");
    expect(onCompositionChange).toHaveBeenLastCalledWith(false);
    expect(editor).toHaveAttribute("contenteditable", "false");
    fireEvent.compositionEnd(editor, { data: "中文末尾" });
    await settleInput();
    expect(initial.onChange).toHaveBeenCalledTimes(1);
    view.rerender(<LiveMarkdownEditor {...initial} value="中文末尾\n" onCompositionChange={onCompositionChange} active />);
    expect(await getEditor()).toBe(editor);
    typeText(editor, "继续输入");
    await waitFor(() => expect(initial.onChange).toHaveBeenLastCalledWith("继续输入\n"));
  });

  it("applies external changes without echoing them as user edits", async () => {
    const initial = props("external");
    const view = render(<LiveMarkdownEditor {...initial} />);
    await getEditor();
    view.rerender(<LiveMarkdownEditor {...initial} value="## Remote update\n" />);
    expect(await screen.findByRole("heading", { level: 2 })).toHaveTextContent("Remote update");
    fireEvent.blur(await getEditor());
    await settleInput();
    expect(initial.onChange).not.toHaveBeenCalled();
  });

  it("keeps the live DOM, selection and scroll when the parent echoes an autosave", async () => {
    const change = vi.fn();
    function Echo() {
      const [value, setValue] = useState("Original\n");
      return <LiveMarkdownEditor {...props("echo")} value={value} onChange={(next) => { change(next); setValue(next); }} />;
    }
    render(<Echo />);
    const editor = await getEditor();
    typeText(editor, "Updated");
    const text = editor.querySelector("p")!.firstChild!;
    select(text, 2, 5);
    editor.scrollTop = 94;
    await waitFor(() => expect(change).toHaveBeenCalledWith("Updated\n"));
    expect(editor.querySelector("p")!.firstChild).toBe(text);
    expect(window.getSelection()?.anchorNode).toBe(text);
    expect(window.getSelection()?.toString()).toBe("dat");
    expect(editor.scrollTop).toBe(94);
  });

  it.each(["metaKey", "ctrlKey"])("%s+S prevents browser save and saves the latest DOM before debounce", async (modifier) => {
    const initial = props(`save-${modifier}`);
    render(<LiveMarkdownEditor {...initial} />);
    const editor = await getEditor();
    typeText(editor, "Save now");
    expect(fireEvent.keyDown(editor, { key: "s", [modifier]: true })).toBe(false);
    expect(initial.onSave).toHaveBeenLastCalledWith("Save now\n");
    expect(initial.onChange).toHaveBeenLastCalledWith("Save now\n");
  });

  it("saves untouched Markdown verbatim rather than Lute's normalized version", async () => {
    const initial = props("save-untouched", "hello");
    render(<LiveMarkdownEditor {...initial} />);
    fireEvent.keyDown(await getEditor(), { key: "s", ctrlKey: true });
    expect(initial.onSave).toHaveBeenCalledWith("hello");
    expect(initial.onChange).not.toHaveBeenCalled();
  });

  it("flushes pending input to the old session on a document switch, never the new callback", async () => {
    const first = props("switch-first");
    const second = props("switch-second", "Second\n");
    const view = render(<LiveMarkdownEditor {...first} />);
    typeText(await getEditor(), "Last keystroke");
    view.rerender(<LiveMarkdownEditor {...second} />);
    expect(first.onChange).toHaveBeenLastCalledWith("Last keystroke\n");
    expect(await getEditor()).toHaveTextContent("Second");
    await settleInput();
    expect(second.onChange).not.toHaveBeenCalled();
    expect(first.onChange).toHaveBeenCalledTimes(1);
  });

  it("flushes on blur and immediate unmount without later duplicate callbacks", async () => {
    const initial = props("unmount");
    const view = render(<LiveMarkdownEditor {...initial} />);
    const editor = await getEditor();
    typeText(editor, "Blurred");
    fireEvent.blur(editor);
    expect(initial.onChange).toHaveBeenLastCalledWith("Blurred\n");
    typeText(editor, "Unmounted");
    view.unmount();
    expect(initial.onChange).toHaveBeenLastCalledWith("Unmounted\n");
    await settleInput();
    expect(initial.onChange).toHaveBeenCalledTimes(2);
  });

  it("does not emit or save intermediate Chinese composition", async () => {
    const initial = props("ime");
    render(<LiveMarkdownEditor {...initial} />);
    const editor = await getEditor();
    select(editor.querySelector("p")!.firstChild!, 0);
    fireEvent.compositionStart(editor);
    typeText(editor, "中文输入");
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true, isComposing: true, keyCode: 229 });
    await settleInput();
    expect(initial.onChange).not.toHaveBeenCalled();
    expect(initial.onSave).not.toHaveBeenCalled();
    fireEvent.compositionEnd(editor, { data: "中文输入" });
    await waitFor(() => expect(initial.onChange).toHaveBeenCalledWith("中文输入\n"));
  });

  it("restores a session's real selection and scroll after remount", async () => {
    const initial = props("restore", "Selection\n");
    const view = render(<LiveMarkdownEditor {...initial} />);
    const editor = await getEditor();
    editor.focus();
    select(editor.querySelector("p")!.firstChild!, 1, 5);
    fireEvent(document, new Event("selectionchange"));
    editor.scrollTop = 123;
    fireEvent.scroll(editor);
    view.unmount();
    render(<LiveMarkdownEditor {...initial} />);
    const restored = await getEditor();
    expect(restored.scrollTop).toBe(123);
    expect(restored.contains(window.getSelection()!.anchorNode)).toBe(true);
    expect(window.getSelection()?.toString()).toBe("elec");
    expect(initial.onChange).not.toHaveBeenCalled();
  });

  it("restores selection across text nodes split by Vditor's undo recording", async () => {
    const initial = props("restore-edited");
    const view = render(<LiveMarkdownEditor {...initial} />);
    const editor = await getEditor();
    typeText(editor, "Edited selection");
    select(editor.querySelector("p")!.firstChild!, 2, 8);
    await waitFor(() => expect(initial.onChange).toHaveBeenCalledWith("Edited selection\n"));
    const selected = window.getSelection()!.toString();
    expect(selected).toBe("ited s");
    view.unmount();
    render(<LiveMarkdownEditor {...initial} value="Edited selection\n" />);
    const restored = await getEditor();
    expect(restored.contains(window.getSelection()!.anchorNode)).toBe(true);
    expect(window.getSelection()?.toString()).toBe("ited s");
  });

  it("survives StrictMode and a late Lute initialization after unmount", async () => {
    const initial = props("strict");
    const first = render(<StrictMode><LiveMarkdownEditor {...initial} /></StrictMode>);
    first.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(initial.onChange).not.toHaveBeenCalled();
    render(<StrictMode><LiveMarkdownEditor {...props("strict-next")} /></StrictMode>);
    expect(await getEditor()).toHaveTextContent("Original");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("loads only the bundled Lute asset and safely disposes a still-loading session", async () => {
    luteScript.remove();
    const initial = props("asset-loading");
    const view = render(<LiveMarkdownEditor {...initial} />);
    const script = document.head.querySelector<HTMLScriptElement>("script[src]")!;
    expect(script).not.toBeNull();
    expect(new URL(script.src).origin).toBe(window.location.origin);
    expect(script.src).toContain("lute.min.js");
    view.unmount();
    await act(async () => { fireEvent.load(script); });
    expect(initial.onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    render(<LiveMarkdownEditor {...props("asset-next")} />);
    expect(await getEditor()).toHaveTextContent("Original");
  });

  it("disables dropped/pasted file uploads", async () => {
    const initial = props("upload");
    const request = vi.spyOn(XMLHttpRequest.prototype, "open");
    render(<LiveMarkdownEditor {...initial} />);
    const editor = await getEditor();
    const files = [new File(["private"], "private.txt", { type: "text/plain" })];
    expect(fireEvent.drop(editor, { dataTransfer: { files, types: ["Files"] } })).toBe(false);
    expect(fireEvent.paste(editor, { clipboardData: { files, types: ["Files"] } })).toBe(false);
    await settleInput();
    expect(request).not.toHaveBeenCalled();
    expect(initial.onChange).not.toHaveBeenCalled();
  });

  it("routes relative links to the document callback without opening external windows", async () => {
    const navigate = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<LiveMarkdownEditor {...props("links", "[Related](notes/related.md) [Website](https://example.com)\n")} onNavigateDoc={navigate} />);
    const editor = await getEditor();
    const links = editor.querySelectorAll<HTMLElement>('[data-type="a"]');
    fireEvent.click(links[0]!);
    expect(navigate).toHaveBeenCalledWith("notes/related.md", "relative");
    fireEvent.click(links[1]!);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps diagram, math, emoji and highlighting dependencies offline", async () => {
    const resources: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const item of [node, ...node.querySelectorAll("script,link,img,iframe")]) {
          if (item.matches("script,link,img,iframe")) resources.push(item.getAttribute("src") ?? item.getAttribute("href") ?? "");
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, "open");
    const initial = props("offline", "# Math $x$\n\n[TOC]\n\n$x$\n\n$$\nx^2\n$$\n\n```plantuml\n@startuml\nAlice -> Bob: private\n@enduml\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n```js\nconst x = 1;\n```\n\n:custom_emoji:\n");
    const view = render(<LiveMarkdownEditor {...initial} />);
    await getEditor();
    await settleInput();
    view.rerender(<LiveMarkdownEditor {...initial} value={initial.value + "\nExternal update\n"} />);
    await settleInput();
    observer.disconnect();
    expect(resources.filter(Boolean)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
  });

  it("sanitizes active HTML and never opens javascript links", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const initial = props("xss", '<img src="x" onerror="window.__xss=1">\n\n<script>window.__xss=1</script>\n\n<iframe src="https://evil.invalid"></iframe>\n\n[bad](javascript:alert(1))\n');
    const view = render(<LiveMarkdownEditor {...initial} />);
    const editor = await getEditor();
    expect(view.container.querySelector("[onerror],script,iframe,a[href^='javascript:']")).toBeNull();
    typeText(editor, '<iframe src="https://evil.invalid/edited"></iframe>', 'code[data-type="html-block"]');
    await waitFor(() => expect(initial.onChange).toHaveBeenCalled());
    expect(initial.onChange.mock.lastCall?.[0]).toContain('<iframe src="https://evil.invalid/edited"></iframe>');
    expect(view.container.querySelector("[onerror],script,iframe,a[href^='javascript:']")).toBeNull();
    for (const link of editor.querySelectorAll<HTMLElement>('[data-type="a"],a')) fireEvent.click(link);
    expect(open).not.toHaveBeenCalled();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });
});

import { useLayoutEffect, useRef } from "react";
import Vditor from "vditor";
import luteUrl from "vditor/dist/js/lute/lute.min.js?url";
import "vditor/dist/js/i18n/zh_CN.js";
import "vditor/dist/index.css";
import "./LiveMarkdownEditor.css";

export interface LiveMarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: (value: string) => void;
  ariaLabel: string;
  sessionId: string;
  active?: boolean;
  onNavigateDoc?: (target: string, kind: "wikilink" | "relative") => void;
  onCompositionChange?: (active: boolean) => void;
}

type Point = { path: number[]; offset: number; textOffset: number };
type ViewState = {
  anchor?: Point;
  focus?: Point;
  scrollTop: number;
  scrollLeft: number;
};

const sessionViews = new Map<string, ViewState>();

function renderedOffset(root: Node, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

function pointIn(root: Node, node: Node | null, offset: number): Point | undefined {
  if (!node || !root.contains(node)) return undefined;
  const path: number[] = [];
  let current: Node = node;
  while (current !== root) {
    const parent: ParentNode | null = current.parentNode;
    if (!parent) return undefined;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }
  return { path, offset, textOffset: renderedOffset(root, node, offset) };
}

function resolvePoint(root: Node, point: Point): [Node, number] {
  let node: Node | undefined = root;
  for (const index of point.path) node = node?.childNodes[index];
  if (node) {
    const length = node.nodeType === Node.TEXT_NODE ? node.textContent?.length ?? 0 : node.childNodes.length;
    if (point.offset <= length && renderedOffset(root, node, point.offset) === point.textOffset) {
      return [node, point.offset];
    }
  }
  // Lute merges text nodes split by undo markers, invalidating saved DOM paths.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = point.textOffset;
  let last: Node = root;
  while (walker.nextNode()) {
    last = walker.currentNode;
    const length = last.textContent?.length ?? 0;
    if (remaining <= length) return [last, remaining];
    remaining -= length;
  }
  return [last, last === root ? 0 : last.textContent?.length ?? 0];
}

function rememberView(sessionId: string, editor: HTMLElement) {
  const selection = window.getSelection();
  const previous = sessionViews.get(sessionId);
  const anchor = pointIn(editor, selection?.anchorNode ?? null, selection?.anchorOffset ?? 0);
  const focus = pointIn(editor, selection?.focusNode ?? null, selection?.focusOffset ?? 0);
  sessionViews.delete(sessionId);
  sessionViews.set(sessionId, {
    anchor: anchor && focus ? anchor : previous?.anchor,
    focus: anchor && focus ? focus : previous?.focus,
    scrollTop: editor.scrollTop,
    scrollLeft: editor.scrollLeft,
  });
  if (sessionViews.size > 100) sessionViews.delete(sessionViews.keys().next().value!);
}

function restoreView(sessionId: string, editor: HTMLElement) {
  const view = sessionViews.get(sessionId);
  if (!view) return;
  const anchor = view.anchor && resolvePoint(editor, view.anchor);
  const focus = view.focus && resolvePoint(editor, view.focus);
  if (anchor && focus) {
    editor.focus({ preventScroll: true });
    window.getSelection()?.setBaseAndExtent(...anchor, ...focus);
  }
  editor.scrollTop = view.scrollTop;
  editor.scrollLeft = view.scrollLeft;
}

function destroyEditor(editor: Vditor) {
  // Vditor 4 destroy() leaves the IR input/undo debounce alive.
  window.clearTimeout(editor.vditor.ir?.processTimeoutId);
  window.clearTimeout(editor.vditor.ir?.hlToolbarTimeoutId);
  window.clearTimeout(editor.vditor.sv?.processTimeoutId);
  editor.destroy();
}

function withoutHtmlPreview(html: string): string {
  // Inert templates prevent preview frames loading before removal; keep their Markdown source.
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll('[data-type="html-block"]').forEach((block) => {
    block.querySelectorAll(".vditor-ir__preview").forEach((preview) => preview.remove());
    block.querySelectorAll(".vditor-ir__marker--pre").forEach((source) => source.classList.remove("vditor-ir__marker"));
  });
  return template.innerHTML;
}

type Session = {
  props: LiveMarkdownEditorProps;
  sync: () => void;
};

export function LiveMarkdownEditor(props: LiveMarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<Session | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current!;
    // Late async initialization must never reuse the next session's React-owned node.
    const host = document.createElement("div");
    host.className = "owb-live-markdown-editor__host";
    container.append(host);
    let disposed = false;
    let ready = false;
    let composing = false;
    let active = true;
    let seenValue = props.value;
    let markdown = props.value;
    let normalized = "";
    let lastReported: string | undefined;
    let editor: Vditor;
    const session: Session = { props, sync: () => {} };
    sessionRef.current = session;

    const flush = (leaving = false) => {
      if (!ready || disposed || (!leaving && (composing || session.props.active === false))) return markdown;
      const next = editor.getValue();
      if (next !== normalized) {
        normalized = next;
        markdown = next;
        lastReported = next;
        session.props.onChange(next);
      }
      return markdown;
    };

    session.sync = () => {
      if (!ready || disposed) return;
      const editable = editor.vditor.ir!.element;
      editable.setAttribute("aria-label", session.props.ariaLabel);
      const nextActive = session.props.active !== false;
      if (active !== nextActive) {
        active = nextActive;
        if (active) {
          editor.enable();
          restoreView(props.sessionId, editable);
        } else {
          rememberView(props.sessionId, editable);
          flush(true);
          if (composing) {
            composing = false;
            editor.vditor.ir!.composingLock = false;
            session.props.onCompositionChange?.(false);
          }
          editor.disabled();
          editable.blur();
        }
      }
      const next = session.props.value;
      if (next === seenValue || composing) return;
      seenValue = next;
      // setValue on a save acknowledgement would destroy the caret and active IME node.
      if (next === lastReported) return;
      editor.setValue(next, false);
      markdown = next;
      normalized = editor.getValue();
      lastReported = undefined;
    };

    const handleKey = (event: KeyboardEvent) => {
      if (!active) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const modifier = event.metaKey || event.ctrlKey;
      const save = modifier && !event.shiftKey && event.key.toLowerCase() === "s";
      const redo = modifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === "z";
      // These mode switches are hard-coded in Vditor even without toolbar items.
      const modeSwitch = modifier && event.altKey && /^Digit[7-9]$/.test(event.code);
      // Typora-style aliases; Vditor only registers ⌘⌥1-6 and ⌘D on its own.
      const heading = modifier && !event.shiftKey && !event.altKey && /^Digit[1-6]$/.test(event.code);
      const strike = modifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === "x";
      if (save || redo || modeSwitch || heading || strike) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (composing || event.isComposing || event.keyCode === 229) {
        // Preserve native IME behavior, but don't let formatting hotkeys reparse it.
        event.stopPropagation();
        return;
      }
      if (redo && ready) {
        editor.vditor.undo!.redo(editor.vditor);
        flush();
      }
      if (save && ready) session.props.onSave(flush());
      if (strike && ready) {
        // Dispatch through the hidden strike button, the same path ⌘D takes.
        const button = editor.vditor.toolbar?.elements?.strike?.children[0] as HTMLElement | undefined;
        button?.dispatchEvent(new CustomEvent("click"));
      }
      if (heading && ready) {
        // The hidden headings panel holds one button per level (h1-h6).
        const level = Number(event.code.replace("Digit", ""));
        const panel = editor.vditor.toolbar?.elements?.headings?.children[1];
        const button = panel?.children[level - 1] as HTMLElement | undefined;
        const sel = window.getSelection();
        (window as unknown as { __headingProbe: unknown }).__headingProbe = {
          level, tag: button?.getAttribute("data-tag"),
          selInside: sel?.anchorNode ? editor.vditor.ir!.element.contains(sel.anchorNode) : null,
          selText: sel?.anchorNode?.textContent?.slice(0, 24) ?? null,
          selCollapsed: sel?.isCollapsed ?? null,
          domAfter: undefined as unknown,
        };
        button?.dispatchEvent(new CustomEvent("click"));
        (window as unknown as { __headingProbe: { domAfter: unknown } }).__headingProbe.domAfter = editor.vditor.ir!.element.innerHTML.slice(0, 220);
        button?.dispatchEvent(new CustomEvent("click"));
      }
    };
    const compositionStart = () => {
      if (!active) return;
      composing = true;
      session.props.onCompositionChange?.(true);
    };
    const compositionEnd = () => {
      if (!active) return;
      composing = false;
      // A pending remote value must not overwrite the composition just committed by Vditor.
      seenValue = session.props.value;
      flush();
      session.props.onCompositionChange?.(false);
    };
    const input = () => { queueMicrotask(() => flush()); };
    const remember = () => {
      if (ready && active && !disposed && !composing) rememberView(props.sessionId, editor.vditor.ir!.element);
    };
    const blur = () => { remember(); flush(); };
    const preventFileUpload = (event: DragEvent | ClipboardEvent) => {
      const transfer = "clipboardData" in event ? event.clipboardData : event.dataTransfer;
      if (transfer?.files.length) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    host.addEventListener("keydown", handleKey, true);
    host.addEventListener("input", input, true);
    host.addEventListener("compositionstart", compositionStart, true);
    host.addEventListener("compositionend", compositionEnd);
    host.addEventListener("blur", blur, true);
    host.addEventListener("scroll", remember, true);
    host.addEventListener("drop", preventFileUpload, true);
    host.addEventListener("paste", preventFileUpload, true);
    document.addEventListener("selectionchange", remember);

    editor = new Vditor(host, {
      mode: "ir",
      // Configure HTML and math handling before rendering any untrusted content.
      value: "",
      _lutePath: luteUrl,
      cdn: "",
      i18n: window.VditorI18n,
      // Empty icon is supported at runtime but missing from Vditor's type union.
      icon: "" as IOptions["icon"],
      // Keep Vditor's formatting hotkeys registered, but no mode switch/upload.
      toolbar: ["headings", "bold", "italic", "strike", "link", "list", "ordered-list", "check", "outdent", "indent", "quote", "line", "code", "inline-code", "table"],
      toolbarConfig: { hide: true },
      height: "100%",
      minHeight: 0,
      cache: { enable: false },
      undoDelay: 50,
      hint: { emoji: {}, emojiPath: "", parse: false },
      upload: { url: "", linkToImgUrl: "" },
      image: { isPreview: false },
      link: {
        isOpen: false,
        click: (element) => {
          const target = element?.textContent?.trim() ?? "";
          if (target.startsWith("owb-wiki:")) {
            try { session.props.onNavigateDoc?.(decodeURIComponent(target.slice(9)), "wikilink"); } catch { /* Invalid encoded link. */ }
          } else if (target && !/^(?:[a-z][a-z\d+.-]*:|[\\/#])/i.test(target)) {
            session.props.onNavigateDoc?.(target, "relative");
          }
        },
      },
      preview: {
        mode: "editor",
        maxWidth: 884,
        actions: [],
        theme: { current: "light", path: "" },
        hljs: { enable: false },
        markdown: { codeBlockPreview: false, mathBlockPreview: false, sanitize: true, toc: false },
        render: { media: { enable: false } },
      },
      input: () => { flush(); },
      after: () => {
        if (disposed) {
          destroyEditor(editor);
          return;
        }
        // SetInlineMath is a real Lute API omitted from Vditor's declarations.
        const lute = editor.vditor.lute as typeof editor.vditor.lute & {
          SetInlineMath: (enabled: boolean) => void;
        };
        lute.SetInlineMath(false);
        // Lute's HTML preview flag misses SpinVditorIRDOM; filter every DOM insertion boundary.
        for (const method of ["Md2VditorIRDOM", "SpinVditorIRDOM", "HTML2VditorIRDOM"] as const) {
          const convert = lute[method].bind(lute);
          lute[method] = (source: string) => withoutHtmlPreview(convert(source));
        }
        editor.setValue(session.props.value, false);
        // Seed undo before the first keystroke can cancel Vditor's delayed initial snapshot.
        window.clearTimeout(editor.vditor.ir!.processTimeoutId);
        editor.vditor.undo!.addToUndoStack(editor.vditor);
        markdown = seenValue = session.props.value;
        ready = true;
        const editable = editor.vditor.ir!.element;
        editable.setAttribute("role", "textbox");
        editable.setAttribute("aria-multiline", "true");
        editable.setAttribute("aria-label", session.props.ariaLabel);
        // Normalization alone must never trigger autosave.
        normalized = editor.getValue();
        session.sync();
        if (active) restoreView(props.sessionId, editable);
      },
    });

    return () => {
      remember();
      flush(true);
      if (composing) session.props.onCompositionChange?.(false);
      disposed = true;
      document.removeEventListener("selectionchange", remember);
      host.removeEventListener("keydown", handleKey, true);
      host.removeEventListener("input", input, true);
      host.removeEventListener("compositionstart", compositionStart, true);
      host.removeEventListener("compositionend", compositionEnd);
      host.removeEventListener("blur", blur, true);
      host.removeEventListener("scroll", remember, true);
      host.removeEventListener("drop", preventFileUpload, true);
      host.removeEventListener("paste", preventFileUpload, true);
      if (ready) destroyEditor(editor);
      host.remove();
      if (sessionRef.current === session) sessionRef.current = null;
    };
    // Flush with this session's callbacks before accepting the next document's props.
  }, [props.sessionId]);

  useLayoutEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    session.props = props;
    session.sync();
  });

  return <div ref={containerRef} className="owb-live-markdown-editor" />;
}

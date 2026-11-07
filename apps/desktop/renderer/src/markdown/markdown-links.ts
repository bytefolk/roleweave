import type { Root, RootContent, PhrasingContent } from "mdast";
import type { Plugin } from "unified";

// GFM covers most bare URLs. Trim Chinese sentence punctuation too, and
// recognize a complete URL in inline code without rewriting code examples.
const URL_START = /^(?:https?:\/\/|www\.)/i;
const URL_TEXT = /(?:https?:\/\/|www\.)[^\s<>\u0000-\u001f，。；：！？、…“”‘’（）【】「」]+/gi;
function trimUrl(value: string): string {
  let result = value.replace(/[.,;:!?]+$/, "");
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
    while (result.endsWith(close!) && result.split(close!).length > result.split(open!).length) result = result.slice(0, -1);
  }
  return result;
}
function href(value: string): string { return /^www\./i.test(value) ? `https://${value}` : value; }

export const remarkResponseLinks: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file.value);
  function visit(parent: { children: RootContent[] }) {
    parent.children = parent.children.flatMap((node): RootContent[] => {
      if (node.type === "link") {
        const raw = source.slice(node.position?.start.offset, node.position?.end.offset);
        // Explicit Markdown links retain their destination exactly.
        if (!URL_START.test(raw)) return [node];
        const label = node.children.map(child => child.type === "text" ? child.value : "").join("");
        const match = label.match(URL_TEXT)?.[0];
        if (!match) return [node];
        const value = trimUrl(match);
        return [{ ...node, url: href(value), children: [{ type: "text", value }] },
          ...(value.length < label.length ? [{ type: "text" as const, value: label.slice(value.length) }] : [])];
      }
      if (node.type === "inlineCode") {
        if (!URL_START.test(node.value) && !/^mailto:/i.test(node.value)) return [node];
        if (/[\s<>\u0000-\u001f]/.test(node.value)) return [node];
        return [{ type: "link", url: href(node.value), children: [node] }];
      }
      if (node.type === "text") {
        const parts: PhrasingContent[] = [];
        let offset = 0;
        for (const match of node.value.matchAll(URL_TEXT)) {
          const index = match.index!;
          // Do not turn pieces of shell commands or relative paths into links.
          if (index > 0 && /[\w/\\@]/.test(node.value[index - 1]!)) continue;
          const value = trimUrl(match[0]);
          if (index > offset) parts.push({ type: "text", value: node.value.slice(offset, index) });
          parts.push({ type: "link", url: href(value), children: [{ type: "text", value }] });
          offset = index + value.length;
        }
        if (!offset) return [node];
        if (offset < node.value.length) parts.push({ type: "text", value: node.value.slice(offset) });
        return parts;
      }
      if ("children" in node) visit(node as { children: RootContent[] });
      return [node];
    });
  }
  visit(tree);
};

/** Display-only help for terse conversation replies, including saved plain
 * text: preserve line breaks and emphasize short field labels. */
export const remarkConversationPresentation: Plugin<[], Root> = () => tree => {
  function visit(node: Root | RootContent) {
    if (node.type === "paragraph") {
      let lineStart = true;
      node.children = node.children.flatMap((child): PhrasingContent[] => {
        if (child.type === "break") { lineStart = true; return [child]; }
        if (child.type !== "text") { lineStart = false; return [child]; }
        const parts: PhrasingContent[] = [];
        for (const [index, line] of child.value.split("\n").entries()) {
          if (index > 0) { parts.push({ type: "break" }); lineStart = true; }
          const label = lineStart ? /^([\p{L}\p{N} _-]{1,20}[：:])(?=[ \t]*(?:[^\s/]|$))/u.exec(line) : null;
          if (label) {
            parts.push({ type: "strong", children: [{ type: "text", value: label[1]! }] });
            if (label[0].length < line.length) parts.push({ type: "text", value: line.slice(label[0].length) });
          } else if (line) parts.push({ type: "text", value: line });
          lineStart = false;
        }
        return parts;
      });
      return;
    }
    if ("children" in node) for (const child of node.children) visit(child as RootContent);
  }
  visit(tree);
};

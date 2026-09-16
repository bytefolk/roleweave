import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, Text } from "mdast";
import type { Plugin } from "unified";

/** Compatibility is deliberately limited to unmatched, literal text nodes.
 * Code, HTML, already parsed emphasis and escaped source are never rewritten.
 * The raw string remains the authority for original-Markdown copying. */
export const remarkReadableEmphasis: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file.value);
  function visit(parent: { children: RootContent[] }) {
    parent.children = parent.children.flatMap(node => {
      if (node.type === "text") {
        const raw = source.slice(node.position?.start.offset, node.position?.end.offset);
        if (raw !== node.value || raw.includes("\\")) return [node];
        const parts: RootContent[] = [];
        const pattern = /\*\*([^*\n]+)\*\*/g;
        let end = 0;
        for (const match of raw.matchAll(pattern)) {
          const inner = match[1]!;
          // This narrowly covers CJK punctuation at emphasis boundaries.
          if (!/[\u3400-\u9fff]/u.test(inner) || inner.trimStart() !== inner || !inner.trim()) continue;
          if (match.index! > end) parts.push({ type: "text", value: raw.slice(end, match.index) });
          parts.push({ type: "strong", children: [{ type: "text", value: inner.trimEnd() }] });
          end = match.index! + match[0].length;
        }
        if (!end) return [node];
        if (end < raw.length) parts.push({ type: "text", value: raw.slice(end) });
        return parts;
      }
      if ("children" in node && node.type !== "strong" && node.type !== "emphasis") visit(node as { children: RootContent[] });
      return [node];
    });
  }
  visit(tree);
};

export const remarkHeadingIds: Plugin<[{ prefix?: string }?], Root> = (options) => tree => {
  const prefix = options?.prefix ?? "rw-heading";
  let index = 0;
  function visit(node: Root | RootContent) {
    if (node.type === "heading") node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: `${prefix}-${++index}` } };
    if ("children" in node) for (const child of node.children) visit(child as RootContent);
  }
  visit(tree);
};

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkReadableEmphasis).use(remarkHeadingIds);
function parsed(content: string): Root { return parser.runSync(parser.parse(content), { value: content }) as Root; }
function textOf(node: Root | RootContent): string {
  if (node.type === "html") return "";
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (node.type === "break") return "\n";
  if ("value" in node) return (node as Text).value;
  if (!("children" in node)) return "";
  const separator = ["root", "list", "blockquote", "listItem", "table"].includes(node.type) ? "\n" : node.type === "tableRow" ? "\t" : "";
  return node.children.map(child => textOf(child as RootContent)).join(separator);
}
export function markdownToPlainText(content: string): string { return textOf(parsed(content)); }
export function markdownHeadings(content: string, prefix = "rw-heading"): Array<{ id: string; text: string; level: number }> {
  const result: Array<{ id: string; text: string; level: number }> = [];
  function visit(node: Root | RootContent) {
    if (node.type === "heading") result.push({ id: `${prefix}-${result.length + 1}`, text: textOf(node), level: node.depth });
    if ("children" in node) for (const child of node.children) visit(child as RootContent);
  }
  visit(parsed(content));
  return result;
}

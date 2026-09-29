import { Children, isValidElement, useId, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check, FileCode2, FileJson2, FileText, Github, Globe2, Mail } from "lucide-react";
import { useT } from "@roleweave/ui";
import { useConversationCopy } from "../locales/conversation";
import { remarkReadableEmphasis, remarkHeadingIds } from "./markdown-content";
import "./markdown.css";
export { markdownHeadings, markdownToPlainText } from "./markdown-content";

export function safeMarkdownUrl(value: string): string {
  if (value.startsWith("#") || value.startsWith("owb-wiki:")) return value;
  const relativePath = value.split(/[?#]/, 1)[0] ?? "";
  if (
    relativePath !== "" &&
    !relativePath.startsWith("/") &&
    !relativePath.includes("\\") &&
    !relativePath.split("/").includes("..") &&
    /\.(?:c|cc|cpp|css|go|h|hpp|html|java|js|jsx|json|md|markdown|mjs|cjs|py|rb|rs|scss|sh|sql|toml|ts|tsx|txt|xml|ya?ml)$/i.test(relativePath)
  ) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password ? value : "";
  } catch { return ""; }
}

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

function remarkWikilinks() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === "link") return;
      if (node.children) {
        node.children = node.children.flatMap((child) => {
          if (child.type !== "text" || !child.value?.includes("[[")) {
            visit(child);
            return child;
          }
          const parts: MarkdownNode[] = [];
          const pattern = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;
          let offset = 0;
          for (const match of child.value.matchAll(pattern)) {
            const index = match.index ?? 0;
            if (index > offset) parts.push({ type: "text", value: child.value.slice(offset, index) });
            const target = match[1]!.trim();
            const label = (match[2] ?? match[1])!.trim();
            parts.push({
              type: "link",
              url: `owb-wiki:${encodeURIComponent(target)}`,
              children: [{ type: "text", value: label }],
            });
            offset = index + match[0].length;
          }
          if (offset < child.value.length) parts.push({ type: "text", value: child.value.slice(offset) });
          return parts.length > 0 ? parts : child;
        });
        for (const child of node.children) visit(child);
      }
    };
    visit(tree);
  };
}

const WORKSPACE_FILE_PATTERN = /((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:c|cc|cpp|css|go|h|hpp|html|java|js|jsx|json|md|markdown|mjs|cjs|py|rb|rs|scss|sh|sql|toml|ts|tsx|txt|xml|ya?ml))(?=$|[\s，。；：、)\]}'"`])/gi;

function remarkWorkspaceFilePaths() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === "link" || node.type === "code" || !node.children) return;
      node.children = node.children.flatMap((child) => {
        const candidate = child.type === "inlineCode" ? child.value : child.type === "text" ? child.value : undefined;
        if (!candidate?.includes("/")) { visit(child); return child; }
        if (child.type === "inlineCode" && !WORKSPACE_FILE_PATTERN.test(candidate)) {
          WORKSPACE_FILE_PATTERN.lastIndex = 0;
          return child;
        }
        WORKSPACE_FILE_PATTERN.lastIndex = 0;
        const valueText = candidate;
        const parts: MarkdownNode[] = [];
        let offset = 0;
        for (const match of valueText.matchAll(WORKSPACE_FILE_PATTERN)) {
          const value = match[1]!;
          const index = match.index ?? 0;
          if (index > offset) parts.push({ type: "text", value: valueText.slice(offset, index) });
          parts.push({ type: "link", url: value, children: [{ type: "text", value }] });
          offset = index + value.length;
        }
        if (offset === 0) return child;
        if (offset < valueText.length) parts.push({ type: "text", value: valueText.slice(offset) });
        return parts;
      });
    };
    visit(tree);
  };
}

function literalText(children: ReactNode): string {
  return Children.toArray(children).map(child => isValidElement<{ children?: ReactNode }>(child) ? literalText(child.props.children) : String(child)).join("");
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const copy = useConversationCopy();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const code = Children.toArray(children).find(isValidElement);
  const language = isValidElement<{ className?: string }>(code) ? code.props.className?.match(/language-(\S+)/)?.[1] : undefined;
  return <div className="owb-markdown-code">
    <div className="owb-markdown-code__toolbar"><span>{language ?? copy.code}</span>
      <button type="button" onClick={async () => {
        try { await navigator.clipboard.writeText(literalText(children).replace(/\n$/, "")); setState("copied"); }
        catch { setState("failed"); }
      }} aria-label={copy.copy}>{state === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{state === "copied" ? copy.copied : state === "failed" ? copy.copyFailed : copy.copy}</button>
    </div><pre>{children}</pre>
  </div>;
}
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const copy = useConversationCopy();
  const [failed, setFailed] = useState(false);
  return failed || !src ? <span className="owb-markdown-image-error" role="img" aria-label={alt || copy.imageFailed}>{copy.imageFailed}{alt ? ` · ${alt}` : ""}</span>
    : <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}
function linkIcon(href: string): ReactNode {
  if (href.startsWith("#")) return null;
  if (href.startsWith("mailto:")) return <Mail data-link-icon="mail" aria-hidden="true" />;
  try {
    const host = new URL(href).hostname.toLowerCase();
    if (host === "github.com" || host.endsWith(".github.com")) return <Github data-link-icon="github" aria-hidden="true" />;
    if (/^(?:docs|drive)\.google\.com$/.test(host) || host === "notion.so" || host.endsWith(".notion.site")) {
      return <FileText data-link-icon="document" aria-hidden="true" />;
    }
  } catch { return null; }
  return <Globe2 data-link-icon="website" aria-hidden="true" />;
}

function internalLinkIcon(target: string): ReactNode {
  const path = target.split(/[?#]/, 1)[0]!.toLowerCase();
  const normalized = path.includes(".") ? path : `${path}.md`;
  if (/\.(?:md|markdown)$/.test(normalized)) return <FileText data-link-icon="markdown" aria-hidden="true" />;
  if (/\.(?:json|ya?ml|toml)$/.test(normalized)) return <FileJson2 data-link-icon="data" aria-hidden="true" />;
  if (/\.(?:c|cc|cpp|css|go|h|hpp|html|java|js|jsx|mjs|cjs|py|rb|rs|scss|sh|sql|ts|tsx|xml)$/.test(normalized)) return <FileCode2 data-link-icon="code" aria-hidden="true" />;
  return <FileText data-link-icon="note" aria-hidden="true" />;
}

function MarkdownLink({
  href,
  children,
  onFailure,
  onNavigateDoc,
  noteAria,
}: {
  href: string;
  children: ReactNode;
  onFailure: () => void;
  onNavigateDoc?: (target: string, kind: "wikilink" | "relative") => void;
  noteAria: string;
}) {
  const wikilink = href.startsWith("owb-wiki:");
  const relative = !wikilink && !href.startsWith("#") && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(href);
  const internal = wikilink || relative;
  const external = !internal && !href.startsWith("#");
  const target = wikilink ? decodeURIComponent(href.slice("owb-wiki:".length)) : href;
  return <a className={internal || external ? "owb-markdown-link" : undefined} href={href}
    aria-label={internal ? noteAria : undefined}
    target={external ? "_blank" : undefined}
    rel={external ? "noopener noreferrer" : undefined} onClick={event => {
      if (internal) {
        event.preventDefault();
        onNavigateDoc?.(target, wikilink ? "wikilink" : "relative");
        return;
      }
      if (!external) return;
      const open = (window.owb as unknown as { openExternalUrl?: (url: string) => Promise<{ ok: boolean }> } | undefined)?.openExternalUrl;
      if (open) {
        event.preventDefault();
        void open(href).then(result => { if (!result.ok) onFailure(); }).catch(onFailure);
      }
    }}>
    {internal ? <span className="owb-markdown-link__icon">{internalLinkIcon(target)}</span> : null}
    {external ? <span className="owb-markdown-link__icon">{linkIcon(href)}</span> : null}
    <span className={internal || external ? "owb-markdown-link__text" : undefined}>{children}</span>
  </a>;
}

export interface MarkdownProps {
  content: string;
  className?: string;
  headingPrefix?: string;
  onNavigateDoc?: (target: string, kind: "wikilink" | "relative") => void;
}

export function Markdown({ content, className = "", headingPrefix, onNavigateDoc }: MarkdownProps) {
  const copy = useConversationCopy();
  const t = useT();
  const instance = useId();
  const prefix = headingPrefix ?? `rw-${instance.replace(/:/g, "")}-heading`;
  const [linkFailed, setLinkFailed] = useState(false);
  return <div className={`owb-markdown ${className}`}>
    <ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkWikilinks, remarkWorkspaceFilePaths, remarkReadableEmphasis, [remarkHeadingIds, { prefix }]]} urlTransform={safeMarkdownUrl}
      components={{
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        table: ({ children }) => <div className="owb-markdown-table" tabIndex={0}><table>{children}</table></div>,
        img: ({ src, alt }) => <MarkdownImage key={src} src={src} alt={alt} />,
        input: ({ checked }) => <input type="checkbox" checked={checked ?? false} readOnly disabled />,
        a: ({ href, children }) => href ? (
          <MarkdownLink
            href={href}
            onFailure={() => setLinkFailed(true)}
            onNavigateDoc={onNavigateDoc}
            noteAria={t("docs.noteLinkAria", { label: literalText(children) })}
          >
            {children}
          </MarkdownLink>
        ) : <span>{children}</span>,
      }}>{content}</ReactMarkdown>
    {linkFailed ? <p role="alert" className="owb-markdown-error">{copy.openFailed}</p> : null}
  </div>;
}

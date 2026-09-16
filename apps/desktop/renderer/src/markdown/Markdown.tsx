import { Children, isValidElement, useId, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import { useConversationCopy } from "../locales/conversation";
import { remarkReadableEmphasis, remarkHeadingIds } from "./markdown-content";
import "./markdown.css";
export { markdownHeadings, markdownToPlainText } from "./markdown-content";

export function safeMarkdownUrl(value: string): string {
  if (value.startsWith("#")) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password ? value : "";
  } catch { return ""; }
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
export function Markdown({ content, className = "", headingPrefix }: { content: string; className?: string; headingPrefix?: string }) {
  const copy = useConversationCopy();
  const instance = useId();
  const prefix = headingPrefix ?? `rw-${instance.replace(/:/g, "")}-heading`;
  const [linkFailed, setLinkFailed] = useState(false);
  return <div className={`owb-markdown ${className}`}>
    <ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkReadableEmphasis, [remarkHeadingIds, { prefix }]]} urlTransform={safeMarkdownUrl}
      components={{
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        table: ({ children }) => <div className="owb-markdown-table" tabIndex={0}><table>{children}</table></div>,
        img: ({ src, alt }) => <MarkdownImage key={src} src={src} alt={alt} />,
        input: ({ checked }) => <input type="checkbox" checked={checked ?? false} readOnly disabled />,
        a: ({ href, children }) => href ? <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer" onClick={event => {
          if (href.startsWith("#")) return;
          const open = (window.owb as unknown as { openExternalUrl?: (url: string) => Promise<{ ok: boolean }> } | undefined)?.openExternalUrl;
          if (open) {
            event.preventDefault();
            void open(href).then(result => setLinkFailed(!result.ok)).catch(() => setLinkFailed(true));
          }
        }}>{children}</a> : <span>{children}</span>,
      }}>{content}</ReactMarkdown>
    {linkFailed ? <p role="alert" className="owb-markdown-error">{copy.openFailed}</p> : null}
  </div>;
}

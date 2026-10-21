import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dropdown, Tooltip } from "antd";
import { Check, Copy, Pencil, ChevronDown } from "lucide-react";
import { useConversationCopy } from "../locales/conversation";
import type { TurnRecord } from "./types";
import { SavedAttachmentCard } from "./AttachmentCard";
export function MessageActions({ raw, plain, onEdit }: { raw: string; plain?: string; onEdit?: (text: string) => void }) {
  const copy = useConversationCopy();
  const [status, setStatus] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const copyButton = useRef<HTMLButtonElement>(null);
  const messageVersion = useRef({ raw, plain });
  useLayoutEffect(() => { messageVersion.current = { raw, plain }; setStatus(""); }, [raw, plain]);
  useEffect(() => {
    if (!menuOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      copyButton.current?.focus();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [menuOpen]);
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 2400);
    return () => clearTimeout(timer);
  }, [status]);
  async function write(value: string) {
    const version = messageVersion.current;
    try { await navigator.clipboard.writeText(value); if (messageVersion.current === version) setStatus(copy.copied); }
    catch { if (messageVersion.current === version) setStatus(copy.copyFailed); }
  }
  return <div className="owb-message-actions">
    {plain === undefined ? <Tooltip title={status || copy.copy} trigger={["hover", "focus"]}>
      <button type="button" aria-label={copy.copy} onClick={() => void write(raw)}>{status === copy.copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}</button>
    </Tooltip> : <Tooltip title={status || copy.copy} trigger={["hover", "focus"]} open={menuOpen ? false : undefined}>
      <span className="owb-message-actions__trigger"><Dropdown trigger={["click"]} open={menuOpen} onOpenChange={setMenuOpen} menu={{ items: [{ key: "plain", label: copy.copyPlain }, { key: "raw", label: copy.copyMarkdown }], onClick: ({ key }) => { setMenuOpen(false); void write(key === "raw" ? raw : plain); } }}>
        <button ref={copyButton} type="button" aria-label={copy.copy} aria-haspopup="menu" aria-expanded={menuOpen}>{status === copy.copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}<ChevronDown size={10} aria-hidden="true" /></button>
      </Dropdown></span>
    </Tooltip>}
    {onEdit ? <Tooltip title={copy.edit} trigger={["hover", "focus"]}><button type="button" aria-label={copy.edit} onClick={() => onEdit(raw)}><Pencil size={15} aria-hidden="true" /></button></Tooltip> : null}
    <span className="owb-message-actions__feedback" role="status">{status}</span>
  </div>;
}
export function OperatorMessage({ turn, onEdit }: { turn: TurnRecord; onEdit?: (text: string) => void }) {
  const copy = useConversationCopy();
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(turn.input.split("\n").length > 12);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const height = parseFloat(getComputedStyle(node).lineHeight) || 26;
      setLong(turn.input.split("\n").length > 12 || node.scrollHeight > height * 12 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [turn.input]);
  return <>
    <p ref={ref} className={`owb-bubble__text${!expanded ? " owb-message-collapsible" : ""}`}>{turn.input}</p>
    {turn.attachments && turn.attachments.length > 0 ? (
      <div className="owb-attachment-strip owb-attachment-strip--saved">
        {turn.attachments.map((att) => <SavedAttachmentCard key={att.id} attachment={att} />)}
      </div>
    ) : null}
    {long ? <button className="owb-message-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? copy.collapse : copy.expand}</button> : null}
    <div className="owb-message-meta"><time dateTime={turn.createdAt}>{new Date(turn.createdAt).toLocaleTimeString()}</time><MessageActions raw={turn.input} onEdit={onEdit} /></div>
  </>;
}

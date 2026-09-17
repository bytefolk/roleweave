import { useLayoutEffect, useRef, useState } from "react";
import { Dropdown } from "antd";
import { Copy, Pencil, ChevronDown } from "lucide-react";
import { useConversationCopy } from "../locales/conversation";
import type { TurnRecord } from "./types";
import { SavedAttachmentCard } from "./AttachmentCard";
export function MessageActions({ raw, plain, onEdit }: { raw: string; plain?: string; onEdit?: (text: string) => void }) {
  const copy = useConversationCopy();
  const [status, setStatus] = useState("");
  async function write(value: string) {
    try { await navigator.clipboard.writeText(value); setStatus(copy.copied); }
    catch { setStatus(copy.copyFailed); }
  }
  return <div className="owb-message-actions">
    {plain === undefined ? <button type="button" onClick={() => void write(raw)}><Copy size={13} aria-hidden="true" />{copy.copy}</button> : <Dropdown trigger={["click"]} menu={{ items: [{ key: "plain", label: copy.copyPlain }, { key: "raw", label: copy.copyMarkdown }], onClick: ({ key }) => void write(key === "raw" ? raw : plain) }}>
      <button type="button"><Copy size={13} aria-hidden="true" />{copy.copy}<ChevronDown size={12} aria-hidden="true" /></button>
    </Dropdown>}
    {onEdit ? <button type="button" onClick={() => onEdit(raw)}><Pencil size={13} aria-hidden="true" />{copy.edit}</button> : null}
    {status ? <span role="status">{status}</span> : null}
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
    <p ref={ref} className={`owb-bubble__text${!expanded ? " owb-message-collapsible" : ""}`} title={turn.input}>{turn.input}</p>
    {turn.attachments && turn.attachments.length > 0 ? (
      <div className="owb-attachment-strip owb-attachment-strip--saved">
        {turn.attachments.map((att) => <SavedAttachmentCard key={att.id} attachment={att} />)}
      </div>
    ) : null}
    {long ? <button className="owb-message-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? copy.collapse : copy.expand}</button> : null}
    <div className="owb-message-meta"><time dateTime={turn.createdAt}>{new Date(turn.createdAt).toLocaleTimeString()}</time><MessageActions raw={turn.input} onEdit={onEdit} /></div>
  </>;
}

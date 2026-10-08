import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Popover, Tooltip } from "antd";
import { NotebookPen } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { TurnRecord } from "./types";
import "./turn-note.css";

export function TurnNoteAction({ turn, onCreated }: { turn: TurnRecord; onCreated?: (uri: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sources, setSources] = useState<Array<{ noteId: string; path: string; ref: string; version: string; excerpt: string }>>([]);
  const alive = useRef(true);
  const lock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let current = true; setSources([]);
    if (typeof window.owb.vault?.used !== "function") return;
    void window.owb.vault.used({ positionId: turn.positionId, turnId: turn.id }).then((response) => {
      if (!current || response.status < 200 || response.status >= 300 || !Array.isArray(response.body?.notes)) return;
      setSources(response.body.notes.filter((note) => typeof note.path === "string" && typeof note.excerpt === "string" && /^vault:\/\/notes\/[A-Za-z0-9-]{1,128}$/.test(note.ref)));
    }).catch(() => { /* A missing old receipt does not claim knowledge was used. */ });
    return () => { current = false; };
  }, [turn.id, turn.positionId]);
  async function save() {
    if (lock.current || !name.trim()) { if (!name.trim()) setError(t("docs.nameRequired")); return; }
    lock.current = true; setBusy(true); setError(undefined);
    try {
      const path = /\.(md|markdown)$/i.test(name.trim()) ? name.trim() : `${name.trim()}.md`;
      const result = await window.owb.vault.fromTurn({ positionId: turn.positionId, turnId: turn.id, path, content });
      if (!alive.current) return;
      if (result.status < 200 || result.status >= 300) throw new Error((result.body as unknown as { message?: string })?.message ?? t("vault.saveTurnFail"));
      setOpen(false); onCreated?.(result.body.note.ref.uri);
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : t("vault.saveTurnFail")); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <>
    {sources.length ? <Popover trigger="click" placement="top" title={t("vault.usedTitle")} content={<div className="owb-turn-note-sources">
      <p>{t("vault.usedHint")}</p>
      {sources.map((source) => <article key={source.noteId}><Button type="link" size="small" onClick={() => onCreated?.(source.ref)}>{source.path}</Button><pre>{source.excerpt}</pre></article>)}
    </div>}><Button size="small" type="text" aria-label={t("vault.usedCount", { count: sources.length })}>{t("vault.usedCount", { count: sources.length })}</Button></Popover> : null}
    <Tooltip title={t("vault.saveTurn")}><button type="button" aria-label={t("vault.saveTurn")} onClick={() => {
      setName(`${turn.input.split("\n")[0]!.slice(0, 60).replace(/[<>:"/\\|?*]/g, " ").trim() || t("vault.turnNote")}-${turn.id.slice(0, 8)}`);
      setContent(turn.output ?? ""); setError(undefined); setOpen(true);
    }}><NotebookPen size={15} aria-hidden="true" /></button></Tooltip>
    <Modal title={t("vault.saveTurn")} open={open} onCancel={() => { if (!busy) setOpen(false); }} footer={[
      <Button key="cancel" disabled={busy} onClick={() => setOpen(false)}>{t("dlg.cancel")}</Button>,
      <Button key="save" type="primary" loading={busy} onClick={() => void save()}>{t("vault.saveNote")}</Button>,
    ]} maskClosable={!busy} closable={!busy}>
      <p>{t("vault.saveTurnHint")}</p>
      <Input aria-label={t("vault.nameAria")} value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
      <Input.TextArea aria-label={t("memory.content")} rows={10} value={content} onChange={(event) => setContent(event.target.value)} disabled={busy} />
      {error ? <Alert type="error" title={error} /> : null}
    </Modal>
  </>;
}

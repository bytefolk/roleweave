import { useEffect, useState } from "react";
import { Alert, Button, Empty, Select, Spin, Tag } from "antd";
import { useT } from "@roleweave/ui";
import type { WorkbenchSession, TurnRecord } from "@roleweave/shared";

/** Durable local history, not an invented long-term memory or cross-employee feed. */
export function SessionMemory({ positionId, onContinue }: {
  positionId: string | null;
  onContinue?: (positionId: string, sessionId: string) => void;
}) {
  const t = useT();
  const [sessions, setSessions] = useState<WorkbenchSession[]>([]);
  const [selected, setSelected] = useState<string>();
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setSessions([]); setSelected(undefined); setError(false);
    if (!positionId) return;
    setLoading(true);
    void window.owb.sessions(positionId).then((res) => {
      if (!alive) return;
      if (res.status !== 200) throw new Error();
      setSessions(res.body.sessions);
      setSelected(res.body.activeSessionId ?? res.body.sessions[0]?.sessionId);
    }).catch(() => { if (alive) setError(true); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [positionId]);
  useEffect(() => {
    let alive = true;
    setTurns([]);
    if (!selected) return;
    setLoading(true); setError(false);
    void window.owb.sessionTurnHistory(selected).then((res) => {
      if (!alive) return;
      if (res.status !== 200) throw new Error();
      setTurns(res.body.turns);
    }).catch(() => { if (alive) setError(true); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [selected]);
  if (!positionId) return <Empty description={t("memory.pickEmployee")} />;
  const session = sessions.find((entry) => entry.sessionId === selected);
  return <div className="owb-session-memory">
    <div className="owb-session-memory__toolbar"><Select aria-label={t("memory.sessionPicker")} value={selected} onChange={setSelected} placeholder={t("memory.sessionPicker")}
      options={sessions.map((entry, index) => ({ value: entry.sessionId, label: `${t("memory.sessionNumber", { count: index + 1 })} · ${new Date(entry.createdAt).toLocaleDateString()}${entry.status === "active" ? ` · ${t("memory.current")}` : ""}` }))} />
      {session ? <Tag>{t(session.threadContextEnabled === false ? "model.contextOff" : "model.contextOn")}</Tag> : null}
      {onContinue ? <Button disabled={!selected || session?.status !== "active"} onClick={() => { if (selected) onContinue(positionId, selected); }}>{t("memory.continue")}</Button> : null}</div>
    <p className="owb-muted">{t("model.contextLimit")}</p>
    {loading ? <Spin /> : error ? <Alert type="error" title={t("memory.historyError")} /> : turns.length === 0 ? <Empty description={t("memory.historyEmpty")} /> :
      <div className="owb-memory-history">{turns.map((turn) => <article key={turn.turnId}>
        <header><time>{new Date(turn.createdAt).toLocaleString()}</time><span>{turn.model ?? turn.engine}</span><Tag>{t(`turn.status.${turn.status}`)}</Tag></header>
        <h3>{turn.input}</h3>
        {turn.threadContext ? <p>{t("model.lastContext", { count: turn.threadContext.sourceTurnCount, bytes: turn.threadContext.contextBytes.toLocaleString() })}</p> : <p>{t("model.noContextReceipt")}</p>}
        {turn.threadContext?.truncated ? <p>{t("model.contextTrimmed", { count: turn.threadContext.omittedTurnCount })}</p> : null}
        {turn.output !== undefined ? <details><summary>{t("memory.showAnswer")}</summary><pre>{typeof turn.output === "string" ? turn.output : JSON.stringify(turn.output, null, 2)}</pre></details> : null}
      </article>)}</div>}
  </div>;
}

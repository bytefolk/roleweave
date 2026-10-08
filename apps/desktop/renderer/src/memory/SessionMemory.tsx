import { useEffect, useState } from "react";
import { Alert, Button, Empty, Select, Spin, Tooltip } from "antd";
import { ArrowRight, ChevronDown, Layers3 } from "lucide-react";
import { useOwbLocale, useT } from "@roleweave/ui";
import type { WorkbenchSession, TurnRecord } from "@roleweave/shared";

function savedOutput(output: unknown): string | undefined {
  if (output === undefined || (typeof output === "string" && !output.trim())) return undefined;
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

/** Durable local history, not an invented long-term memory or cross-employee feed. */
export function SessionMemory({ positionId, onContinue }: {
  positionId: string | null;
  onContinue?: (positionId: string, sessionId: string) => void;
}) {
  const t = useT();
  const locale = useOwbLocale() === "en" ? "en-US" : "zh-CN";
  const [sessions, setSessions] = useState<WorkbenchSession[]>([]);
  const [selected, setSelected] = useState<string>();
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [loadedPositionId, setLoadedPositionId] = useState<string | null>(null);
  const [historySessionId, setHistorySessionId] = useState<string>();
  const [listError, setListError] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setSessions([]); setSelected(undefined); setListError(false); setLoadedPositionId(null);
    setListLoading(Boolean(positionId));
    if (!positionId) return;
    void window.owb.sessions(positionId).then((res) => {
      if (!alive) return;
      if (res.status !== 200) throw new Error();
      setSessions(res.body.sessions);
      setLoadedPositionId(positionId);
      setSelected(res.body.activeSessionId ?? res.body.sessions[0]?.sessionId);
    }).catch(() => { if (alive) setListError(true); }).finally(() => { if (alive) setListLoading(false); });
    return () => { alive = false; };
  }, [positionId]);
  useEffect(() => {
    let alive = true;
    setTurns([]); setHistorySessionId(undefined); setHistoryError(false); setHistoryLoading(false);
    if (!selected || !positionId || loadedPositionId !== positionId) return;
    setHistoryLoading(true);
    void window.owb.sessionTurnHistory(selected).then((res) => {
      if (!alive) return;
      if (res.status !== 200) throw new Error();
      setTurns(res.body.turns);
      setHistorySessionId(selected);
    }).catch(() => { if (alive) setHistoryError(true); }).finally(() => { if (alive) setHistoryLoading(false); });
    return () => { alive = false; };
  }, [selected, positionId, loadedPositionId]);
  if (!positionId) return <Empty description={t("memory.pickEmployee")} />;
  const ownedSessions = loadedPositionId === positionId ? sessions : [];
  const session = ownedSessions.find((entry) => entry.sessionId === selected && entry.positionId === positionId);
  const error = listError || historyError;
  const loading = listLoading || historyLoading || (!listError && loadedPositionId !== positionId)
    || Boolean(session && !historyError && historySessionId !== selected);
  const visibleTurns = session && historySessionId === selected ? turns : [];
  const canContinue = session?.status === "active" && !listLoading && !listError;
  const enabled = session?.threadContextEnabled !== false;
  return <div className="owb-session-memory owb-session-memory--compact" aria-busy={loading}>
    <div className="owb-session-memory__toolbar">
      <Select className="owb-session-memory__picker" aria-label={t("memory.sessionPicker")}
        value={session?.sessionId} onChange={setSelected} placeholder={t("memory.sessionPicker")}
        disabled={listLoading || ownedSessions.length === 0} loading={listLoading} popupMatchSelectWidth={300}
        options={ownedSessions.map((entry, index) => ({ value: entry.sessionId, title: "",
          label: `${t("memory.sessionNumber", { count: index + 1 })} · ${new Date(entry.createdAt).toLocaleDateString(locale)}${entry.status === "active" ? ` · ${t("memory.current")}` : ""}` }))} />
      {session ? <Tooltip trigger={["hover", "focus"]} title={<div className="owb-session-memory__context-tip">
        <strong>{t(enabled ? "memory.contextEnabled" : "memory.contextDisabled")}</strong>
        <p>{t("model.contextLimit")}</p>
        {!enabled ? <p>{t("model.contextOffHint")}</p> : null}
        <p>{t("model.contextScope")}</p>
      </div>}>
        <Button className="owb-session-memory__context" type="text" aria-label={t("memory.contextStatus")}
          icon={<Layers3 size={14} aria-hidden="true" />}>{t(enabled ? "model.contextOn" : "model.contextOff")}</Button>
      </Tooltip> : null}
      {onContinue ? <Tooltip trigger={["hover", "focus"]} title={canContinue ? t("memory.continue") : loading ? t("memory.historyLoading") : t("memory.continueReadonly")}>
        <span className="owb-session-memory__continue-trigger" tabIndex={!canContinue ? 0 : undefined}>
          <Button className="owb-session-memory__continue" type="text" disabled={!canContinue} icon={<ArrowRight size={14} aria-hidden="true" />}
            onClick={() => { if (canContinue && session) onContinue(positionId, session.sessionId); }}>{t("memory.continue")}</Button>
        </span>
      </Tooltip> : null}
    </div>
    {loading ? <div className="owb-session-memory__loading" role="status" aria-label={t("memory.historyLoading")}><Spin /></div> : error ? <Alert type="error" title={t("memory.historyError")} /> : visibleTurns.length === 0 ? <Empty description={t("memory.historyEmpty")} /> :
      <div className="owb-memory-history">{visibleTurns.map((turn) => {
        const output = savedOutput(turn.output);
        const receipt = turn.threadContext;
        const included = receipt && receipt.sourceTurnCount > 0 && receipt.contextBytes > 0;
        return <article className="owb-session-memory__turn" key={turn.turnId}>
        <header>
          <time dateTime={turn.createdAt}>{new Date(turn.createdAt).toLocaleString(locale, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
          <span className="owb-session-memory__model">{turn.model ?? turn.engine}</span>
          <span className="owb-session-memory__status" data-status={turn.status}>{t(`turn.status.${turn.status}`)}</span>
          <Tooltip trigger={["hover", "focus"]} title={<div className="owb-session-memory__context-tip">
            <strong>{t("memory.contextReceipt")}</strong>
            {receipt ? <>
              <p>{t(receipt.enabled ? "memory.contextEnabled" : "memory.contextDisabled")}</p>
              <p>{t("memory.contextIncluded", { count: receipt.sourceTurnCount, bytes: receipt.contextBytes.toLocaleString(locale) })}</p>
              {receipt.truncated ? <p>{t("memory.contextTrimmed", { count: receipt.omittedTurnCount })}</p> : null}
            </> : <p>{t("model.noContextReceipt")}</p>}
            <p>{t("model.contextScope")}</p>
          </div>}>
            <Button className={`owb-session-memory__receipt${receipt?.truncated ? " is-truncated" : ""}`} type="text"
              aria-label={t("memory.contextReceipt")} icon={<Layers3 size={13} aria-hidden="true" />} />
          </Tooltip>
        </header>
        <h3>{turn.input}</h3>
        {included ? <p className="owb-session-memory__included">{t("memory.contextIncluded", { count: receipt.sourceTurnCount, bytes: receipt.contextBytes.toLocaleString(locale) })}</p> : null}
        {receipt?.truncated ? <p className="owb-session-memory__trimmed">{t("memory.contextTrimmed", { count: receipt.omittedTurnCount })}</p> : null}
        {output !== undefined ? <details><summary><ChevronDown size={13} aria-hidden="true" />{t("memory.showAnswer")}</summary><pre>{output}</pre></details>
          : <p className="owb-session-memory__no-answer">{t("memory.noSavedAnswer")}</p>}
      </article>;
      })}</div>}
  </div>;
}

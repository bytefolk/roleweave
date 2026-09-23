import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Tag } from "antd";
import type { EscalationEntry, ReportsAdviceResponse } from "@roleweave/shared";
import { EXPERIMENTS_CHANGED, useWorkspaceExperiments, type ExperimentScope } from "../experiments/useWorkspaceExperiments";
import { useExperimentCopy } from "../locales/experiments";
import "../experiments/experiments.css";

const key = (item: { turnId: string; positionId: string; at: string }) => JSON.stringify([item.turnId, item.positionId, item.at]);

export function useReportAdvice(scope: ExperimentScope, entries: EscalationEntry[]) {
  const settings = useWorkspaceExperiments(scope);
  const signature = JSON.stringify(entries.map(entry => [key(entry), entry.code, entry.budgetRelated]));
  const owner = useMemo(() => ({}), [settings.owner, settings.snapshot?.workspaceSession, settings.snapshot?.revision, settings.snapshot?.enabled, signature]);
  const activeOwner = useRef(owner); activeOwner.current = owner;
  const version = useRef(0);
  const [result, setResult] = useState<{ owner: object; value: ReportsAdviceResponse } | null>(null);
  const [pendingOwner, setPendingOwner] = useState<object | null>(null);
  const [errorOwner, setErrorOwner] = useState<object | null>(null);
  const [staleOwner, setStaleOwner] = useState<object | null>(null);
  useEffect(() => {
    // Revocation invalidates even a response that races the next render.
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ workspacePath: string }>).detail?.workspacePath === scope.workspacePath) { ++version.current; setResult(null); setPendingOwner(null); }
    };
    window.addEventListener(EXPERIMENTS_CHANGED, changed);
    return () => { ++version.current; window.removeEventListener(EXPERIMENTS_CHANGED, changed); };
  }, [owner, scope.workspacePath]);
  async function generate() {
    const snapshot = settings.snapshot;
    if (!snapshot?.enabled || snapshot.availability !== "ready" || !entries.length || pendingOwner === owner || !window.owb.reportAdvice) return;
    const request = ++version.current;
    const current = () => settings.current() && activeOwner.current === owner && request === version.current;
    setPendingOwner(owner); setErrorOwner(null); setStaleOwner(null); setResult(null);
    try {
      const { workspacePath, workspaceSession, revision } = snapshot;
      const response = await window.owb.reportAdvice({ workspacePath, workspaceSession, revision });
      if (!current()) return;
      if (response.status === 409) { setStaleOwner(settings.owner); await settings.refresh(); return; }
      if (response.status !== 200 || response.body.workspacePath !== workspacePath || response.body.workspaceSession !== workspaceSession || response.body.revision !== revision || response.body.status !== "ready") throw Error("advice unavailable");
      setResult({ owner, value: response.body });
    } catch { if (current()) setErrorOwner(owner); }
    finally { if (current()) setPendingOwner(null); }
  }
  const value = result?.owner === owner ? result.value : null;
  const items = new Map(value?.items.filter(item => entries.some(entry => key(entry) === key(item))).map(item => [key(item), item]));
  return { settings, generate, value, items, loading: pendingOwner === owner, failed: errorOwner === owner, stale: staleOwner === settings.owner, count: entries.length };
}

export function ReportAdviceControls({ controller, onOpenSettings }: { controller: ReturnType<typeof useReportAdvice>; onOpenSettings?: () => void }) {
  const c = useExperimentCopy();
  const { settings, loading, failed, count, value } = controller;
  const snapshot = settings.snapshot;
  const ready = snapshot?.enabled && snapshot.availability === "ready";
  const unavailable = !!snapshot && (snapshot.availability === "storage_error" || (snapshot.enabled && !snapshot.provider.configured));
  return <section className="owb-report-advice" aria-label={c("reportTitle")}>
    <header className="owb-report-advice__heading"><h2>{c("reportTitle")}</h2><Tag>{c("preview")}</Tag>
      {ready ? <Button size="small" aria-label={c(loading ? "generating" : failed ? "retry" : value ? "generateAgain" : "generate")} loading={loading} disabled={count === 0} onClick={() => void controller.generate()}>{c(loading ? "generating" : failed ? "retry" : value ? "generateAgain" : "generate")}</Button> : onOpenSettings ? <Button size="small" onClick={onOpenSettings}>{c("openSettings")}</Button> : null}
    </header>
    <p>{c(settings.loading ? "loading" : ready ? count ? "reportIntro" : "noFailures" : snapshot?.enabled ? "enabledUnavailable" : "reportOff")}</p>
    {ready ? <p className="owb-report-advice__meta">{c("incomplete")}</p> : null}
    {settings.error ? <Alert type="warning" showIcon title={c("loadError")} action={<Button size="small" onClick={() => void settings.refresh()}>{c("retry")}</Button>} /> : null}
    {unavailable ? <Alert type="warning" showIcon title={c(snapshot?.availability === "storage_error" ? "storageError" : "unavailable")} /> : null}
    {failed ? <Alert type="warning" showIcon title={c("adviceFailed")} action={<Button size="small" onClick={() => void settings.refresh()}>{c("refresh")}</Button>} /> : null}
    {controller.stale ? <Alert type="info" showIcon title={c("stale")} /> : null}
    {value ? <p role="status" className="owb-report-advice__meta">{c("results").replace("{considered}", String(value.considered)).replace("{total}", String(value.total)).replace("{count}", String(controller.items.size))}{value.cached ? ` · ${c("cached")}` : ""}</p> : null}
  </section>;
}

export function ReportAdviceChip({ advice }: { advice?: ReportsAdviceResponse["items"][number] }) {
  const c = useExperimentCopy();
  if (!advice) return null;
  return <div className="owb-report-advice-chip"><Tag>{c("suggestion")} · {c(advice.suggestion)}</Tag></div>;
}
export const reportAdviceKey = key;

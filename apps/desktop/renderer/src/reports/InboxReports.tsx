import { useState } from "react";
import { Alert, Button, Input, Select, Table, Tag } from "antd";
import { useOwbLocale, useT } from "@roleweave/ui";
import type { AuditEntry, EvidenceEntry, EscalationEntry, ReportsResponse } from "@roleweave/shared";
import type { AuditTimelineEvent } from "./AuditTimeline";
import type { ReportsCenterProps } from "./ReportsCenter";
import { ClipboardList } from "lucide-react";
import type { ApprovalQueueItem } from "../approvals/types";
import { ReportAdviceChip, reportAdviceKey, type useReportAdvice } from "./ReportAdvice";
import { engineLabel } from "../turns/engine-contract";

type SourceLink = ReportsCenterProps["onOpenTurn"];
type TraceLink = (positionId: string, turnId?: string) => void;
export function evidenceKey(entry: { positionId: string; turnId: string }): string {
  return JSON.stringify([entry.positionId, entry.turnId]);
}

export interface InboxReportFilters { query: string; position: string; status: string; date: string }

export function ReportFilters({ value, onChange, positionNames, reports, updatedAt, tab }: {
  value: InboxReportFilters; onChange: (value: InboxReportFilters) => void;
  positionNames?: Record<string, string>; reports: ReportsResponse; updatedAt?: string; tab: string;
}) {
  const t = useT();
  const locale = useOwbLocale();
  const roles = [...new Set([...reports.budgets.map(b => b.positionId), ...reports.streams.evidence.map(e => e.positionId), ...reports.streams.escalations.map(e => e.positionId)])];
  const statuses = tab === "budgets" ? ["within", "exceeded", "unobserved"] : tab === "audits" ? ["granted", "denied", "completed", "failed", "indeterminate"] : ["completed", "running", "failed", "indeterminate"];
  return <div className="owb-inbox-filters" role="group" aria-label={t("inbox.reportFilters")}>
    {tab !== "budgets" ? <Input type="date" aria-label={t("inbox.dateFilter")} value={value.date} onChange={e => onChange({ ...value, date: e.target.value })} /> : null}
    <Select allowClear value={value.position || undefined} aria-label={t("inbox.roleFilter")} placeholder={t("apr.filterPosition")} options={roles.map(id => ({ value: id, label: positionNames?.[id] ?? id }))} onChange={position => onChange({ ...value, position: position ?? "" })} />
    <Select allowClear value={value.status || undefined} aria-label={t("rep.executionStatus")} placeholder={t("rep.allStatuses")} options={statuses.map(status => ({ value: status, label: tab === "budgets" ? t(`rep.state${status === "within" ? "Within" : status === "exceeded" ? "Exceeded" : "Unobserved"}`) : status === "granted" || status === "denied" ? t(`apr.status.${status}`) : t(`inbox.status.${status}`) }))} onChange={status => onChange({ ...value, status: status ?? "" })} />
    <Input allowClear className="owb-inbox-filters__search" aria-label={t("inbox.searchReports")} placeholder={t("inbox.searchReports")} value={value.query} onChange={e => onChange({ ...value, query: e.target.value })} />
    {updatedAt ? <time dateTime={updatedAt} title={updatedAt}>{new Date(updatedAt).toLocaleTimeString(locale === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })} {t("inbox.updated")}</time> : null}
  </div>;
}

export function RunInspector({ entry, positionNames, onOpenTurn, onOpenTimeline }: { entry?: EvidenceEntry; positionNames?: Record<string, string>; onOpenTurn?: SourceLink; onOpenTimeline: TraceLink }) {
  const t = useT();
  const elapsed = entry && entry.status !== "running" ? Date.parse(entry.updatedAt) - Date.parse(entry.createdAt) : NaN;
  return <aside className="owb-inbox-inspector" aria-label={t("inbox.evidenceTitle")}>
    <header><h2>{t("inbox.evidenceTitle")}</h2>{entry ? <Tag color={entry.status === "completed" ? "success" : entry.status === "failed" ? "error" : "default"}>{t(`inbox.status.${entry.status}`)}</Tag> : null}</header>
    {entry ? <><h3>{entry.runId ?? entry.turnId}</h3><p>{positionNames?.[entry.positionId] ?? entry.positionId} · {engineLabel(entry.engine)}</p>
      <dl><div><dt>{t("inbox.runId")}</dt><dd><code>{entry.runId ?? "—"}</code></dd></div><div><dt>{t("apr.sourceTurn")}</dt><dd><code>{entry.turnId}</code></dd></div><div><dt>{t("inbox.usage")}</dt><dd>{entry.usage.totalTokens.toLocaleString()} Token</dd></div><div><dt>{t("inbox.duration")}</dt><dd>{Number.isFinite(elapsed) && elapsed >= 0 ? `${Math.round(elapsed / 1000)} s` : "—"}</dd></div></dl>
      <section className="owb-inbox-result"><strong>{t("inbox.result")}</strong><p>{t(`inbox.status.${entry.status}`)}{entry.errorCode ? ` · ${entry.errorCode}` : ""}</p></section>
      <p className="owb-muted">{t("inbox.artifactUnavailable")}</p>
      <footer>{onOpenTurn ? <Button onClick={() => onOpenTurn({ positionId: entry.positionId, conversationId: entry.conversationId, turnId: entry.turnId })}>{t("apr.openSource")}</Button> : null}<Button onClick={() => onOpenTimeline(entry.positionId, entry.turnId)}>{t("rep.tabTimeline")}</Button></footer>
    </> : <p>{t("inbox.selectRecord")}</p>}
  </aside>;
}

export function ExceptionWorkbench({ entries, evidence, evidenceByTurn, positionNames, onOpenTimeline, onOpenTurn, advice }: {
  entries: EscalationEntry[]; evidence: EvidenceEntry[]; evidenceByTurn: Map<string, EvidenceEntry>;
  positionNames?: Record<string, string>; onOpenTimeline: TraceLink; onOpenTurn?: SourceLink;
  advice: ReturnType<typeof useReportAdvice>["items"];
}) {
  const t = useT();
  const locale = useOwbLocale() === "en" ? "en-US" : "zh-CN";
  const [selectedId, setSelectedId] = useState<string>();
  // Merge on the source identity: a receipt may fail without producing an escalation.
  const rows = [...entries.map(e => ({ positionId: e.positionId, turnId: e.turnId, code: e.code, status: e.status, at: e.at, escalation: e })),
    ...evidence.filter(e => (e.status === "failed" || e.status === "indeterminate") && !entries.some(x => x.turnId === e.turnId && x.positionId === e.positionId)).map(e => ({ positionId: e.positionId, turnId: e.turnId, code: e.errorCode, status: e.status, at: e.updatedAt, escalation: undefined }))]
    .sort((a, b) => b.at.localeCompare(a.at));
  const selected = rows.find(e => evidenceKey(e) === selectedId) ?? rows[0];
  const receipt = selected ? evidenceByTurn.get(evidenceKey(selected)) : undefined;
  if (!selected) return <p className="owb-report-empty">{t("rep.noEscalations")}</p>;
  return <div className="owb-inbox-report-split owb-inbox-exceptions"><section className="owb-inbox-exception-list" aria-label={t("rep.tabEscalations")}>
    {rows.map(row => <button type="button" key={evidenceKey(row)} className={row === selected ? "is-selected" : ""} aria-pressed={row === selected} onClick={() => setSelectedId(evidenceKey(row))}><strong>{row.code ?? t(`inbox.status.${row.status}`)}</strong><span>{positionNames?.[row.positionId] ?? row.positionId} · {row.turnId}</span><time dateTime={row.at}>{formatTime(row.at, locale)}</time><Tag color="error">{t(`inbox.status.${row.status}`)}</Tag></button>)}
  </section><aside className="owb-inbox-inspector" aria-label={t("inbox.exceptionDetail")}><header><h2>{t("inbox.exceptionDetail")}</h2><Tag color="error">{t(`inbox.status.${selected.status}`)}</Tag></header><h3>{selected.code ?? t(`inbox.status.${selected.status}`)}</h3><p>{positionNames?.[selected.positionId] ?? selected.positionId}</p><dl><div><dt>{t("inbox.errorCode")}</dt><dd><code>{selected.code ?? "—"}</code></dd></div><div><dt>{t("inbox.runId")}</dt><dd><code>{receipt?.runId ?? selected.turnId}</code></dd></div></dl>
    <section className="owb-inbox-result"><strong>{t("inbox.recoverySuggestion")}</strong><p>{t("inbox.recoveryHint")}</p></section>
    {selected.escalation ? <ReportAdviceChip advice={advice.get(reportAdviceKey(selected.escalation))} /> : null}
    {onOpenTurn ? receipt ? <Button type="primary" aria-label={t("rep.openTurnNamed", { turnId: selected.turnId })} onClick={() => onOpenTurn({ positionId: receipt.positionId, conversationId: receipt.conversationId, turnId: receipt.turnId })}>{t("rep.openTurn")}</Button> : <span className="owb-muted">{t("rep.turnUnavailable")}</span> : null}
    <Alert type="info" title={t("inbox.recoveryReceiptHint")} />
    <footer><Button onClick={() => onOpenTimeline(selected.positionId, selected.turnId)}>{t("rep.traceRun")}</Button></footer>
  </aside></div>;
}

export function AuditRecords({ entries, positionNames, evidence = [], approvals = [], onOpenApproval, onOpenTimeline }: { entries: AuditEntry[]; evidence?: EvidenceEntry[]; approvals?: ApprovalQueueItem[]; onOpenApproval?: (id: string) => void; onOpenTimeline?: TraceLink; positionNames?: Record<string, string> }) {
  const t = useT();
  const locale = useOwbLocale() === "en" ? "en-US" : "zh-CN";
  type Row = { id: string; at: string; type: string; actor: string; result: string; audit?: AuditEntry; approval?: ApprovalQueueItem; receipt?: EvidenceEntry };
  const rows: Row[] = [
    ...entries.map((a, index) => ({ id: `org:${a.at}:${index}`, at: a.at, type: t("rep.tabAudits"), actor: a.actor, result: a.bootstrapped ? t("inbox.bootstrapped") : t("inbox.recorded"), audit: a })),
    ...approvals.flatMap(a => (a.decision.kind === "granted" || a.decision.kind === "denied") && a.decision.decidedAt ? [{ id: `approval:${a.approvalId}`, at: a.decision.decidedAt, type: t("apr.lifecycleApproval"), actor: a.decision.decidedBy ?? "—", result: t(`apr.status.${a.decision.kind}`), approval: a }] : []),
    ...evidence.filter(e => e.status !== "running").map(e => ({ id: `receipt:${e.positionId}:${e.turnId}`, at: e.updatedAt, type: t("inbox.executionReceipt"), actor: positionNames?.[e.positionId] ?? e.positionId, result: t(`inbox.status.${e.status}`), receipt: e })),
  ].sort((a,b) => b.at.localeCompare(a.at));
  return <><p className="owb-report-scope">{t("inbox.auditSources")}</p><Table<Row> rowKey="id" size="middle" dataSource={rows} scroll={{ x: 650 }} pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }} locale={{ emptyText: t("rep.noAudits") }} columns={[
    { title: t("rep.updatedAt"), dataIndex: "at", key: "at", render: at => <time>{new Date(at).toLocaleString(locale, { hour12: false })}</time> },
    { title: t("inbox.auditType"), dataIndex: "type", key: "type", render: type => <Tag>{type}</Tag> },
    { title: t("inbox.auditAction"), key: "action", render: (_, row) => row.audit ? <ul className="owb-inbox-audit-cell"><AuditRow entry={row.audit} positionNames={positionNames} localeTag={locale} /></ul> : row.approval ? <Button type="link" disabled={!onOpenApproval} onClick={() => onOpenApproval?.(row.approval!.approvalId)}>{row.approval.description}</Button> : <Button type="link" disabled={!onOpenTimeline} onClick={() => onOpenTimeline?.(row.receipt!.positionId, row.receipt!.turnId)}>{row.receipt?.runId ?? row.receipt?.turnId}</Button> },
    { title: t("inbox.actor"), dataIndex: "actor", key: "actor" },
    { title: t("inbox.result"), dataIndex: "result", key: "result" },
  ]} /></>;
}

export function RunSummary({ evidence, events, onOpenTurn, onOpenEvidence }: { evidence?: EvidenceEntry; events: AuditTimelineEvent[]; onOpenTurn?: SourceLink; onOpenEvidence: (positionId: string, turnId: string) => void }) {
  const t = useT();
  return <aside className="owb-inbox-inspector"><header><h2>{t("inbox.runSummary")}</h2></header>{evidence ? <><h3>{evidence.runId ?? evidence.turnId}</h3><Tag>{t(`inbox.status.${evidence.status}`)}</Tag><dl><div><dt>{t("inbox.usage")}</dt><dd>{evidence.usage.totalTokens.toLocaleString()} Token</dd></div><div><dt>{t("inbox.events")}</dt><dd>{events.length}</dd></div></dl><footer>{onOpenTurn ? <Button onClick={() => onOpenTurn({ positionId: evidence.positionId, conversationId: evidence.conversationId, turnId: evidence.turnId })}>{t("apr.openSource")}</Button> : null}<Button onClick={() => onOpenEvidence(evidence.positionId, evidence.turnId)}>{t("apr.openEvidence")}</Button></footer></> : <><p>{t("inbox.selectRunHint")}</p><strong>{events.length} {t("inbox.events")}</strong></>}</aside>;
}

function AuditRow({ entry, positionNames, localeTag }: { entry: AuditEntry; positionNames?: Record<string, string>; localeTag: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const nameOf = (id: string) => positionNames?.[id] ?? id;
  const parentOf = (id: string | null) => (id === null ? t("rep.noParent") : nameOf(id));
  const groups = [
    { key: "hired", label: t("rep.changeHired"), count: entry.changes.hired.length },
    { key: "moved", label: t("rep.changeMoved"), count: entry.changes.moved.length },
    { key: "dismissed", label: t("rep.changeDismissed"), count: entry.changes.dismissed.length },
    { key: "budget", label: t("rep.changeBudget"), count: entry.changes.budgetUpdated.length },
  ];
  const live = groups.filter((group) => group.count > 0);
  const summary = t("rep.auditSummary", {
    hired: entry.changes.hired.length,
    moved: entry.changes.moved.length,
    dismissed: entry.changes.dismissed.length,
    budget: entry.changes.budgetUpdated.length,
  });
  return (
    <li className={`owb-report-card owb-report-card--expandable${open ? " is-open" : ""}`}>
      <ClipboardList aria-hidden="true" size={16} />
      <div>
        <header><strong>{entry.actor}</strong><time title={formatTime(entry.at, localeTag)}>{formatRelativeTime(entry.at, localeTag, t)}</time></header>
        <div className="owb-report-chips" title={summary}>
          {live.length === 0
            ? <span className="owb-report-chip is-muted">{t("rep.noSubstantiveChanges")}</span>
            : live.map((group) => <span className="owb-report-chip" key={group.key}>{group.label} {group.count}</span>)}
          <small>{t("rep.auditPositions", { count: entry.positionCount })}</small>
        </div>
        {live.length > 0 ? (
          <button type="button" className="owb-report-expand" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t("rep.collapseChanges") : t("rep.expandChanges")}
          </button>
        ) : null}
        {open && live.length > 0 ? (
          <div className="owb-report-changes">
            {entry.changes.hired.length > 0 ? (
              <section><h4>{t("rep.changeHired")}</h4><ul>{entry.changes.hired.map((role) => <li key={role.id}>{nameOf(role.id)}</li>)}</ul></section>
            ) : null}
            {entry.changes.moved.length > 0 ? (
              <section><h4>{t("rep.changeMoved")}</h4><ul>{entry.changes.moved.map((move) => <li key={move.id}>{nameOf(move.id)}<span className="owb-report-move">{parentOf(move.from)} → {parentOf(move.to)}</span></li>)}</ul></section>
            ) : null}
            {entry.changes.dismissed.length > 0 ? (
              <section><h4>{t("rep.changeDismissed")}</h4><ul>{entry.changes.dismissed.map((role) => <li key={role.id}>{nameOf(role.id)}</li>)}</ul></section>
            ) : null}
            {entry.changes.budgetUpdated.length > 0 ? (
              <section><h4>{t("rep.changeBudget")}</h4><ul>{entry.changes.budgetUpdated.map((id) => <li key={id}>{nameOf(id)}</li>)}</ul></section>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}


function formatTime(value: string, locale: string) { return new Date(value).toLocaleString(locale, { hour12: false }); }
function formatRelativeTime(value: string, locale: string, _t: unknown) { return formatTime(value, locale); }

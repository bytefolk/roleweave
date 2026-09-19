import { useMemo, useState } from "react";
import { Button, Input, Select, Skeleton, Table, Tag } from "antd";
import { useOwbLocale, useT, type OwbT } from "@roleweave/ui";
import type { AuditEntry, EvidenceEntry, EscalationEntry, ReportsResponse } from "@roleweave/shared";
import { AlertOctagon, ClipboardList, RefreshCw } from "lucide-react";
import { BudgetDashboard } from "./BudgetDashboard";
import { AuditTimeline, type AuditTimelineEvent } from "./AuditTimeline";

type Tab = "budgets" | "escalations" | "audits" | "evidence" | "timeline";

export interface ReportsCenterProps {
  onRefresh?: () => void;
  reports: ReportsResponse | null;
  loading: boolean;
  positionNames?: Record<string, string>;
  positionColors?: Record<string, string>;
  onOpenTimeline?: (positionId: string) => void;
}

export function ReportsCenter({ reports, loading, positionNames, positionColors, onOpenTimeline, onRefresh }: ReportsCenterProps) {
  const t = useT();
  const timelineEvents = useMemo<AuditTimelineEvent[]>(
    () => (reports ? buildTimelineEventsFromReports(reports, t) : []),
    [reports, t],
  );
  // Prefer a stream with real facts on first open. Landing on an empty
  // escalation tab made a healthy workspace look broken and hid the evidence
  // that explains what this module is for.
  const [tabOverride, setTabOverride] = useState<Tab | null>(null);
  const [timelinePosition, setTimelinePosition] = useState<string | null>(null);
  if (loading && !reports) return <section className="owb-reports" aria-label={t("rep.loading")}><Skeleton active paragraph={{ rows: 6 }} /></section>;
  if (!reports) return <section className="owb-reports"><p className="owb-muted">{t("rep.unavailable")}</p>{onRefresh ? <Button onClick={onRefresh}>{t("rep.refresh")}</Button> : null}</section>;
  const tab = tabOverride ?? firstReportTab(reports, timelineEvents.length);
  const total = reports.budgets.reduce((sum, budget) => sum + budget.recorded.totalTokens, 0);
  const exceptions = new Set([...reports.streams.escalations.map((item) => item.turnId), ...reports.streams.evidence.filter((item) => item.status === "failed" || item.status === "indeterminate").map((item) => item.turnId)]).size;
  const completed = reports.streams.evidence.filter((item) => item.status === "completed").length;
  const hasObservedUsage = reports.budgets.some((budget) => budget.latestTurn !== null);
  const filteredTimeline = timelinePosition ? timelineEvents.filter((event) => event.positionId === timelinePosition) : timelineEvents;
  const openTimeline = (positionId: string) => { setTimelinePosition(positionId); setTabOverride("timeline"); };
  return (
    <section className="owb-reports" aria-label={t("rep.center")}>
      <header className="owb-reports__hero">
        <div className="owb-reports__hero-copy">
          <h1>{t("rep.center")}</h1>
          <p>{t("rep.lede")}</p>
        </div>
        {onRefresh ? <Button icon={<RefreshCw size={14} />} loading={loading} onClick={onRefresh}>{t("rep.refresh")}</Button> : null}
      </header>
      <div className="owb-report-overview" role="group" aria-label={t("rep.overview")}>
        <SummaryMetric label={t("rep.recordedTokenTotal")} value={hasObservedUsage ? total.toLocaleString() : "—"} detail={t("rep.usageScope")} onClick={() => setTabOverride("budgets")} />
        <SummaryMetric label={t("rep.runCount")} value={reports.streams.evidence.length.toLocaleString()} detail={t("rep.completedCount", { count: completed })} onClick={() => setTabOverride("evidence")} />
        <SummaryMetric label={t("rep.exceptionCount")} value={exceptions.toLocaleString()} detail={t("rep.exceptionHint")} warning={exceptions > 0} onClick={() => setTabOverride("escalations")} />
        <SummaryMetric label={t("rep.employeeCount")} value={reports.budgets.length.toLocaleString()} detail={t("rep.observedCount", { count: reports.budgets.filter((budget) => budget.latestTurn !== null).length })} onClick={() => setTabOverride("budgets")} />
      </div>
      <p className="owb-report-scope">{t("rep.scopeHint")}{reports.page.hasMore ? ` ${t("rep.partialSnapshot")}` : ""}</p>
      <nav className="owb-report-tabs" aria-label={t("rep.streamsAria")}>
        <TabButton active={tab === "budgets"} onClick={() => setTabOverride("budgets")} label={t("rep.tabBudgets")} count={reports.budgets.length} />
        <TabButton active={tab === "evidence"} onClick={() => setTabOverride("evidence")} label={t("rep.tabEvidence")} count={reports.streams.evidence.length} />
        <TabButton active={!["budgets", "evidence"].includes(tab)} onClick={() => setTabOverride("escalations")} label={t("rep.governance")} count={exceptions} />
      </nav>
      {!["budgets", "evidence"].includes(tab) ? <nav className="owb-report-subtabs" aria-label={t("rep.governance")}>
        <TabButton active={tab === "escalations"} onClick={() => setTabOverride("escalations")} label={t("rep.tabEscalations")} count={reports.streams.escalations.length} />
        <TabButton active={tab === "audits"} onClick={() => setTabOverride("audits")} label={t("rep.tabAudits")} count={reports.streams.audits.length} />
        <TabButton active={tab === "timeline"} onClick={() => { setTimelinePosition(null); setTabOverride("timeline"); }} label={t("rep.tabTimeline")} count={timelineEvents.length} />
      </nav> : null}
      <div className="owb-report-stream" role="tabpanel" aria-label={t("rep.streamTabpanelAria", { tab: tabLabel(tab, t) })}>
        {tab === "budgets" ? (
          <BudgetDashboard
            compact
            budgets={reports.budgets}
            escalations={reports.streams.escalations}
            positionNames={positionNames}
            positionColors={positionColors}
            onOpenTimeline={openTimeline}
          />
        ) : null}
        {tab === "escalations" ? <Escalations entries={reports.streams.escalations} positionNames={positionNames} /> : null}
        {tab === "audits" ? <Audits entries={reports.streams.audits} /> : null}
        {tab === "evidence" ? <Evidence entries={reports.streams.evidence} positionNames={positionNames} onOpenTimeline={openTimeline} /> : null}
        {tab === "timeline" && timelinePosition ? <div className="owb-report-filter-note"><span>{positionNames?.[timelinePosition] ?? timelinePosition}</span><Button type="link" onClick={() => setTimelinePosition(null)}>{t("rep.clearScope")}</Button></div> : null}
        {tab === "timeline" ? (
          <AuditTimeline
            events={filteredTimeline}
            positionNames={positionNames}
            page={{
              cursor: reports.page.cursor,
              hasMore: reports.page.hasMore,
              total: filteredTimeline.length,
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

function firstReportTab(reports: ReportsResponse, timelineCount: number): Tab {
  if (reports.streams.escalations.length > 0) return "escalations";
  if (reports.streams.evidence.length > 0) return "evidence";
  if (reports.streams.audits.length > 0) return "audits";
  if (timelineCount > 0) return "timeline";
  return "budgets";
}

function tabLabel(tab: Tab, t: OwbT): string {
  return {
    budgets: t("rep.tabBudgets"),
    escalations: t("rep.tabEscalations"),
    audits: t("rep.tabAudits"),
    evidence: t("rep.tabEvidence"),
    timeline: t("rep.tabTimeline"),
  }[tab];
}

function SummaryMetric({ label, value, detail, warning = false, onClick }: { label: string; value: string; detail: string; warning?: boolean; onClick: () => void }) {
  return <button type="button" className={`owb-report-metric${warning ? " is-warning" : ""}`} onClick={onClick} aria-label={label}>
    <span>{label}</span><strong>{value}</strong><small>{detail}</small>
  </button>;
}

/**
 * v1 timeline projection: fold `reports.streams` into the unified timeline event shape.
 * The full three-source merge (TurnRecord.events / SSE live / org-audit.v1) lands in
 * the data plane; this projection keeps the UI honest to the fields we already carry.
 */
function buildTimelineEventsFromReports(reports: ReportsResponse, t: OwbT): AuditTimelineEvent[] {
  const events: AuditTimelineEvent[] = [];
  const evidenceByRun = new Map<string, EvidenceEntry>();
  const evidenceByTurn = new Map<string, EvidenceEntry>();
  for (const evidence of reports.streams.evidence) {
    if (evidence.runId) evidenceByRun.set(evidence.runId, evidence);
    evidenceByTurn.set(evidence.turnId, evidence);
  }
  for (const evidence of reports.streams.evidence) {
    const runId = evidence.runId ?? evidence.turnId;
    events.push({
      id: `evidence:started:${evidence.turnId}`,
      at: evidence.createdAt,
      runId,
      positionId: evidence.positionId,
      engine: evidence.engine,
      type: "run.started",
      task: undefined,
    });
    const terminalType: AuditTimelineEvent["type"] =
      evidence.status === "completed"
        ? "run.completed"
        : evidence.status === "failed"
          ? "run.failed"
          : evidence.status === "indeterminate"
            ? "turn.indeterminate"
            : "run.started";
    if (evidence.status !== "running") events.push({
      id: `evidence:terminal:${evidence.turnId}`,
      at: evidence.updatedAt,
      runId,
      positionId: evidence.positionId,
      engine: evidence.engine,
      type: terminalType,
      errorCode: evidence.errorCode,
      envelopeDigest: evidence.envelopeDigest,
      totalTokens: evidence.usage.totalTokens,
      summary: `${evidenceStatusLabel(evidence.status, t)} · ${evidence.usage.totalTokens.toLocaleString()} tokens`,
    });
  }
  for (const escalation of reports.streams.escalations) {
    const runId = evidenceByTurn.get(escalation.turnId)?.runId ?? escalation.turnId;
    events.push({
      id: `escalation:${escalation.turnId}:${escalation.at}`,
      at: escalation.at,
      runId,
      positionId: escalation.positionId,
      type: "escalation.created",
      errorCode: escalation.code,
      budgetRelated: escalation.budgetRelated,
      reportingChain: escalation.reportingChain,
      summary: escalation.budgetRelated ? t("rep.budgetRelated") : t("rep.eventEscalation"),
    });
  }
  reports.streams.audits.forEach((audit, index) => {
    events.push({
      id: `audit:${audit.at}:${index}`,
      at: audit.at,
      runId: `audit-${audit.at}-${index}`,
      type: "org.audit",
      summary: t("rep.auditTimelineSummary", {
        actor: audit.actor,
        hired: audit.changes.hired.length,
        moved: audit.changes.moved.length,
        dismissed: audit.changes.dismissed.length,
        budget: audit.changes.budgetUpdated.length,
        count: audit.positionCount,
      }),
    });
  });
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events;
}

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return <button type="button" aria-pressed={active} onClick={onClick}>{label}<span>{count}</span></button>;
}

function Empty({ text }: { text: string }) { return <p className="owb-report-empty">{text}</p>; }

function Escalations({ entries, positionNames }: { entries: EscalationEntry[]; positionNames?: Record<string, string> }) {
  const t = useT();
  const localeTag = useLocaleTag();
  if (entries.length === 0) return <Empty text={t("rep.noEscalations")} />;
  return <ol>{entries.map((entry) => {
    const summary = entry.budgetRelated ? t("rep.budgetRelated") : t("rep.eventEscalation");
    return <li className="owb-report-card is-escalation" key={entry.turnId}><AlertOctagon aria-hidden="true" size={16} /><div><header><strong>{positionNames?.[entry.positionId] ?? t("rep.unknownPosition")}</strong><time>{formatTime(entry.at, localeTag)}</time></header><p className="owb-clamp-2" title={summary}>{summary}</p><div className="owb-report-chain">{entry.reportingChain.map((position, index) => <span key={position} style={{ borderLeftWidth: Math.min(index + 1, 4) }}>{positionNames?.[position] ?? t("rep.unknownPosition")}</span>)}</div></div></li>;
  })}</ol>;
}

function Audits({ entries }: { entries: AuditEntry[] }) {
  const t = useT();
  const localeTag = useLocaleTag();
  if (entries.length === 0) return <Empty text={t("rep.noAudits")} />;
  return <ol>{entries.map((entry, index) => {
    const summary = t("rep.auditSummary", {
      hired: entry.changes.hired.length,
      moved: entry.changes.moved.length,
      dismissed: entry.changes.dismissed.length,
      budget: entry.changes.budgetUpdated.length,
    });
    return <li className="owb-report-card" key={`${entry.at}-${index}`}><ClipboardList aria-hidden="true" size={16} /><div><header><strong>{entry.actor}</strong><time>{formatTime(entry.at, localeTag)}</time></header><p className="owb-clamp-2" title={summary}>{summary}</p><small>{t("rep.auditPositions", { count: entry.positionCount })}</small></div></li>;
  })}</ol>;
}

function Evidence({ entries, positionNames, onOpenTimeline }: { entries: EvidenceEntry[]; positionNames?: Record<string, string>; onOpenTimeline: (id: string) => void }) {
  const t = useT();
  const localeTag = useLocaleTag();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const filtered = entries.filter((entry) => (status === "all" || entry.status === status) && `${positionNames?.[entry.positionId] ?? entry.positionId} ${entry.engine}`.toLowerCase().includes(query.trim().toLowerCase()));
  const rows = [...filtered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (entries.length === 0) return <Empty text={t("rep.noEvidence")} />;
  return <div className="owb-execution-records"><div className="owb-report-toolbar">
    <Input allowClear aria-label={t("rep.searchExecutions")} placeholder={t("rep.searchExecutions")} value={query} onChange={(event) => setQuery(event.target.value)} />
    <Select aria-label={t("rep.executionStatus")} value={status} onChange={setStatus} options={[{ value: "all", label: t("rep.allStatuses") }, ...["completed", "running", "failed", "indeterminate"].map((value) => ({ value, label: evidenceStatusLabel(value, t) }))]} />
    <span>{t("rep.recordCount", { count: rows.length })}</span>
  </div><Table<EvidenceEntry> rowKey="turnId" size="middle" dataSource={rows} scroll={{ x: 670 }} pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }} locale={{ emptyText: t("rep.noMatchingExecutions") }} columns={[
    { title: t("rep.colPosition"), key: "position", render: (_, entry) => <strong>{positionNames?.[entry.positionId] ?? entry.positionId}</strong> },
    { title: "Agent", dataIndex: "engine", key: "engine", render: (engine: string) => engine.startsWith("codex") ? "Codex" : engine.startsWith("claude") ? "Claude Code" : engine === "gemini" ? "Gemini" : "Qoder" },
    { title: t("rep.executionStatus"), key: "status", render: (_, entry) => <Tag color={entry.status === "failed" ? "error" : entry.status === "completed" ? "success" : "default"}>{evidenceStatusLabel(entry.status, t)}</Tag> },
    { title: t("rep.recordedTokenTotal"), key: "usage", align: "right", render: (_, entry) => entry.usage.totalTokens.toLocaleString() },
    { title: t("rep.updatedAt"), key: "at", render: (_, entry) => formatTime(entry.updatedAt, localeTag) },
    { title: "", key: "action", render: (_, entry) => <Button type="link" size="small" onClick={() => onOpenTimeline(entry.positionId)}>{t("rep.openTimeline")}</Button> },
  ]} /></div>;
}

function evidenceStatusLabel(status: string, t: OwbT): string {
  if (status === "completed") return t("turn.done");
  if (status === "failed") return t("turn.failed");
  if (status === "indeterminate") return t("turn.statusUnknown");
  return t("turn.statusRunning");
}

function formatTime(value: string, localeTag = "zh-CN"): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(localeTag, { hour12: false });
}

/** #146：时间格式跟随应用 locale（数据本身仍是原时间戳）。 */
function useLocaleTag(): string {
  return useOwbLocale() === "en" ? "en-US" : "zh-CN";
}

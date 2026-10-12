import type { ApprovalQueueItem } from "../approvals/types";
import { useMemo, useState } from "react";
import { Alert, Button, Skeleton, Table, Tag } from "antd";
import { useOwbLocale, useT, type OwbT } from "@roleweave/ui";
import type { EvidenceEntry, ReportsResponse } from "@roleweave/shared";
import { RefreshCw } from "lucide-react";
import { BudgetDashboard } from "./BudgetDashboard";
import { useReportAdvice, ReportAdviceControls } from "./ReportAdvice";
import type { ExperimentScope } from "../experiments/useWorkspaceExperiments";
import { RunInspector, ExceptionWorkbench, ReportFilters, AuditRecords, RunSummary, evidenceKey } from "./InboxReports";
import "../inbox/inbox-workspace.css";
import { AuditTimeline, type AuditTimelineEvent } from "./AuditTimeline";

type Tab = "budgets" | "escalations" | "audits" | "evidence" | "timeline";

export interface ReportsCenterProps extends ExperimentScope {
  onOpenExperiments?: () => void;
  onRefresh?: () => void;
  onNavigateToOrg?: () => void;
  errorMessage?: string;
  updatedAt?: string;
  approvals?: ApprovalQueueItem[];
  onOpenApproval?: (id: string) => void;
  reports: ReportsResponse | null;
  loading: boolean;
  positionNames?: Record<string, string>;
  positionColors?: Record<string, string>;
  onOpenTimeline?: (positionId: string) => void;
  onOpenTurn?: (source: { positionId: string; conversationId: string; turnId: string }) => void;
  focusTurnId?: string;
}

export function ReportsCenter({ reports, loading, positionNames, positionColors, focusTurnId, onOpenTimeline, onOpenTurn, onRefresh, workspacePath, workspaceScope, onOpenExperiments, errorMessage, updatedAt, onNavigateToOrg, approvals, onOpenApproval }: ReportsCenterProps) {
  const t = useT();
  const advice = useReportAdvice({ workspacePath, workspaceScope }, reports?.streams.escalations ?? []);
  const timelineEvents = useMemo<AuditTimelineEvent[]>(
    () => (reports ? buildTimelineEventsFromReports(reports, t) : []),
    [reports, t],
  );
  // Prefer a stream with real facts on first open. Landing on an empty
  // escalation tab made a healthy workspace look broken and hid the evidence
  // that explains what this module is for.
  const [filters, setFilters] = useState({ query: "", position: "", status: "", date: "" });
  const filteredReports = useMemo(() => {
    if (!reports) return null;
    const evidence = new Map(reports.streams.evidence.map(e => [evidenceKey(e), e]));
    const matches = (position: string, at?: string, status?: string, extra = "") =>
      (!filters.position || filters.position === position) &&
      (!filters.date || at !== undefined && recordedDate(at) === filters.date) &&
      (!filters.status || status === filters.status) &&
      `${positionNames?.[position] ?? position} ${extra}`.toLowerCase().includes(filters.query.trim().toLowerCase());
    return { ...reports, budgets: reports.budgets.filter(b => matches(b.positionId, undefined, b.state)), streams: {
      evidence: reports.streams.evidence.filter(e => matches(e.positionId, e.updatedAt, e.status, `${e.turnId} ${e.runId ?? ""} ${e.engine}`)),
      escalations: reports.streams.escalations.filter(e => matches(e.positionId, e.at, e.status, `${e.turnId} ${e.code} ${evidence.get(evidenceKey(e))?.runId ?? ""} ${evidence.get(evidenceKey(e))?.engine ?? ""}`)),
      audits: reports.streams.audits.filter(a => (!filters.date || recordedDate(a.at) === filters.date) && (!filters.position || [...a.changes.hired.map(r => r.id), ...a.changes.moved.map(r => r.id), ...a.changes.dismissed.map(r => r.id), ...a.changes.budgetUpdated].includes(filters.position)) && (!filters.status || filters.status === "completed") && `${a.actor} ${a.workspace}`.toLowerCase().includes(filters.query.trim().toLowerCase())),
    } };
  }, [reports, filters, positionNames]);
  const [tabOverride, setTabOverride] = useState<Tab | null>(null);
  const [timelinePosition, setTimelinePosition] = useState<string | null>(null);
  const [timelineRunId, setTimelineRunId] = useState<string | null>(null);
  const selectTab = (next: Tab) => { setTabOverride(next); setFilters(current => ({ ...current, status: "", date: next === "budgets" ? "" : current.date })); };
  if (loading && !reports) return <section className="owb-reports" aria-label={t("rep.loading")}><Skeleton active paragraph={{ rows: 6 }} /></section>;
  if (!reports || !filteredReports) return <section className="owb-reports owb-inbox-state"><h1>{t("inbox.loadFailed")}</h1><p>{errorMessage ?? t("rep.unavailable")}</p>{onRefresh ? <Button onClick={onRefresh}>{t("rep.refresh")}</Button> : null}</section>;
  const tab = tabOverride ?? (focusTurnId ? "evidence" : firstReportTab(reports, timelineEvents.length));
  const total = reports.budgets.reduce((sum, budget) => sum + budget.recorded.totalTokens, 0);
  const exceptions = new Set([...reports.streams.escalations.map(evidenceKey), ...reports.streams.evidence.filter((item) => item.status === "failed" || item.status === "indeterminate").map(evidenceKey)]).size;
  const completed = reports.streams.evidence.filter((item) => item.status === "completed").length;
  const hasObservedUsage = reports.budgets.some((budget) => budget.latestTurn !== null);
  const evidenceByTurn = new Map(reports.streams.evidence.map((entry) => [evidenceKey(entry), entry]));
  const visibleTimeline = buildTimelineEventsFromReports(filteredReports, t);
  const filteredTimeline = visibleTimeline.filter((event) =>
    (timelinePosition === null || event.positionId === timelinePosition) &&
    (timelineRunId === null || event.runId === timelineRunId),
  );
  const openTimeline = (positionId: string, turnId?: string) => {
    setTimelinePosition(positionId);
    setTimelineRunId(turnId ? reports.streams.evidence.find((entry) => entry.positionId === positionId && entry.turnId === turnId)?.runId ?? turnId : null);
    setTabOverride("timeline");
  };
  return (
    <section className="owb-reports" aria-label={t("inbox.reportsTitle")}>
      <header className="owb-reports__hero">
        <div className="owb-reports__hero-copy">
          <h1>{t("inbox.reportsTitle")}</h1>
          <p>{t("rep.lede")}</p>
        </div>
        {onRefresh ? <Button icon={<RefreshCw size={14} />} loading={loading} onClick={onRefresh}>{t("rep.refresh")}</Button> : null}
      </header>
      {errorMessage ? <Alert type="warning" showIcon title={t("inbox.cachedSnapshot")} description={errorMessage} action={onRefresh ? <Button onClick={onRefresh}>{t("inbox.retry")}</Button> : undefined} /> : null}
      <div className="owb-report-overview" role="group" aria-label={t("rep.overview")}>
        <SummaryMetric active={tab === "budgets"} label={t("rep.recordedTokenTotal")} value={hasObservedUsage ? total.toLocaleString() : "—"} detail={t("rep.usageScope")} onClick={() => selectTab("budgets")} />
        <SummaryMetric active={tab === "evidence"} label={t("rep.runCount")} value={reports.streams.evidence.length.toLocaleString()} detail={t("rep.completedCount", { count: completed })} onClick={() => selectTab("evidence")} />
        <SummaryMetric active={tab === "escalations"} label={t("rep.exceptionCount")} value={exceptions.toLocaleString()} detail={t("rep.exceptionHint")} warning={exceptions > 0} onClick={() => selectTab("escalations")} />
        <SummaryMetric active={tab === "budgets"} label={t("rep.employeeCount")} value={reports.budgets.length.toLocaleString()} detail={t("rep.observedCount", { count: reports.budgets.filter((budget) => budget.latestTurn !== null).length })} onClick={() => selectTab("budgets")} />
      </div>
      <p className="owb-report-scope">{t("rep.scopeHint")}{reports.page.hasMore ? ` ${t("rep.partialSnapshot")}` : ""}</p>
      {/* #394：单层视图切换。旧的两层 tab（治理父 tab 再套三个子 tab）把时间线这种
          全量流塞进"异常"分组里，用户找不到也记不住；拍平后 KPI 卡与视图一一对应。 */}
      <nav className="owb-report-tabs" aria-label={t("rep.streamsAria")}>
        <TabButton active={tab === "budgets"} onClick={() => selectTab("budgets")} label={t("rep.tabBudgets")} count={reports.budgets.length} />
        <TabButton active={tab === "evidence"} onClick={() => selectTab("evidence")} label={t("rep.tabEvidence")} count={reports.streams.evidence.length} />
        <TabButton active={tab === "escalations"} onClick={() => selectTab("escalations")} label={t("rep.tabEscalations")} count={exceptions} />
        <TabButton active={tab === "audits"} onClick={() => selectTab("audits")} label={t("rep.tabAudits")} count={reports.streams.audits.length + reports.streams.evidence.filter(e => e.status !== "running").length + (approvals?.filter(a => (a.decision.kind === "granted" || a.decision.kind === "denied") && a.decision.decidedAt).length ?? 0)} />
        <TabButton active={tab === "timeline"} onClick={() => { setTimelinePosition(null); setTimelineRunId(null); selectTab("timeline"); }} label={t("rep.tabTimeline")} count={timelineEvents.length} />
      </nav>
      <ReportFilters value={filters} onChange={setFilters} positionNames={positionNames} reports={reports} updatedAt={updatedAt} tab={tab} />
      {Object.values(filters).some(Boolean) ? <Button type="link" onClick={() => setFilters({ query: "", position: "", status: "", date: "" })}>{t("apr.clearFilters")}</Button> : null}
      {reports.streams.evidence.length + reports.streams.escalations.length + reports.streams.audits.length + reports.budgets.length === 0 ? <section className="owb-inbox-state"><h2>{t("inbox.noReports")}</h2><p>{t("inbox.noReportsHint")}</p>{onNavigateToOrg ? <Button onClick={onNavigateToOrg}>{t("inbox.openCollaboration")}</Button> : null}</section> : null}
      <div className="owb-report-stream" role="tabpanel" aria-label={t("rep.streamTabpanelAria", { tab: tabLabel(tab, t) })}>
        {tab === "budgets" ? (
          <BudgetDashboard
            compact
            budgets={filteredReports.budgets}
            escalations={reports.streams.escalations}
            positionNames={positionNames}
            positionColors={positionColors}
            onOpenTimeline={openTimeline}
          />
        ) : null}
        {tab === "escalations" ? <>{workspacePath ? <ReportAdviceControls controller={advice} onOpenSettings={onOpenExperiments} /> : null}<ExceptionWorkbench entries={filteredReports.streams.escalations} evidence={filteredReports.streams.evidence} evidenceByTurn={evidenceByTurn} positionNames={positionNames} onOpenTimeline={openTimeline} onOpenTurn={onOpenTurn} advice={advice.items} /></> : null}
        {tab === "audits" ? <AuditRecords entries={filteredReports.streams.audits} evidence={filteredReports.streams.evidence} approvals={approvals?.filter(a => (!filters.position || a.positionId === filters.position) && (!filters.query || `${a.description} ${a.approvalId}`.toLowerCase().includes(filters.query.toLowerCase())) && (!filters.date || (a.decision.kind === "granted" || a.decision.kind === "denied") && a.decision.decidedAt !== undefined && recordedDate(a.decision.decidedAt) === filters.date) && (!filters.status || filters.status === a.decision.kind))} onOpenApproval={onOpenApproval} onOpenTimeline={openTimeline} positionNames={positionNames} /> : null}
        {tab === "evidence" ? <Evidence entries={filteredReports.streams.evidence} positionNames={positionNames} focusTurnId={focusTurnId} onOpenTimeline={openTimeline} onOpenTurn={onOpenTurn} /> : null}
        {tab === "timeline" && timelinePosition ? <div className="owb-report-filter-note"><span>{positionNames?.[timelinePosition] ?? timelinePosition}</span><Button type="link" onClick={() => { setTimelinePosition(null); setTimelineRunId(null); setFilters({ query: "", position: "", status: "", date: "" }); }}>{t("rep.clearScope")}</Button></div> : null}
        {tab === "timeline" ? (
          <div className="owb-inbox-report-split owb-inbox-timeline"><AuditTimeline
            events={filteredTimeline}
            positionNames={positionNames}
            page={{
              cursor: reports.page.cursor,
              hasMore: reports.page.hasMore,
              total: filteredTimeline.length,
            }}
          /><RunSummary evidence={reports.streams.evidence.find(e => timelinePosition === e.positionId && timelineRunId === (e.runId ?? e.turnId))} events={filteredTimeline} onOpenTurn={onOpenTurn} onOpenEvidence={(positionId, turnId) => { setTabOverride("evidence"); setFilters({ query: turnId, position: positionId, status: "", date: "" }); }} /></div>
        ) : null}
      </div>
    </section>
  );
}

function firstReportTab(reports: ReportsResponse, timelineCount: number): Tab {
  if (reports.streams.escalations.length > 0 || reports.streams.evidence.some(e => e.status === "failed" || e.status === "indeterminate")) return "escalations";
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

function SummaryMetric({ label, value, detail, warning = false, active = false, onClick }: { label: string; value: string; detail: string; warning?: boolean; active?: boolean; onClick: () => void }) {
  return <button type="button" aria-pressed={active} className={`owb-report-metric${warning ? " is-warning" : ""}${active ? " is-active" : ""}`} onClick={onClick} aria-label={label}>
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
    evidenceByTurn.set(evidenceKey(evidence), evidence);
  }
  for (const evidence of reports.streams.evidence) {
    const runId = evidence.runId ?? evidence.turnId;
    events.push({
      id: `evidence:started:${evidenceKey(evidence)}`,
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
      id: `evidence:terminal:${evidenceKey(evidence)}`,
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
    const runId = evidenceByTurn.get(evidenceKey(escalation))?.runId ?? escalation.turnId;
    events.push({
      id: `escalation:${evidenceKey(escalation)}:${escalation.at}`,
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
  events.sort((a, b) => a.at.localeCompare(b.at));
  return events;
}

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return <button type="button" aria-pressed={active} onClick={onClick}>{label}<span>{count}</span></button>;
}

function Empty({ text }: { text: string }) { return <p className="owb-report-empty">{text}</p>; }

function Evidence({ entries, positionNames, focusTurnId, onOpenTimeline, onOpenTurn }: { entries: EvidenceEntry[]; positionNames?: Record<string, string>; focusTurnId?: string; onOpenTimeline: (id: string, turnId?: string) => void; onOpenTurn?: ReportsCenterProps["onOpenTurn"] }) {
  const t = useT();
  const localeTag = useLocaleTag();
  const [selectedTurn, setSelectedTurn] = useState<string>();
  const focused = focusTurnId ? entries.filter((entry) => entry.turnId === focusTurnId) : entries;
  const rows = [...focused].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const selected = rows.find(e => evidenceKey(e) === selectedTurn) ?? rows[0];
  if (entries.length === 0) return <Empty text={t("rep.noEvidence")} />;
  return <div className="owb-execution-records">
    {focusTurnId && focused.length === 0 ? <Alert type="warning" showIcon message={t("rep.focusEvidenceMissing", { turnId: focusTurnId })} /> : null}
    {focusTurnId && focused.length > 0 ? <Alert type="info" showIcon message={t("rep.focusEvidenceFound", { turnId: focusTurnId })} /> : null}
    {focusTurnId && focused.length === 0 ? null : <><div className="owb-inbox-report-split"><div className="owb-inbox-table"><Table<EvidenceEntry> rowKey={evidenceKey} size="middle" rowClassName={e => selected !== undefined && evidenceKey(e) === evidenceKey(selected) ? "is-selected" : ""} onRow={e => ({ onClick: () => setSelectedTurn(evidenceKey(e)) })} dataSource={rows} scroll={{ x: 560 }} pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }} locale={{ emptyText: t("rep.noMatchingExecutions") }} columns={[
    { title: t("inbox.task"), key: "task", render: (_, e) => <button className="owb-inbox-row-link" onClick={() => setSelectedTurn(evidenceKey(e))}>{e.runId ?? e.turnId}</button> },
    { title: t("rep.colPosition"), key: "position", render: (_, entry) => <strong>{positionNames?.[entry.positionId] ?? entry.positionId}</strong> },
    { responsive: ["xxl"], title: "Agent", dataIndex: "engine", key: "engine", render: (engine: string) => engine.startsWith("codex") ? "Codex" : engine.startsWith("claude") ? "Claude Code" : engine === "gemini" ? "Gemini" : "Qoder" },
    { title: t("rep.executionStatus"), key: "status", render: (_, entry) => <Tag color={entry.status === "failed" ? "error" : entry.status === "completed" ? "success" : "default"}>{evidenceStatusLabel(entry.status, t)}</Tag> },
    { responsive: ["xxl"], title: t("rep.recordedTokenTotal"), key: "usage", align: "right", render: (_, entry) => entry.usage.totalTokens.toLocaleString() },
    { title: t("rep.updatedAt"), key: "at", render: (_, entry) => <time title={formatTime(entry.updatedAt, localeTag)}>{formatRelativeTime(entry.updatedAt, localeTag, t)}</time> },
    { title: "", key: "action", render: (_, entry) => <>{onOpenTurn ? <Button type="link" size="small" aria-label={t("rep.openTurnNamed", { turnId: entry.turnId })} onClick={() => onOpenTurn({ positionId: entry.positionId, conversationId: entry.conversationId, turnId: entry.turnId })}>{t("rep.openTurn")}</Button> : null}<Button type="link" size="small" onClick={() => onOpenTimeline(entry.positionId, entry.turnId)}>{t("rep.openTimeline")}</Button></> },
  ]} /><footer>{t("rep.recordCount", { count: rows.length })}</footer></div><RunInspector entry={selected} positionNames={positionNames} onOpenTurn={onOpenTurn} onOpenTimeline={onOpenTimeline} /></div></>}
  </div>;
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

/** #394：列表行主时间用相对值（秒级绝对戳是噪声），完整绝对时间挂在 title 上。 */
function formatRelativeTime(value: string, localeTag: string, t: OwbT): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diff = Date.now() - date.getTime();
  if (diff < 0) return formatTime(value, localeTag);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t("rep.relJustNow");
  if (minutes < 60) return t("rep.relMinutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("rep.relHoursAgo", { count: hours });
  return t("rep.relDaysAgo", { count: Math.floor(hours / 24) });
}

/** #146：时间格式跟随应用 locale（数据本身仍是原时间戳）。 */
function useLocaleTag(): string {
  return useOwbLocale() === "en" ? "en-US" : "zh-CN";
}

function recordedDate(at: string): string { return new Date(at).toLocaleDateString("sv-SE"); }

import { useMemo, useState } from "react";
import { Alert, Button, Input, Select, Skeleton, Table, Tag } from "antd";
import { useOwbLocale, useT, type OwbT } from "@roleweave/ui";
import type { AuditEntry, EvidenceEntry, EscalationEntry, ReportsResponse } from "@roleweave/shared";
import { AlertOctagon, ClipboardList, RefreshCw } from "lucide-react";
import { BudgetDashboard } from "./BudgetDashboard";
import { useReportAdvice, ReportAdviceControls, ReportAdviceChip, reportAdviceKey } from "./ReportAdvice";
import type { ExperimentScope } from "../experiments/useWorkspaceExperiments";
import { AuditTimeline, type AuditTimelineEvent } from "./AuditTimeline";

type Tab = "budgets" | "escalations" | "audits" | "evidence" | "timeline";

export interface ReportsCenterProps extends ExperimentScope {
  onOpenExperiments?: () => void;
  onRefresh?: () => void;
  reports: ReportsResponse | null;
  loading: boolean;
  positionNames?: Record<string, string>;
  positionColors?: Record<string, string>;
  onOpenTimeline?: (positionId: string) => void;
  focusTurnId?: string;
}

export function ReportsCenter({ reports, loading, positionNames, positionColors, focusTurnId, onOpenTimeline, onRefresh, workspacePath, workspaceScope, onOpenExperiments }: ReportsCenterProps) {
  const t = useT();
  const advice = useReportAdvice({ workspacePath, workspaceScope }, reports?.streams.escalations ?? []);
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
  const tab = tabOverride ?? (focusTurnId ? "evidence" : firstReportTab(reports, timelineEvents.length));
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
        <SummaryMetric active={tab === "budgets"} label={t("rep.recordedTokenTotal")} value={hasObservedUsage ? total.toLocaleString() : "—"} detail={t("rep.usageScope")} onClick={() => setTabOverride("budgets")} />
        <SummaryMetric active={tab === "evidence"} label={t("rep.runCount")} value={reports.streams.evidence.length.toLocaleString()} detail={t("rep.completedCount", { count: completed })} onClick={() => setTabOverride("evidence")} />
        <SummaryMetric active={tab === "escalations"} label={t("rep.exceptionCount")} value={exceptions.toLocaleString()} detail={t("rep.exceptionHint")} warning={exceptions > 0} onClick={() => setTabOverride("escalations")} />
        <SummaryMetric active={tab === "budgets"} label={t("rep.employeeCount")} value={reports.budgets.length.toLocaleString()} detail={t("rep.observedCount", { count: reports.budgets.filter((budget) => budget.latestTurn !== null).length })} onClick={() => setTabOverride("budgets")} />
      </div>
      <p className="owb-report-scope">{t("rep.scopeHint")}{reports.page.hasMore ? ` ${t("rep.partialSnapshot")}` : ""}</p>
      {/* #394：单层视图切换。旧的两层 tab（治理父 tab 再套三个子 tab）把时间线这种
          全量流塞进"异常"分组里，用户找不到也记不住；拍平后 KPI 卡与视图一一对应。 */}
      <nav className="owb-report-tabs" aria-label={t("rep.streamsAria")}>
        <TabButton active={tab === "budgets"} onClick={() => setTabOverride("budgets")} label={t("rep.tabBudgets")} count={reports.budgets.length} />
        <TabButton active={tab === "evidence"} onClick={() => setTabOverride("evidence")} label={t("rep.tabEvidence")} count={reports.streams.evidence.length} />
        <TabButton active={tab === "escalations"} onClick={() => setTabOverride("escalations")} label={t("rep.tabEscalations")} count={reports.streams.escalations.length} />
        <TabButton active={tab === "audits"} onClick={() => setTabOverride("audits")} label={t("rep.tabAudits")} count={reports.streams.audits.length} />
        <TabButton active={tab === "timeline"} onClick={() => { setTimelinePosition(null); setTabOverride("timeline"); }} label={t("rep.tabTimeline")} count={timelineEvents.length} />
      </nav>
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
        {tab === "escalations" ? <>{workspacePath ? <ReportAdviceControls controller={advice} onOpenSettings={onOpenExperiments} /> : null}<Escalations entries={reports.streams.escalations} positionNames={positionNames} onOpenTimeline={openTimeline} advice={advice.items} /></> : null}
        {tab === "audits" ? <Audits entries={reports.streams.audits} positionNames={positionNames} /> : null}
        {tab === "evidence" ? <Evidence entries={reports.streams.evidence} positionNames={positionNames} focusTurnId={focusTurnId} onOpenTimeline={openTimeline} /> : null}
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

function Escalations({ entries, positionNames, onOpenTimeline, advice }: { entries: EscalationEntry[]; positionNames?: Record<string, string>; onOpenTimeline: (id: string) => void; advice: ReturnType<typeof useReportAdvice>["items"] }) {
  const t = useT();
  const localeTag = useLocaleTag();
  if (entries.length === 0) return <Empty text={t("rep.noEscalations")} />;
  return <ol>{entries.map((entry) => {
    const summary = entry.budgetRelated ? t("rep.budgetRelated") : t("rep.eventEscalation");
    return <li className="owb-report-card is-escalation" key={entry.turnId}><AlertOctagon aria-hidden="true" size={16} /><div><header><strong>{positionNames?.[entry.positionId] ?? t("rep.unknownPosition")}</strong><time title={formatTime(entry.at, localeTag)}>{formatRelativeTime(entry.at, localeTag, t)}</time></header><p className="owb-clamp-2" title={summary}>{summary}</p><div className="owb-report-chain">{entry.reportingChain.map((position, index) => <span key={position} style={{ borderLeftWidth: Math.min(index + 1, 4) }}>{positionNames?.[position] ?? t("rep.unknownPosition")}</span>)}</div><ReportAdviceChip advice={advice.get(reportAdviceKey(entry))} /><Button type="link" size="small" className="owb-report-trace" onClick={() => onOpenTimeline(entry.positionId)}>{t("rep.traceRun")}</Button></div></li>;
  })}</ol>;
}

/**
 * #394：审计行从"只报数字"升级为可展开明细。旧行只写"调岗 27"，用户没法回答
 * "谁调去了哪"，追溯承诺落空；展开后按 招聘/调岗/裁撤/预算 四组列具体岗位，
 * 调岗带 从→到。零值组不渲染，全零显示"无实质变更"。
 */
function Audits({ entries, positionNames }: { entries: AuditEntry[]; positionNames?: Record<string, string> }) {
  const t = useT();
  const localeTag = useLocaleTag();
  if (entries.length === 0) return <Empty text={t("rep.noAudits")} />;
  return <ol>{entries.map((entry, index) => <AuditRow key={`${entry.at}-${index}`} entry={entry} positionNames={positionNames} localeTag={localeTag} />)}</ol>;
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

function Evidence({ entries, positionNames, focusTurnId, onOpenTimeline }: { entries: EvidenceEntry[]; positionNames?: Record<string, string>; focusTurnId?: string; onOpenTimeline: (id: string) => void }) {
  const t = useT();
  const localeTag = useLocaleTag();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const focused = focusTurnId ? entries.filter((entry) => entry.turnId === focusTurnId) : entries;
  const filtered = focused.filter((entry) => (status === "all" || entry.status === status) && `${positionNames?.[entry.positionId] ?? entry.positionId} ${entry.engine}`.toLowerCase().includes(query.trim().toLowerCase()));
  const rows = [...filtered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (entries.length === 0) return <Empty text={t("rep.noEvidence")} />;
  return <div className="owb-execution-records">
    {focusTurnId && focused.length === 0 ? <Alert type="warning" showIcon message={t("rep.focusEvidenceMissing", { turnId: focusTurnId })} /> : null}
    {focusTurnId && focused.length > 0 ? <Alert type="info" showIcon message={t("rep.focusEvidenceFound", { turnId: focusTurnId })} /> : null}
    {focusTurnId && focused.length === 0 ? null : <><div className="owb-report-toolbar">
    <Input allowClear aria-label={t("rep.searchExecutions")} placeholder={t("rep.searchExecutions")} value={query} onChange={(event) => setQuery(event.target.value)} />
    <Select aria-label={t("rep.executionStatus")} value={status} onChange={setStatus} options={[{ value: "all", label: t("rep.allStatuses") }, ...["completed", "running", "failed", "indeterminate"].map((value) => ({ value, label: evidenceStatusLabel(value, t) }))]} />
    <span>{t("rep.recordCount", { count: rows.length })}</span>
  </div><Table<EvidenceEntry> rowKey="turnId" size="middle" dataSource={rows} scroll={{ x: 670 }} pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }} locale={{ emptyText: t("rep.noMatchingExecutions") }} columns={[
    { title: t("rep.colPosition"), key: "position", render: (_, entry) => <strong>{positionNames?.[entry.positionId] ?? entry.positionId}</strong> },
    { title: "Agent", dataIndex: "engine", key: "engine", render: (engine: string) => engine.startsWith("codex") ? "Codex" : engine.startsWith("claude") ? "Claude Code" : engine === "gemini" ? "Gemini" : "Qoder" },
    { title: t("rep.executionStatus"), key: "status", render: (_, entry) => <Tag color={entry.status === "failed" ? "error" : entry.status === "completed" ? "success" : "default"}>{evidenceStatusLabel(entry.status, t)}</Tag> },
    { title: t("rep.recordedTokenTotal"), key: "usage", align: "right", render: (_, entry) => entry.usage.totalTokens.toLocaleString() },
    { title: t("rep.updatedAt"), key: "at", render: (_, entry) => <time title={formatTime(entry.updatedAt, localeTag)}>{formatRelativeTime(entry.updatedAt, localeTag, t)}</time> },
    { title: "", key: "action", render: (_, entry) => <Button type="link" size="small" onClick={() => onOpenTimeline(entry.positionId)}>{t("rep.openTimeline")}</Button> },
  ]} /></>}
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

import { useMemo, useState } from "react";
import { BudgetBar } from "@roleweave/ui";
import { useOwbLocale, useT, type OwbT } from "@roleweave/ui";
import type { AuditEntry, BudgetReport, EvidenceEntry, EscalationEntry, ReportsResponse } from "@roleweave/shared";
import { AlertOctagon, ArrowUpRight, ClipboardList } from "lucide-react";
import { BudgetDashboard } from "./BudgetDashboard";
import { AuditTimeline, type AuditTimelineEvent } from "./AuditTimeline";

type Tab = "budgets" | "escalations" | "audits" | "evidence" | "timeline";

export interface ReportsCenterProps {
  reports: ReportsResponse | null;
  loading: boolean;
  positionNames?: Record<string, string>;
  positionColors?: Record<string, string>;
  onOpenTimeline?: (positionId: string) => void;
}

export function ReportsCenter({ reports, loading, positionNames, positionColors, onOpenTimeline }: ReportsCenterProps) {
  const t = useT();
  const timelineEvents = useMemo<AuditTimelineEvent[]>(
    () => (reports ? buildTimelineEventsFromReports(reports, t) : []),
    [reports, t],
  );
  // Prefer a stream with real facts on first open. Landing on an empty
  // escalation tab made a healthy workspace look broken and hid the evidence
  // that explains what this module is for.
  const [tabOverride, setTabOverride] = useState<Tab | null>(null);
  if (loading) return <section className="owb-reports"><p className="owb-muted">{t("rep.loading")}</p></section>;
  if (!reports) return <section className="owb-reports"><p className="owb-muted">{t("rep.unavailable")}</p></section>;
  const tab = tabOverride ?? firstReportTab(reports, timelineEvents.length);
  return (
    <section className="owb-reports" aria-label={t("rep.center")}>
      <header className="owb-reports__hero">
        <div className="owb-reports__hero-copy">
          <h1>{t("rep.center")}</h1>
          <p>{t("rep.lede")}</p>
        </div>
      </header>
      <BudgetDeck budgets={reports.budgets} positionNames={positionNames} onViewAll={() => setTabOverride("budgets")} />
      <nav className="owb-report-tabs" aria-label={t("rep.streamsAria")}>
        <TabButton active={tab === "budgets"} onClick={() => setTabOverride("budgets")} label={t("rep.tabBudgets")} count={reports.budgets.length} />
        <TabButton active={tab === "escalations"} onClick={() => setTabOverride("escalations")} label={t("rep.tabEscalations")} count={reports.streams.escalations.length} />
        <TabButton active={tab === "audits"} onClick={() => setTabOverride("audits")} label={t("rep.tabAudits")} count={reports.streams.audits.length} />
        <TabButton active={tab === "evidence"} onClick={() => setTabOverride("evidence")} label={t("rep.tabEvidence")} count={reports.streams.evidence.length} />
        <TabButton active={tab === "timeline"} onClick={() => setTabOverride("timeline")} label={t("rep.tabTimeline")} count={timelineEvents.length} />
      </nav>
      <div className="owb-report-stream" role="tabpanel" aria-label={t("rep.streamTabpanelAria", { tab: tabLabel(tab, t) })}>
        {tab === "budgets" ? (
          <BudgetDashboard
            budgets={reports.budgets}
            escalations={reports.streams.escalations}
            positionNames={positionNames}
            positionColors={positionColors}
            onOpenTimeline={onOpenTimeline}
          />
        ) : null}
        {tab === "escalations" ? <Escalations entries={reports.streams.escalations} positionNames={positionNames} /> : null}
        {tab === "audits" ? <Audits entries={reports.streams.audits} /> : null}
        {tab === "evidence" ? <Evidence entries={reports.streams.evidence} positionNames={positionNames} /> : null}
        {tab === "timeline" ? (
          <AuditTimeline
            events={timelineEvents}
            positionNames={positionNames}
            page={{
              cursor: reports.page.cursor,
              hasMore: reports.page.hasMore,
              total: timelineEvents.length,
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

function BudgetDeck({ budgets, positionNames, onViewAll }: { budgets: BudgetReport[]; positionNames?: Record<string, string>; onViewAll: () => void }) {
  const t = useT();
  return <section className="owb-budget-deck" aria-label={t("rep.budgetSnapshot")}>
    <header className="owb-budget-deck__head">
      <div><h2>{t("rep.budgetSnapshot")}</h2><p>{t("rep.budgetSnapshotHint")}</p></div>
      <button type="button" className="owb-budget-deck__link" onClick={onViewAll}>{t("rep.viewCostBoard")} <ArrowUpRight aria-hidden="true" size={13} /></button>
    </header>
    {budgets.length === 0 ? <p className="owb-budget-deck__empty">{t("rep.budgetDeckEmpty")}</p> : <div className="owb-budget-deck__grid">{budgets.map((budget) => {
      const limit = budget.declared.perTask.tokens;
      const ratio = limit && budget.latestTurn ? budget.latestTurn.totalTokens / limit : null;
      return <article key={budget.positionId} data-state={budget.state}>
        <header><strong>{positionNames?.[budget.positionId] ?? t("rep.unknownPosition")}</strong><span>{budget.state === "unobserved" ? t("rep.declaredPhase") : budget.state === "exceeded" ? t("rep.stateExceeded") : t("rep.stateWithin")}</span></header>
        <BudgetBar declared={{ taskLimit: budget.declared.perTask, dailyLimit: budget.declared.perDay }} consumption={ratio} />
        <small><span>{t("rep.colRecorded")}</span><span>{budget.recorded.totalTokens.toLocaleString()} tokens</span></small>
      </article>;
    })}</div>}
  </section>;
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
    events.push({
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
    const runId = escalation.turnId;
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

function Evidence({ entries, positionNames }: { entries: EvidenceEntry[]; positionNames?: Record<string, string> }) {
  const t = useT();
  const localeTag = useLocaleTag();
  if (entries.length === 0) return <Empty text={t("rep.noEvidence")} />;
  return <ol>{entries.map((entry) => {
    const summary = `${evidenceStatusLabel(entry.status, t)} · ${entry.usage.totalTokens.toLocaleString()} tokens`;
    return <li className="owb-report-card" key={entry.turnId}><ClipboardList aria-hidden="true" size={16} /><div><header><strong>{positionNames?.[entry.positionId] ?? t("rep.unknownPosition")}</strong><time>{formatTime(entry.updatedAt, localeTag)}</time></header><p className="owb-clamp-2" title={summary}>{summary}</p></div></li>;
  })}</ol>;
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

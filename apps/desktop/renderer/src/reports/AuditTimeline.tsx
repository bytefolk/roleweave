// TODO: merge three sources — TurnRecord.events / SSE live / org-audit.v1.
// v1 accepts a pre-merged `events` prop; the data-plane merge lives elsewhere.
//
// Field mapping (single source of truth per design-spec § 6.6):
//   TurnRecord.events[i] (engine.v1)   → { runId, at=timestamp, type, positionId=parent, engine=parent, ...typeSpecific }
//   EscalationEntry (org-audit.v1)     → { runId=turnId, at, type="escalation.created", positionId, code, reportingChain, budgetRelated, status }
//   AuditEntry (org-audit.v1)          → { runId=synthetic("audit-"+at), at, type="org.audit", actor, changes, positionCount }
//   EvidenceEntry (turn-evidence.v1)   → attached to the parent runId as mini-card fields (envelopeDigest, usage, status, errorCode)
//   SSE turn.* (live)                  → same shape as TurnRecord.events, appended in real time (out of scope for v1 UI).

import { useMemo, useState } from "react";
import {
  Button,
  Collapse,
  DatePicker,
  Empty,
  Pagination,
  Select,
  Tag,
} from "antd";
import { useOwbLocale, useT } from "@roleweave/ui";
import type { TurnEngine, TurnTerminalReason } from "@roleweave/shared";

/** Event classes rendered on the timeline. `model.delta` is intentionally excluded. */
export type AuditTimelineEventType =
  | "run.started"
  | "usage"
  | "run.completed"
  | "run.failed"
  | "turn.indeterminate"
  | "approval.requested"
  | "approval.granted"
  | "approval.denied"
  | "escalation.created"
  | "org.audit"
  | "hire.progress";

export type AuditTimelineEventClass =
  | "turn"
  | "approval"
  | "escalation"
  | "org";

/** Unified timeline event — the merge product of the three sources. */
export interface AuditTimelineEvent {
  /** Stable client-side id for React keys (`${runId}:${at}:${type}` recommended). */
  id: string;
  /** ISO-8601 timestamp. */
  at: string;
  /** engine.v1 runId, or a synthetic id for audit-only events. */
  runId: string;
  /** Position that produced the event; audit events may lack this (undefined). */
  positionId?: string;
  /** engine label for run.* events; absent for audit events. */
  engine?: TurnEngine;
  type: AuditTimelineEventType;
  /** Terminal reason word from run.failed / indeterminate (drives red-dot). */
  terminalReason?: TurnTerminalReason | string;
  /** Stable error code from engine.v1 error.code (e.g. engine.position_budget_exceeded). */
  errorCode?: string;
  /** Human-readable summary line rendered under the head. */
  summary?: string;
  /** Turn evidence digest (only on run terminal events). */
  envelopeDigest?: string;
  /** Total tokens observed at this event (usage / terminal). */
  totalTokens?: number;
  /** Escalation-only fields. */
  budgetRelated?: boolean;
  reportingChain?: string[];
  /** Free-form task input (for the mini card, run.started). */
  task?: string;
  /** approval.* action kind. */
  approvalKind?: "exec" | "write" | "network" | "tool";
  /** Original approvalId (for deep-linking to ③). */
  approvalId?: string;
}

export interface AuditTimelineFilters {
  /** Only render events for these positions; undefined / [] = all. */
  positionIds?: string[];
  /** Event classes to include; undefined / [] = all. */
  classes?: AuditTimelineEventClass[];
  /** Inclusive ISO date range [from, to]. */
  from?: string;
  to?: string;
}

export interface AuditTimelinePage {
  /** Current cursor (server-issued). */
  cursor: string | null;
  hasMore: boolean;
  /** Total known count for the current filter (optional; drives pagination.total). */
  total?: number;
  /** Client page size hint; defaults to 50. */
  pageSize?: number;
}

export interface AuditTimelineProps {
  events: AuditTimelineEvent[];
  loading?: boolean;
  positionNames?: Record<string, string>;
  /** Positions available in the position Select. Falls back to distinct positions in events. */
  positions?: Array<{ id: string; label?: string }>;
  filters?: AuditTimelineFilters;
  onFiltersChange?: (next: AuditTimelineFilters) => void;
  page?: AuditTimelinePage;
  onCursorChange?: (next: string | null) => void;
  /** Deep-link handler for budget-related events; called with the runId of the source event. */
  onOpenCostDashboard?: (runId: string, positionId?: string) => void;
}

/** Terminal reason words that are budget-related (§ 6.1). */
const BUDGET_TERMINAL_REASONS = new Set<string>([
  "turn_budget_exceeded",
  "position_budget_exceeded",
]);

/** Event types that carry a red dot per design § 6.1. */
const RED_DOT_TYPES = new Set<AuditTimelineEventType>([
  "run.failed",
  "escalation.created",
]);

/** Map an event to its class (turn / approval / escalation / org). */
export function classifyAuditEvent(event: AuditTimelineEvent): AuditTimelineEventClass {
  switch (event.type) {
    case "approval.requested":
    case "approval.granted":
    case "approval.denied":
      return "approval";
    case "escalation.created":
      return "escalation";
    case "org.audit":
      return "org";
    default:
      return "turn";
  }
}

/** Is this event budget-related (drives red tag + deep link)? */
export function isBudgetRelatedEvent(event: AuditTimelineEvent): boolean {
  if (event.budgetRelated) return true;
  const reason = event.terminalReason;
  if (reason && BUDGET_TERMINAL_REASONS.has(reason)) return true;
  if (event.errorCode && (event.errorCode.includes("turn_budget_exceeded") || event.errorCode.includes("position_budget_exceeded"))) return true;
  return false;
}

/** True iff the event drives a red status dot (design § 6.1). */
export function isRedDotEvent(event: AuditTimelineEvent): boolean {
  if (RED_DOT_TYPES.has(event.type)) return true;
  if (isBudgetRelatedEvent(event)) return true;
  return false;
}

/**
 * Pure predicate: is the event visible under filters?
 * Exported so unit tests can exercise the classification independently.
 */
export function isEventVisible(event: AuditTimelineEvent, filters: AuditTimelineFilters | undefined): boolean {
  if (!filters) return true;
  if (filters.positionIds && filters.positionIds.length > 0) {
    if (!event.positionId) return false;
    if (!filters.positionIds.includes(event.positionId)) return false;
  }
  if (filters.classes && filters.classes.length > 0) {
    if (!filters.classes.includes(classifyAuditEvent(event))) return false;
  }
  if (filters.from) {
    if (event.at < filters.from) return false;
  }
  if (filters.to) {
    if (event.at > filters.to) return false;
  }
  return true;
}

/** Group filtered events by runId, preserving first-seen order. */
export function groupEventsByRun(events: AuditTimelineEvent[]): Array<{ runId: string; events: AuditTimelineEvent[] }> {
  const order: string[] = [];
  const map = new Map<string, AuditTimelineEvent[]>();
  for (const event of events) {
    const bucket = map.get(event.runId);
    if (bucket) {
      bucket.push(event);
    } else {
      order.push(event.runId);
      map.set(event.runId, [event]);
    }
  }
  return order.map((runId) => ({ runId, events: map.get(runId) ?? [] }));
}

/** Terminal reason → catalog key (design § 6.1); words resolve through t(). */
const TERMINAL_REASON_KEYS: Record<string, string> = {
  goal_met: "turn.trusted",
  turn_budget_exceeded: "rep.reasonTurnBudget",
  position_budget_exceeded: "rep.reasonPositionBudget",
  iteration_cap: "rep.reasonIterationCap",
  doom_loop: "rep.reasonDoomLoop",
  deadline_exceeded: "rep.reasonDeadline",
  cancelled: "rep.reasonCancelled",
  engine_internal_error: "rep.reasonEngineError",
  invalid_output_exhausted: "rep.reasonInvalidOutput",
};

function terminalReasonLabel(reason: string | undefined, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (reason === undefined) return "";
  const key = TERMINAL_REASON_KEYS[reason];
  return key !== undefined ? t(key) : reason;
}

/** Deep-link route for the cost dashboard. Uses hash-router pattern; caller may override. */
export function buildCostDashboardHref(runId: string, positionId?: string): string {
  const params = new URLSearchParams();
  params.set("runId", runId);
  if (positionId) params.set("positionId", positionId);
  return `#/reports/cost?${params.toString()}`;
}

/**
 * AuditTimeline — read-only, evidence-only merge of turn/approval/audit events.
 * v1 accepts a pre-merged `events` prop; SSE + record + audit merging happens upstream.
 */
export function AuditTimeline({
  events,
  loading,
  positionNames,
  positions,
  filters,
  onFiltersChange,
  page,
  onCursorChange,
  onOpenCostDashboard,
}: AuditTimelineProps) {
  const t = useT();
  // Filter out `model.delta` unconditionally (streaming text is not evidence).
  const evidenceOnly = useMemo(
    () => events.filter((event) => (event.type as string) !== "model.delta"),
    [events],
  );

  const [localFilters, setLocalFilters] = useState<AuditTimelineFilters>({});
  const activeFilters = filters ?? localFilters;
  const updateFilters = (next: AuditTimelineFilters) => {
    if (onFiltersChange) onFiltersChange(next);
    else setLocalFilters(next);
  };

  const visible = useMemo(
    () => evidenceOnly.filter((event) => isEventVisible(event, activeFilters)),
    [evidenceOnly, activeFilters],
  );

  const groups = useMemo(() => groupEventsByRun(visible), [visible]);

  const positionOptions = useMemo(() => {
    const seen = new Set<string>();
    const source = positions ?? [];
    for (const p of source) seen.add(p.id);
    for (const event of evidenceOnly) if (event.positionId) seen.add(event.positionId);
    return Array.from(seen).map((id) => {
      const meta = source.find((p) => p.id === id);
      return { value: id, label: meta?.label ?? positionNames?.[id] ?? t("rep.unknownPosition") };
    });
  }, [positions, positionNames, evidenceOnly]);

  const classOptions: Array<{ value: AuditTimelineEventClass; label: string }> = [
    { value: "turn", label: t("rep.classTurn") },
    { value: "approval", label: t("rep.classApproval") },
    { value: "escalation", label: t("rep.classEscalation") },
    { value: "org", label: t("rep.classOrg") },
  ];

  const pageSize = page?.pageSize ?? 50;
  const totalCount = page?.total ?? visible.length;

  return (
    <section className="owb-timeline" aria-label={t("rep.timelineAria")}>
      <div className="owb-timeline__toolbar" role="toolbar" aria-label={t("rep.timelineFilterAria")}>
        <Select
          size="small"
          mode="multiple"
          allowClear
          placeholder={t("rep.filterPositionPh")}
          className="owb-timeline__filter owb-timeline__filter--position"
          value={activeFilters.positionIds ?? []}
          options={positionOptions}
          onChange={(value: string[]) => updateFilters({ ...activeFilters, positionIds: value })}
          aria-label={t("rep.filterPositionAria")}
          data-testid="timeline-filter-position"
        />
        <Select
          size="small"
          mode="multiple"
          allowClear
          placeholder={t("rep.filterClassPh")}
          className="owb-timeline__filter owb-timeline__filter--class"
          value={activeFilters.classes ?? []}
          options={classOptions}
          onChange={(value: AuditTimelineEventClass[]) => updateFilters({ ...activeFilters, classes: value })}
          aria-label={t("rep.filterClassAria")}
          data-testid="timeline-filter-class"
        />
        <DatePicker.RangePicker
          size="small"
          showTime
          className="owb-timeline__filter owb-timeline__filter--range"
          value={null}
          onChange={(_dates, dateStrings) => {
            const [from, to] = dateStrings;
            updateFilters({ ...activeFilters, from: from || undefined, to: to || undefined });
          }}
          aria-label={t("rep.filterRangeAria")}
          data-testid="timeline-filter-range"
        />
        <span className="owb-timeline__count" aria-live="polite">{t("rep.totalCount", { count: visible.length })}</span>
      </div>

      {loading ? (
        <div className="owb-timeline__loading" data-testid="timeline-loading">
          <div className="owb-timeline__skeleton" />
          <div className="owb-timeline__skeleton" />
          <div className="owb-timeline__skeleton" />
        </div>
      ) : groups.length === 0 ? (
        <Empty
          className="owb-timeline__empty"
          data-testid="timeline-empty"
          description={
            evidenceOnly.length === 0
              ? t("rep.timelineEmpty")
              : t("rep.timelineEmptyFiltered")
          }
        />
      ) : (
        <Collapse
          className="owb-timeline__groups"
          bordered={false}
          expandIconPlacement="end"
          items={groups.map((group) => {
            const groupClass = groupSignatureClass(group.events);
            const budgetRelated = group.events.some((e) => isBudgetRelatedEvent(e));
            return {
              key: group.runId,
              className: `owb-timeline__group is-${groupClass}${budgetRelated ? " has-budget-flag" : ""}`,
              label: (
                <TimelineGroupHead
                  runId={group.runId}
                  events={group.events}
                  positionNames={positionNames}
                  onOpenCost={onOpenCostDashboard}
                />
              ),
              children: (
                <ul className="owb-timeline__events" data-testid={`timeline-group-${group.runId}`}>
                  {group.events.map((event) => (
                    <li key={event.id} className="owb-timeline__event">
                      <TimelineEventRow event={event} positionNames={positionNames} onOpenCost={onOpenCostDashboard} />
                    </li>
                  ))}
                </ul>
              ),
            };
          })}
        />
      )}

      {page && (page.hasMore || (typeof page.total === "number" && page.total > pageSize)) ? (
        <div className="owb-timeline__pagination">
          <Pagination
            size="small"
            simple
            current={1}
            total={totalCount}
            pageSize={pageSize}
            onChange={() => {
              if (onCursorChange) onCursorChange(page.cursor);
            }}
            data-testid="timeline-pagination"
          />
          <Button
            size="small"
            type="link"
            disabled={!page.hasMore}
            onClick={() => onCursorChange?.(page.cursor)}
            data-testid="timeline-load-more"
          >
            {t("rep.loadMore")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function groupSignatureClass(events: AuditTimelineEvent[]): "running" | "completed" | "failed" | "indeterminate" | "audit" | "neutral" {
  let hasFailed = false;
  let hasIndeterminate = false;
  let hasCompleted = false;
  let hasStarted = false;
  let allAudit = true;
  for (const event of events) {
    if (event.type !== "org.audit") allAudit = false;
    if (event.type === "run.failed") hasFailed = true;
    if (event.type === "turn.indeterminate") hasIndeterminate = true;
    if (event.type === "run.completed") hasCompleted = true;
    if (event.type === "run.started") hasStarted = true;
  }
  if (allAudit) return "audit";
  if (hasFailed) return "failed";
  if (hasIndeterminate) return "indeterminate";
  if (hasCompleted) return "completed";
  if (hasStarted) return "running";
  return "neutral";
}

function TimelineGroupHead({
  runId,
  events,
  positionNames,
  onOpenCost,
}: {
  runId: string;
  events: AuditTimelineEvent[];
  positionNames?: Record<string, string>;
  onOpenCost?: (runId: string, positionId?: string) => void;
}) {
  const t = useT();
  const localeTag = useLocaleTag();
  const first = events[0];
  const terminal = events.find(
    (e) => e.type === "run.failed" || e.type === "run.completed" || e.type === "turn.indeterminate",
  );
  const positionId = first?.positionId;
  const engine = first?.engine;
  const status = terminal?.type ?? first?.type ?? "run.started";
  const budgetRelated = events.some((e) => isBudgetRelatedEvent(e));
  const isFailed = status === "run.failed";
  const isIndeterminate = status === "turn.indeterminate";
  const isCompleted = status === "run.completed";
  const dotClass = isFailed || budgetRelated
    ? "is-danger"
    : isIndeterminate
      ? "is-warning"
      : isCompleted
        ? "is-success"
        : "is-primary";
  return (
    <div className="owb-timeline__group-head">
      <span
        className={`owb-timeline__dot ${dotClass}`}
        data-testid={`timeline-dot-${runId}`}
        aria-hidden="true"
      />
      <span className="owb-timeline__group-time">{formatTime(first?.at, localeTag)}</span>
      <strong className="owb-timeline__group-who">
        {positionId ? (positionNames?.[positionId] ?? t("rep.unknownPosition")) : t("rep.classOrg")}
        {engine ? <em className="owb-timeline__group-eng"> · {engineLabel(engine)}</em> : null}
      </strong>
      <span className="owb-timeline__group-status" data-status={status}>
        {status === "run.failed"
          ? t("rep.statusFailed", { reason: terminalReasonLabel(terminal?.terminalReason, t) })
          : status === "turn.indeterminate"
            ? t("turn.untrusted")
            : status === "run.completed"
              ? t("turn.trusted")
              : status === "org.audit"
                ? t("rep.classOrg")
                : t("turn.statusRunning")}
      </span>
      {budgetRelated ? (
        <>
          <Tag color="red" className="owb-timeline__budget-tag" data-testid={`timeline-budget-tag-${runId}`}>
            {t("rep.budgetRelated")}
          </Tag>
          <a
            className="owb-timeline__cost-link"
            href={buildCostDashboardHref(runId, positionId)}
            data-testid={`timeline-cost-link-${runId}`}
            onClick={(e) => {
              if (onOpenCost) {
                e.preventDefault();
                onOpenCost(runId, positionId);
              }
            }}
          >
            {t("rep.costLink")}
          </a>
        </>
      ) : null}
    </div>
  );
}

function TimelineEventRow({
  event,
  positionNames,
  onOpenCost,
}: {
  event: AuditTimelineEvent;
  positionNames?: Record<string, string>;
  onOpenCost?: (runId: string, positionId?: string) => void;
}) {
  const t = useT();
  const localeTag = useLocaleTag();
  const isBudget = isBudgetRelatedEvent(event);
  const isRed = isRedDotEvent(event);
  const isIndeterminate = event.type === "turn.indeterminate";
  const dotClass = isRed
    ? "is-danger"
    : isIndeterminate
      ? "is-warning is-indeterminate"
      : event.type === "run.completed"
        ? "is-success"
        : event.type === "org.audit"
          ? "is-neutral"
          : "is-primary";
  return (
    <div className={`owb-tc owb-timeline__card is-${event.type.replace(/\./g, "-")}${isIndeterminate ? " is-indeterminate" : ""}`}>
      <div className="owb-timeline__event-head">
        <span
          className={`owb-timeline__dot ${dotClass}`}
          data-testid={`timeline-event-dot-${event.id}`}
          data-indeterminate={isIndeterminate ? "true" : "false"}
          aria-hidden="true"
        />
        <time className="owb-tc-head__time">{formatTime(event.at, localeTag)}</time>
        <span className="owb-timeline__event-type">{typeLabel(event.type, t)}</span>
        {isBudget ? (
          <>
            <Tag color="red" className="owb-timeline__budget-tag" data-testid={`timeline-event-budget-${event.id}`}>
              {t("rep.budgetRelated")}
            </Tag>
            <a
              className="owb-timeline__cost-link"
              href={buildCostDashboardHref(event.runId, event.positionId)}
              data-testid={`timeline-event-cost-link-${event.id}`}
              onClick={(e) => {
                if (onOpenCost) {
                  e.preventDefault();
                  onOpenCost(event.runId, event.positionId);
                }
              }}
            >
              {t("rep.costLink")}
            </a>
          </>
        ) : null}
      </div>
      {event.summary ? <p className="owb-tc__task">{event.summary}</p> : null}
      {event.task ? (
        <p className="owb-tc__task"><span className="owb-tc__task-key">TASK</span>{event.task}</p>
      ) : null}
      {typeof event.totalTokens === "number" ? (
        <div className="owb-timeline__evidence">
          <span className="owb-timeline__tokens">{event.totalTokens.toLocaleString()} tokens</span>
        </div>
      ) : null}
      {event.reportingChain && event.reportingChain.length > 0 ? (
        <div className="owb-timeline__chain">
          {event.reportingChain.map((position) => (
            <span key={position}>{positionNames?.[position] ?? t("rep.unknownPosition")}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function typeLabel(type: AuditTimelineEventType, t: ReturnType<typeof useT>): string {
  switch (type) {
    case "run.started": return t("rep.eventStarted");
    case "usage": return t("rep.eventUsage");
    case "run.completed": return t("rep.eventCompleted");
    case "run.failed": return t("rep.eventFailed");
    case "turn.indeterminate": return t("rep.eventUnknown");
    case "approval.requested": return t("rep.eventApprovalRequested");
    case "approval.granted": return t("rep.eventApprovalGranted");
    case "approval.denied": return t("rep.eventApprovalDenied");
    case "escalation.created": return t("rep.eventEscalation");
    case "org.audit": return t("rep.eventOrgChange");
    case "hire.progress": return t("rep.eventHireProgress");
    default: return type;
  }
}

function engineLabel(engine: string): string {
  if (engine === "qoder") return "Qoder";
  if (engine === "claude-code") return "Claude Code";
  if (engine === "claude-local") return "Claude Local";
  return engine;
}

function formatTime(value: string | undefined, localeTag = "zh-CN"): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(localeTag, { hour12: false });
}

/** #146：时间格式跟随应用 locale（时间戳本身不变）。 */
function useLocaleTag(): string {
  return useOwbLocale() === "en" ? "en-US" : "zh-CN";
}

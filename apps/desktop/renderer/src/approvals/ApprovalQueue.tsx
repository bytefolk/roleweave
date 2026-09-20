/**
 * ApprovalQueue (design spec §5 · approval / overreach event queue)
 *
 * Reads a props-injected `items: ApprovalQueueItem[]` and renders a queue
 * of approval cards. Wired-in interactions (approve / deny) forward via
 * callbacks to the shared approval cache. The server resolves the source
 * conversation and constructs the resume turn; the UI never chooses it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, List, Select, Segmented, Tag, Tooltip } from "antd";
import { ArrowRight, Clock3, ShieldAlert, ShieldCheck } from "lucide-react";
import { useOwbLocale, useT, type OwbT } from "@roleweave/ui";
import {
  approvalExpiryState,
  isActionablePending,
  isDecided,
  isPermissionOverreach,
  type ApprovalCategory,
  type ApprovalQueueCallbacks,
  type ApprovalQueueItem,
} from "./types";
import { ApprovalDetailDrawer } from "./ApprovalDetailDrawer";
import { safeApprovalText } from "./safe-display";
import { decodeEscapedUnicode } from "../display-text";

export type ApprovalQueueFilter = "pending" | "decided" | "all";
export type ApprovalExpiryFilter = "all" | "active" | "expiring" | "expired";
export type ApprovalExecutionFilter = NonNullable<ApprovalQueueItem["executionPhase"]>;
export type ApprovalQueueDataState = "ready" | "not-connected";
type DesktopNotificationPermission = NotificationPermission | "unsupported";

export interface ApprovalQueueProps extends ApprovalQueueCallbacks {
  items: ApprovalQueueItem[];
  loading?: boolean;
  /** Read failure banner (e.g., control plane unreachable). Kept as a
   * plain message; App wires the actual apiErrorMessage in. */
  errorMessage?: string;
  defaultFilter?: ApprovalQueueFilter;
  /** `not-connected` is used when the host has not started deriving items
   * from turn history/SSE yet; it must not be presented as a real zero. */
  dataState?: ApprovalQueueDataState;
  onNavigateToOrg?: () => void;
}

const FILTER_OPTIONS: { labelKey: string; value: ApprovalQueueFilter }[] = [
  { labelKey: "apr.filterPending", value: "pending" },
  { labelKey: "apr.filterDecided", value: "decided" },
  { labelKey: "apr.filterAll", value: "all" },
];

const CATEGORY_TAG_COLOR: Record<ApprovalCategory, string> = {
  exec: "purple",
  write: "geekblue",
  network: "cyan",
  tool: "default",
};

const EXECUTION_FILTER_OPTIONS: ApprovalExecutionFilter[] = [
  "not_started", "starting", "running", "completed", "denied", "failed", "indeterminate",
];

const EXECUTION_TAG_COLOR: Record<ApprovalExecutionFilter, string> = {
  not_started: "default",
  starting: "processing",
  running: "processing",
  completed: "green",
  denied: "default",
  failed: "red",
  indeterminate: "orange",
};

function decisionLabel(item: ApprovalQueueItem, t: OwbT): string {
  switch (item.decision.kind) {
    case "pending":
      return t("apr.filterPending");
    case "granted":
      return t("apr.decisionGranted");
    case "denied":
      return t("apr.decisionDenied");
    case "expired":
      return t("apr.decisionExpired");
    case "cancelled":
    case "indeterminate":
      return t(`apr.status.${item.decision.kind}`);
  }
}

function decisionCssState(item: ApprovalQueueItem): string {
  return item.decision.kind;
}

function desktopNotificationPermission(): DesktopNotificationPermission {
  if (typeof window === "undefined" || typeof window.Notification !== "function") return "unsupported";
  return window.Notification.permission;
}

export function ApprovalQueue({
  items,
  loading,
  errorMessage,
  defaultFilter = "pending",
  dataState = "ready",
  onNavigateToOrg,
  onApprove,
  onDeny,
  onOpenSource,
  onOpenEvidence,
}: ApprovalQueueProps) {
  const t = useT();
  const [filter, setFilter] = useState<ApprovalQueueFilter>(defaultFilter);
  const [query, setQuery] = useState("");
  const [positionFilter, setPositionFilter] = useState<string>();
  const [categoryFilter, setCategoryFilter] = useState<ApprovalCategory>();
  const [executionFilter, setExecutionFilter] = useState<ApprovalExecutionFilter>();
  const [expiryFilter, setExpiryFilter] = useState<ApprovalExpiryFilter>();
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [notificationPermission, setNotificationPermission] = useState<DesktopNotificationPermission>(desktopNotificationPermission);
  const notificationSnapshot = useRef<Map<string, { status: ApprovalQueueItem["decision"]["kind"]; expiry: ReturnType<typeof approvalExpiryState> }>>();

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const next = new Map(items.map(item => [item.approvalId, { status: item.decision.kind, expiry: approvalExpiryState(item, now) }]));
    const previous = notificationSnapshot.current;
    notificationSnapshot.current = next;
    if (!previous || notificationPermission !== "granted" || typeof window.Notification !== "function") return;

    const notify = (title: string, body: string, tag: string) => {
      try { new window.Notification(title, { body, tag }); } catch { /* BrowserWindow may decline notifications. */ }
    };
    for (const item of items) {
      const before = previous.get(item.approvalId);
      const position = safeApprovalText(decodeEscapedUnicode(item.positionName ?? t("apr.unknownPosition")));
      if (!before && item.decision.kind === "pending") {
        notify(t("apr.notificationNewTitle"), t("apr.notificationNewBody", { position, category: t(`apr.kind.${item.category}`) }), `approval-${item.approvalId}`);
      } else if (before?.status === "pending" && item.decision.kind !== "pending") {
        notify(t("apr.notificationDecisionTitle"), t("apr.notificationDecisionBody", { position, status: decisionLabel(item, t) }), `approval-${item.approvalId}`);
      } else if (before?.expiry !== "expiring" && next.get(item.approvalId)?.expiry === "expiring") {
        notify(t("apr.notificationExpiryTitle"), t("apr.notificationExpiryBody", { position }), `approval-${item.approvalId}`);
      }
    }
  }, [items, notificationPermission, now, t]);

  const pendingCount = useMemo(
    () => items.filter((item) => isActionablePending(item, now)).length,
    [items, now],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (filter === "pending" && !isActionablePending(item, now)) return false;
      if (filter === "decided" && !isDecided(item)) return false;
      if (positionFilter && item.positionId !== positionFilter) return false;
      if (categoryFilter && item.category !== categoryFilter) return false;
      if (executionFilter && (item.executionPhase ?? "not_started") !== executionFilter) return false;
      if (expiryFilter && expiryFilter !== "all" && approvalExpiryState(item, now) !== expiryFilter) return false;
      if (fromDate && (!item.requestedAt || item.requestedAt.slice(0, 10) < fromDate)) return false;
      if (toDate && (!item.requestedAt || item.requestedAt.slice(0, 10) > toDate)) return false;
      if (needle) {
        const haystack = [
          item.positionName,
          item.positionId,
          item.category,
          item.description,
          item.target,
          item.requestReason,
          item.source?.conversationId,
          item.source?.turnId,
          item.source?.runId,
          item.decision.kind,
          item.decision.kind === "denied" || item.decision.kind === "granted" ? item.decision.reason : undefined,
          item.executionErrorCode,
          item.executionPhase,
        ].filter(Boolean).join(" ").toLocaleLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [categoryFilter, executionFilter, expiryFilter, filter, fromDate, items, now, positionFilter, query, toDate]);

  const positionOptions = useMemo(() => [...new Map(items.map((item) => [item.positionId, item.positionName ?? item.positionId]))]
    .sort((a, b) => a[1].localeCompare(b[1])), [items]);
  const expiringSoonCount = useMemo(() => items.filter(item => approvalExpiryState(item, now) === "expiring").length, [items, now]);
  const hasAdvancedFilters = Boolean(query || positionFilter || categoryFilter || executionFilter || expiryFilter || fromDate || toDate);
  const clearAdvancedFilters = () => {
    setQuery("");
    setPositionFilter(undefined);
    setCategoryFilter(undefined);
    setExecutionFilter(undefined);
    setExpiryFilter(undefined);
    setFromDate("");
    setToDate("");
  };
  const enableDesktopNotifications = async () => {
    if (typeof window.Notification !== "function") return;
    try { setNotificationPermission(await window.Notification.requestPermission()); } catch { setNotificationPermission(desktopNotificationPermission()); }
  };

  const selectedItem = useMemo(
    () => items.find((item) => item.approvalId === selectedId) ?? null,
    [items, selectedId],
  );

  return (
    <section className="owb-approval-queue" aria-label={t("apr.center")}>
      <header className="owb-approval-queue__hero">
        <div className="owb-approval-queue__hero-copy">
          <div className="owb-approval-queue__title-row">
            <h1 className="owb-approval-queue__title">{t("apr.center")}</h1>
            <span className={`owb-approval-queue__state is-${dataState}`}>
              <span aria-hidden="true" />
              {dataState === "ready" ? t("apr.dataStateReady") : t("apr.dataStateDisconnected")}
            </span>
          </div>
          <p className="owb-approval-queue__lede">{t("apr.centerLede")}</p>
        </div>
        <div className="owb-approval-queue__metric" aria-label={t("apr.pendingBadge", { count: pendingCount })}>
          <span className="owb-approval-queue__metric-icon" aria-hidden="true">
            <ShieldAlert size={18} />
          </span>
          <span className="owb-approval-queue__metric-copy">
            <strong>{pendingCount}</strong>
            <span>{t("apr.filterPending")}</span>
          </span>
        </div>
      </header>

      <div className="owb-approval-queue__toolbar" role="toolbar" aria-label={t("apr.filterAria")}>
        <div className="owb-approval-queue__filter-label">
          <span>{t("apr.decisionStatus")}</span>
          <Segmented
            value={filter}
            onChange={(value) => setFilter(value as ApprovalQueueFilter)}
            options={FILTER_OPTIONS.map((option) => ({ label: t(option.labelKey), value: option.value }))}
            aria-label={t("apr.filterStateAria")}
          />
        </div>
        <Input
          allowClear
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("apr.filterKeywordPh")}
          aria-label={t("apr.filterKeywordAria")}
          className="owb-approval-queue__search"
          data-testid="approval-filter-keyword"
        />
        <Select
          allowClear
          value={positionFilter}
          onChange={setPositionFilter}
          placeholder={t("apr.filterPosition")}
          options={positionOptions.map(([value, label]) => ({ value, label }))}
          aria-label={t("apr.filterPositionAria")}
          className="owb-approval-queue__select"
          data-testid="approval-filter-position"
        />
        <Select
          allowClear
          value={categoryFilter}
          onChange={setCategoryFilter}
          placeholder={t("apr.filterCategory")}
          options={Object.keys(CATEGORY_TAG_COLOR).map((value) => ({ value, label: t(`apr.kind.${value as ApprovalCategory}`) }))}
          aria-label={t("apr.filterCategoryAria")}
          className="owb-approval-queue__select"
          data-testid="approval-filter-category"
        />
        <Select
          allowClear
          value={executionFilter}
          onChange={setExecutionFilter}
          placeholder={t("apr.filterExecution")}
          options={EXECUTION_FILTER_OPTIONS.map((value) => ({ value, label: t(`apr.phase.${value}`) }))}
          aria-label={t("apr.filterExecutionAria")}
          className="owb-approval-queue__select"
          data-testid="approval-filter-execution"
        />
        <Select
          allowClear
          value={expiryFilter}
          onChange={setExpiryFilter}
          placeholder={t("apr.filterExpiry")}
          options={[
            { value: "active", label: t("apr.filterExpiryActive") },
            { value: "expiring", label: t("apr.filterExpirySoon") },
            { value: "expired", label: t("apr.filterExpiryExpired") },
          ]}
          aria-label={t("apr.filterExpiryAria")}
          className="owb-approval-queue__select"
          data-testid="approval-filter-expiry"
        />
        <Input
          type="date"
          value={fromDate}
          onChange={(event) => setFromDate(event.target.value)}
          aria-label={t("apr.filterFromAria")}
          className="owb-approval-queue__date"
          data-testid="approval-filter-from"
        />
        <Input
          type="date"
          value={toDate}
          onChange={(event) => setToDate(event.target.value)}
          aria-label={t("apr.filterToAria")}
          className="owb-approval-queue__date"
          data-testid="approval-filter-to"
        />
        {hasAdvancedFilters ? <Button type="link" onClick={clearAdvancedFilters}>{t("apr.clearFilters")}</Button> : null}
        {notificationPermission === "default" ? <Button type="link" onClick={() => void enableDesktopNotifications()}>{t("apr.enableDesktopNotifications")}</Button> : null}
        <span className="owb-approval-queue__count">{t("apr.filteredRecords", { visible: visible.length, total: items.length })}</span>
      </div>

      {expiringSoonCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t("apr.expiryReminder", { count: expiringSoonCount })}
          action={<Button type="link" size="small" onClick={() => setExpiryFilter("expiring")}>{t("apr.showExpiring")}</Button>}
          className="owb-approval-queue__banner"
        />
      ) : null}

      {errorMessage ? (
        <Alert
          type="warning"
          showIcon
          message={t("apr.offlineBanner")}
          description={errorMessage}
          className="owb-approval-queue__banner"
        />
      ) : null}

      {loading ? (
        <div className="owb-approval-queue__loading" aria-label={t("apr.queueLoading")}>
          <List
            dataSource={[0, 1, 2]}
            renderItem={(key) => (
              <List.Item key={key}>
                <div className="owb-approval-card is-skeleton" />
              </List.Item>
            )}
          />
        </div>
      ) : visible.length === 0 ? (
        <ApprovalEmptyState
          filter={filter}
          dataState={dataState}
          onNavigateToOrg={onNavigateToOrg}
        />
      ) : (
        <List
          className="owb-approval-queue__list"
          dataSource={visible}
          rowKey={(item) => item.approvalId}
          renderItem={(item) => (
            <List.Item className="owb-approval-queue__item">
              <ApprovalCard
                item={item}
                now={now}
                onOpen={() => setSelectedId(item.approvalId)}
              />
            </List.Item>
          )}
        />
      )}

      <ApprovalDetailDrawer
        open={selectedItem !== null}
        item={selectedItem}
        now={now}
        onClose={() => setSelectedId(null)}
        onApprove={onApprove}
        onDeny={onDeny}
        onOpenSource={onOpenSource}
        onOpenEvidence={onOpenEvidence}
      />
    </section>
  );
}

function ApprovalEmptyState({
  filter,
  dataState,
  onNavigateToOrg,
}: {
  filter: ApprovalQueueFilter;
  dataState: ApprovalQueueDataState;
  onNavigateToOrg?: () => void;
}) {
  const t = useT();
  const disconnected = dataState === "not-connected";
  const title = disconnected
    ? t("apr.emptyDisconnectedTitle")
    : filter === "pending"
      ? t("apr.emptyPendingTitle")
      : filter === "decided"
        ? t("apr.emptyDecidedTitle")
        : t("apr.emptyAllTitle");
  const description = disconnected
    ? t("apr.emptyDisconnectedDesc")
    : filter === "pending"
      ? t("apr.emptyPendingDesc")
      : filter === "decided"
        ? t("apr.emptyDecidedDesc")
        : t("apr.emptyAllDesc");

  return (
    <section className={`owb-approval-queue__empty is-${disconnected ? "disconnected" : filter}`}>
      <div className="owb-approval-queue__empty-icon" aria-hidden="true">
        {disconnected ? <Clock3 size={24} /> : <ShieldCheck size={26} />}
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      <div className="owb-approval-queue__rules" aria-label={t("apr.rulesAria")}>
        <div>
          <strong>{t("apr.rulesWhenTitle")}</strong>
          <span>{t("apr.rulesWhenDesc")}</span>
        </div>
        <div>
          <strong>{t("apr.rulesHowTitle")}</strong>
          <span>{t("apr.rulesHowDesc")}</span>
        </div>
      </div>
      {disconnected && onNavigateToOrg ? (
        <Button type="primary" ghost onClick={onNavigateToOrg} icon={<ArrowRight size={14} />}>
          {t("apr.backToOrg")}
        </Button>
      ) : null}
    </section>
  );
}

interface ApprovalCardProps {
  item: ApprovalQueueItem;
  now: number;
  onOpen: () => void;
}

function ApprovalCard({ item, now, onOpen }: ApprovalCardProps) {
  const t = useT();
  const localeTag = useOwbLocale() === "en" ? "en-US" : "zh-CN";
  const positionName = decodeEscapedUnicode(item.positionName ?? t("apr.unknownPosition"));
  const description = safeApprovalText(decodeEscapedUnicode(item.description));
  const target = item.target ? safeApprovalText(decodeEscapedUnicode(item.target)) : undefined;
  const overreach = isPermissionOverreach(item);
  const decided = isDecided(item);
  const expiry = approvalExpiryState(item, now);
  const expiringSoon = expiry === "expiring";
  const expired = expiry === "expired";
  const executionPhase = item.executionPhase ?? "not_started";
  const decisionTagColor = expired
    ? "default"
    : !decided
    ? "blue"
    : item.decision.kind === "granted"
      ? "green"
      : item.decision.kind === "denied"
        ? "red"
        : "default";
  return (
    <article
      className="owb-approval-card"
      data-testid={`approval-card-${item.approvalId}`}
      data-approval-id={item.approvalId}
      data-decision-state={decisionCssState(item)}
      data-expiry-state={expiry}
      data-execution-phase={executionPhase}
      data-overreach={overreach ? "true" : "false"}
      data-decided={decided ? "true" : "false"}
      onClick={onOpen}
    >
      <button
        type="button"
        className="owb-approval-card__row"
        onClick={onOpen}
        aria-label={t("apr.cardAria")}
      >
        <div className="owb-approval-card__head">
          <span className="owb-approval-card__tags">
            <Tag color={CATEGORY_TAG_COLOR[item.category]}>
              {t(`apr.kind.${item.category}`)}
            </Tag>
            {overreach ? (
              <Tag color="red" data-testid="approval-overreach-tag">
                {t("apr.overreach")}
              </Tag>
            ) : null}
            {item.positionMode ? (
              <Tag color={item.positionMode === "read_only" ? "default" : "purple"}>
                {t("apr.modeTag", { mode: item.positionMode === "read_only" ? t("pos.readOnly") : t("pos.approval") })}
              </Tag>
            ) : null}
            {expiringSoon ? <Tag color="orange">{t("apr.expiringSoon")}</Tag> : null}
            <Tag color={decisionTagColor}>{expired ? t("apr.decisionExpired") : decisionLabel(item, t)}</Tag>
            {executionPhase !== "not_started" ? <Tag color={EXECUTION_TAG_COLOR[executionPhase]}>{t(`apr.phase.${executionPhase}`)}</Tag> : null}
          </span>
        </div>
        <div className="owb-approval-card__title">
          <strong>{positionName}</strong>
        </div>
        <p className="owb-approval-card__description" title={description}>
          {description}
        </p>
        {target ? (
          <p className="owb-approval-card__target" title={target}>
            {target}
          </p>
        ) : null}
        <p className="owb-approval-card__meta">
          {item.requestedAt ? <span>{t("apr.requested", { at: formatApprovalTime(item.requestedAt, t, localeTag) })}</span> : null}
          {item.expiresAt ? (
            <Tooltip title={item.expiresAt}>
              <span className="owb-approval-card__expires">{t("apr.expires", { at: formatApprovalTime(item.expiresAt, t, localeTag) })}</span>
            </Tooltip>
          ) : null}
        </p>
      </button>
    </article>
  );
}

function formatApprovalTime(value: string | undefined, t: OwbT, localeTag: string): string {
  if (!value) return t("apr.undeclaredTime");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(localeTag, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

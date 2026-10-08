/**
 * ApprovalQueue (design spec §5 · approval / overreach event queue)
 *
 * Reads a props-injected `items: ApprovalQueueItem[]` and renders a queue
 * of approval cards. Wired-in interactions (approve / deny) forward via
 * callbacks to the shared approval cache. The server resolves the source
 * conversation and constructs the resume turn; the UI never chooses it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Input, List, Select, Segmented, Space, Tag, Tooltip } from "antd";
import { ArrowRight, FilePenLine, Globe, RefreshCw, SlidersHorizontal, Terminal, Wrench } from "lucide-react";
import { DateField, useOwbLocale, useT, type OwbT } from "@roleweave/ui";
import {
  approvalExpiryState,
  isActionablePending,
  isDecided,
  isPermissionOverreach,
  type ApprovalCategory,
  type ApprovalQueueCallbacks,
  type ApprovalQueueItem,
} from "./types";
import "../inbox/inbox-workspace.css";
import { ApprovalDetail } from "./ApprovalDetail";
import { safeApprovalText } from "./safe-display";
import { decodeEscapedUnicode } from "../display-text";

export type ApprovalQueueFilter = "pending" | "decided" | "all" | "expired";
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
  onRefresh?: () => void;
  focusApprovalId?: string;
}

const FILTER_OPTIONS: { labelKey: string; value: ApprovalQueueFilter }[] = [
  { labelKey: "apr.filterPending", value: "pending" },
  { labelKey: "apr.filterAll", value: "all" },
  { labelKey: "apr.filterDecided", value: "decided" },
  { labelKey: "inbox.filterExpired", value: "expired" },
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

function toLocalDateString(isoString?: string): string {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function ApprovalQueue({
  items,
  loading,
  errorMessage,
  defaultFilter = "pending",
  dataState = "ready",
  onNavigateToOrg,
  onRefresh,
  focusApprovalId,
  onApprove,
  onDeny,
  onOpenSource,
  onOpenEvidence,
  onApproveBatch,
  onDenyBatch,
}: ApprovalQueueProps) {
  const t = useT();
  const [filter, setFilter] = useState<ApprovalQueueFilter>(defaultFilter);
  const [query, setQuery] = useState("");
  const [positionFilter, setPositionFilter] = useState<string>();
  const [riskFilter, setRiskFilter] = useState<string>();
  const [categoryFilter, setCategoryFilter] = useState<ApprovalCategory>();
  const [executionFilter, setExecutionFilter] = useState<ApprovalExecutionFilter>();
  const [expiryFilter, setExpiryFilter] = useState<ApprovalExpiryFilter>();
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const workspaceRef = useRef<HTMLElement>(null);
  const focusNextRequest = useRef(false);
  const [batchSelection, setBatchSelection] = useState<ReadonlySet<string>>(new Set());
  const [batchOperating, setBatchOperating] = useState(false);
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

  useEffect(() => {
    setBatchSelection(current => {
      if (current.size === 0) return current;
      const next = new Set<string>();
      for (const id of current) {
        const item = items.find(candidate => candidate.approvalId === id);
        if (item && isActionablePending(item, now)) {
          next.add(id);
        }
      }
      return next.size === current.size ? current : next;
    });
  }, [items, now]);

  const pendingCount = useMemo(
    () => items.filter((item) => isActionablePending(item, now) && item.canDecide !== false).length,
    [items, now],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (filter === "pending" && (!isActionablePending(item, now) || item.canDecide === false)) return false;
      if (filter === "expired" && approvalExpiryState(item, now) !== "expired") return false;
      if (riskFilter && item.context?.risk !== riskFilter) return false;
      if (filter === "decided" && !isDecided(item)) return false;
      if (positionFilter && item.positionId !== positionFilter) return false;
      if (categoryFilter && item.category !== categoryFilter) return false;
      if (executionFilter && (item.executionPhase ?? "not_started") !== executionFilter) return false;
      if (expiryFilter && expiryFilter !== "all" && approvalExpiryState(item, now) !== expiryFilter) return false;
      const localDate = toLocalDateString(item.requestedAt);
      if (fromDate && (!localDate || localDate < fromDate)) return false;
      if (toDate && (!localDate || localDate > toDate)) return false;
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
    }).sort((a, b) => (Date.parse(b.requestedAt ?? "") || 0) - (Date.parse(a.requestedAt ?? "") || 0));
  }, [riskFilter, categoryFilter, executionFilter, expiryFilter, filter, fromDate, items, now, positionFilter, query, toDate]);

  const positionOptions = useMemo(() => [...new Map(items.map((item) => [item.positionId, item.positionName ?? item.positionId]))]
    .sort((a, b) => a[1].localeCompare(b[1])), [items]);
  const expiringSoonCount = useMemo(() => items.filter(item => approvalExpiryState(item, now) === "expiring").length, [items, now]);
  const hasAdvancedFilters = Boolean(riskFilter || query || positionFilter || categoryFilter || executionFilter || expiryFilter || fromDate || toDate);
  const clearAdvancedFilters = () => {
    setSelectedId(null);
    setRiskFilter(undefined);
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

  const consumedFocus = useRef<string>();
  useEffect(() => { if (focusApprovalId && consumedFocus.current !== focusApprovalId && items.some(item => item.approvalId === focusApprovalId)) { consumedFocus.current = focusApprovalId; setFilter("all"); setSelectedId(focusApprovalId); } }, [focusApprovalId, items]);

  const selectedItem = items.find((item) => item.approvalId === selectedId) ?? visible[0] ?? null;
  useEffect(() => {
    if (selectedItem?.approvalId !== selectedId) setSelectedId(selectedItem?.approvalId ?? null);
    if (focusNextRequest.current) {
      workspaceRef.current?.querySelector<HTMLElement>(".owb-approval-detail__header h2")?.focus({ preventScroll: true });
      focusNextRequest.current = false;
    }
  }, [selectedItem?.approvalId, selectedId]);
  const selectedIndex = visible.findIndex(item => item.approvalId === selectedItem?.approvalId);
  useEffect(() => {
    if (selectedIndex >= 0) setPage(Math.floor(selectedIndex / pageSize) + 1);
  }, [selectedIndex, pageSize]);
  const nextItem = selectedIndex < 0 ? visible[0] : visible[(selectedIndex + 1) % visible.length];
  const batchSelectedItems = useMemo(() => items.filter(item => batchSelection.has(item.approvalId)), [batchSelection, items]);
  const batchSource = batchSelectedItems[0]?.source;
  const batchSourceLabel = batchSource ? `${batchSource.positionId} · ${batchSource.conversationId}` : "";
  const canBatchItem = (item: ApprovalQueueItem) => item.batchMaxItems !== undefined && item.canDecide !== false &&
    !errorMessage && item.busy !== true && isActionablePending(item, now) && item.source !== undefined && item.source.kind !== "group";
  const batchVerified = batchSelectedItems.every(canBatchItem);
  const sameTurnBatchableItems = useMemo(() => {
    if (!batchSource) return [];
    return visible.filter(item =>
      canBatchItem(item) &&
      item.source &&
      item.source.kind === batchSource.kind &&
      item.source.positionId === batchSource.positionId &&
      item.source.conversationId === batchSource.conversationId &&
      item.source.turnId === batchSource.turnId &&
      item.source.runId === batchSource.runId &&
      item.source.engine === batchSource.engine
    );
  }, [visible, batchSource, now, errorMessage]);
  const selectBatchItem = (item: ApprovalQueueItem, checked: boolean) => {
    if (batchOperating || !canBatchItem(item)) return;
    setBatchSelection(current => {
      const next = new Set(current);
      if (!checked) { next.delete(item.approvalId); return next; }
      const selected = items.find(candidate => current.has(candidate.approvalId));
      if (selected?.source && item.source && (selected.source.kind !== item.source.kind || selected.source.positionId !== item.source.positionId || selected.source.conversationId !== item.source.conversationId || selected.source.turnId !== item.source.turnId || selected.source.runId !== item.source.runId || selected.source.engine !== item.source.engine)) return current;
      const maximum = Math.min(item.batchMaxItems ?? 0, ...(selected ? [selected.batchMaxItems ?? 0] : []));
      if (next.size >= maximum) return current;
      next.add(item.approvalId); return next;
    });
  };

  return (
    <section ref={workspaceRef} className="owb-approval-queue" aria-label={t("apr.center")}>
      <header className="owb-inbox-hero"><div><h1>{t("inbox.approvalTitle")}</h1><p>{t("inbox.approvalLede")}</p></div>{onRefresh ? <Button icon={<RefreshCw size={14} />} loading={loading} onClick={onRefresh}>{t("rep.refresh")}</Button> : null}</header>
      <div className="owb-approval-queue__toolbar" role="toolbar" aria-label={t("apr.filterAria")}>
        <div className="owb-approval-queue__filter-label">
          <Segmented
            value={filter}
            onChange={(value) => { setSelectedId(null); setFilter(value as ApprovalQueueFilter); }}
            options={FILTER_OPTIONS.map((option) => ({ label: <span>{t(option.labelKey)} <small>{loading || dataState !== "ready" ? "—" : option.value === "pending" ? pendingCount : option.value === "all" ? items.length : items.filter(item => option.value === "expired" ? approvalExpiryState(item, now) === "expired" : isDecided(item)).length}</small></span>, value: option.value, title: t(option.labelKey) }))}
            aria-label={t("apr.filterStateAria")}
          />
        </div>
        <Input
          allowClear
          value={query}
          onChange={(event) => { setSelectedId(null); setQuery(event.target.value); }}
          placeholder={t("apr.filterKeywordPh")}
          aria-label={t("apr.filterKeywordAria")}
          className="owb-approval-queue__search"
          data-testid="approval-filter-keyword"
        />
        <Select allowClear value={riskFilter} onChange={value => { setSelectedId(null); setRiskFilter(value); }} aria-label={t("inbox.riskFilter")} placeholder={t("inbox.allRisks")} options={["low", "medium", "high"].map(value => ({ value, label: t(`apr.risk.${value}`) }))} />
        <Select allowClear value={positionFilter} onChange={value => { setSelectedId(null); setPositionFilter(value); }} aria-label={t("inbox.roleFilter")} placeholder={t("apr.filterPosition")} options={positionOptions.map(([value, label]) => ({ value, label }))} />
        <Button icon={<SlidersHorizontal size={14} />} aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>{t("apr.moreFilters")}</Button>
        {hasAdvancedFilters ? <Button type="text" onClick={clearAdvancedFilters}>{t("apr.clearFilters")}</Button> : null}
        {notificationPermission === "default" ? <Button type="text" onClick={() => void enableDesktopNotifications()}>{t("apr.enableDesktopNotifications")}</Button> : null}
      </div>
      {filtersOpen ? <div className="owb-approval-queue__advanced">
        <Select
          allowClear
          value={positionFilter}
          onChange={(value) => { setSelectedId(null); setPositionFilter(value); }}
          placeholder={t("apr.filterPosition")}
          options={positionOptions.map(([value, label]) => ({ value, label }))}
          aria-label={t("apr.filterPositionAria")}
          className="owb-approval-queue__select"
          data-testid="approval-filter-position"
        />
        <Select
          allowClear
          value={categoryFilter}
          onChange={(value) => { setSelectedId(null); setCategoryFilter(value); }}
          placeholder={t("apr.filterCategory")}
          options={Object.keys(CATEGORY_TAG_COLOR).map((value) => ({ value, label: t(`apr.kind.${value as ApprovalCategory}`) }))}
          aria-label={t("apr.filterCategoryAria")}
          className="owb-approval-queue__select"
          data-testid="approval-filter-category"
        />
        <Select
          allowClear
          value={executionFilter}
          onChange={(value) => { setSelectedId(null); setExecutionFilter(value); }}
          placeholder={t("apr.filterExecution")}
          options={EXECUTION_FILTER_OPTIONS.map((value) => ({ value, label: t(`apr.phase.${value}`) }))}
          aria-label={t("apr.filterExecutionAria")}
          className="owb-approval-queue__select"
          data-testid="approval-filter-execution"
        />
        <Select
          allowClear
          value={expiryFilter}
          onChange={(value) => { setSelectedId(null); setExpiryFilter(value); }}
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
        <DateField
          value={fromDate}
          onChange={(value) => { setSelectedId(null); setFromDate(value); }}
          aria-label={t("apr.filterFromAria")}
          className="owb-approval-queue__date"
          data-testid="approval-filter-from"
        />
        <DateField
          value={toDate}
          onChange={(value) => { setSelectedId(null); setToDate(value); }}
          aria-label={t("apr.filterToAria")}
          className="owb-approval-queue__date"
          data-testid="approval-filter-to"
        />
      </div> : null}

      {expiringSoonCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          title={t("apr.expiryReminder", { count: expiringSoonCount })}
          action={<Button type="link" size="small" onClick={() => { setSelectedId(null); setExpiryFilter("expiring"); }}>{t("apr.showExpiring")}</Button>}
          className="owb-approval-queue__banner"
        />
      ) : null}

      {errorMessage ? (
        <Alert
          type="warning"
          showIcon
          title={t("apr.offlineBanner")}
          description={errorMessage}
          action={onRefresh ? <Button onClick={onRefresh}>{t("inbox.retry")}</Button> : undefined}
          className="owb-approval-queue__banner"
        />
      ) : null}

      <div className="owb-approval-workspace">
      <section className="owb-approval-workspace__queue" aria-label={t("apr.requestList")}>
        <header className="owb-approval-workspace__queue-header">
          <strong aria-label={dataState === "ready" ? t("apr.pendingBadge", { count: pendingCount }) : t("apr.dataStateDisconnected")}>{dataState === "ready" ? t("apr.pendingBadge", { count: pendingCount }) : t("apr.dataStateDisconnected")}</strong>
          {dataState === "ready" ? <span>{t("apr.filteredRecords", { visible: visible.length, total: items.length })}</span> : null}
        </header>
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
      ) : visible.length === 0 && hasAdvancedFilters ? (
        <section className="owb-inbox-state"><h2>{t("inbox.noMatches")}</h2><p>{t("inbox.noMatchesHint")}</p><Button onClick={clearAdvancedFilters}>{t("apr.clearFilters")}</Button></section>
      ) : visible.length === 0 && errorMessage ? (
        <section className="owb-inbox-state"><h2>{t("inbox.loadFailed")}</h2>{onRefresh ? <Button onClick={onRefresh}>{t("inbox.retry")}</Button> : null}</section>
      ) : visible.length === 0 ? (
        <ApprovalEmptyState
          filter={filter}
          dataState={dataState}
          onNavigateToOrg={onNavigateToOrg}
        />
      ) : (
        <>
          {batchSelectedItems.length > 0 ? (
            <Alert
              className="owb-approval-queue__batch-summary"
              type="info"
              showIcon
              title={t("apr.batchSummary", { count: batchSelectedItems.length, source: batchSourceLabel })}
              description={
                batchSelectedItems.length < 2 ? (
                  t("apr.batchNeedMore")
                ) : (
                  <div>
                    <div>{t("apr.batchBoundary")}</div>
                    <div style={{ marginTop: 2, opacity: 0.85 }}>{t("apr.batchDenyBoundary")}</div>
                  </div>
                )
              }
              action={
                <Space>
                  {sameTurnBatchableItems.length > batchSelectedItems.length &&
                  batchSelectedItems.length < Math.min(...sameTurnBatchableItems.map(i => i.batchMaxItems ?? 32)) ? (
                    <Button
                      size="small"
                      disabled={batchOperating || !batchVerified}
                      data-testid="approval-batch-select-all-turn"
                      onClick={() => {
                        const maximum = Math.min(...sameTurnBatchableItems.map(i => i.batchMaxItems ?? 32));
                        const selectedIds = new Set(batchSelectedItems.map(i => i.approvalId));
                        const unselected = sameTurnBatchableItems.filter(i => !selectedIds.has(i.approvalId));
                        const ordered = [...batchSelectedItems, ...unselected];
                        const toSelect = ordered.slice(0, maximum).map(i => i.approvalId);
                        setBatchSelection(new Set(toSelect));
                      }}
                    >
                      {t("apr.batchSelectAllTurn", { count: sameTurnBatchableItems.length })}
                    </Button>
                  ) : null}
                  <Button
                    type="primary"
                    size="small"
                    disabled={batchSelectedItems.length < 2 || !onApproveBatch || batchOperating || !batchVerified || batchSelectedItems.some(isPermissionOverreach)}
                    loading={batchOperating}
                    onClick={() => {
                      const ids = batchSelectedItems.map(item => item.approvalId);
                      setBatchSelection(new Set());
                      onApproveBatch?.(ids);
                    }}
                  >
                    {t("apr.batchApprove")}
                  </Button>
                  <Button
                    danger
                    size="small"
                    data-testid="approval-batch-deny-button"
                    disabled={batchSelectedItems.length < 2 || !onDenyBatch || batchOperating || !batchVerified}
                    loading={batchOperating}
                    onClick={async () => {
                      const ids = batchSelectedItems.map(item => item.approvalId);
                      setBatchOperating(true);
                      try {
                        const result = await onDenyBatch?.(ids);
                        if (result && typeof result === "object" && "succeeded" in result && Array.isArray((result as { succeeded: string[] }).succeeded)) {
                          const succeededSet = new Set((result as { succeeded: string[] }).succeeded);
                          setBatchSelection(current => new Set([...current].filter(id => !succeededSet.has(id))));
                        } else {
                          setBatchSelection(new Set());
                        }
                      } catch {
                        // Retain current selection on unexpected error so operator can retry
                      } finally {
                        setBatchOperating(false);
                      }
                    }}
                  >
                    {t("apr.bulkDeny")}
                  </Button>
                </Space>
              }
            />
          ) : null}
          <List
            className="owb-approval-queue__list"
            dataSource={visible}
            rowKey={(item) => item.approvalId}
            pagination={visible.length > 20 ? {
              current: Math.min(page, Math.max(1, Math.ceil(visible.length / pageSize))),
              pageSize,
              showSizeChanger: true,
              pageSizeOptions: ["10", "20", "50", "100"],
              size: "small",
              showTotal: (total, range) => `${range[0]}-${range[1]} / ${total}`,
              onChange: (nextPage, nextSize) => {
                setPage(nextPage);
                setPageSize(nextSize);
                setSelectedId(visible[(nextPage - 1) * nextSize]?.approvalId ?? null);
              },
            } : false}
            renderItem={(item) => (
              <List.Item className="owb-approval-queue__item">
                <ApprovalCard
                  item={item}
                  now={now}
                  selected={selectedItem?.approvalId === item.approvalId}
                  batchSelected={batchSelection.has(item.approvalId)}
                  batchDisabled={!canBatchItem(item) || batchOperating || (batchSelectedItems.length > 0 && batchSource !== undefined && (!item.source || item.source.kind !== batchSource.kind || item.source.positionId !== batchSource.positionId || item.source.conversationId !== batchSource.conversationId || item.source.turnId !== batchSource.turnId || item.source.runId !== batchSource.runId || item.source.engine !== batchSource.engine))}
                  onBatchChange={(checked) => selectBatchItem(item, checked)}
                  onOpen={() => setSelectedId(item.approvalId)}
                />
              </List.Item>
            )}
          />
        </>
      )}

      {visible.length === 0 && filter === "pending" && !loading && !errorMessage ? <Button type="link" onClick={() => setFilter("decided")}>{t("inbox.viewProcessed")}</Button> : null}
      </section>
      <ApprovalDetail
        item={loading ? null : selectedItem && (batchOperating || errorMessage) ? { ...selectedItem, busy: batchOperating, canDecide: errorMessage ? false : selectedItem.canDecide } : selectedItem}
        now={now}
        onNext={nextItem && nextItem.approvalId !== selectedItem?.approvalId ? () => { focusNextRequest.current = true; setSelectedId(nextItem.approvalId); } : undefined}
        onApprove={onApprove}
        onDeny={onDeny}
        onOpenSource={onOpenSource}
        onOpenEvidence={onOpenEvidence}
      />
      </div>
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
      <h2>{title}</h2>
      <p>{description}</p>
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
  selected: boolean;
  batchSelected: boolean;
  batchDisabled: boolean;
  onBatchChange: (checked: boolean) => void;
}

function ApprovalCard({ item, now, onOpen, selected, batchSelected, batchDisabled, onBatchChange }: ApprovalCardProps) {
  const t = useT();
  const localeTag = useOwbLocale() === "en" ? "en-US" : "zh-CN";
  const Icon = { write: FilePenLine, network: Globe, exec: Terminal, tool: Wrench }[item.category];
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
      className={`owb-approval-card${selected ? " is-selected" : ""}`}
      data-testid={`approval-card-${item.approvalId}`}
      data-approval-id={item.approvalId}
      data-decision-state={decisionCssState(item)}
      data-expiry-state={expiry}
      data-execution-phase={executionPhase}
      data-overreach={overreach ? "true" : "false"}
      data-decided={decided ? "true" : "false"}
      onClick={onOpen}
    >
      {item.batchMaxItems !== undefined ? <Checkbox className="owb-approval-card__batch-select" checked={batchSelected} disabled={batchDisabled} onClick={(event) => event.stopPropagation()} onChange={(event) => onBatchChange(event.target.checked)} aria-label={t("apr.batchSelect")} /> : null}
      <button
        type="button"
        className="owb-approval-card__row"
        onClick={onOpen}
        aria-label={t("apr.cardAria")}
        aria-pressed={selected}
      >
        <div className="owb-approval-card__head">
          <span className="owb-approval-card__tags">
            {item.context ? (
              <Tag color={item.context.risk === "high" ? "red" : "orange"} data-testid="approval-rule-risk">
                {t(`apr.risk.${item.context.risk}`)}
              </Tag>
            ) : null}
            {item.context?.riskOverlay && item.context.riskOverlay !== item.context.risk ? (
              <Tag data-testid="approval-risk-overlay">
                {t("apr.riskOverlay")}: {t(`apr.risk.${item.context.riskOverlay}`)} · {t("apr.suggestionNotAdopted")}
              </Tag>
            ) : null}
            {overreach ? (
              <Tag color="red" data-testid="approval-overreach-tag">
                {t("apr.overreach")}
              </Tag>
            ) : null}
          </span>
        </div>
        <div className="owb-approval-card__title">
          <Icon size={15} aria-hidden="true" /><strong>{description}</strong>
        </div>
        {item.requestedAt ? <time className="owb-approval-card__time" dateTime={item.requestedAt}>{formatApprovalTime(item.requestedAt, t, localeTag)}</time> : null}
        <span className="owb-approval-card__status">
          <Tag color={decisionTagColor}>{expired ? t("apr.decisionExpired") : decisionLabel(item, t)}</Tag>
          {executionPhase !== "not_started" ? <Tag color={EXECUTION_TAG_COLOR[executionPhase]}>{t(`apr.phase.${executionPhase}`)}</Tag> : null}
        </span>
        <p className="owb-approval-card__description" title={description}>
          <span>{positionName}</span> · {t(`apr.kind.${item.category}`)}
        </p>
        {target ? (
          <p className="owb-approval-card__target" title={target}>
            {target}
          </p>
        ) : null}
        <p className="owb-approval-card__meta">
          {item.expiresAt ? (
            <Tooltip title={item.expiresAt}>
              <span className="owb-approval-card__expires">{expiringSoon ? <span><span>{t("apr.expiringSoon")}</span> · </span> : null}{t("apr.expires", { at: formatApprovalTime(item.expiresAt, t, localeTag) })}</span>
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

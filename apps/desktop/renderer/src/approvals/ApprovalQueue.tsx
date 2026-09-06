/**
 * ApprovalQueue (design spec §5 · approval / overreach event queue)
 *
 * Reads a props-injected `items: ApprovalQueueItem[]` and renders a queue
 * of approval cards. Wired-in interactions (approve / deny) forward via
 * `callbacks` up to App.tsx, which is responsible for building the
 * `pendingApproval`-carrying resume turn.
 *
 * DATA GAP (TODO, v0):
 *   v0 has no dedicated `/approvals` HTTP stream; items are supplied by the
 *   host. v1 derives the list from bounded turn-history scan + SSE
 *   `turn.approval.requested`. UI shape is stable across that swap.
 */
import { useMemo, useState } from "react";
import { Alert, Button, List, Segmented, Tag, Tooltip } from "antd";
import { ArrowRight, Clock3, ShieldAlert, ShieldCheck } from "lucide-react";
import { useOwbLocale, useT, type OwbT } from "@roleweave/ui";
import {
  isDecided,
  isPermissionOverreach,
  type ApprovalCategory,
  type ApprovalQueueCallbacks,
  type ApprovalQueueItem,
} from "./types";
import { ApprovalDetailDrawer } from "./ApprovalDetailDrawer";
import { decodeEscapedUnicode } from "../display-text";

export type ApprovalQueueFilter = "pending" | "decided" | "all";
export type ApprovalQueueDataState = "ready" | "not-connected";

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
  }
}

function decisionCssState(item: ApprovalQueueItem): string {
  return item.decision.kind;
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
}: ApprovalQueueProps) {
  const t = useT();
  const [filter, setFilter] = useState<ApprovalQueueFilter>(defaultFilter);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const pendingCount = useMemo(
    () => items.filter((item) => item.decision.kind === "pending").length,
    [items],
  );

  const visible = useMemo(() => {
    if (filter === "pending") return items.filter((item) => !isDecided(item));
    if (filter === "decided") return items.filter((item) => isDecided(item));
    return items;
  }, [items, filter]);

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
        <span className="owb-approval-queue__count">{t("apr.totalRecords", { count: items.length })}</span>
      </div>

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
                onOpen={() => setSelectedId(item.approvalId)}
              />
            </List.Item>
          )}
        />
      )}

      <ApprovalDetailDrawer
        open={selectedItem !== null}
        item={selectedItem}
        onClose={() => setSelectedId(null)}
        onApprove={onApprove}
        onDeny={onDeny}
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
        <Button type="default" onClick={onNavigateToOrg} icon={<ArrowRight size={14} />}>
          {t("apr.backToOrg")}
        </Button>
      ) : null}
    </section>
  );
}

interface ApprovalCardProps {
  item: ApprovalQueueItem;
  onOpen: () => void;
}

function ApprovalCard({ item, onOpen }: ApprovalCardProps) {
  const t = useT();
  const localeTag = useOwbLocale() === "en" ? "en-US" : "zh-CN";
  const positionName = decodeEscapedUnicode(item.positionName ?? t("apr.unknownPosition"));
  const description = decodeEscapedUnicode(item.description);
  const target = item.target ? decodeEscapedUnicode(item.target) : undefined;
  const overreach = isPermissionOverreach(item);
  const decided = isDecided(item);
  const decisionTagColor = !decided
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
            <Tag color={decisionTagColor}>{decisionLabel(item, t)}</Tag>
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

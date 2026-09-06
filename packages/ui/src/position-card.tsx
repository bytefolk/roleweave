import type { ReactNode } from "react";
import { Button, Empty, Skeleton } from "antd";
import { cn } from "@fullstack-ai-infra/ui";
import { ChartNoAxesColumn, Cloud, Crosshair, FileText, Info, RefreshCw, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { BudgetBar } from "./budget-bar";
import { useT, type OwbT } from "./i18n";
import type { PositionCardData } from "./types";
import type { ContextSourceSummary } from "@roleweave/shared";

export interface PositionCardProps {
  position: PositionCardData | null;
  loading?: boolean;
  notFound?: boolean;
  onRefresh?: () => void;
  /** Opens the unified employee-memory surface for a context source. */
  onContextSourceSelect?: (source: ContextSourceSummary) => void;
  /** Per-task consumption ratio (0..1+) for the budget gauge; null/undefined
   * keeps the gauge in declaration phase — never a fabricated percentage. */
  consumption?: number | null;
  /** Live turn in flight for this position: header status light breathes. */
  running?: boolean;
  /** #137 review: operator actions (e.g. the dismiss dialog) render inside
   * the card header's right cluster instead of floating outside the card. */
  actions?: ReactNode;
  className?: string;
}

/**
 * PositionCard — read-only position record (#73 signature move ②「岗位即端点」).
 *
 * Rendered as the custom `.owb-panel` shell from
 * docs/design/control-plane-v2-preview.html, not an antd Card: display-font
 * title + role sub-line, a mode
 * badge and a status light on the right, then three sections — budget gauge
 * (dual lane), permission chips, context sources. antd still supplies the
 * controls (Button/Empty/Skeleton) per DL5.
 *
 * States: empty guidance / loading skeleton / 404 after disband / record.
 */
export function PositionCard({
  position,
  loading = false,
  notFound = false,
  onRefresh,
  onContextSourceSelect,
  consumption = null,
  running = false,
  actions,
  className,
}: PositionCardProps) {
  const t = useT();
  if (loading) {
    return (
      <section className={cn("owb-panel", "ui-org-position-card", className)} aria-label={t("pos.title")}>
        <header className="owb-panel-head">
          <div className="owb-panel-head__main">
            <div className="ui-org-position-card__skeleton-title">
              <Skeleton.Input active block size="small" />
            </div>
          </div>
        </header>
        <div className="owb-pos-body">
          <Skeleton active title={false} paragraph={{ rows: 4 }} />
        </div>
      </section>
    );
  }

  if (notFound) {
    return (
      <section
        className={cn("owb-panel", "ui-org-position-card", "ui-org-position-card--notice", className)}
        aria-label={t("pos.title")}
      >
        <header className="owb-panel-head">
          <div className="owb-panel-head__main">
            <h2>{t("pos.unavailable")}</h2>
          </div>
          <div className="owb-panel-head__right">
            <span className="owb-badge owb-badge--muted">{t("pos.dismissedBadge")}</span>
          </div>
        </header>
        <div className="owb-panel__notice">
          <Info aria-hidden="true" size={26} className="ui-org-position-card__notice-icon" />
          <p>{t("pos.gone")}</p>
          {onRefresh ? (
            <Button type="primary" icon={<RefreshCw aria-hidden="true" size={13} />} onClick={onRefresh}>
              {t("pos.refreshTree")}
            </Button>
          ) : null}
        </div>
      </section>
    );
  }

  if (!position) {
    return (
      <section
        className={cn("owb-panel", "ui-org-position-card", "ui-org-position-card--empty", className)}
        aria-label={t("pos.title")}
      >
        <header className="owb-panel-head">
          <div className="owb-panel-head__main">
            <h2>{t("pos.title")}</h2>
          </div>
        </header>
        <div className="owb-panel__notice">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("pos.empty")} />
        </div>
      </section>
    );
  }

  const readOnly = position.mode === "read_only";
  // Documents and drive are selectable memory planes. Runtime context stays
  // visible as a compact, read-only signal so operators can see what informs
  // the employee without treating it as a third managed memory store.
  const contextSources = position.contextSources ?? legacyContextSource(position, t);
  const capabilities = position.capabilities ?? { skills: [], mcpServers: [] };
  return (
    <section className={cn("owb-panel", "ui-org-position-card", className)} aria-label={t("pos.title")}>
      <header className="owb-panel-head">
        <div className="owb-panel-head__main">
          <h2>{position.name}</h2>
        </div>
        <div className="owb-panel-head__right">
          {actions}
          <span className={cn("owb-badge", readOnly ? "owb-badge--read" : "owb-badge--approval")}>
            <Zap aria-hidden="true" size={11} />
            {readOnly ? t("pos.readOnly") : t("pos.approval")}
          </span>
          <span
            className={cn("owb-led", running && "owb-led--running")}
            role="img"
            aria-label={running ? t("pos.running") : t("pos.ready")}
            title={running ? t("pos.running") : t("pos.ready")}
          />
        </div>
      </header>

      <div className="owb-pos-body">
        <p className="owb-pos-desc">{position.description}</p>

        <section className="owb-pos-section">
          <h3>
            <ChartNoAxesColumn aria-hidden="true" size={13} />
            {t("pos.budget")}
          </h3>
          <BudgetBar
            declared={
              position.budget
                ? { taskLimit: position.budget.perTask, dailyLimit: position.budget.perDay }
                : null
            }
            consumption={consumption}
          />
        </section>

        {capabilities.skills.length > 0 || capabilities.mcpServers.length > 0 ? (
          <section className="owb-pos-section">
            <h3><Sparkles aria-hidden="true" size={13} />{t("pos.capabilities")}</h3>
            <div className="owb-tagrow">
              {capabilities.skills.map((skill) => <span key={`skill-${skill.id}`} className="owb-tag">Skill · {skill.name}</span>)}
              {capabilities.mcpServers.map((server) => <span key={`mcp-${server.id}`} className="owb-tag owb-tag--mcp" title={server.tools.join(", ")}>MCP · {server.name} · {server.tools.length} tools</span>)}
            </div>
          </section>
        ) : null}

        <section className="owb-pos-section">
          <h3>
            <ShieldCheck aria-hidden="true" size={13} />
            {t("pos.perms")}
          </h3>
          <div className="owb-tagrow">
            {position.permissions.toolAllow.length === 0 ? (
              <span className="owb-tag owb-tag--muted">{t("pos.noAllow")}</span>
            ) : (
              position.permissions.toolAllow.map((tool) => (
                <span key={tool} className="owb-tag">
                  {tool}
                </span>
              ))
            )}
            {position.permissions.toolDeny.map((tool) => (
              <span key={tool} className="owb-tag owb-tag--deny">
                deny {tool}
              </span>
            ))}
          </div>
        </section>

        <section className="owb-pos-section">
          <h3>
            <Crosshair aria-hidden="true" size={13} />
            {t("pos.scope")}
          </h3>
          <div className="owb-context-sources">
            {contextSources.map((source) => (
              <ContextSourceRow key={source.id} source={source} onSelect={onContextSourceSelect} />
            ))}
          </div>
          <p className="owb-context-sources__hint">{t("pos.contextSourcesHint")}</p>
        </section>
      </div>
    </section>
  );
}

function legacyContextSource(position: PositionCardData, t: OwbT): ContextSourceSummary[] {
  return [{
    id: "legacy-context-scope",
    kind: "workspace_docs",
    name: t("pos.legacyContextName"),
    locator: position.contextScope || t("pos.undeclared"),
    binding: "bound",
    state: position.contextScope ? "ready" : "empty",
    readOnly: true,
  }];
}

function ContextSourceRow({
  source,
  onSelect,
}: {
  source: ContextSourceSummary;
  onSelect?: (source: ContextSourceSummary) => void;
}) {
  const t = useT();
  const SourceIcon = source.kind === "workspace_docs"
    ? FileText
    : source.kind === "mem_drive"
      ? Cloud
      : Crosshair;
  const stateLabel = source.kind === "context_provider" && (source.itemCount ?? 0) > 0
    ? t("pos.srcState.connected")
    : {
    ready: source.kind === "workspace_docs" ? t("pos.srcState.connected") : t("pos.srcState.configured"),
    empty: t("pos.srcState.empty"),
    not_configured: t("pos.srcState.notConfigured"),
    error: t("pos.srcState.readFailed"),
      }[source.state];
  const bindingLabel = source.binding === "bound" ? t("pos.binding.bound") : t("pos.binding.available");
  const countLabel = source.itemCount === undefined
    ? ""
    : ` · ${t(source.kind === "workspace_docs" ? "pos.srcCount.docs" : "pos.srcCount.records", { count: source.itemCount })}`;
  const content = (
    <>
      <div className="owb-context-source__head">
        <span className="owb-context-source__icon" aria-hidden="true"><SourceIcon size={13} /></span>
        <div className="owb-context-source__main">
          <strong>{source.name}</strong>
        </div>
        <span className={`owb-context-source__state is-${source.state}`}>{stateLabel}</span>
      </div>
      <div className="owb-context-source__meta">{bindingLabel}{countLabel}{source.readOnly ? t("pos.srcReadOnlySuffix") : ""}</div>
    </>
  );
  // Runtime context is surfaced for transparency but has no separate page to
  // open. Keep it a read-only row instead of routing it to the docs surface.
  if (!onSelect || source.kind === "context_provider") {
    return <div className="owb-context-source">{content}</div>;
  }
  return (
    <button
      type="button"
      className="owb-context-source owb-context-source--interactive"
      onClick={() => onSelect(source)}
      aria-label={t("pos.openContextSource", { name: source.name })}
    >
      {content}
    </button>
  );
}

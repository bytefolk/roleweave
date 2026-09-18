import { TriangleAlert } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@fullstack-ai-infra/ui";
import { useT } from "./i18n";
import { capsText, primaryCap, type BudgetCaps } from "./types";

export interface BudgetBarProps {
  /** Budget declaration of one position (perTask → taskLimit, perDay → dailyLimit). null = 预算未配齐. */
  declared: { taskLimit: BudgetCaps | null; dailyLimit: BudgetCaps | null } | null;
  /** Per-task consumption ratio (0..1+). null = declaration phase. */
  consumption?: number | null;
  /** Per-day window ratio. Omit when no truthful day bucket exists. */
  dailyConsumption?: number | null;
  format?: "compact" | "full";
  label?: string;
  className?: string;
}

const TIER_WARNING = 0.8;

function tierClass(ratio: number): string {
  if (ratio > 1) return "is-over";
  if (ratio >= TIER_WARNING) return "is-warning";
  return "is-ok";
}

/**
 * BudgetBar — dual-phase contract (D1 spec §4):
 *  - Phase 1 (declaration): consumption=null renders declared caps without a
 *    percentage; budget-not-allocated renders a warning soft badge (mirrors
 *    the org apply budget gate).
 *  - Phase 2 (consumption, D3+): three-tier color scale (<80% success /
 *    80–100% warning / >100% danger).
 * Colors are semantic tokens only — never raw hex.
 */
export function BudgetBar({
  declared,
  consumption = null,
  dailyConsumption,
  format = "full",
  label,
  className,
}: BudgetBarProps) {
  const t = useT();
  if (!declared) {
    return (
      <span
        className={cn("ui-org-budget", "ui-org-budget--missing", className)}
        role="status"
      >
        <TriangleAlert aria-hidden="true" size={12} />
        {t("pos.budgetMissing")}
      </span>
    );
  }
  if (format === "compact") {
    return (
      <div className={cn("ui-org-budget", "is-compact", className)}>
        <BudgetLane
          label={label ?? t("pos.budgetDefault")}
          caps={declared.taskLimit}
          consumption={consumption}
        />
      </div>
    );
  }
  return (
    <div className={cn("ui-org-budget", className)}>
      <div className="ui-org-budget__lanes">
        <BudgetLane label={t("pos.perTask")} caps={declared.taskLimit} consumption={consumption} />
        <BudgetLane
          label={t("pos.perDay")}
          caps={declared.dailyLimit}
          consumption={consumption === null && dailyConsumption === undefined ? null : dailyConsumption}
        />
      </div>
    </div>
  );
}

/** Declared caps with the primary number emphasised (设计稿 .val b):
 * `<b>20,000 tokens</b> · 8 iterations`. Falls back to em dash when the
 * declaration carries no cap at all — never invents a number. */
function DeclaredCaps({ caps }: { caps: BudgetCaps | null | undefined }) {
  const t = useT();
  const text = capsText(caps);
  if (text === "—") return <>{t("pos.undeclared")}</>;
  const [head, ...rest] = text.split(" · ");
  return (
    <>
      <b>{head}</b>
      {rest.length > 0 ? ` · ${rest.join(" · ")}` : null}
    </>
  );
}

function BudgetLane({
  label,
  caps,
  consumption,
}: {
  label: string;
  caps: BudgetCaps | null;
  consumption: number | null | undefined;
}) {
  const t = useT();
  const cap = primaryCap(caps);
  const declarationMode = consumption === null;
  const unavailable = consumption === undefined;
  const ratio = cap && typeof consumption === "number" ? consumption : null;
  const laneClass = declarationMode || unavailable || ratio === null ? "is-declared" : tierClass(ratio);
  const percent = ratio === null ? null : Math.max(Math.round(ratio * 100), 0);
  // The label remains truthful above 100%, while the visual fill and numeric
  // meter position stay bounded by the track. aria-valuetext carries the
  // actual percentage for assistive technology.
  const boundedPercent = percent === null ? null : Math.min(percent, 100);
  const fillWidth = boundedPercent === null ? "100%" : `${boundedPercent}%`;
  const meterProps: CSSProperties | undefined =
    ratio === null
      ? undefined
      : { width: fillWidth };
  return (
    <div className="ui-org-budget__lane">
      <span className="ui-org-budget__lane-label">{label}</span>
      <span
        className={cn("ui-org-budget__track", laneClass)}
        role="meter"
        aria-label={`${label}${declarationMode ? t("pos.laneDeclared") : unavailable ? t("pos.laneUnavailable") : t("pos.laneConsumed")}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ratio === null ? undefined : boundedPercent ?? undefined}
        aria-valuetext={ratio === null ? undefined : `${percent}%`}
      >
        <span className="ui-org-budget__fill" style={meterProps ?? undefined} />
      </span>
      <span className="ui-org-budget__value">
        {declarationMode ? (
          <DeclaredCaps caps={caps} />
        ) : unavailable ? (
          <>{t("pos.unrecordedPrefix")}<DeclaredCaps caps={caps} /></>
        ) : (
          `${Math.round((ratio ?? 0) * 100)}%`
        )}
      </span>
    </div>
  );
}

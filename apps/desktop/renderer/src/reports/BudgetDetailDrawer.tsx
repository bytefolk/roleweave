import { Button, Drawer, Statistic } from "antd";
import { BudgetBar, useT } from "@roleweave/ui";
import type { BudgetReport } from "@roleweave/shared";
import { ArrowUpRight } from "lucide-react";

export interface BudgetDetailDrawerProps {
  open: boolean;
  budget: (BudgetReport & { displayName?: string; ratio?: number | null }) | null;
  onClose: () => void;
  onOpenTimeline?: (positionId: string) => void;
}

/** Right-side drawer with the full BudgetBar (per-task + per-day lanes) and the
 * raw evidence panels. Honest-lane rule: per-day never renders a percentage —
 * only the declared cap and the「unrecorded」word. */
export function BudgetDetailDrawer({ open, budget, onClose, onOpenTimeline }: BudgetDetailDrawerProps) {
  const t = useT();
  const title = budget
    ? t("rep.budgetDetail", { name: budget.displayName ?? t("rep.unknownPosition") })
    : t("rep.budgetDetailPlain");
  const ratio = budget?.ratio
    ?? (budget && budget.latestTurn && budget.declared.perTask.tokens
      ? budget.latestTurn.totalTokens / budget.declared.perTask.tokens
      : null);
  return (
    <Drawer
      className="owb-budget-drawer"
      open={open}
      onClose={onClose}
      title={title}
      width={420}
      destroyOnClose
      aria-label={t("rep.budgetDetailAria")}
    >
      {budget ? (
        <div className="owb-budget-drawer__body">
          <section aria-label={t("rep.declaredFactsAria")}>
            <BudgetBar
              declared={{
                taskLimit: budget.declared.perTask,
                dailyLimit: budget.declared.perDay,
              }}
              consumption={ratio}
              format="full"
              label={t("rep.budgetBarLabel")}
            />
          </section>
          <section aria-label={t("rep.lastTurnUsageAria")} className="owb-budget-drawer__usage">
            <h4>{t("rep.lastTurnUsage")}</h4>
            {budget.latestTurn ? (
              <div className="owb-budget-drawer__stats">
                <Statistic title="input" value={budget.latestTurn.inputTokens} />
                <Statistic title="output" value={budget.latestTurn.outputTokens} />
                <Statistic title="total" value={budget.latestTurn.totalTokens} />
              </div>
            ) : (
              <p className="owb-muted">{t("rep.noTurnsYet")}</p>
            )}
          </section>
          <section aria-label={t("rep.colRecorded")} className="owb-budget-drawer__usage">
            <h4>{t("rep.colRecorded")}</h4>
            <div className="owb-budget-drawer__stats">
              <Statistic title="input" value={budget.recorded.inputTokens} />
              <Statistic title="output" value={budget.recorded.outputTokens} />
              <Statistic title="total" value={budget.recorded.totalTokens} />
            </div>
            <p className="owb-muted">{t("rep.recordedNote")}</p>
          </section>
          {onOpenTimeline ? (
            <div className="owb-budget-drawer__actions">
              <Button
                type="primary"
                onClick={() => {
                  onOpenTimeline(budget.positionId);
                  onClose();
                }}
                icon={<ArrowUpRight size={14} />}
              >
                {t("rep.openTimeline")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

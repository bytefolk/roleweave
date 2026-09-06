import { useMemo, useState } from "react";
import { Alert, Badge, Empty, Input, Segmented, Skeleton, Statistic, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { BudgetBar, useT, zhText } from "@roleweave/ui";
import type { BudgetReport, EscalationEntry } from "@roleweave/shared";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { BudgetDetailDrawer } from "./BudgetDetailDrawer";

/** P0 预算/成本看板：`reports.v1.budgets` 唯一权威读法。
 *
 * 诚实纪律（design spec §4.1 / §0）：
 *   1. 无货币维度：只展示 tokens / iterations。
 *   2. 声明期不伪造百分比：`latestTurn === null` 时消耗条走 declared-only。
 *   3. 单日车道只声明、不推算：`declared.perDay` 直出「未记录 · 上限 …」。
 *   4. 超限即事实：`state === "exceeded"` 永远置顶 + 左 3px 红条 + 汇总 Alert。
 */
export interface BudgetDashboardProps {
  budgets: BudgetReport[];
  escalations?: EscalationEntry[];
  loading?: boolean;
  positionNames?: Record<string, string>;
  positionColors?: Record<string, string>;
  /** Optional deep-link: called with a turnId / positionId when the user clicks
   *  「查看时间线」in the detail drawer. Wired to the ④ timeline in App.tsx; if
   *  omitted the link is hidden (no dead affordances). */
  onOpenTimeline?: (positionId: string) => void;
}

type FilterKey = "all" | "exceeded" | "approaching" | "declared";

interface BudgetRow extends BudgetReport {
  /** Per-task consumption ratio; null in 声明期 (no latestTurn). */
  ratio: number | null;
  approaching: boolean;
  displayName: string;
  color?: string;
}

/** Ordering: exceeded > approaching (>=80%) > within > unobserved. */
function stateOrder(row: BudgetRow): number {
  if (row.state === "exceeded") return 0;
  if (row.approaching) return 1;
  if (row.state === "within") return 2;
  return 3;
}

function computeRatio(budget: BudgetReport): number | null {
  const limit = budget.declared.perTask.tokens;
  if (!limit || !budget.latestTurn) return null;
  return budget.latestTurn.totalTokens / limit;
}

/** Format numbers with tabular-nums; kept side-effect free so tests can import.
 * #146：声明期词面走目录；裸调用（测试）回退 zh 目录，渲染侧传入 t() 词面。 */
export function budgetPercentText(ratio: number | null, declaredLabel: string = zhText("rep.declaredPhase")): string {
  if (ratio === null) return declaredLabel;
  return `${Math.round(ratio * 100)}%`;
}

const STATE_LABEL_KEYS: Record<BudgetReport["state"], string> = {
  exceeded: "rep.stateExceeded",
  within: "rep.stateWithin",
  unobserved: "rep.stateUnobserved",
};

export function stateLabel(state: BudgetReport["state"]): string {
  return zhText(STATE_LABEL_KEYS[state]);
}

export function BudgetDashboard({
  budgets,
  escalations = [],
  loading = false,
  positionNames,
  positionColors,
  onOpenTimeline,
}: BudgetDashboardProps) {
  const t = useT();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [keyword, setKeyword] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const rows: BudgetRow[] = useMemo(() => {
    return budgets.map((budget) => {
      const ratio = computeRatio(budget);
      return {
        ...budget,
        ratio,
        approaching: ratio !== null && ratio >= 0.8 && ratio <= 1 && budget.state !== "exceeded",
        displayName: positionNames?.[budget.positionId] ?? t("rep.unknownPosition"),
        color: positionColors?.[budget.positionId],
      };
    });
  }, [budgets, positionNames, positionColors, t]);

  const summary = useMemo(() => {
    let exceeded = 0;
    let approaching = 0;
    let unobserved = 0;
    for (const row of rows) {
      if (row.state === "exceeded") exceeded += 1;
      else if (row.approaching) approaching += 1;
      if (row.state === "unobserved") unobserved += 1;
    }
    return { total: rows.length, exceeded, approaching, unobserved };
  }, [rows]);

  const visibleRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (filter === "exceeded" && row.state !== "exceeded") return false;
      if (filter === "approaching" && !row.approaching) return false;
      if (filter === "declared" && row.state !== "unobserved") return false;
      if (kw.length > 0) {
        return row.positionId.toLowerCase().includes(kw)
          || row.displayName.toLowerCase().includes(kw);
      }
      return true;
    });
    return [...filtered].sort((a, b) => {
      const diff = stateOrder(a) - stateOrder(b);
      if (diff !== 0) return diff;
      // Within the same state, order by ratio desc so heavier consumers surface first.
      const ra = a.ratio ?? -1;
      const rb = b.ratio ?? -1;
      return rb - ra;
    });
  }, [rows, filter, keyword]);

  const budgetRelatedEscalations = useMemo(
    () => escalations.filter((entry) => entry.budgetRelated),
    [escalations],
  );

  const columns: ColumnsType<BudgetRow> = useMemo(
    () => [
      {
        title: t("rep.colPosition"),
        dataIndex: "positionId",
        key: "position",
        width: 240,
        render: (_: unknown, row: BudgetRow) => (
          <div className="owb-budget-dash__cell-position">
            <span
              aria-hidden="true"
              className="owb-budget-dash__avatar"
              style={row.color ? { backgroundColor: row.color } : undefined}
            />
            <div>
              <strong>{row.displayName}</strong>
            </div>
          </div>
        ),
      },
      {
        title: t("rep.colPerTask"),
        key: "perTask",
        render: (_: unknown, row: BudgetRow) => (
          <BudgetBar
            label={t("pos.perTask")}
            declared={{ taskLimit: row.declared.perTask, dailyLimit: null }}
            consumption={row.ratio}
            format="compact"
          />
        ),
      },
      {
        title: t("pos.perDay"),
        key: "perDay",
        width: 200,
        render: (_: unknown, row: BudgetRow) => {
          const cap = row.declared.perDay.tokens ?? row.declared.perDay.iterations;
          const unit = row.declared.perDay.tokens !== undefined ? "tokens" : "iterations";
          return (
            <span className="owb-budget-dash__daily">
              <BudgetBar
                label={t("pos.perDay")}
                declared={{ taskLimit: null, dailyLimit: row.declared.perDay }}
                consumption={null}
                format="compact"
              />
              <span className="owb-budget-dash__daily-cap">
                {typeof cap === "number"
                  ? t("rep.dailyCap", { cap: cap.toLocaleString(), unit })
                  : t("pos.undeclared")}
              </span>
            </span>
          );
        },
      },
      {
        title: t("rep.colRecorded"),
        key: "recorded",
        width: 140,
        align: "right" as const,
        render: (_: unknown, row: BudgetRow) => (
          <Tooltip
            title={`input ${row.recorded.inputTokens.toLocaleString()} · output ${row.recorded.outputTokens.toLocaleString()}`}
          >
            <span className="owb-budget-dash__recorded">
              {row.recorded.totalTokens.toLocaleString()}
            </span>
          </Tooltip>
        ),
      },
      {
        title: t("rep.colState"),
        key: "state",
        width: 120,
        render: (_: unknown, row: BudgetRow) => {
          if (row.state === "exceeded") {
            return (
              <Tag className="owb-budget-dash__tag is-danger" bordered={false}>
                {t("rep.stateExceeded")}
              </Tag>
            );
          }
          if (row.approaching) {
            return (
              <Tag className="owb-budget-dash__tag is-warning" bordered={false}>
                {t("rep.approaching", { pct: budgetPercentText(row.ratio, t("rep.declaredPhase")) })}
              </Tag>
            );
          }
          if (row.state === "within") {
            return (
              <Tag className="owb-budget-dash__tag is-success" bordered={false}>
                {t("rep.stateWithin")}
              </Tag>
            );
          }
          return (
            <Tag className="owb-budget-dash__tag is-neutral" bordered={false}>
              {t("rep.stateUnobserved")}
            </Tag>
          );
        },
      },
    ],
    [t],
  );

  if (loading) {
    return (
      <section className="owb-budget-dash" aria-label={t("rep.dashAria")}>
        <div className="owb-budget-dash__summary" aria-label={t("rep.summaryShort")}>
          {[0, 1, 2, 3].map((idx) => (
            <div className="owb-budget-dash__stat" key={idx}>
              <Skeleton.Input active size="small" />
            </div>
          ))}
        </div>
        <Skeleton
          active
          paragraph={{ rows: 4 }}
          title={false}
          aria-label={t("rep.tableLoading")}
        />
      </section>
    );
  }

  const openBudget = openId ? rows.find((row) => row.positionId === openId) ?? null : null;

  return (
    <section className="owb-budget-dash" aria-label={t("rep.dashAria")}>
      <div className="owb-budget-dash__summary" role="group" aria-label={t("rep.summary")}>
        <div className="owb-budget-dash__stat" data-tone="neutral">
          <Statistic title={t("rep.colPosition")} value={summary.total} />
        </div>
        <div className="owb-budget-dash__stat" data-tone="danger" data-testid="stat-exceeded">
          <Statistic
            title={t("rep.statExceeded")}
            value={summary.exceeded}
            valueStyle={{
              color: summary.exceeded > 0 ? "var(--ui-danger)" : "var(--ui-foreground)",
            }}
          />
        </div>
        <div className="owb-budget-dash__stat" data-tone="warning">
          <Statistic
            title={t("rep.statApproaching")}
            value={summary.approaching}
            valueStyle={{
              color: summary.approaching > 0 ? "var(--ui-warning)" : "var(--ui-foreground)",
            }}
          />
        </div>
        <div className="owb-budget-dash__stat" data-tone="neutral">
          <Statistic title={t("rep.declaredPhase")} value={summary.unobserved} />
        </div>
      </div>

      {summary.exceeded > 0 ? (
        <Alert
          role="alert"
          data-testid="budget-summary-alert"
          className="owb-budget-dash__alert"
          type="error"
          showIcon
          message={t("rep.exceededAlert", { count: summary.exceeded })}
          description={t("rep.exceededAlertDesc")}
        />
      ) : null}

      <div className="owb-budget-dash__toolbar" role="group" aria-label={t("rep.filterAria")}>
        <Input.Search
          allowClear
          placeholder={t("rep.filterPh")}
          className="owb-budget-dash__search"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          onSearch={(value) => setKeyword(value)}
        />
        <Segmented<FilterKey>
          value={filter}
          onChange={(value) => setFilter(value as FilterKey)}
          options={[
            { label: t("rep.filterAll", { count: summary.total }), value: "all" },
            { label: t("rep.filterExceeded", { count: summary.exceeded }), value: "exceeded" },
            { label: t("rep.filterApproaching", { count: summary.approaching }), value: "approaching" },
            { label: t("rep.filterDeclared", { count: summary.unobserved }), value: "declared" },
          ]}
        />
      </div>

      {rows.length === 0 ? (
        <Empty
          className="owb-budget-dash__empty"
          description={t("rep.noBudgetFacts")}
        />
      ) : visibleRows.length === 0 ? (
        <Empty className="owb-budget-dash__empty" description={t("rep.noBudgetFactsFiltered")} />
      ) : (
        <Table<BudgetRow>
          className="owb-budget-dash__table"
          rowKey="positionId"
          columns={columns}
          dataSource={visibleRows}
          pagination={false}
          size="middle"
          rowClassName={(row) => {
            const marks: string[] = [];
            if (row.state === "exceeded") marks.push("is-exceeded");
            else if (row.approaching) marks.push("is-approaching");
            return marks.join(" ");
          }}
          onRow={(row) => ({
            "data-position-id": row.positionId,
            "data-state": row.state,
            role: "button",
            tabIndex: 0,
            onClick: () => setOpenId(row.positionId),
            onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setOpenId(row.positionId);
              }
            },
          })}
        />
      )}

      {budgetRelatedEscalations.length > 0 ? (
        <div className="owb-budget-dash__escalations" aria-label={t("rep.budgetFailsAria")}>
          <header>
            <AlertTriangle aria-hidden="true" size={14} />
            <h3>{t("rep.budgetFails", { count: budgetRelatedEscalations.length })}</h3>
          </header>
          <ul>
            {budgetRelatedEscalations.map((entry) => (
              <li key={`${entry.positionId}-${entry.turnId}`}>
                <Badge status="error" />
                <strong>{positionNames?.[entry.positionId] ?? t("rep.unknownPosition")}</strong>
                <span className="owb-budget-dash__chain">
                  {t("rep.reportingChain", { chain: entry.reportingChain.join(" → ") || "—" })}
                </span>
                {onOpenTimeline ? (
                  <button
                    type="button"
                    className="owb-budget-dash__linkbtn"
                    onClick={() => onOpenTimeline(entry.positionId)}
                  >
                    {t("rep.openTimeline")}
                    <ArrowUpRight aria-hidden="true" size={12} />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <BudgetDetailDrawer
        open={openBudget !== null}
        budget={openBudget}
        onClose={() => setOpenId(null)}
        onOpenTimeline={onOpenTimeline}
      />
    </section>
  );
}

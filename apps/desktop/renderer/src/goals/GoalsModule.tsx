import { useCallback, useEffect, useState } from "react";
import { Button as AntButton, Select } from "antd";
import { Trash2, Target } from "lucide-react";
import { useT } from "@roleweave/ui";
import { type GoalDetail, type GoalStatus, type GoalSummary } from "@roleweave/shared";
import { GoalCreateDialog } from "./GoalCreateDialog.js";

const GOAL_STATUSES: GoalStatus[] = ["open", "in_progress", "completed", "cancelled"];

interface GoalsModuleProps {
  workspaceOpen: boolean;
}

const STATUS_BADGE: Record<string, string> = {
  open: "owb-badge--info",
  in_progress: "owb-badge--warn",
  completed: "owb-badge--ok",
  cancelled: "owb-badge--muted",
};

const HEALTH_DOT: Record<string, string> = {
  on_track: "owb-health--ok",
  at_risk: "owb-health--warn",
  blocked: "owb-health--bad",
  unknown: "owb-health--unknown",
};

export function GoalsModule({ workspaceOpen }: GoalsModuleProps) {
  const t = useT();
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GoalDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadGoals = useCallback(async () => {
    if (!workspaceOpen) return;
    setLoading(true);
    setError(null);
    try {
      const response = await window.owb.goals();
      if (response.status === 200) {
        setGoals(response.body.goals);
      } else {
        setError((response.body as { message?: string })?.message ?? t("goals.loadError"));
      }
    } catch {
      setError(t("goals.loadError"));
    } finally {
      setLoading(false);
    }
  }, [workspaceOpen, t]);

  const loadDetail = useCallback(async (goalId: string) => {
    try {
      const response = await window.owb.goal(goalId);
      if (response.status === 200) {
        setDetail(response.body);
      }
    } catch {
      // Detail load failure is non-fatal; list stays visible.
    }
  }, []);

  useEffect(() => {
    void loadGoals();
  }, [loadGoals]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    const off = window.owb.onEvent((event: unknown) => {
      const e = event as { type?: string };
      if (e.type === "goal.created" || e.type === "goal.updated") {
        void loadGoals();
        if (selectedId) void loadDetail(selectedId);
      }
    });
    return off;
  }, [loadGoals, loadDetail, selectedId]);

  const changeStatus = async (status: GoalStatus) => {
    if (!selectedId) return;
    try {
      await window.owb.updateGoal({ goalId: selectedId, status });
    } catch {
      setError(t("goals.statusChangeFail"));
    }
  };

  const deleteGoal = async () => {
    if (!selectedId) return;
    if (!window.confirm(t("goals.deleteConfirm"))) return;
    setDeleting(true);
    try {
      const response = await window.owb.deleteGoal(selectedId);
      if (response.status === 200) {
        setSelectedId(null);
        setDetail(null);
      } else {
        setError(t("goals.deleteFail"));
      }
    } catch {
      setError(t("goals.deleteFail"));
    } finally {
      setDeleting(false);
    }
  };

  if (!workspaceOpen) {
    return (
      <section className="owb-goals-module" aria-label={t("goals.moduleAria")}>
        <header className="owb-module-header"><h1>{t("goals.title")}</h1></header>
        <p className="owb-empty">{t("tree.notOpened")}</p>
      </section>
    );
  }

  return (
    <section className="owb-goals-module" aria-label={t("goals.moduleAria")}>
      <header className="owb-module-header">
        <h1>{t("goals.title")}</h1>
        <span className="owb-module-header__count">{t("goals.count", { count: goals.length })}</span>
        <AntButton type="primary" size="small" icon={<Target aria-hidden="true" size={14} />} onClick={() => setShowCreate(true)}>
          {t("goals.create")}
        </AntButton>
      </header>

      {error && <p className="owb-goals-error" role="alert">{error}</p>}

      <div className="owb-goals-layout">
        <ul className="owb-goals-list" role="listbox" aria-label={t("goals.listAria")}>
          {loading && goals.length === 0 && <li className="owb-goals-loading">{t("misc.loading")}</li>}
          {!loading && goals.length === 0 && <li className="owb-goals-empty">{t("goals.empty")}</li>}
          {goals.map((goal) => (
            <li
              key={goal.goalId}
              role="option"
              aria-selected={goal.goalId === selectedId}
              className={`owb-goals-list__item${goal.goalId === selectedId ? " owb-goals-list__item--active" : ""}`}
              onClick={() => setSelectedId(goal.goalId)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(goal.goalId); } }}
              tabIndex={0}
            >
              <span className={`owb-health-dot ${HEALTH_DOT[goal.health] ?? "owb-health--unknown"}`} aria-hidden="true" />
              <span className="owb-goals-list__title">{goal.title}</span>
              <span className={`owb-badge ${STATUS_BADGE[goal.status] ?? ""}`}>{t(`goals.status.${goal.status}`)}</span>
            </li>
          ))}
        </ul>

        <aside className="owb-goals-detail" aria-live="polite">
          {!selectedId && <p className="owb-goals-empty">{t("goals.selectPrompt")}</p>}
          {selectedId && !detail && <p className="owb-goals-loading">{t("misc.loading")}</p>}
          {detail && (
            <div className="owb-goals-detail__content">
              <div className="owb-goals-detail__head">
                <h2>{detail.goal.title}</h2>
                <AntButton
                  type="text"
                  size="small"
                  danger
                  icon={<Trash2 aria-hidden="true" size={14} />}
                  loading={deleting}
                  onClick={() => void deleteGoal()}
                >
                  {t("goals.deleteAction")}
                </AntButton>
              </div>
              <div className="owb-goals-detail__meta">
                <Select
                  value={detail.goal.status}
                  onChange={(value) => void changeStatus(value as GoalStatus)}
                  size="small"
                  options={GOAL_STATUSES.map((s) => ({ value: s, label: t(`goals.status.${s}`) }))}
                  aria-label={t("goals.statusChange")}
                />
                <span className={`owb-health-dot ${HEALTH_DOT[detail.goal.health] ?? "owb-health--unknown"}`}>{t(`goals.health.${detail.goal.health}`)}</span>
              </div>
              <p className="owb-goals-detail__desc">{detail.goal.description}</p>
              {detail.goal.acceptanceCriteria.length > 0 && (
                <div>
                  <h3>{t("goals.criteria")}</h3>
                  <ul>{detail.goal.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </div>
              )}
              {detail.goal.branches.length > 0 && (
                <div>
                  <h3>{t("goals.branches")}</h3>
                  <ul>{detail.goal.branches.map((b) => (
                    <li key={b.branchId}>
                      <span className={`owb-badge ${STATUS_BADGE[b.status] ?? ""}`}>{t(`goals.status.${b.status}`)}</span>
                      {" "}{b.title}
                    </li>
                  ))}</ul>
                </div>
              )}
              <div>
                <h3>{t("goals.activity")}</h3>
                <ol className="owb-goals-activity">
                  {detail.activity.map((a) => (
                    <li key={a.activityId}>
                      <time>{new Date(a.createdAt).toLocaleString()}</time>
                      <span className={`owb-goals-activity__kind owb-goals-activity__kind--${a.kind}`}>{t(`goals.activityKind.${a.kind}`)}</span>
                      <span>{a.detail}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}
        </aside>
      </div>

      <GoalCreateDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </section>
  );
}

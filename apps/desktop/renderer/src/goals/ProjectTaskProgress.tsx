import { useT } from "@roleweave/ui";
import type { GoalTaskExecution, GoalWorkItem } from "@roleweave/shared/goals";
import type { TaskProgressSnapshot } from "@roleweave/shared";

export function ProjectTaskProgress({ item, run, snapshot, unavailable, accepted, now }: {
  item: GoalWorkItem;
  run?: GoalTaskExecution;
  snapshot?: TaskProgressSnapshot;
  unavailable?: boolean;
  accepted?: boolean;
  now: number;
}) {
  const t = useT();
  const cancelled = run?.errorCode === "turn_cancelled" || snapshot?.steps.some((step) => step.message === "turn_cancelled");
  const state = (() => {
    if (unavailable) return "unavailable";
    if (cancelled) return "cancelled";
    if (run?.status === "failed" || snapshot?.overallStatus === "failed") return "failed";
    if (run?.status === "indeterminate") return "indeterminate";
    if (run?.status === "completed") return accepted ? "accepted" : "review";
    if (item.status === "blocked") return "blocked";
    if (run?.status === "running") return "running";
    return item.status === "done" ? "done" : "idle";
  })();
  const complete = ["accepted", "review", "done"].includes(state);
  const unknown = state === "unavailable" || state === "indeterminate" || !!run && !snapshot && !complete;
  const percent = complete ? 100 : Math.max(0, Math.min(100, snapshot?.progress ?? 0));
  const total = snapshot?.steps.length ?? 0;
  const completed = Math.round(percent / 100 * total);
  const phase = state === "running" && snapshot ? snapshot.steps[snapshot.currentStep]?.id : undefined;
  const startedAt = run?.startedAt ? Date.parse(run.startedAt) : snapshot?.startedAt;
  let endedAt = snapshot?.updatedAt;
  if (run?.status === "running") endedAt = now;
  if (run?.completedAt) endedAt = Date.parse(run.completedAt);
  const seconds = startedAt !== undefined && endedAt !== undefined ? Math.max(0, Math.floor((endedAt - startedAt) / 1000)) : undefined;
  const label = phase ? t(`project.phase.${phase}`) : t(`project.taskProgress.${state}`);
  return <div className="owb-project-task-progress" data-state={state}>
    <div className="owb-project-task-progress__meta">
      <span>{label}</span>
      {seconds !== undefined && Number.isFinite(seconds) ? <span>{t("project.taskProgress.elapsed", { seconds })}</span> : null}
    </div>
    <progress aria-label={t("project.taskProgress.named", { title: item.title })}
      aria-valuetext={label} max={100} value={unknown ? undefined : percent} />
    {total > 0 && state !== "unavailable" ? <small>{t("project.taskProgress.stages", { completed, total })}</small> : null}
  </div>;
}

import { Button, Progress } from "antd";
import { CheckCircle2, Circle, CircleDot, XCircle } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { GoalBranch } from "@roleweave/shared/goals";

const branchIcons = { open: Circle, in_progress: CircleDot, completed: CheckCircle2, cancelled: XCircle };

export function GoalEvidence({ branches, positionNames, onOpenBoundSession }: {
  branches: GoalBranch[];
  positionNames: Record<string, string>;
  onOpenBoundSession?: (positionId: string, sessionId?: string) => void;
}) {
  const t = useT();
  const completed = branches.filter((branch) => branch.status === "completed").length;
  return <section className="owb-goal-evidence">
    <div className="owb-goal-evidence__heading">
      <h3>{t("goals.executionBranches")}</h3>
      <span>{t("goals.branchCount", { count: branches.length })}</span>
    </div>
    <div className="owb-goal-evidence__progress">
      <span>{t("goals.branchProgress")}</span>
      {branches.length ? <>
        <Progress percent={Math.round(completed / branches.length * 100)} showInfo={false} size="small" />
        <strong>{t("goals.branchFraction", { completed, total: branches.length })}</strong>
      </> : <span>{t("goals.progressUnknown")}</span>}
    </div>
    {branches.length ? <ul className="owb-goal-evidence__branches">
      {branches.map((branch) => {
        const Icon = branchIcons[branch.status];
        return <li key={branch.branchId} className={`owb-goal-evidence__branch is-${branch.status}`}>
          <Icon size={18} aria-hidden="true" />
          <div className="owb-goal-evidence__identity">
            <strong>{branch.title}</strong>
            <span>{branch.positionId ? (positionNames[branch.positionId] ?? branch.positionId) : t("goals.unassigned")}</span>
          </div>
          <span>{t(`goals.status.${branch.status}`)}</span>
          {branch.positionId && branch.sessionId && onOpenBoundSession ? <Button type="link" onClick={() => onOpenBoundSession(branch.positionId!, branch.sessionId)}>{t("goals.openSession")}</Button> : null}
        </li>;
      })}
    </ul> : <p className="owb-goal-evidence__hint">{t("goals.noBranches")}</p>}
    <p className="owb-goal-evidence__hint">{t("goals.branchProgressHint")}</p>
  </section>;
}

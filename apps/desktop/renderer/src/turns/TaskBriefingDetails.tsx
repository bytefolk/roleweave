import { useState } from "react";
import { useOwbLocale, useT } from "@roleweave/ui";
import type { TaskBriefingSnapshot } from "@roleweave/shared";
import "./task-briefing.css";

/** Read only the execution snapshot; current project edits cannot change it. */
export function TaskBriefingDetails({ snapshot, currentPlanVersion }: {
  snapshot: TaskBriefingSnapshot; currentPlanVersion?: string;
}) {
  const t = useT();
  const locale = useOwbLocale();
  const [open, setOpen] = useState(false);
  const p = snapshot.payload;
  const dateLabel = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  return <details className="owb-task-briefing" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("taskBriefing.title")} · {p.taskTitle}</summary>
    {open && <div className="owb-task-briefing__body">
      <p>{t("taskBriefing.explanation")}</p>
      {currentPlanVersion && currentPlanVersion !== p.planUpdatedAt && <p role="status">{t("taskBriefing.planChanged")}</p>}
      {p.redacted && <p>{t("taskBriefing.redacted")}</p>}
      <dl>
        <dt>{t("taskBriefing.project")}</dt><dd>{p.goalTitle}{p.goalDescription && <p>{p.goalDescription}</p>}</dd>
        <dt>{t("taskBriefing.task")}</dt><dd>{p.taskTitle}{p.taskDescription && <p>{p.taskDescription}</p>}</dd>
        <dt>{t("taskBriefing.recipient")}</dt><dd>{p.positionId}</dd>
        <dt>{t("taskBriefing.planVersion")}</dt><dd><time dateTime={p.planUpdatedAt}>{dateLabel(p.planUpdatedAt)}</time></dd>
        <dt>{t("taskBriefing.generatedAt")}</dt><dd><time dateTime={p.generatedAt}>{dateLabel(p.generatedAt)}</time></dd>
      </dl>
      <strong>{t("taskBriefing.criteria")}</strong>
      {p.acceptanceCriteria.length ? <ol>{p.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ol>
        : <p>{t("taskBriefing.noCriteria")}</p>}
    </div>}
  </details>;
}

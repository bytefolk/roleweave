import { useState } from "react";
import { useOwbLocale, useT } from "@roleweave/ui";
import type { TaskCollaborationContext } from "@roleweave/shared/task-collaboration";
import "./task-collaboration.css";

export function TaskCollaborationView({ context, positionNames = {}, onOpenBoundSession }: {
  context: TaskCollaborationContext; positionNames?: Record<string, string>;
  onOpenBoundSession?: (positionId: string, sessionId?: string, turnId?: string) => void;
}) {
  const t = useT(), locale = useOwbLocale();
  const name = (id: string) => Object.hasOwn(positionNames, id) ? positionNames[id]! : id;
  return <div className="owb-task-collaboration__body">
    <p className="owb-task-collaboration__muted">{t("taskCollaboration.observedAt")} <time dateTime={context.capturedAt}>
      {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(context.capturedAt))}</time></p>
    <p>{t("taskCollaboration.fixedInput")}</p>
    {context.redacted && <p>{t("taskCollaboration.redacted")}</p>}
    <h4>{t("taskCollaboration.participants")}</h4>
    {context.participants.length === 0 ? <p>{t("taskCollaboration.noParticipants")}</p> : <ul>{context.participants.map(p => <li key={p.positionId}>
      <strong>{name(p.positionId)}</strong> · {t(`taskCollaboration.role.${p.role}`)}<p>{p.responsibility}</p>
    </li>)}</ul>}
    <h4>{t("taskCollaboration.dependencies")}</h4>
    {context.dependencies.length === 0 ? <p>{t("taskCollaboration.independent")}</p> : <ul>{context.dependencies.map(d => <li key={d.taskId}>
      <strong>{d.title}</strong>{d.assigneePositionId && <> · {name(d.assigneePositionId)}</>}
      <p>{t(`project.status.${d.status}`)} · <span data-readiness={d.readiness}>{t(`taskCollaboration.readiness.${d.readiness}`)}</span>
        {d.executionStatus && <> · {t(`project.execution.${d.executionStatus}`)}</>}</p>
      {d.delivery && <div>
        <p className="owb-task-collaboration__muted">{t("taskCollaboration.delivery")} <code>{d.delivery.turnId}</code></p>
        <code className="owb-task-collaboration__digest">{d.delivery.outputDigest}</code>
        <pre>{d.delivery.outputExcerpt || t("taskCollaboration.emptyOutput")}</pre>
        {d.delivery.truncated && <p>{t("taskCollaboration.truncated")}</p>}
        {onOpenBoundSession && <button type="button" onClick={() => onOpenBoundSession(d.delivery!.positionId, d.delivery!.sessionId, d.delivery!.turnId)}>{t("taskCollaboration.openSource")}</button>}
      </div>}
    </li>)}</ul>}
    <h4>{t("taskCollaboration.dependents")}</h4>
    {context.dependents.length === 0 ? <p>{t("taskCollaboration.noDependents")}</p> : <ul>{context.dependents.map(d => <li key={d.taskId}>
      {d.title}{d.assigneePositionId && <> · {name(d.assigneePositionId)}</>}
    </li>)}</ul>}
    {context.omittedDependentCount > 0 && <p>{t("taskCollaboration.omitted", { count: context.omittedDependentCount })}</p>}
  </div>;
}

export function TaskCollaborationDetails({ title, ...props }: Parameters<typeof TaskCollaborationView>[0] & { title?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return <details className="owb-task-collaboration" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{title ?? t("taskCollaboration.title")}</summary>
    {open && <TaskCollaborationView {...props} />}
  </details>;
}

import { Button, Checkbox, Input } from "antd";
import { Select } from "@fullstack-ai-infra/ui";
import { useT } from "@roleweave/ui";
import type { GoalWorkItem } from "@roleweave/shared/goals";
import type { TaskParticipant } from "@roleweave/shared/task-collaboration";
import "./task-collaboration.css";

export function TaskCollaborationEditor({ item, items, positionNames, disabled, onChange }: {
  item: GoalWorkItem; items: GoalWorkItem[]; positionNames: Record<string, string>; disabled: boolean;
  onChange: (patch: Partial<GoalWorkItem>) => void;
}) {
  const t = useT();
  const participants = item.participants ?? [];
  const dependencies = item.dependsOn ?? [];
  const patchParticipant = (positionId: string, fields: Partial<TaskParticipant>) =>
    onChange({ participants: participants.map(p => p.positionId === positionId ? { ...p, ...fields } : p) });
  const available = Object.keys(positionNames).filter(id => id !== item.assigneePositionId && !participants.some(p => p.positionId === id));
  return <section className="owb-task-collaboration-editor" aria-label={t("taskCollaboration.editor")}>
    <h4>{t("taskCollaboration.participants")}</h4>
    <p>{t("taskCollaboration.explicit")}</p>
    {participants.map(p => {
      const name = Object.hasOwn(positionNames, p.positionId) ? positionNames[p.positionId]! : p.positionId;
      return <div key={p.positionId} className="owb-task-collaboration-editor__person">
        <div><strong>{name}</strong><Button size="small" disabled={disabled} aria-label={t("taskCollaboration.remove", { name })}
          onClick={() => onChange({ participants: participants.filter(person => person.positionId !== p.positionId) })}>{t("taskCollaboration.removeAction")}</Button></div>
        <Select<TaskParticipant["role"]> aria-label={t("taskCollaboration.roleFor", { name })} value={p.role} disabled={disabled}
          options={[{ value: "contributor", label: t("taskCollaboration.role.contributor") }, { value: "reviewer", label: t("taskCollaboration.role.reviewer") }]}
          onChange={role => patchParticipant(p.positionId, { role })} />
        <Input.TextArea rows={2} maxLength={1024} disabled={disabled} aria-label={t("taskCollaboration.responsibilityFor", { name })}
          placeholder={t("taskCollaboration.responsibilityHint")} value={p.responsibility}
          onChange={event => patchParticipant(p.positionId, { responsibility: event.target.value })} />
      </div>;
    })}
    <Select<string> aria-label={t("taskCollaboration.add")} value="" disabled={disabled || participants.length >= 8 || available.length === 0}
      options={[{ value: "", label: t("taskCollaboration.add") }, ...available.map(id => ({ value: id, label: positionNames[id]! }))]}
      onChange={positionId => { if (positionId) onChange({ participants: [...participants, { positionId, role: "contributor", responsibility: "" }] }); }} />
    <h4>{t("taskCollaboration.dependencies")}</h4>
    <p>{t("taskCollaboration.dependencyHint")}</p>
    <div className="owb-task-collaboration-editor__dependencies">
      {items.filter(candidate => candidate.taskId !== item.taskId).map(candidate => <Checkbox key={candidate.taskId}
        checked={dependencies.includes(candidate.taskId)} disabled={disabled || (!dependencies.includes(candidate.taskId) && dependencies.length >= 8)}
        onChange={event => onChange({ dependsOn: event.target.checked ? [...dependencies, candidate.taskId] : dependencies.filter(id => id !== candidate.taskId) })}>
        {candidate.title}
      </Checkbox>)}
      {items.every(candidate => candidate.taskId === item.taskId) && <p>{t("taskCollaboration.noCandidates")}</p>}
    </div>
  </section>;
}

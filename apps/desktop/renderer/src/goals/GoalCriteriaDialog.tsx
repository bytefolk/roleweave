import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal } from "antd";
import { useT } from "@roleweave/ui";
import { validateGoalUpdateRequest, type Goal } from "@roleweave/shared/goals";

interface GoalCriteriaDialogProps {
  goal: Goal;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

/** Keep the reviewed criteria and their version together until explicitly reloaded. */
export function GoalCriteriaDialog({ goal, onClose, onSaved }: GoalCriteriaDialogProps) {
  const t = useT();
  const [criteria, setCriteria] = useState([...goal.acceptanceCriteria]);
  const [version, setVersion] = useState(goal.updatedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const alive = useRef(true);
  const lock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const nextCriteria = criteria.map((item) => item.trim()).filter(Boolean);
  const valid = nextCriteria.length > 0 && validateGoalUpdateRequest({ acceptanceCriteria: nextCriteria, expectedUpdatedAt: version }).ok;

  const reload = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const response = await window.owb.goal(goal.goalId);
      if (!alive.current) return;
      if (response.status !== 200) throw new Error(t("goals.loadError"));
      setCriteria([...response.body.goal.acceptanceCriteria]);
      setVersion(response.body.goal.updatedAt);
      setConflict(false);
    } catch {
      if (alive.current) setError(t("goals.loadError"));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const save = async () => {
    if (lock.current || !valid || conflict) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const response = await window.owb.updateGoal({ goalId: goal.goalId, acceptanceCriteria: nextCriteria, expectedUpdatedAt: version });
      if (!alive.current) return;
      if (response.status !== 200) {
        setConflict(response.status === 409);
        setError(t(response.status === 409 ? "goals.criteriaConflict" : "goals.criteriaSaveError"));
        return;
      }
      await onSaved();
      if (alive.current) onClose();
    } catch {
      if (alive.current) setError(t("goals.criteriaSaveError"));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return <Modal title={t("goals.criteriaEdit")} open onCancel={() => { if (!busy) onClose(); }}
    mask={{ closable: !busy }} closable={!busy} onOk={() => void save()} confirmLoading={busy}
    okButtonProps={{ disabled: !valid || conflict }} okText={t("goals.criteriaSave")} cancelText={t("dlg.cancel")}>
    <p>{t("goals.criteriaEditHint")}</p>
    {error && <Alert type="error" showIcon title={error} />}
    {conflict && <><p>{t("goals.criteriaReloadHint")}</p><Button disabled={busy} onClick={() => void reload()}>{t("goals.criteriaReload")}</Button></>}
    {criteria.map((criterion, index) => <div key={index} className="owb-goal-create__criteria-row">
      <Input.TextArea rows={2} maxLength={4096} value={criterion} disabled={busy}
        aria-label={t("goals.criteriaItem", { index: index + 1 })}
        onChange={(event) => setCriteria((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} />
      <Button disabled={busy} onClick={() => setCriteria((current) => current.filter((_, itemIndex) => itemIndex !== index))}
        aria-label={t("goals.criteriaRemoveItem", { index: index + 1 })}>{t("goals.criteriaRemove")}</Button>
    </div>)}
    <Button disabled={busy || criteria.length >= 16} onClick={() => setCriteria((current) => [...current, ""])}>{t("goals.criteriaAdd")}</Button>
  </Modal>;
}

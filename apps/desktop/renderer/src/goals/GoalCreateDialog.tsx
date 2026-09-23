import { useEffect, useRef, useState } from "react";
import { Button as AntButton, Drawer, Input } from "antd";
import { FolderKanban, Target, Plus, Trash2 } from "lucide-react";
import { validateGoalCreateRequest } from "@roleweave/shared/goals";
import { useT } from "@roleweave/ui";

interface GoalCreateDialogProps {
  open: boolean;
  presentation?: "goals" | "projects";
  onClose: () => void;
  onCreated?: (goalId: string) => void;
}

export function GoalCreateDialog({
  open,
  presentation = "goals",
  onClose,
  onCreated,
}: GoalCreateDialogProps) {
  const t = useT();
  const label = (field: string) =>
    t(`${presentation === "projects" ? "project.form" : "goals"}.${field}`);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setCriteria([]);
    setBusy(false);
    setError(null);
  }, [open, presentation]);

  const request = {
    title: title.trim(),
    description: description.trim(),
    acceptanceCriteria: criteria
      .map((criterion) => criterion.trim())
      .filter(Boolean),
  };
  const formValid = validateGoalCreateRequest(request).ok;

  const addCriterion = () => {
    if (criteria.length >= 16) return;
    setCriteria([...criteria, ""]);
  };

  const updateCriterion = (index: number, value: string) => {
    const next = [...criteria];
    next[index] = value;
    setCriteria(next);
  };

  const removeCriterion = (index: number) => {
    setCriteria(criteria.filter((_, i) => i !== index));
  };

  const create = async () => {
    if (!formValid || creating.current) return;
    creating.current = true;
    setBusy(true);
    setError(null);
    try {
      const filtered = criteria
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      const response = await window.owb.createGoal({
        title: title.trim(),
        description: description.trim(),
        ...(filtered.length > 0 ? { acceptanceCriteria: filtered } : {}),
      });
      if (!alive.current) return;
      if (response.status !== 201) {
        const body = response.body as { message?: unknown };
        setError(
          typeof body?.message === "string"
            ? body.message
            : label("createFail"),
        );
        return;
      }
      onCreated?.(response.body.goalId);
      onClose();
    } catch {
      if (alive.current) setError(label("createFail"));
    } finally {
      creating.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return (
    <Drawer
      title={label("createTitle")}
      rootClassName="owb-goal-create-drawer"
      footer={
        <footer className="owb-goal-create__footer">
          <AntButton onClick={onClose} disabled={busy}>
            {t("dlg.cancel")}
          </AntButton>
          <AntButton
            type="primary"
            onClick={() => void create()}
            loading={busy}
            disabled={!formValid}
            icon={
              presentation === "projects" ? (
                <FolderKanban aria-hidden="true" size={14} />
              ) : (
                <Target aria-hidden="true" size={14} />
              )
            }
          >
            {label("createAction")}
          </AntButton>
        </footer>
      }
      width="min(560px, calc(100vw - 24px))"
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      destroyOnHidden
    >
      <div className="owb-goal-create">
        <p className="owb-goal-create__hint">{label("descPh")}</p>

        <fieldset
          disabled={busy}
          className="owb-goal-create__form"
          aria-label={label("createTitle")}
        >
          <label>
            <span>{label("titleField")}</span>
            <Input
              autoFocus
              value={title}
              maxLength={256}
              placeholder={label("titlePh")}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            <span>{label("descField")}</span>
            <Input.TextArea
              value={description}
              maxLength={4096}
              autoSize={{ minRows: 3, maxRows: 6 }}
              placeholder={label("descPh")}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          <div className="owb-goal-create__criteria">
            <span>{label("criteria")}</span>
            {criteria.map((item, i) => (
              <div key={i} className="owb-goal-create__criteria-row">
                <Input
                  value={item}
                  maxLength={4096}
                  placeholder={label("criteriaAdd")}
                  onChange={(e) => updateCriterion(i, e.target.value)}
                />
                <AntButton
                  type="text"
                  size="small"
                  icon={<Trash2 aria-hidden="true" size={14} />}
                  onClick={() => removeCriterion(i)}
                  aria-label={label("criteriaRemove")}
                />
              </div>
            ))}
            {criteria.length < 16 && (
              <AntButton
                type="dashed"
                size="small"
                icon={<Plus aria-hidden="true" size={14} />}
                onClick={addCriterion}
              >
                {label("criteriaAdd")}
              </AntButton>
            )}
          </div>
        </fieldset>

        {error ? (
          <p className="owb-goal-create__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Drawer>
  );
}

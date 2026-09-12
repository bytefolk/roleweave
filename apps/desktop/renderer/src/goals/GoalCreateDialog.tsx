import { useEffect, useState } from "react";
import { Button as AntButton, Drawer, Input } from "antd";
import { Target, Plus, Trash2 } from "lucide-react";
import { useT } from "@roleweave/ui";

interface GoalCreateDialogProps {
  open: boolean;
  onClose: () => void;
}

export function GoalCreateDialog({ open, onClose }: GoalCreateDialogProps) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setCriteria([]);
    setBusy(false);
    setError(null);
  }, [open]);

  const formValid = title.trim().length > 0 && description.trim().length > 0;

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
    if (!formValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const filtered = criteria.map((c) => c.trim()).filter((c) => c.length > 0);
      const response = await window.owb.createGoal({
        title: title.trim(),
        description: description.trim(),
        ...(filtered.length > 0 ? { acceptanceCriteria: filtered } : {}),
      });
      if (response.status !== 201) {
        const body = response.body as { message?: unknown };
        setError(typeof body?.message === "string" ? body.message : t("goals.createFail"));
        return;
      }
      onClose();
    } catch {
      setError(t("goals.createFail"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title={t("goals.createTitle")}
      width="min(560px, calc(100vw - 24px))"
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      destroyOnHidden
    >
      <div className="owb-goal-create">
        <section className="owb-goal-create__hero">
          <div className="owb-goal-create__icon"><Target aria-hidden="true" size={20} /></div>
          <div>
            <h3>{t("goals.createTitle")}</h3>
            <p>{t("goals.descPh")}</p>
          </div>
        </section>

        <section className="owb-goal-create__form" aria-label={t("goals.createTitle")}>
          <label>
            <span>{t("goals.titleField")}</span>
            <Input
              autoFocus
              value={title}
              maxLength={256}
              placeholder={t("goals.titlePh")}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            <span>{t("goals.descField")}</span>
            <Input.TextArea
              value={description}
              maxLength={4096}
              autoSize={{ minRows: 3, maxRows: 6 }}
              placeholder={t("goals.descPh")}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          <div className="owb-goal-create__criteria">
            <span>{t("goals.criteria")}</span>
            {criteria.map((item, i) => (
              <div key={i} className="owb-goal-create__criteria-row">
                <Input
                  value={item}
                  maxLength={4096}
                  placeholder={t("goals.criteriaAdd")}
                  onChange={(e) => updateCriterion(i, e.target.value)}
                />
                <AntButton
                  type="text"
                  size="small"
                  icon={<Trash2 aria-hidden="true" size={14} />}
                  onClick={() => removeCriterion(i)}
                  aria-label={t("goals.criteriaRemove")}
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
                {t("goals.criteriaAdd")}
              </AntButton>
            )}
          </div>
        </section>

        {error ? <p className="owb-goal-create__error" role="alert">{error}</p> : null}
        <footer className="owb-goal-create__footer">
          <AntButton onClick={onClose} disabled={busy}>{t("dlg.cancel")}</AntButton>
          <AntButton type="primary" onClick={() => void create()} loading={busy} disabled={!formValid} icon={<Target aria-hidden="true" size={14} />}>
            {t("goals.createAction")}
          </AntButton>
        </footer>
      </div>
    </Drawer>
  );
}

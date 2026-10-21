import { useEffect, useRef, useState } from "react";
import { Button as AntButton, Drawer, Input } from "antd";
import { FolderKanban, Target, Plus, Trash2, Code2, Search, FileText, Pencil, ChevronDown } from "lucide-react";
import { validateGoalCreateRequest } from "@roleweave/shared/goals";
import { useT } from "@roleweave/ui";
import { goalCreatePresetDraft, goalCreatePresetIds, type GoalCreateDraft, type GoalCreatePresetId } from "./goal-create-presets";
import "./goal-create-presets.css";

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
  const [selectedPreset, setSelectedPreset] = useState<GoalCreatePresetId>("custom");
  const [editingOpen, setEditingOpen] = useState(false);
  const presetDrafts = useRef(new Map<GoalCreatePresetId, GoalCreateDraft>());
  const creating = useRef<symbol | null>(null);
  const requestVersion = useRef(0);
  const visibility = useRef({ open, presentation });
  visibility.current = { open, presentation };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      requestVersion.current += 1;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    requestVersion.current += 1;
    creating.current = null;
    if (!open) return;
    setTitle("");
    setDescription("");
    setCriteria([]);
    setSelectedPreset("custom");
    setEditingOpen(false);
    presetDrafts.current.clear();
    setBusy(false);
    setError(null);
  }, [open, presentation]);

  const choosePreset = (next: GoalCreatePresetId) => {
    if (busy || creating.current || next === selectedPreset) return;
    presetDrafts.current.set(selectedPreset, { title, description, criteria: [...criteria] });
    const draft = presetDrafts.current.get(next) ?? goalCreatePresetDraft(next, t);
    setSelectedPreset(next);
    setEditingOpen(false);
    setTitle(draft.title);
    setDescription(draft.description);
    setCriteria([...draft.criteria]);
    setError(null);
  };

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
    const operation = Symbol();
    const version = requestVersion.current;
    creating.current = operation;
    const isCurrent = () => alive.current && requestVersion.current === version && visibility.current.open
      && visibility.current.presentation === presentation;
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
      if (!isCurrent()) return;
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
      if (isCurrent()) setError(label("createFail"));
    } finally {
      if (creating.current === operation) creating.current = null;
      if (isCurrent()) setBusy(false);
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
        <section className="owb-goal-create-presets" aria-label={t("creation.planPresets.heading")}>
          <h3>{t("creation.planPresets.heading")}</h3>
          <div className="owb-goal-create-presets__choices" role="group" aria-label={t("creation.planPresets.heading")}>
            {goalCreatePresetIds.map(id => {
              const Icon = { feature: Code2, research: Search, content: FileText, custom: Pencil }[id];
              return <button key={id} type="button" className="owb-goal-create-presets__choice"
                aria-label={t(`creation.planPresets.${id}.name`)} aria-pressed={selectedPreset === id} disabled={busy}
                onClick={() => choosePreset(id)}>
                <Icon size={16} aria-hidden="true" />
                <span><strong>{t(`creation.planPresets.${id}.name`)}</strong><small>{t(`creation.planPresets.${id}.summary`)}</small></span>
              </button>;
            })}
          </div>
          <p className="owb-goal-create-presets__hint">{t("creation.planPresets.hint")}</p>
        </section>

        {selectedPreset !== "custom" ? <section className="owb-goal-create-presets__preview" aria-label={t("creation.planPresets.preview")}>
          <span className="owb-goal-create-presets__preview-label">{t("creation.planPresets.preview")}</span>
          <strong>{request.title || label("titlePh")}</strong>
          {request.description ? <p>{request.description}</p> : null}
          {request.acceptanceCriteria.length > 0 ? <ol aria-label={label("criteria")}>
            {request.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}
          </ol> : null}
        </section> : null}

        <details className="owb-goal-create-presets__editor" data-custom={selectedPreset === "custom" || undefined}
          open={selectedPreset === "custom" || editingOpen}
          onToggle={event => { if (selectedPreset !== "custom") setEditingOpen(event.currentTarget.open); }}>
          <summary hidden={selectedPreset === "custom"}><ChevronDown size={14} aria-hidden="true" />{t("creation.planPresets.adjust")}</summary>
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
        </details>

        {error ? (
          <p className="owb-goal-create__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Drawer>
  );
}

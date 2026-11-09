import { useEffect, useMemo, useRef, useState } from "react";
import { Button as AntButton, Input, Select } from "antd";
import { ChevronDown, FolderPlus } from "lucide-react";
import type { WorkspaceCreateResponse } from "@roleweave/shared";
import { useT } from "@roleweave/ui";
import { AGENT_HOST_LABEL, AGENT_HOSTS, defaultAgentHost, resolveAgentEngine, type AgentHost } from "../turns/agent-host";
import type { TurnEngine, TurnEngineAvailability } from "../turns/types";
import "./project-create-presets.css";

const PROJECT_PRESETS = ["general", "software", "research"] as const;
type ProjectPreset = (typeof PROJECT_PRESETS)[number] | "custom";
type ProjectDraft = { business: string; description: string };

interface ProjectCreateFormProps {
  onCancel: () => void;
  onCreated: (workspace: WorkspaceCreateResponse) => void;
  onBusyChange?: (busy: boolean) => void;
  engineAvailability: Record<TurnEngine, TurnEngineAvailability>;
  /** When set, bootstrap metadata in this existing directory instead of
   * opening the parent-folder picker used by a new project. */
  targetPath?: string;
  initialBusiness?: string;
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (slug) return slug;
  if (!value.trim()) return "new-project";

  // Keep the platform rule deterministic for names without Latin letters
  // without making users manage an implementation-facing id field.
  let hash = 2166136261;
  for (const character of value.trim()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `project-${(hash >>> 0).toString(36).padStart(7, "0")}`;
}

/** The creation form is intentionally independent from the workspace picker. */
export function ProjectCreateForm({ onCancel, onCreated, onBusyChange, engineAvailability, targetPath, initialBusiness = "" }: ProjectCreateFormProps) {
  const t = useT();
  const initialDraft = (preset: ProjectPreset): ProjectDraft => ({
    business: initialBusiness || (preset === "custom" ? "" : t(`project.template.${preset}.name`)),
    description: preset === "custom" ? "" : t(`project.template.${preset}.description`),
  });
  const [preset, setPreset] = useState<ProjectPreset>("general");
  const [draft, setDraft] = useState<ProjectDraft>(() => initialDraft("general"));
  const { business, description } = draft;
  const drafts = useRef<Partial<Record<ProjectPreset, ProjectDraft>>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentHost, setAgentHost] = useState<AgentHost>(() => defaultAgentHost(engineAvailability));
  const agentChosen = useRef(false);
  const [busy, setBusy] = useState(false);
  const creating = useRef<symbol | null>(null);
  const alive = useRef(true);
  const scope = useMemo(() => Symbol("project-create-scope"), [initialBusiness, targetPath]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (creating.current !== null) onBusyChange?.(false);
      creating.current = null;
    };
  }, []);
  useEffect(() => {
    setPreset("general");
    setDraft(initialDraft("general"));
    drafts.current = {};
    setSettingsOpen(false);
    creating.current = null;
    setBusy(false);
    setError(null);
    onBusyChange?.(false);
  }, [initialBusiness, targetPath]);
  useEffect(() => {
    if (!agentChosen.current) setAgentHost(defaultAgentHost(engineAvailability));
  }, [engineAvailability]);
  const generatedId = useMemo(() => slugify(business), [business]);
  const agentEngine = useMemo(
    () => resolveAgentEngine(agentHost, engineAvailability),
    [agentHost, engineAvailability],
  );
  const formValid = business.trim().length > 0 && business.trim().length <= 64;
  const choosePreset = (next: ProjectPreset) => {
    if (busy || next === preset) return;
    drafts.current[preset] = draft;
    setPreset(next);
    setDraft(drafts.current[next] ?? initialDraft(next));
    if (next === "custom") setSettingsOpen(true);
    setError(null);
  };

  const create = async () => {
    if (!formValid || creating.current) return;
    const operation = Symbol("project-create");
    creating.current = operation;
    const isCurrent = () => alive.current && creating.current === operation && currentScope.current === scope;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const response = targetPath
        ? await window.owb.initializeWorkspace?.({
            path: targetPath,
            projectId: generatedId,
            business: business.trim(),
            description: description.trim(),
            agentEngine,
          })
        : await window.owb.createWorkspace({
            projectId: generatedId,
            business: business.trim(),
            description: description.trim(),
            agentEngine,
          });
      if (!isCurrent()) return;
      if (!response || !("status" in response)) {
        setError(targetPath ? t("project.initializeFailed") : t("project.createFailed"));
        return;
      }
      if (response.status !== 201) {
        const body = response.body as { message?: unknown };
        setError(typeof body?.message === "string" ? body.message : targetPath ? t("project.initializeFailed") : t("project.createFailed"));
        return;
      }
      onCreated(response.body as WorkspaceCreateResponse);
    } catch {
      if (isCurrent()) setError(targetPath ? t("project.initializeOffline") : t("project.createOffline"));
    } finally {
      if (isCurrent()) {
        creating.current = null;
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  };

  return (
    <form
      className="owb-project-create-form"
      aria-label={t("project.formAria")}
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <section className="owb-project-presets" aria-label={t("project.templateHeading")}>
        <div className="owb-project-presets__heading"><strong>{t("project.templateHeading")}</strong><p>{t("project.templateHint")}</p></div>
        <div className="owb-project-presets__choices">
          {PROJECT_PRESETS.map((choice) => <button key={choice} type="button" aria-pressed={preset === choice} disabled={busy} onClick={() => choosePreset(choice)}>
            <strong>{t(`project.template.${choice}.title`)}</strong><span>{t(`project.template.${choice}.hint`)}</span>
          </button>)}
        </div>
        <button className="owb-project-presets__custom" type="button" aria-pressed={preset === "custom"} disabled={busy} onClick={() => choosePreset("custom")}>{t("project.customStart")}</button>
      </section>

      <section className="owb-project-draft-preview" aria-label={t("project.draftPreview")}>
        <strong>{business || t("project.customStart")}</strong>
        {description ? <p>{description}</p> : null}
        <span>{t("project.agentSummary", { agent: AGENT_HOST_LABEL[agentHost] })}</span>
      </section>

      <details className="owb-project-create-settings" open={settingsOpen} onToggle={(event) => setSettingsOpen(event.currentTarget.open)}>
        <summary><ChevronDown size={15} aria-hidden="true" />{t("project.adjustSettings")}</summary>
        <div className="owb-project-create-settings__body">
        <div className="owb-project-create-form__field">
        <label htmlFor="owb-project-business">{t("project.business")}</label>
        <Input
          id="owb-project-business"
          disabled={busy}
          value={business}
          maxLength={64}
          placeholder={t("project.businessPh")}
          onChange={(event) => setDraft((current) => ({ ...current, business: event.target.value }))}
        />
      </div>

      <div className="owb-project-create-form__field">
        <label htmlFor="owb-project-description">{t("project.description")}</label>
        <Input.TextArea
          id="owb-project-description"
          value={description}
          disabled={busy}
          maxLength={1024}
          autoSize={{ minRows: 3, maxRows: 6 }}
          placeholder={t("project.descriptionPh")}
          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
        />
      </div>

      <div className="owb-project-create-form__field">
        <label htmlFor="owb-project-owner-agent">{t("project.ownerAgent")}</label>
        <Select
          id="owb-project-owner-agent"
          aria-label={t("project.ownerAgent")}
          value={agentHost}
          disabled={busy}
          onChange={(value) => { agentChosen.current = true; setAgentHost(value as AgentHost); }}
          options={AGENT_HOSTS.map((host) => ({ value: host, label: AGENT_HOST_LABEL[host] }))}
        />
        <p>{targetPath ? t("project.initializeAgentHint") : t("project.ownerAgentHint")}</p>
      </div>
        </div>
      </details>

      {error ? <p className="owb-project-create-form__error" role="alert">{error}</p> : null}

      <footer className="owb-project-create-form__footer">
        <span title={targetPath}>{targetPath ? t("project.initializeLocation", { path: targetPath }) : t("project.locationHint")}</span>
        <AntButton htmlType="button" onClick={onCancel} disabled={busy}>{t("dlg.cancel")}</AntButton>
        <AntButton type="primary" htmlType="submit" loading={busy} disabled={!formValid} icon={<FolderPlus aria-hidden="true" size={14} />}>
          {targetPath ? t("project.initializeSubmitAction") : t("project.createAction")}
        </AntButton>
      </footer>
    </form>
  );
}

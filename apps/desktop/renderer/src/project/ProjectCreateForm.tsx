import { useEffect, useMemo, useState } from "react";
import { Button as AntButton, Input, Select } from "antd";
import { FolderPlus } from "lucide-react";
import type { WorkspaceCreateResponse } from "@roleweave/shared";
import { useT } from "@roleweave/ui";
import { AGENT_HOST_LABEL, AGENT_HOSTS, defaultAgentHost, resolveAgentEngine, type AgentHost } from "../turns/agent-host";
import type { TurnEngine, TurnEngineAvailability } from "../turns/types";

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
  const [business, setBusiness] = useState(initialBusiness);
  const [description, setDescription] = useState("");
  const [agentHost, setAgentHost] = useState<AgentHost>(() => defaultAgentHost(engineAvailability));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (targetPath !== undefined) setBusiness(initialBusiness);
  }, [initialBusiness, targetPath]);
  const generatedId = useMemo(() => slugify(business), [business]);
  const agentEngine = useMemo(
    () => resolveAgentEngine(agentHost, engineAvailability),
    [agentHost, engineAvailability],
  );
  const formValid = business.trim().length > 0;

  const create = async () => {
    if (!formValid || busy) return;
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
      setError(targetPath ? t("project.initializeOffline") : t("project.createOffline"));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
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
      <div className="owb-project-create-form__field">
        <label htmlFor="owb-project-business">{t("project.business")}</label>
        <Input
          id="owb-project-business"
          autoFocus
          value={business}
          maxLength={64}
          placeholder={t("project.businessPh")}
          onChange={(event) => setBusiness(event.target.value)}
        />
        <p>{targetPath ? t("project.initializeIdNote") : t("project.idAutoNote")}</p>
      </div>

      <div className="owb-project-create-form__field">
        <label htmlFor="owb-project-description">{t("project.description")}</label>
        <Input.TextArea
          id="owb-project-description"
          value={description}
          maxLength={1024}
          autoSize={{ minRows: 3, maxRows: 6 }}
          placeholder={t("project.descriptionPh")}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="owb-project-create-form__field">
        <label htmlFor="owb-project-owner-agent">{t("project.ownerAgent")}</label>
        <Select
          id="owb-project-owner-agent"
          aria-label={t("project.ownerAgent")}
          value={agentHost}
          onChange={(value) => setAgentHost(value as AgentHost)}
          options={AGENT_HOSTS.map((host) => ({ value: host, label: AGENT_HOST_LABEL[host] }))}
        />
        <p>{targetPath ? t("project.initializeAgentHint") : t("project.ownerAgentHint")}</p>
      </div>

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

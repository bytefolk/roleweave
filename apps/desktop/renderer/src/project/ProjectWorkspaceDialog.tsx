import { useEffect, useState, type ReactNode } from "react";
import { Modal } from "antd";
import { ArrowLeft, Check, FolderOpen, FolderPlus, LoaderCircle, Wrench } from "lucide-react";
import type { WorkspaceCreateResponse, WorkspaceInfoResponse } from "@roleweave/shared";
import { useT } from "@roleweave/ui";
import { ProjectCreateForm } from "./ProjectCreateForm";
import type { TurnEngine, TurnEngineAvailability } from "../turns/types";

interface ProjectWorkspaceDialogProps {
  open: boolean;
  workspace: WorkspaceInfoResponse | null;
  positionCount: number | null;
  engineAvailability: Record<TurnEngine, TurnEngineAvailability>;
  disabled?: boolean;
  opening?: boolean;
  openError?: string | null;
  initializePath?: string | null;
  onClose: () => void;
  onOpenWorkspace: () => void;
  onCreated: (workspace: WorkspaceCreateResponse) => void;
}

type WorkspaceDialogPage = "choose" | "create" | "initialize";

function WorkspaceAction({
  icon,
  title,
  description,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="owb-project-workspace-action" disabled={disabled} onClick={onClick}>
      <span className="owb-project-workspace-action__icon" aria-hidden="true">{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}

function CurrentWorkspace({ workspace, positionCount }: Pick<ProjectWorkspaceDialogProps, "workspace" | "positionCount">) {
  const t = useT();
  if (workspace?.open !== true) return null;
  return (
    <section className="owb-project-current-workspace" aria-label={t("project.current")}>
      <span className="owb-project-current-workspace__mark" aria-hidden="true"><Check size={13} /></span>
      <span>
        <strong>{workspace.business ?? t("tree.workspaceFallback")}</strong>
        <small title={workspace.path}>{workspace.path ?? t("project.localOnly")}</small>
        <em>{positionCount === null ? t("project.positionsUnknown") : t("tree.positions", { count: positionCount })}</em>
      </span>
    </section>
  );
}

/**
 * A centered workspace hub, modelled after a desktop project chooser: users
 * make the open-vs-create decision before entering the creation form. It is
 * intentionally a dialog, never a side drawer, so it does not displace the
 * conversation they were working in.
 */
export function ProjectWorkspaceDialog({
  open,
  workspace,
  positionCount,
  engineAvailability,
  disabled = false,
  opening = false,
  openError = null,
  initializePath = null,
  onClose,
  onOpenWorkspace,
  onCreated,
}: ProjectWorkspaceDialogProps) {
  const t = useT();
  const [page, setPage] = useState<WorkspaceDialogPage>("choose");
  const [createBusy, setCreateBusy] = useState(false);

  useEffect(() => {
    if (!open) setPage("choose");
  }, [open]);

  const openExisting = () => { onOpenWorkspace(); };
  const dialogBusy = disabled || createBusy || opening;
  const initializeBusiness = initializePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? "";

  return (
    <Modal
      className="owb-project-dialog"
      title={page === "choose" ? t("project.chooseTitle") : page === "create" ? t("project.createTitle") : t("project.initializeTitle")}
      open={open}
      footer={null}
      width="min(560px, calc(100vw - 32px))"
      styles={{
        container: { maxHeight: "calc(100dvh - 32px)", display: "flex", flexDirection: "column" },
        body: { minHeight: 0, overflowY: "auto" },
      }}
      onCancel={() => { if (!createBusy && !opening) onClose(); }}
      mask={{ closable: !createBusy && !opening }}
      keyboard={!createBusy && !opening}
      destroyOnHidden
    >
      {page === "choose" ? (
        <div className="owb-project-dialog__chooser">
          <p className="owb-project-dialog__description">{t("project.chooseDescription")}</p>
          <CurrentWorkspace workspace={workspace} positionCount={positionCount} />
          {opening ? (
            <p className="owb-project-dialog__status" role="status" aria-live="polite">
              <LoaderCircle size={15} aria-hidden="true" />
              {t("project.opening")}
            </p>
          ) : null}
          {openError ? <p className="owb-project-dialog__error" role="alert">{openError}</p> : null}
          <div className="owb-project-dialog__actions" aria-label={t("project.actionsAria")}>
            <WorkspaceAction
              icon={<FolderOpen size={18} />}
              title={t("project.openAction")}
              description={t("project.openActionHint")}
              disabled={dialogBusy}
              onClick={openExisting}
            />
            <WorkspaceAction
              icon={<FolderPlus size={18} />}
              title={t("project.newCta")}
              description={t("project.newActionHint")}
              disabled={dialogBusy}
              onClick={() => setPage("create")}
            />
            {initializePath ? (
              <WorkspaceAction
                icon={<Wrench size={18} />}
                title={t("project.initializeAction")}
                description={t("project.initializeActionHint")}
                disabled={dialogBusy}
                onClick={() => setPage("initialize")}
              />
            ) : null}
          </div>
        </div>
      ) : page === "create" ? (
        <div className="owb-project-dialog__create">
          <button type="button" className="owb-project-dialog__back" disabled={dialogBusy} onClick={() => setPage("choose")}>
            <ArrowLeft aria-hidden="true" size={15} />
            {t("project.back")}
          </button>
          <p className="owb-project-dialog__description">{t("project.createDescription")}</p>
          <ProjectCreateForm
            engineAvailability={engineAvailability}
            onBusyChange={setCreateBusy}
            onCancel={() => setPage("choose")}
            onCreated={(created) => {
              onCreated(created);
              onClose();
            }}
          />
        </div>
      ) : (
        <div className="owb-project-dialog__create">
          <button type="button" className="owb-project-dialog__back" disabled={dialogBusy} onClick={() => setPage("choose")}>
            <ArrowLeft aria-hidden="true" size={15} />
            {t("project.back")}
          </button>
          <p className="owb-project-dialog__description">{t("project.initializeDescription")}</p>
          <ProjectCreateForm
            engineAvailability={engineAvailability}
            targetPath={initializePath ?? undefined}
            initialBusiness={initializeBusiness}
            onBusyChange={setCreateBusy}
            onCancel={() => setPage("choose")}
            onCreated={(created) => {
              onCreated(created);
              onClose();
            }}
          />
        </div>
      )}
    </Modal>
  );
}

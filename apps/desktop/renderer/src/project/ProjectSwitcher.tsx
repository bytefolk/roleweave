import { ChevronDown, FolderOpen } from "lucide-react";
import type { WorkspaceInfoResponse } from "@roleweave/shared";
import { useT } from "@roleweave/ui";

export interface ProjectSwitcherProps {
  workspace: WorkspaceInfoResponse | null;
  disabled?: boolean;
  dialogOpen: boolean;
  onOpen: () => void;
}

/**
 * The sidebar trigger deliberately does one thing: open the workspace hub.
 * Keeping it separate from the hub avoids a second, competing menu state in
 * App and leaves the choice of an existing vs. new workspace in one place.
 */
export function ProjectSwitcher({ workspace, disabled = false, dialogOpen, onOpen }: ProjectSwitcherProps) {
  const t = useT();
  const open = workspace?.open === true;

  return (
    <div className="owb-project-switcher">
      <button
        type="button"
        className="owb-project-switcher__trigger"
        aria-label={t("project.switcherAria")}
        aria-haspopup="dialog"
        aria-expanded={dialogOpen}
        disabled={disabled}
        title={open ? workspace?.path : undefined}
        onClick={onOpen}
      >
        <span className="owb-project-switcher__icon" aria-hidden="true">
          <FolderOpen size={14} />
        </span>
        <span className="owb-project-switcher__copy">
          <strong>{open ? workspace?.business ?? t("tree.workspaceFallback") : t("project.launcherTitle")}</strong>
        </span>
        <ChevronDown className="owb-project-switcher__chevron" aria-hidden="true" size={15} />
      </button>
    </div>
  );
}

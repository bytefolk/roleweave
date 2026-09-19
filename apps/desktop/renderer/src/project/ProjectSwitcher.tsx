import { ChevronDown, FolderOpen } from "lucide-react";
import type { WorkspaceInfoResponse } from "@roleweave/shared";
import { BytefolkOpenHerdMark, useT } from "@roleweave/ui";

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
 *
 * The trigger carries the opened project's face (its configured brand mark):
 * the directory tree below leads with people, so the project identity row
 * lives here. Without an open project there is no face to show — the plain
 * folder icon stands in until a workspace is chosen.
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
          {open ? <BytefolkOpenHerdMark /> : <FolderOpen size={14} />}
        </span>
        <span className="owb-project-switcher__copy">
          <strong>{open ? workspace?.business ?? t("tree.workspaceFallback") : t("project.launcherTitle")}</strong>
        </span>
        <ChevronDown className="owb-project-switcher__chevron" aria-hidden="true" size={15} />
      </button>
    </div>
  );
}

import type { TurnEngine } from "@roleweave/shared";
import { GoalsModule } from "../goals/GoalsModule";

interface ProjectManagementModuleProps {
  workspaceOpen: boolean;
  workspaceKey?: string;
  positionNames: Record<string, string>;
  positionEngines?: Record<string, TurnEngine>;
  positionAvatars?: Record<string, import("../PositionAvatar.js").AvatarValue>;
  positionAvatarSources?: Record<string, string>;
  ownerPositionId?: string;
  onOpenApprovals?: () => void;
  onOpenBoundSession?: (positionId: string, sessionId?: string, turnId?: string) => void;
}

/** Independent navigation, sharing durable goals and their execution links. */
export function ProjectManagementModule(props: ProjectManagementModuleProps) {
  return <GoalsModule {...props} presentation="projects" />;
}

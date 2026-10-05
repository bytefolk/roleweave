import { useMemo } from "react";
import { useT } from "@roleweave/ui";
import type { AcceptanceRecord } from "@roleweave/shared";
import { SpaceModule, type SpaceAgent } from "./SpaceModule.js";
import { useSpaceFiles } from "./useSpaceFiles.js";

export interface SpaceHostProps {
  workspaceOpen: boolean;
  /** The position whose package directory backs the current space, if any. */
  spacePositionId: string | null;
  positionNames: Record<string, string>;
  ownerPositionId?: string;
  onOpenBoundSession?: (positionId: string) => void;
  onAccept?: (record: AcceptanceRecord) => void | Promise<void>;
}

/**
 * Bridges the space module to the shell: resolves the current space's files
 * through the existing position-docs bridge and derives the participant list
 * from the org, so the module itself stays a pure view.
 */
export function SpaceHost({
  workspaceOpen,
  spacePositionId,
  positionNames,
  ownerPositionId,
  onOpenBoundSession,
  onAccept,
}: SpaceHostProps) {
  const t = useT();
  const state = useSpaceFiles(spacePositionId, workspaceOpen);

  const participants = useMemo<SpaceAgent[]>(() => {
    const ids = Object.keys(positionNames);
    // The owner always comes first and is marked; it is an org-level fact.
    const ordered = ownerPositionId && ids.includes(ownerPositionId)
      ? [ownerPositionId, ...ids.filter((id) => id !== ownerPositionId)]
      : ids;
    return ordered.map((positionId) => ({
      positionId,
      name: positionNames[positionId] ?? positionId,
      owner: positionId === ownerPositionId,
    }));
  }, [positionNames, ownerPositionId]);

  return (
    <SpaceModule
      key={spacePositionId ?? "none"}
      workspaceOpen={workspaceOpen}
      spaceId={spacePositionId ?? undefined}
      spaceName={spacePositionId ? (positionNames[spacePositionId] ?? spacePositionId) : t("space.untitled")}
      files={state.files}
      readFile={state.readFile}
      writeFile={state.writeFile}
      participants={participants}
      onOpenBoundSession={onOpenBoundSession}
      onAccept={onAccept}
    />
  );
}

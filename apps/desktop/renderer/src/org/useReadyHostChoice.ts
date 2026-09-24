import { useEffect, useMemo, useRef, useState } from "react";
import { EXPERIMENTS_CHANGED, useWorkspaceExperiments } from "../experiments/useWorkspaceExperiments";
import { presentReadyHostOverlay, type ReadyHostFact, type ReadyHostOverlayPresentation } from "./ready-host-overlay";

export function useReadyHostOverlay(
  workspacePath: string | undefined,
  selected: ReadyHostFact | null,
  facts: ReadyHostFact[],
): ReadyHostOverlayPresentation {
  const settings = useWorkspaceExperiments({ workspacePath });
  const overlayEnabled = settings.snapshot?.enabled === true && settings.snapshot.availability === "ready";
  const presented = presentReadyHostOverlay({ overlayEnabled, selected, positions: facts });
  const signature = JSON.stringify(presented.candidates.map((item) => item.positionId));
  const owner = useMemo(
    () => ({}),
    [settings.owner, settings.snapshot?.workspaceSession, settings.snapshot?.revision, settings.snapshot?.enabled, signature, presented.callJev],
  );
  const activeOwner = useRef(owner);
  activeOwner.current = owner;
  const version = useRef(0);
  const [choice, setChoice] = useState<{ owner: object; positionId: string | null } | null>(null);

  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ workspacePath: string }>).detail?.workspacePath === workspacePath) {
        version.current += 1;
        setChoice(null);
      }
    };
    window.addEventListener(EXPERIMENTS_CHANGED, changed);
    return () => {
      version.current += 1;
      window.removeEventListener(EXPERIMENTS_CHANGED, changed);
    };
  }, [owner, workspacePath]);

  useEffect(() => {
    if (!presented.callJev) {
      setChoice(null);
      return;
    }
    const snapshot = settings.snapshot;
    if (!snapshot || !window.owb.readyHostChoice) {
      setChoice({ owner, positionId: null });
      return;
    }
    const request = ++version.current;
    const current = () => settings.current() && activeOwner.current === owner && request === version.current;
    const candidates = presented.candidates.map((item) => ({
      positionId: item.positionId,
      engine: item.engine,
      ready: item.ready,
    }));
    void window.owb.readyHostChoice({
      workspacePath: snapshot.workspacePath,
      workspaceSession: snapshot.workspaceSession,
      revision: snapshot.revision,
      candidates,
    }).then((response) => {
      if (!current()) return;
      if (response.status === 409) {
        setChoice({ owner, positionId: null });
        void settings.refresh();
        return;
      }
      const positionId = response.status === 200 ? response.body.positionId : null;
      const allowed = presented.candidates.some((item) => item.positionId === positionId);
      setChoice({ owner, positionId: allowed ? positionId : null });
    }).catch(() => {
      if (current()) setChoice({ owner, positionId: null });
    });
  }, [owner]);

  if (!presented.callJev) return presented;
  const positionId = choice?.owner === owner ? choice.positionId : null;
  const chosen = presented.candidates.filter((item) => item.positionId === positionId);
  return { visible: chosen.length > 0, callJev: true, candidates: chosen };
}

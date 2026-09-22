import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExperimentsResponse } from "@roleweave/shared";

export const EXPERIMENTS_CHANGED = "owb:experiments-changed";
export interface ExperimentScope {
  workspacePath?: string;
  /** Changes for every workspace transition, including A → B → A. */
  workspaceScope?: symbol;
}

export function useWorkspaceExperiments({ workspacePath, workspaceScope }: ExperimentScope) {
  const owner = useMemo(() => ({}), [workspacePath, workspaceScope]);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const mounted = useRef(false);
  const request = useRef(0);
  const [state, setState] = useState<{ owner: object; snapshot: ExperimentsResponse | null; loading: boolean; error: boolean }>({ owner, snapshot: null, loading: !!workspacePath, error: false });
  const current = useCallback(() => mounted.current && ownerRef.current === owner, [owner]);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    setState({ owner, snapshot: null, loading: !!workspacePath, error: false });
    if (!workspacePath) return;
    try {
      if (!window.owb.experiments) throw Error("bridge unavailable");
      const response = await window.owb.experiments.get(workspacePath);
      if (!current() || request.current !== id) return;
      if (response.status !== 200 || response.body.workspacePath !== workspacePath) throw Error("settings unavailable");
      setState({ owner, snapshot: response.body, loading: false, error: false });
    } catch {
      if (current() && request.current === id) setState({ owner, snapshot: null, loading: false, error: true });
    }
  }, [owner, workspacePath, current]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ workspacePath: string }>).detail?.workspacePath === workspacePath) void refresh();
    };
    window.addEventListener(EXPERIMENTS_CHANGED, changed);
    return () => { mounted.current = false; ++request.current; window.removeEventListener(EXPERIMENTS_CHANGED, changed); };
  }, [refresh, workspacePath]);
  const snapshot = state.owner === owner ? state.snapshot : null;
  return { snapshot, loading: state.owner !== owner ? !!workspacePath : state.loading, error: state.owner === owner && state.error, refresh, current, owner };
}

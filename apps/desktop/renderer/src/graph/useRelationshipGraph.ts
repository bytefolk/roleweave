import { useCallback, useEffect, useRef, useState } from "react";
import type { RelationshipGraphResponse } from "@roleweave/shared/relationship-graph";
import { SERVICES_CHANGED } from "../settings/ServiceConnections";

/** Read only while visible; coalesce SSE bursts and reject obsolete workspace reads. */
export function useRelationshipGraph(workspaceKey: string | undefined, enabled: boolean) {
  const [result, setResult] = useState<{ scope: string; data: RelationshipGraphResponse } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const version = ++generation.current;
    if (!enabled || !workspaceKey) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await window.owb.relationshipGraph(workspaceKey);
        if (cancelled || generation.current !== version) return;
        if (response.status !== 200 || response.body?.schemaVersion !== "relationship-graph.v1") {
          throw new Error("graph_unavailable");
        }
        setResult({ scope: workspaceKey, data: response.body });
      } catch {
        if (!cancelled && generation.current === version) setError("graph_unavailable");
      } finally {
        if (!cancelled && generation.current === version) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceKey, enabled, revision]);

  useEffect(() => {
    if (!enabled || !workspaceKey) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(reload, 250);
    };
    const off = window.owb.onEvent((raw) => {
      const event = raw as { type?: string; payload?: { workspacePath?: string } };
      if (event.payload?.workspacePath !== workspaceKey) return;
      if (["org.updated", "goal.created", "goal.updated"].includes(event.type ?? "")) schedule();
    });
    window.addEventListener(SERVICES_CHANGED, schedule);
    return () => {
      off();
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener(SERVICES_CHANGED, schedule);
    };
  }, [enabled, workspaceKey, reload]);

  return { data: result && result.scope === workspaceKey ? result.data : null, loading, error, reload };
}

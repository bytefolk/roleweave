import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalBatchDecisionRequest, ApprovalDecisionRequest, ApprovalList, ApprovalView } from "@roleweave/shared";
import { useT } from "@roleweave/ui";

function errorText(body: unknown, fallback: string): string {
  return body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;
}

/** One authoritative cache for both entry points; SSE is an invalidation hint.
 * Requests are serialized so events during a read trigger another full snapshot. */
export function useApprovals(workspacePath: string | undefined) {
  const t = useT();
  const [items, setItems] = useState<ApprovalView[]>([]);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const owner = useRef<object>({});
  const refreshRef = useRef<() => Promise<ApprovalView[]>>(async () => cache.current.items);
  const cache = useRef<{ items: ApprovalView[]; token?: string }>({ items: [] });
  const pending = useRef(new Map<string, ApprovalDecisionRequest>());
  const inFlight = useRef(new Set<string>());
  const batchPending = useRef(new Map<string, ApprovalBatchDecisionRequest>());
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const generation = {};
    owner.current = generation;
    let again = false;
    let inFlightRefresh: Promise<ApprovalView[]> | null = null;
    let lastRefreshTime = 0;
    cache.current = { items: [] }; pending.current.clear(); batchPending.current.clear(); inFlight.current.clear();
    setItems([]); setReady(false); setError(undefined); setErrors({}); setBusy(new Set());
    const current = () => owner.current === generation;
    const executeRefresh = async (): Promise<ApprovalView[]> => {
      if (!workspacePath || !window.owb?.listApprovals || !current()) return cache.current.items;
      if (inFlightRefresh) {
        again = true;
        return inFlightRefresh;
      }
      inFlightRefresh = (async () => {
        setLoading(true);
        try {
          do {
            again = false;
            const all: ApprovalView[] = [];
            let cursor: string | undefined, token: string | undefined;
            let restart = false;
            do {
              const response = await window.owb.listApprovals({ workspacePath, ...(cursor ? { cursor } : {}) });
              if (!current()) return cache.current.items;
              if (response.status === 409 && (response.body as { code?: string }).code === "approval_snapshot_changed") { restart = true; break; }
              if (response.status !== 200) throw new Error(errorText(response.body, t("apr.loadFailed")));
              const page = response.body as ApprovalList;
              if (token && token !== page.workspaceToken) throw new Error(t("apr.loadFailed"));
              token = page.workspaceToken; all.push(...page.items); cursor = page.nextCursor ?? undefined;
            } while (cursor);
            if (restart) { again = true; continue; }
            cache.current = { items: all, token }; setItems(all); setReady(true); setError(undefined);
            lastRefreshTime = Date.now();
          } while (again && current());
          return cache.current.items;
        } catch (e) {
          if (current()) setError(e instanceof Error ? e.message : t("apr.loadFailed"));
          return cache.current.items;
        } finally {
          inFlightRefresh = null;
          if (current()) setLoading(false);
        }
      })();
      return inFlightRefresh;
    };
    refreshRef.current = executeRefresh;
    const focus = () => {
      if (Date.now() - lastRefreshTime > 2000) {
        void executeRefresh();
      }
    };
    window.addEventListener("focus", focus);
    const visibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        if (Date.now() - lastRefreshTime > 2000) {
          void executeRefresh();
        }
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", visibility);
    }
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        void executeRefresh();
      }
    }, 10000);
    void executeRefresh();
    return () => {
      if (current()) owner.current = {};
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", visibility);
      }
    };
  }, [workspacePath, t]);

  const decide = useCallback(async (id: string, decision: "granted" | "denied", reason?: string, scope: "once" | "run" = "once") => {
    const generation = owner.current;
    const item = cache.current.items.find(a => a.id === id);
    if (!item || !cache.current.token || !item.canDecide || inFlight.current.has(id)) return;
    const prior = pending.current.get(id);
    if (prior && (prior.decision !== decision || prior.reason !== reason || prior.scope !== scope)) {
      setErrors(e => ({ ...e, [id]: t("apr.retrySameDecision") })); return;
    }
    const request = prior ?? { requestId: crypto.randomUUID(), expectedVersion: item.version, decision, scope, ...(reason ? { reason } : {}) };
    pending.current.set(id, request); inFlight.current.add(id); setBusy(new Set(inFlight.current));
    setErrors(e => { const next = { ...e }; delete next[id]; return next; });
    try {
      const response = await window.owb.decideApproval({ ...request, id, workspaceToken: cache.current.token });
      if (owner.current !== generation) return;
      if (response.status !== 200 && response.status !== 202) {
        if (response.status < 500) pending.current.delete(id);
        throw new Error(errorText(response.body, t("apr.submitFailed")));
      }
      pending.current.delete(id);
      const updated = response.body as ApprovalView;
      cache.current.items = cache.current.items.map(a => a.id === id ? updated : a);
      setItems([...cache.current.items]);
    } catch (e) {
      if (owner.current === generation) setErrors(es => ({ ...es, [id]: e instanceof Error ? e.message : t("apr.submitFailed") }));
    } finally {
      if (owner.current === generation) { inFlight.current.delete(id); setBusy(new Set(inFlight.current)); await refreshRef.current(); }
    }
  }, [t]);
  const decideBatch = useCallback(async (ids: string[], reason?: string) => {
    const generation = owner.current;
    const unique = [...new Set(ids)].sort();
    const selected = unique.map(id => cache.current.items.find(item => item.id === id));
    if (unique.length < 2 || selected.some(item => !item || !item.canDecide) || !cache.current.token || unique.some(id => inFlight.current.has(id))) return;
    const key = unique.join(",");
    const previous = batchPending.current.get(key);
    if (previous && previous.reason !== reason) {
      setErrors(errors => Object.fromEntries(unique.map(id => [id, t("apr.retrySameDecision")]))); return;
    }
    const request = previous ?? {
      requestId: crypto.randomUUID(), decision: "granted" as const,
      ...(reason ? { reason } : {}),
      items: selected.map(item => ({ id: item!.id, expectedVersion: item!.version })),
    };
    batchPending.current.set(key, request); unique.forEach(id => inFlight.current.add(id)); setBusy(new Set(inFlight.current));
    setErrors(errors => { const next = { ...errors }; unique.forEach(id => delete next[id]); return next; });
    try {
      const response = await window.owb.decideApprovalsBatch({ ...request, workspaceToken: cache.current.token });
      if (owner.current !== generation) return;
      if (response.status !== 200 && response.status !== 202) {
        if (response.status < 500) batchPending.current.delete(key);
        throw new Error(errorText(response.body, t("apr.submitFailed")));
      }
      const body = response.body;
      const updates = new Map(body.items.filter(item => item.status === "accepted" && item.record).map(item => [item.id, item.record!]));
      cache.current.items = cache.current.items.map(item => updates.get(item.id) ?? item);
      setItems([...cache.current.items]);
      batchPending.current.delete(key);
      const rejected = body.items.filter(item => item.status === "rejected");
      if (rejected.length) setErrors(errors => ({ ...errors, ...Object.fromEntries(rejected.map(item => [item.id, item.message ?? t("apr.submitFailed")])) }));
    } catch (error) {
      if (owner.current === generation) setErrors(errors => ({ ...errors, ...Object.fromEntries(unique.map(id => [id, error instanceof Error ? error.message : t("apr.submitFailed")])) }));
    } finally {
      if (owner.current === generation) { unique.forEach(id => inFlight.current.delete(id)); setBusy(new Set(inFlight.current)); await refreshRef.current(); }
    }
  }, [t]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { items, loading, ready, error, errors, busy, decide, decideBatch, refresh };
}

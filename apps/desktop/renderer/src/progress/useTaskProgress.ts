import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SseEventEnvelope, TaskProgressEvent, TaskProgressSnapshot } from "@roleweave/shared";

export interface UseTaskProgressResult {
  snapshots: TaskProgressSnapshot[];
  loading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
  selected: TaskProgressSnapshot | null;
  select: (taskId: string | null) => void;
}

export function applyProgressEvent(current: TaskProgressSnapshot[], event: TaskProgressEvent): TaskProgressSnapshot[] {
  const existing = current.find((item) => item.taskId === event.taskId);
  if (!existing) return current;
  const steps = existing.steps.map((step, index) => {
    if (index !== event.stepIndex) return step;
    if (step.status === "failed" && event.stepStatus !== "failed") return step;
    return {
      ...step,
      status: event.stepStatus,
      ...(event.message !== undefined ? { message: event.message } : {}),
      ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
      ...(event.finishedAt !== undefined ? { finishedAt: event.finishedAt } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    };
  });
  const failed = existing.overallStatus === "failed" || event.stepStatus === "failed" || steps.some((step) => step.status === "failed");
  const next: TaskProgressSnapshot = {
    ...existing,
    steps,
    progress: event.progress,
    currentStep: event.stepIndex,
    updatedAt: event.timestamp,
    overallStatus: failed ? "failed" : event.progress >= 100 ? "success" : "running",
  };
  return [next, ...current.filter((item) => item.taskId !== event.taskId)];
}

export function useTaskProgress(workspaceOpen: boolean): UseTaskProgressResult {
  const [snapshots, setSnapshots] = useState<TaskProgressSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const seqRef = useRef(0);
  const readVersion = useRef(0);
  const alive = useRef(true);
  const knownIds = useRef(new Set<string>());

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; readVersion.current += 1; };
  }, []);

  const reload = useCallback(async () => {
    const version = ++readVersion.current;
    if (!workspaceOpen) {
      setSnapshots([]);
      knownIds.current.clear();
      setSelectedId(null);
      setLoading(false);
      setError(false);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      if (!window.owb.turnProgress) throw new Error("progress_unavailable");
      const response = await window.owb.turnProgress();
      if (!alive.current || version !== readVersion.current) return;
      if (response.status === 200 && response.body && Array.isArray(response.body.snapshots)) {
        knownIds.current = new Set(response.body.snapshots.map((item) => item.taskId));
        setSnapshots(response.body.snapshots);
      } else setError(true);
    } catch {
      if (alive.current && version === readVersion.current) setError(true);
    } finally {
      if (alive.current && version === readVersion.current) setLoading(false);
    }
  }, [workspaceOpen]);

  useEffect(() => {
    void reload();
    return () => { readVersion.current += 1; };
  }, [reload]);

  useEffect(() => {
    if (!workspaceOpen || !window.owb.onEvent) return undefined;
    return window.owb.onEvent((raw) => {
      const envelope = raw as SseEventEnvelope;
      if (typeof envelope.seq === "number") {
        if (envelope.seq <= seqRef.current) return;
        if (seqRef.current > 0 && envelope.seq > seqRef.current + 1) void reload();
        seqRef.current = envelope.seq;
      }
      if (envelope.type !== "turn.progress") return;
      const payload = envelope.payload as TaskProgressEvent;
      if (!payload || typeof payload.taskId !== "string") return;
      if (!knownIds.current.has(payload.taskId)) void reload();
      else setSnapshots((current) => applyProgressEvent(current, payload));
    });
  }, [reload, workspaceOpen]);

  const selected = useMemo(
    () => snapshots.find((item) => item.taskId === selectedId) ?? null,
    [snapshots, selectedId],
  );

  return { snapshots, loading, error, refresh: reload, selected, select: setSelectedId };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SseEventEnvelope, TaskProgressEvent, TaskProgressSnapshot } from "@roleweave/shared";

export interface UseTaskProgressResult {
  snapshots: TaskProgressSnapshot[];
  loading: boolean;
  selected: TaskProgressSnapshot | null;
  select: (taskId: string | null) => void;
}

function applyEvent(current: TaskProgressSnapshot[], event: TaskProgressEvent, workspacePath?: string): TaskProgressSnapshot[] {
  if (workspacePath && event.positionId && current[0] && current.every((item) => item.workspacePath !== workspacePath) && current.length === 0) {
    // keep going — empty list is fine
  }
  const existing = current.find((item) => item.taskId === event.taskId);
  if (!existing) return current;
  const steps = existing.steps.map((step, index) => {
    if (index !== event.stepIndex) return step;
    return {
      ...step,
      status: event.stepStatus,
      ...(event.message !== undefined ? { message: event.message } : {}),
      ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
      ...(event.finishedAt !== undefined ? { finishedAt: event.finishedAt } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    };
  });
  const next: TaskProgressSnapshot = {
    ...existing,
    steps,
    progress: event.progress,
    currentStep: event.stepIndex,
    updatedAt: event.timestamp,
    overallStatus: event.stepStatus === "failed" ? "failed" : event.progress >= 100 ? "success" : existing.overallStatus === "stuck" ? "stuck" : "running",
  };
  return [next, ...current.filter((item) => item.taskId !== event.taskId)];
}

export function useTaskProgress(workspaceOpen: boolean): UseTaskProgressResult {
  const [snapshots, setSnapshots] = useState<TaskProgressSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const seqRef = useRef(0);

  const reload = useCallback(async () => {
    if (!workspaceOpen || !window.owb.turnProgress) {
      setSnapshots([]);
      return;
    }
    setLoading(true);
    try {
      const response = await window.owb.turnProgress();
      if (response.status === 200 && response.body && Array.isArray(response.body.snapshots)) {
        setSnapshots(response.body.snapshots);
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceOpen]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!window.owb.onEvent) return undefined;
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
      setSnapshots((current) => {
        if (!current.some((item) => item.taskId === payload.taskId)) {
          void reload();
          return current;
        }
        return applyEvent(current, payload);
      });
    });
  }, [reload]);

  const selected = useMemo(
    () => snapshots.find((item) => item.taskId === selectedId) ?? null,
    [snapshots, selectedId],
  );

  return { snapshots, loading, selected, select: setSelectedId };
}

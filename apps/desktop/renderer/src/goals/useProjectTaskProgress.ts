import { useEffect, useRef, useState } from "react";
import type { GoalTaskExecution } from "@roleweave/shared/goals";
import type { SseEventEnvelope, TaskProgressEvent, TaskProgressSnapshot } from "@roleweave/shared";
import { applyProgressEvent } from "../progress/useTaskProgress";

/** One subscription and clock for all cards, schedule rows, and the editor. */
export function useProjectTaskProgress(
  executions: Record<string, GoalTaskExecution>,
  scopeKey: string,
  workspaceKey?: string,
) {
  const latest = useRef(executions);
  latest.current = executions;
  const [live, setLive] = useState<{ scope: string; snapshots: TaskProgressSnapshot[] }>({ scope: scopeKey, snapshots: [] });
  const [now, setNow] = useState(Date.now);
  const running = Object.values(executions).some((run) => run.status === "running");

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, scopeKey]);

  useEffect(() => {
    let active = true;
    const off = window.owb.onEvent?.((raw) => {
      if (!active) return;
      const envelope = raw as SseEventEnvelope;
      if (envelope.type !== "turn.progress") return;
      const event = envelope.payload as TaskProgressEvent;
      const run = Object.values(latest.current).find((entry) => entry.turnId === event?.taskId && entry.positionId === event.positionId);
      const initial = run?.progress;
      if (!initial) return;
      setLive((current) => {
        const snapshots = current.scope === scopeKey ? current.snapshots : [];
        const prior = snapshots.find((entry) => entry.taskId === event.taskId);
        const seed = prior && prior.updatedAt >= initial.updatedAt ? prior : initial;
        if ((workspaceKey && seed.workspacePath !== workspaceKey) || event.timestamp < seed.updatedAt) return current;
        const next = applyProgressEvent([seed], event)[0]!;
        return { scope: scopeKey, snapshots: [next, ...snapshots.filter((entry) => entry.taskId !== next.taskId)] };
      });
    });
    return () => { active = false; off?.(); };
  }, [scopeKey, workspaceKey]);

  const snapshots = new Map(live.scope === scopeKey ? live.snapshots.map((snapshot) => [snapshot.taskId, snapshot]) : []);
  return {
    now,
    snapshotFor(run?: GoalTaskExecution) {
      if (!run) return undefined;
      const event = snapshots.get(run.turnId);
      const seed = run.progress;
      const snapshot = event && (!seed || event.updatedAt >= seed.updatedAt) ? event : seed;
      return snapshot?.positionId === run.positionId && (!workspaceKey || snapshot.workspacePath === workspaceKey) ? snapshot : undefined;
    },
  };
}

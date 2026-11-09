import type { GoalWorkItem, GoalWorkItemStatus } from "./goals.js";
import type { TurnRecordStatus } from "./turns.js";

export const MAX_TASK_PARTICIPANTS = 8;
export const MAX_TASK_DEPENDENCIES = 8;
export interface TaskParticipant {
  positionId: string;
  role: "contributor" | "reviewer";
  responsibility: string;
}
export interface TaskPeerReference { taskId: string; title: string; assigneePositionId?: string }
export interface TaskDependencyContext extends TaskPeerReference {
  status: GoalWorkItemStatus;
  readiness: "accepted" | "manual_done" | "pending" | "unavailable";
  executionStatus?: TurnRecordStatus;
  delivery?: {
    positionId: string; turnId: string; sessionId: string; outputDigest: string; completedAt: string;
    outputExcerpt: string; excerptDigest: string; truncated: boolean; redacted: boolean;
  };
  acceptanceId?: string;
  acceptedAt?: string;
}
export interface TaskCollaborationContext {
  schemaVersion: "task-collaboration.v1";
  goalId: string;
  taskId: string;
  capturedAt: string;
  participants: TaskParticipant[];
  dependencies: TaskDependencyContext[];
  dependents: TaskPeerReference[];
  omittedDependentCount: number;
  redacted: boolean;
}

const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (x: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(x, k)) && Object.keys(x).every(k => required.includes(k) || optional.includes(k));
const taskId = (x: unknown): x is string => typeof x === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(x);
const positionId = (x: unknown): x is string => typeof x === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x) && x.length <= 64;
const text = (x: unknown, max = 4096): x is string => typeof x === "string" && x.length <= max;
const hash = (x: unknown) => typeof x === "string" && /^sha256:[a-f0-9]{64}$/.test(x);

export function taskParticipantError(value: unknown, assignee?: string): string | null {
  if (!Array.isArray(value) || value.length > MAX_TASK_PARTICIPANTS) return "participants must be a list of at most 8 employees";
  const seen = new Set<string>();
  for (const p of value) {
    if (!record(p) || !exact(p, ["positionId", "role", "responsibility"]) || !positionId(p.positionId) ||
        !["contributor", "reviewer"].includes(String(p.role)) || !text(p.responsibility, 1024) || !p.responsibility.trim() ||
        p.positionId === assignee || seen.has(p.positionId)) return "each collaborator needs a unique employee, explicit role and responsibility (up to 1024 characters), distinct from the assignee";
    seen.add(p.positionId);
  }
  return null;
}

/** Validate the complete submitted plan, so removal and cycles fail atomically. */
export function taskDependencyGraphError(items: readonly GoalWorkItem[]): string | null {
  const tasks = new Map(items.map(item => [item.taskId, item]));
  for (const item of items) {
    if (item.dependsOn !== undefined && (!Array.isArray(item.dependsOn) || item.dependsOn.length > MAX_TASK_DEPENDENCIES ||
        new Set(item.dependsOn).size !== item.dependsOn.length || item.dependsOn.some(id => !taskId(id) || id === item.taskId || !tasks.has(id)))) {
      return "dependencies must be at most 8 unique, existing tasks in this project; self references are not allowed";
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const cycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if (tasks.get(id)?.dependsOn?.some(cycle)) return true;
    visiting.delete(id); visited.add(id);
    return false;
  };
  return items.some(item => cycle(item.taskId)) ? "task dependencies must not contain a cycle" : null;
}

export function taskDependenciesReady(context: TaskCollaborationContext): boolean {
  return context.dependencies.every(d => d.readiness === "accepted" || d.readiness === "manual_done");
}

/** Snapshot-reader validation; dates are supplied by the server's strict RFC3339 parser. */
export function isTaskCollaborationContext(value: unknown, validTime: (value: unknown) => boolean, assignee?: string): value is TaskCollaborationContext {
  if (!record(value) || !exact(value, ["schemaVersion", "goalId", "taskId", "capturedAt", "participants", "dependencies", "dependents", "omittedDependentCount", "redacted"]) ||
      value.schemaVersion !== "task-collaboration.v1" || !taskId(value.goalId) || !taskId(value.taskId) || !validTime(value.capturedAt) ||
      !Array.isArray(value.participants) || value.participants.length > MAX_TASK_PARTICIPANTS ||
      !Array.isArray(value.dependencies) || value.dependencies.length > MAX_TASK_DEPENDENCIES ||
      !Array.isArray(value.dependents) || value.dependents.length > 8 ||
      !Number.isSafeInteger(value.omittedDependentCount) || (value.omittedDependentCount as number) < 0 || (value.omittedDependentCount as number) > 63 || typeof value.redacted !== "boolean") return false;
  const participants = new Set<string>();
  for (const p of value.participants) {
    if (!record(p) || !exact(p, ["positionId", "role", "responsibility"]) || !positionId(p.positionId) ||
        p.positionId === assignee || participants.has(p.positionId) || !["contributor", "reviewer"].includes(String(p.role)) || !text(p.responsibility) || !p.responsibility.trim()) return false;
    participants.add(p.positionId);
  }
  const peers = new Set<string>();
  const peer = (p: Record<string, unknown>) => taskId(p.taskId) && p.taskId !== value.taskId && !peers.has(p.taskId) &&
    text(p.title) && !!p.title.trim() && (p.assigneePositionId === undefined || positionId(p.assigneePositionId));
  for (const p of value.dependencies) {
    if (!record(p) || !exact(p, ["taskId", "title", "status", "readiness"], ["assigneePositionId", "executionStatus", "delivery", "acceptanceId", "acceptedAt"]) || !peer(p) ||
        !["todo", "in_progress", "blocked", "review", "done"].includes(String(p.status)) ||
        !["accepted", "manual_done", "pending", "unavailable"].includes(String(p.readiness)) ||
        (p.executionStatus !== undefined && !["running", "completed", "failed", "indeterminate"].includes(String(p.executionStatus)))) return false;
    peers.add(p.taskId as string);
    if (p.delivery !== undefined) {
      const d = p.delivery;
      if (!record(d) || !exact(d, ["positionId", "turnId", "sessionId", "outputDigest", "completedAt", "outputExcerpt", "excerptDigest", "truncated", "redacted"]) ||
          !positionId(d.positionId) || d.positionId !== p.assigneePositionId || !taskId(d.turnId) || !taskId(d.sessionId) || !hash(d.outputDigest) || !validTime(d.completedAt) ||
          !text(d.outputExcerpt) || new TextEncoder().encode(d.outputExcerpt).length > 2048 || !hash(d.excerptDigest) ||
          typeof d.truncated !== "boolean" || typeof d.redacted !== "boolean" || (d.redacted && !value.redacted)) return false;
    }
    if (p.readiness === "accepted") {
      if (p.status !== "done" || p.executionStatus !== "completed" || !p.delivery || !taskId(p.acceptanceId) || !validTime(p.acceptedAt)) return false;
    } else if (p.acceptanceId !== undefined || p.acceptedAt !== undefined ||
        (p.readiness === "manual_done" && (p.status !== "done" || p.delivery !== undefined || p.executionStatus !== undefined))) return false;
  }
  for (const p of value.dependents) {
    if (!record(p) || !exact(p, ["taskId", "title"], ["assigneePositionId"]) || !peer(p)) return false;
    peers.add(p.taskId as string);
  }
  return true;
}

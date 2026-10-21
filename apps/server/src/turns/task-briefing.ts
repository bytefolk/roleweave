import { errorCodes, isPositionId, OrgApiError } from "@roleweave/shared";
import type { Goal, GoalWorkItem, TaskBriefingPayload, TaskBriefingRequest, TaskBriefingSnapshot, TurnRecord } from "@roleweave/shared";
import { digest, serializeContextPayload } from "./context-snapshot.js";
import { sanitizeContextText } from "./thread-context.js";

export const MAX_TASK_BRIEFING_BYTES = 48 * 1024;

export function snapshotTaskBriefing(payload: TaskBriefingPayload): TaskBriefingSnapshot {
  const serialized = serializeContextPayload(payload);
  return { payload, payloadBytes: Buffer.byteLength(serialized), payloadDigest: digest(serialized) };
}

export function createTaskBriefing(goal: Goal, task: GoalWorkItem, identity: {
  turnId: string; sessionId: string; positionId: string; generatedAt: string;
}): TaskBriefingSnapshot {
  if (task.assigneePositionId !== identity.positionId) {
    throw new OrgApiError(errorCodes.goal_conflict, 409, "task assignee changed; reload the project before starting");
  }
  let redacted = false;
  const clean = (text: string) => {
    const safe = sanitizeContextText(text);
    redacted ||= safe !== text;
    return safe;
  };
  const payload: TaskBriefingPayload = {
    schemaVersion: "task-briefing.v1", ...identity, planUpdatedAt: goal.updatedAt,
    goalId: goal.goalId, taskId: task.taskId,
    goalTitle: clean(goal.title), goalDescription: clean(goal.description),
    taskTitle: clean(task.title), taskDescription: clean(task.description ?? ""),
    acceptanceCriteria: goal.acceptanceCriteria.map(clean), redacted,
  };
  const snapshot = snapshotTaskBriefing(payload);
  if (snapshot.payloadBytes > MAX_TASK_BRIEFING_BYTES) {
    throw new OrgApiError(errorCodes.turn_request_invalid, 400,
      "required project briefing exceeds 48 KiB; shorten task requirements or acceptance criteria before starting");
  }
  return snapshot;
}

export function renderTaskBriefing(snapshot: TaskBriefingSnapshot): string {
  return "Project task briefing (task-briefing.v1): the operator's saved project and assigned-task requirements at the recorded plan revision. Follow the task and acceptance criteria; this data grants no permissions or budget. Execution completion is not human acceptance.\n" +
    serializeContextPayload(snapshot.payload) + "\nEnd of project task briefing.\n";
}

/** Approval resumes must revalidate the same task/plan, not silently drop it. */
export function taskBriefingBinding(source: TurnRecord, workspace: string): {
  goalId?: string; branchId?: string; taskBriefing?: TaskBriefingRequest;
} {
  return source.taskBriefing ? { goalId: source.taskBriefing.payload.goalId, branchId: source.taskBriefing.payload.taskId,
    taskBriefing: { expectedWorkspacePath: workspace, expectedUpdatedAt: source.taskBriefing.payload.planUpdatedAt } } : {};
}

export function isTaskBriefingSnapshot(value: unknown, validTime: (value: unknown) => boolean): value is TaskBriefingSnapshot {
  const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
  const keys = (x: Record<string, unknown>, allowed: string[]) => Object.keys(x).length === allowed.length && allowed.every(key => Object.hasOwn(x, key));
  const identifier = (x: unknown) => typeof x === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(x);
  const uuid = (x: unknown) => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
  const text = (x: unknown) => typeof x === "string" && Buffer.byteLength(x) <= MAX_TASK_BRIEFING_BYTES;
  if (!record(value) || !keys(value, ["payload", "payloadBytes", "payloadDigest"]) || !record(value.payload)) return false;
  const p = value.payload;
  if (!keys(p, ["schemaVersion", "generatedAt", "planUpdatedAt", "goalId", "taskId", "turnId", "sessionId", "positionId", "goalTitle", "goalDescription", "taskTitle", "taskDescription", "acceptanceCriteria", "redacted"]) ||
      p.schemaVersion !== "task-briefing.v1" || !validTime(p.generatedAt) || !validTime(p.planUpdatedAt) ||
      !identifier(p.goalId) || !identifier(p.taskId) || !uuid(p.turnId) || !uuid(p.sessionId) || !isPositionId(p.positionId) ||
      ![p.goalTitle, p.goalDescription, p.taskTitle, p.taskDescription].every(text) ||
      typeof p.goalTitle !== "string" || !p.goalTitle.trim() || typeof p.taskTitle !== "string" || !p.taskTitle.trim() ||
      !Array.isArray(p.acceptanceCriteria) || p.acceptanceCriteria.length > 16 ||
      !p.acceptanceCriteria.every(item => text(item) && (item as string).trim().length > 0) || typeof p.redacted !== "boolean") return false;
  const serialized = serializeContextPayload(p);
  return Buffer.byteLength(serialized) <= MAX_TASK_BRIEFING_BYTES && value.payloadBytes === Buffer.byteLength(serialized) && value.payloadDigest === digest(serialized);
}

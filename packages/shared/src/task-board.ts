import type { OrganizationFile } from "./org-tree.js";

export const TASK_BOARD_SCHEMA_VERSION = "task-board.v1" as const;
export const taskStatuses = ["queued", "active", "waiting", "done", "declined", "failed"] as const;
export type TaskStatus = (typeof taskStatuses)[number];
export type TaskKind = "direct" | "collaboration" | "contractor";

export interface AgentTask {
  schemaVersion: typeof TASK_BOARD_SCHEMA_VERSION;
  taskId: string;
  title: string;
  description: string;
  assigneePositionId: string;
  requestedByPositionId: string;
  budgetOwnerPositionId: string;
  kind: TaskKind;
  mainline: boolean;
  priority: "normal" | "urgent";
  status: TaskStatus;
  /** Set when a collaboration is accepted, including while its work is waiting. */
  acceptedAt?: string;
  queueOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCreateRequest {
  targetPositionId: string;
  title: string;
  description?: string;
  urgent?: boolean;
  contractor?: boolean;
}

export interface TaskDecisionRequest { decision: "accept" | "decline"; }
export const taskStatusUpdates = ["active", "waiting", "done", "failed"] as const;
export interface TaskStatusRequest { status: (typeof taskStatusUpdates)[number]; }

const allowedTaskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["active", "waiting", "done", "failed"],
  active: ["waiting", "done", "failed"],
  waiting: ["active", "done", "failed"],
  done: [],
  declined: [],
  failed: [],
};

export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  return allowedTaskTransitions[from]?.includes(to) ?? false;
}

export function isPendingTaskCollaboration(task: AgentTask): boolean {
  return task.kind === "collaboration" && task.status === "waiting" && !task.acceptedAt;
}

export function classifyTaskAuthority(org: OrganizationFile, request: TaskCreateRequest & { actorPositionId: string }): Pick<AgentTask, "kind" | "status" | "priority" | "mainline" | "budgetOwnerPositionId"> {
  const actor = org.roles.find((role) => role.id === request.actorPositionId);
  const target = org.roles.find((role) => role.id === request.targetPositionId);
  if (!actor || !target) throw new Error("actor and target must be organization positions");
  const ownerOverride = actor.id === org.owner;
  const direct = target.reportTo === actor.id;
  if (request.urgent && !ownerOverride) throw new Error("only the owner may insert urgent work");
  if (request.contractor) return { kind: "contractor", status: "queued", priority: request.urgent ? "urgent" : "normal", mainline: false, budgetOwnerPositionId: actor.id };
  return {
    kind: direct || ownerOverride ? "direct" : "collaboration",
    status: direct || ownerOverride ? "queued" : "waiting",
    priority: request.urgent ? "urgent" : "normal",
    mainline: true,
    budgetOwnerPositionId: actor.id,
  };
}

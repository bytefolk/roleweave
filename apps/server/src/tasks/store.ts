import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  canTransitionTaskStatus, classifyTaskAuthority, errorCodes, isPendingTaskCollaboration,
  OrgApiError, taskStatuses, taskStatusUpdates, type AgentTask, type OrganizationFile,
  type TaskCreateRequest, type TaskStatusRequest,
} from "@roleweave/shared";
import { atomicWriteJson, nodeAtomicTurnWriteOperations } from "../turns/store.js";
import { PerKeyLock } from "../per-key-lock.js";
import { decodeStableUtf8, readStableBoundedFile } from "../stable-read.js";

const ROOT = [".roleweave", "tasks"] as const;
const MAX_TASKS = 512;
const MAX_RECORD_BYTES = 32 * 1024;
const safe = /^[a-zA-Z0-9_-]{1,128}$/;

function taskError(message: string): Error { return new OrgApiError(errorCodes.body_invalid, 400, message); }
function storageError(message: string): Error { return new OrgApiError(errorCodes.internal, 500, message); }
function root(workspace: string) { return path.join(workspace, ...ROOT); }
function file(workspace: string, id: string) { if (typeof id !== "string" || !safe.test(id)) throw taskError("unsafe task id"); return path.join(root(workspace), `${id}.json`); }
function text(value: unknown, field: string, max: number) { if (typeof value !== "string" || !value.trim() || value.length > max) throw taskError(`${field} is invalid`); return value.trim(); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function requestObject(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw taskError("task request must be an object"); return value; }
function optionalBoolean(value: unknown, field: string): boolean | undefined { if (value !== undefined && typeof value !== "boolean") throw taskError(`${field} must be a boolean`); return value; }

export function validateTaskRecord(value: unknown, id: string): AgentTask {
  if (!isRecord(value) || value.schemaVersion !== "task-board.v1" || value.taskId !== id ||
      typeof value.taskId !== "string" || !safe.test(value.taskId) ||
      typeof value.status !== "string" || !(taskStatuses as readonly string[]).includes(value.status) ||
      !["direct", "collaboration", "contractor"].includes(value.kind as string) ||
      typeof value.mainline !== "boolean" || !["normal", "urgent"].includes(value.priority as string) ||
      !Number.isSafeInteger(value.queueOrder) || typeof value.title !== "string" || !value.title.trim() || value.title.length > 256 ||
      typeof value.description !== "string" || value.description.length > 4096 ||
      [value.assigneePositionId, value.requestedByPositionId, value.budgetOwnerPositionId].some((id) => typeof id !== "string" || !id.trim() || id.length > 128) ||
      [value.createdAt, value.updatedAt].some((date) => typeof date !== "string" || !Number.isFinite(Date.parse(date))) ||
      (value.acceptedAt !== undefined && (value.kind !== "collaboration" || value.status === "declined" || typeof value.acceptedAt !== "string" || !Number.isFinite(Date.parse(value.acceptedAt))))) {
    throw storageError("invalid task record");
  }
  return value as unknown as AgentTask;
}

export class TaskBoardStore {
  private readonly mutationLocks = new PerKeyLock();

  async list(workspace: string, positionId?: string): Promise<AgentTask[]> {
    await fs.mkdir(root(workspace), { recursive: true, mode: 0o700 });
    const entries = (await fs.readdir(root(workspace), { withFileTypes: true })).filter((e) => e.isFile() && !e.isSymbolicLink() && e.name.endsWith(".json"));
    if (entries.length > MAX_TASKS) throw storageError("task board exceeds its bound");
    const tasks: AgentTask[] = [];
    for (const entry of entries) {
      const parsed = await this.get(workspace, entry.name.slice(0, -5));
      if (!positionId || parsed.assigneePositionId === positionId) tasks.push(parsed);
    }
    return tasks.sort((a, b) => a.queueOrder - b.queueOrder || a.createdAt.localeCompare(b.createdAt));
  }

  async create(workspace: string, org: OrganizationFile, actorPositionId: string, raw: unknown): Promise<AgentTask> {
    const body = requestObject(raw);
    if (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 4096)) throw taskError("description is invalid");
    const request: TaskCreateRequest & { actorPositionId: string } = {
      actorPositionId: text(actorPositionId, "actorPositionId", 128),
      targetPositionId: text(body.targetPositionId, "targetPositionId", 128),
      title: text(body.title, "title", 256),
      description: body.description as string | undefined,
      urgent: optionalBoolean(body.urgent, "urgent"),
      contractor: optionalBoolean(body.contractor, "contractor"),
    };
    let authority: ReturnType<typeof classifyTaskAuthority>;
    try { authority = classifyTaskAuthority(org, request); }
    catch (error) { throw taskError(error instanceof Error ? error.message : "invalid task authority"); }
    const tasks = await this.list(workspace, request.targetPositionId);
    const now = new Date().toISOString();
    const task: AgentTask = { schemaVersion: "task-board.v1", taskId: crypto.randomUUID(), title: request.title, description: request.description ?? "", assigneePositionId: request.targetPositionId, requestedByPositionId: request.actorPositionId, ...authority, queueOrder: request.urgent ? ((tasks[0]?.queueOrder ?? 0) - 1) : ((tasks.at(-1)?.queueOrder ?? -1) + 1), createdAt: now, updatedAt: now };
    return this.save(workspace, task);
  }

  async decide(workspace: string, id: string, org: OrganizationFile, actorPositionId: string, raw: unknown): Promise<AgentTask> {
    const body = requestObject(raw);
    if (body.decision !== "accept" && body.decision !== "decline") throw taskError("decision must be accept or decline");
    return this.mutationLocks.run(path.resolve(file(workspace, id)), async () => {
      const task = await this.get(workspace, id);
      if (!isPendingTaskCollaboration(task) ||
          (actorPositionId !== task.assigneePositionId && actorPositionId !== org.owner) ||
          !org.roles.some((r) => r.id === actorPositionId)) {
        throw taskError("only the receiving Agent or owner may decide a pending collaboration");
      }
      const now = new Date().toISOString();
      return this.save(workspace, { ...task, status: body.decision === "accept" ? "queued" : "declined", ...(body.decision === "accept" ? { acceptedAt: now } : {}), updatedAt: now });
    });
  }

  async transition(workspace: string, id: string, org: OrganizationFile, actorPositionId: string, raw: unknown): Promise<AgentTask> {
    const body = requestObject(raw);
    if (typeof body.status !== "string" || !(taskStatusUpdates as readonly string[]).includes(body.status)) throw taskError("status must be active, waiting, done, or failed");
    const status = body.status as TaskStatusRequest["status"];
    return this.mutationLocks.run(path.resolve(file(workspace, id)), async () => {
      const task = await this.get(workspace, id);
      if ((actorPositionId !== task.assigneePositionId && actorPositionId !== org.owner) || !org.roles.some((r) => r.id === actorPositionId)) throw taskError("only the assignee or owner may update a task");
      if (isPendingTaskCollaboration(task)) throw taskError("pending collaborations require an accept or decline decision");
      if (!canTransitionTaskStatus(task.status, status)) throw taskError(`cannot transition task from ${task.status} to ${status}`);
      const now = new Date().toISOString();
      // Older queued/active collaborations have already been accepted. Preserve that
      // fact before they enter waiting; old unmarked waiting records stay pending.
      const acceptedAt = task.kind === "collaboration" ? task.acceptedAt ?? task.updatedAt : undefined;
      return this.save(workspace, { ...task, status, ...(acceptedAt ? { acceptedAt } : {}), updatedAt: now });
    });
  }

  private async get(workspace: string, id: string): Promise<AgentTask> {
    const taskFile = file(workspace, id);
    let record: unknown;
    try {
      const stable = await readStableBoundedFile(taskFile, MAX_RECORD_BYTES);
      record = JSON.parse(decodeStableUtf8(stable.buffer));
    } catch {
      throw storageError("invalid task record");
    }
    return validateTaskRecord(record, id);
  }
  private async save(workspace: string, task: AgentTask): Promise<AgentTask> { await atomicWriteJson(file(workspace, task.taskId), task, MAX_RECORD_BYTES, nodeAtomicTurnWriteOperations, storageError); return task; }
}

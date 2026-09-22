import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { classifyTaskAuthority, type AgentTask, type OrganizationFile, type TaskCreateRequest, type TaskDecisionRequest, type TaskStatusRequest } from "@roleweave/shared";
import { atomicWriteJson, nodeAtomicTurnWriteOperations } from "../turns/store.js";

const ROOT = [".roleweave", "tasks"] as const;
const MAX_TASKS = 512;
const MAX_RECORD_BYTES = 32 * 1024;
const safe = /^[a-zA-Z0-9_-]{1,128}$/;

function taskError(message: string): Error { return new Error(message); }
function root(workspace: string) { return path.join(workspace, ...ROOT); }
function file(workspace: string, id: string) { if (!safe.test(id)) throw taskError("unsafe task id"); return path.join(root(workspace), `${id}.json`); }
function text(value: unknown, field: string, max: number) { if (typeof value !== "string" || !value.trim() || value.length > max) throw taskError(`${field} is invalid`); return value.trim(); }

export class TaskBoardStore {
  async list(workspace: string, positionId?: string): Promise<AgentTask[]> {
    await fs.mkdir(root(workspace), { recursive: true, mode: 0o700 });
    const entries = (await fs.readdir(root(workspace), { withFileTypes: true })).filter((e) => e.isFile() && !e.isSymbolicLink() && e.name.endsWith(".json"));
    if (entries.length > MAX_TASKS) throw taskError("task board exceeds its bound");
    const tasks: AgentTask[] = [];
    for (const entry of entries) {
      const parsed = JSON.parse(await fs.readFile(path.join(root(workspace), entry.name), "utf8")) as AgentTask;
      if (parsed.schemaVersion !== "task-board.v1" || !safe.test(parsed.taskId)) throw taskError("invalid task record");
      if (!positionId || parsed.assigneePositionId === positionId) tasks.push(parsed);
    }
    return tasks.sort((a, b) => a.queueOrder - b.queueOrder || a.createdAt.localeCompare(b.createdAt));
  }

  async create(workspace: string, org: OrganizationFile, actorPositionId: string, raw: TaskCreateRequest): Promise<AgentTask> {
    const request = { ...raw, actorPositionId: text(actorPositionId, "actorPositionId", 128), targetPositionId: text(raw.targetPositionId, "targetPositionId", 128), title: text(raw.title, "title", 256), description: typeof raw.description === "string" ? raw.description.slice(0, 4096) : "" };
    const authority = classifyTaskAuthority(org, request);
    const tasks = await this.list(workspace, request.targetPositionId);
    const now = new Date().toISOString();
    const task: AgentTask = { schemaVersion: "task-board.v1", taskId: crypto.randomUUID(), title: request.title, description: request.description, assigneePositionId: request.targetPositionId, requestedByPositionId: request.actorPositionId, ...authority, queueOrder: request.urgent ? ((tasks[0]?.queueOrder ?? 0) - 1) : ((tasks.at(-1)?.queueOrder ?? -1) + 1), createdAt: now, updatedAt: now };
    await atomicWriteJson(file(workspace, task.taskId), task, MAX_RECORD_BYTES, nodeAtomicTurnWriteOperations, taskError);
    return task;
  }

  async decide(workspace: string, id: string, org: OrganizationFile, actorPositionId: string, raw: TaskDecisionRequest): Promise<AgentTask> {
    const task = await this.get(workspace, id);
    if (task.kind !== "collaboration" || task.status !== "waiting" || actorPositionId !== task.assigneePositionId || !org.roles.some((r) => r.id === actorPositionId)) throw taskError("only the receiving Agent may decide a pending collaboration");
    return this.save(workspace, { ...task, status: raw.decision === "accept" ? "queued" : "declined", updatedAt: new Date().toISOString() });
  }

  async transition(workspace: string, id: string, org: OrganizationFile, actorPositionId: string, raw: TaskStatusRequest): Promise<AgentTask> {
    const task = await this.get(workspace, id);
    if (actorPositionId !== task.assigneePositionId && actorPositionId !== org.owner) throw taskError("only the assignee or owner may update a task");
    return this.save(workspace, { ...task, status: raw.status, updatedAt: new Date().toISOString() });
  }

  private async get(workspace: string, id: string): Promise<AgentTask> { return JSON.parse(await fs.readFile(file(workspace, id), "utf8")) as AgentTask; }
  private async save(workspace: string, task: AgentTask): Promise<AgentTask> { await atomicWriteJson(file(workspace, task.taskId), task, MAX_RECORD_BYTES, nodeAtomicTurnWriteOperations, taskError); return task; }
}

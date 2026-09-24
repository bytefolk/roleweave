import fs from "node:fs/promises";
import path from "node:path";
import {
  STALE_PROGRESS_MS,
  TURN_PROGRESS_SCHEMA_VERSION,
  WORKBENCH_PROGRESS_STEPS,
  type TaskProgressEvent,
  type TaskProgressSnapshot,
  type TurnProgressStepStatus,
  type TurnProgressStepView,
} from "@roleweave/shared";
import type { EventBus } from "../bus.js";

const MAX_SAFE_MESSAGE = 240;
const MAX_FINISHED = 128;

function safeMessage(raw?: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(/\s+/g, " ").trim().slice(0, MAX_SAFE_MESSAGE);
  if (!text) return undefined;
  if (text.includes("model.delta") || text.includes("chain-of-thought") || text.includes("ndjson")) return undefined;
  return text;
}

function percent(steps: readonly TurnProgressStepView[]): number {
  if (steps.length === 0) return 0;
  const done = steps.filter((step) => step.status === "success" || step.status === "skipped").length;
  return Math.min(100, Math.round((done / steps.length) * 100));
}

function currentStepIndex(steps: readonly TurnProgressStepView[]): number {
  const running = steps.findIndex((step) => step.status === "running");
  if (running >= 0) return running;
  const lastDone = [...steps].map((step, index) => ({ step, index })).reverse().find((item) => item.step.status === "success" || item.step.status === "failed");
  return lastDone?.index ?? 0;
}

function overall(steps: readonly TurnProgressStepView[], updatedAt: number, now: number): TaskProgressSnapshot["overallStatus"] {
  if (steps.some((step) => step.status === "failed")) return "failed";
  if (steps.every((step) => step.status === "success" || step.status === "skipped")) return "success";
  if (now - updatedAt >= STALE_PROGRESS_MS) return "stuck";
  return "running";
}

function snapshotPath(workspace: string, positionId: string, turnId: string): string {
  return path.join(workspace, ".roleweave", "conversations", positionId, "progress", `${turnId}.json`);
}

/**
 * In-process progress center. Shares EventBus fate (single control-plane
 * process). Snapshots are also written next to turn records so history
 * survives restart. No Redis.
 */
export class ProgressTracker {
  private readonly snapshots = new Map<string, TaskProgressSnapshot>();
  private readonly finishedOrder: string[] = [];

  constructor(
    private readonly bus: EventBus,
    private readonly now: () => number = () => Date.now(),
  ) {}

  begin(input: {
    workspacePath: string;
    taskId: string;
    positionId: string;
    employeeName?: string;
    taskTitle?: string;
    retryOf?: string;
    retryCount?: number;
  }): TaskProgressSnapshot {
    const timestamp = this.now();
    const steps: TurnProgressStepView[] = WORKBENCH_PROGRESS_STEPS.map((step, index) => ({
      id: step.id,
      name: step.name,
      status: index === 0 ? "running" : "pending",
      ...(index === 0 ? { startedAt: timestamp } : {}),
    }));
    const snapshot: TaskProgressSnapshot = {
      schemaVersion: TURN_PROGRESS_SCHEMA_VERSION,
      taskId: input.taskId,
      employeeId: input.positionId,
      positionId: input.positionId,
      ...(input.employeeName !== undefined ? { employeeName: input.employeeName } : {}),
      ...(input.taskTitle !== undefined ? { taskTitle: input.taskTitle } : {}),
      progress: percent(steps),
      currentStep: 0,
      steps,
      overallStatus: "running",
      startedAt: timestamp,
      updatedAt: timestamp,
      ...(input.retryOf !== undefined ? { retryOf: input.retryOf } : {}),
      ...(input.retryCount !== undefined ? { retryCount: input.retryCount } : {}),
      workspacePath: input.workspacePath,
    };
    this.snapshots.set(input.taskId, snapshot);
    this.publish(snapshot, 0, "running");
    return snapshot;
  }

  reportStepStart(taskId: string, stepIndex: number, message?: string): void {
    this.patchStep(taskId, stepIndex, "running", message);
  }

  reportStepFinish(taskId: string, stepIndex: number, message?: string): void {
    this.patchStep(taskId, stepIndex, "success", message);
  }

  reportStepFail(taskId: string, stepIndex: number, message?: string): void {
    this.patchStep(taskId, stepIndex, "failed", message);
  }

  failCurrent(taskId: string, message?: string): void {
    const snapshot = this.snapshots.get(taskId);
    if (!snapshot) return;
    const running = snapshot.steps.findIndex((step) => step.status === "running");
    this.reportStepFail(taskId, running >= 0 ? running : snapshot.currentStep, message);
  }

  getSnapshot(taskId: string): TaskProgressSnapshot | undefined {
    const snapshot = this.snapshots.get(taskId);
    return snapshot ? this.refreshStuck(snapshot) : undefined;
  }

  listActive(workspacePath?: string): TaskProgressSnapshot[] {
    const now = this.now();
    return [...this.snapshots.values()]
      .filter((snapshot) => workspacePath === undefined || snapshot.workspacePath === workspacePath)
      .map((snapshot) => this.refreshStuck(snapshot, now))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  /**
   * Merge live snapshots with files under
   * `.roleweave/conversations/<positionId>/progress/`. Live rows win on
   * `taskId`. Used by GET /turns/progress so a control-plane restart still
   * shows finished history.
   */
  async listAll(workspacePath: string): Promise<TaskProgressSnapshot[]> {
    const live = this.listActive(workspacePath);
    const seen = new Set(live.map((snapshot) => snapshot.taskId));
    const persisted = await this.listPersisted(workspacePath);
    const merged = [...live, ...persisted.filter((snapshot) => !seen.has(snapshot.taskId))];
    merged.sort((left, right) => right.updatedAt - left.updatedAt);
    return merged.slice(0, MAX_FINISHED);
  }

  async listPersisted(workspacePath: string): Promise<TaskProgressSnapshot[]> {
    const root = path.join(workspacePath, ".roleweave", "conversations");
    let positions: string[] = [];
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      positions = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
    const loaded: TaskProgressSnapshot[] = [];
    for (const positionId of positions) {
      const dir = path.join(root, positionId, "progress");
      let files: string[] = [];
      try {
        files = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
      } catch {
        continue;
      }
      for (const name of files) {
        try {
          const parsed = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as TaskProgressSnapshot;
          if (parsed.schemaVersion !== TURN_PROGRESS_SCHEMA_VERSION) continue;
          if (typeof parsed.taskId !== "string" || parsed.workspacePath !== workspacePath) continue;
          loaded.push(this.refreshStuck(parsed));
        } catch {
          // A corrupt snapshot must not fail the list.
        }
      }
    }
    loaded.sort((left, right) => right.updatedAt - left.updatedAt);
    return loaded.slice(0, MAX_FINISHED);
  }

  async persist(workspacePath: string, positionId: string, taskId: string): Promise<void> {
    const snapshot = this.snapshots.get(taskId);
    if (!snapshot) return;
    const file = snapshotPath(workspacePath, positionId, taskId);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Progress persistence must not fail the turn.
    }
  }

  async loadPersisted(workspacePath: string, positionId: string, taskId: string): Promise<TaskProgressSnapshot | undefined> {
    const cached = this.snapshots.get(taskId);
    if (cached) return this.refreshStuck(cached);
    try {
      const raw = await fs.readFile(snapshotPath(workspacePath, positionId, taskId), "utf8");
      const parsed = JSON.parse(raw) as TaskProgressSnapshot;
      if (parsed.schemaVersion !== TURN_PROGRESS_SCHEMA_VERSION || parsed.taskId !== taskId) return undefined;
      this.snapshots.set(taskId, parsed);
      return this.refreshStuck(parsed);
    } catch {
      return undefined;
    }
  }

  private patchStep(taskId: string, stepIndex: number, status: TurnProgressStepStatus, message?: string): void {
    const snapshot = this.snapshots.get(taskId);
    if (!snapshot) return;
    const step = snapshot.steps[stepIndex];
    if (!step) return;
    if (step.status === "failed" && status !== "failed") return;
    const timestamp = this.now();
    const startedAt = status === "running" ? timestamp : step.startedAt;
    const finishedAt = status === "running" ? undefined : timestamp;
    const next: TurnProgressStepView = {
      ...step,
      status,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(finishedAt !== undefined ? { finishedAt, durationMs: startedAt !== undefined ? Math.max(0, finishedAt - startedAt) : 0 } : {}),
      ...(safeMessage(message) !== undefined ? { message: safeMessage(message) } : {}),
    };
    const steps = snapshot.steps.map((item, index) => (index === stepIndex ? next : item));
    const updated: TaskProgressSnapshot = {
      ...snapshot,
      steps,
      progress: percent(steps),
      currentStep: currentStepIndex(steps),
      overallStatus: overall(steps, timestamp, timestamp),
      updatedAt: timestamp,
    };
    this.snapshots.set(taskId, updated);
    if (updated.overallStatus === "success" || updated.overallStatus === "failed") this.rememberFinished(taskId);
    this.publish(updated, stepIndex, status);
  }

  private rememberFinished(taskId: string): void {
    if (!this.finishedOrder.includes(taskId)) this.finishedOrder.push(taskId);
    while (this.finishedOrder.length > MAX_FINISHED) {
      const oldest = this.finishedOrder.shift();
      if (oldest) this.snapshots.delete(oldest);
    }
  }

  private refreshStuck(snapshot: TaskProgressSnapshot, now = this.now()): TaskProgressSnapshot {
    const nextStatus = overall(snapshot.steps, snapshot.updatedAt, now);
    if (nextStatus === snapshot.overallStatus) return snapshot;
    const updated = { ...snapshot, overallStatus: nextStatus };
    this.snapshots.set(snapshot.taskId, updated);
    return updated;
  }

  private publish(snapshot: TaskProgressSnapshot, stepIndex: number, stepStatus: TurnProgressStepStatus): void {
    const step = snapshot.steps[stepIndex];
    if (!step) return;
    const payload: TaskProgressEvent = {
      taskId: snapshot.taskId,
      employeeId: snapshot.positionId,
      positionId: snapshot.positionId,
      ...(snapshot.employeeName !== undefined ? { employeeName: snapshot.employeeName } : {}),
      ...(snapshot.taskTitle !== undefined ? { taskTitle: snapshot.taskTitle } : {}),
      stepIndex,
      stepName: step.name,
      stepStatus,
      totalSteps: snapshot.steps.length,
      progress: snapshot.progress,
      ...(step.message !== undefined ? { message: step.message } : {}),
      ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
      ...(step.finishedAt !== undefined ? { finishedAt: step.finishedAt } : {}),
      ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
      timestamp: snapshot.updatedAt,
      ...(snapshot.retryOf !== undefined ? { retryOf: snapshot.retryOf } : {}),
      ...(snapshot.retryCount !== undefined ? { retryCount: snapshot.retryCount } : {}),
    };
    try {
      this.bus.publish("turn.progress", payload);
    } catch {
      // A progress publish must not abort the turn.
    }
  }
}

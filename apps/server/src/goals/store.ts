import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  GOAL_ACTIVITY_SCHEMA_VERSION,
  GOAL_MAX_ACTIVITY_ENTRIES,
  GOAL_MAX_BRANCHES,
  GOAL_MAX_TITLE_LENGTH,
  GOAL_SCHEMA_VERSION,
  OrgApiError,
  canTransitionGoalStatus,
  errorCodes,
  validateGoal,
  validateGoalActivity,
  validateGoalCreateRequest,
  validateGoalUpdateRequest,
  type Goal,
  type GoalActivity,
  type GoalHealthStatus,
  type GoalSummary,
  type GoalsCreateRequest,
  type GoalsUpdateRequest,
} from "@roleweave/shared";
import { StableReadError, decodeStableUtf8, readStableBoundedFile } from "../stable-read.js";
import { atomicWriteJson, nodeAtomicTurnWriteOperations } from "../turns/store.js";
import type { TurnRecord } from "@roleweave/shared";

const GOAL_ROOT_SEGMENTS = [".digital-employee", "workbench", "goals"];
const MAX_GOALS = 64;
const MAX_GOAL_RECORD_BYTES = 32 * 1024;
const MAX_GOAL_ACTIVITY_BYTES = 16 * 1024;
const GOAL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function goalError(message: string, cause?: unknown): OrgApiError {
  return new OrgApiError(
    errorCodes.goal_storage_failed,
    500,
    message,
    false,
    cause === undefined ? undefined : { cause },
  );
}

function goalMissing(): OrgApiError {
  return new OrgApiError(errorCodes.goal_missing, 404, "goal not found in the open workspace");
}

function goalConflict(message: string): OrgApiError {
  return new OrgApiError(errorCodes.goal_conflict, 409, message);
}

function goalRequestInvalid(message: string): OrgApiError {
  return new OrgApiError(errorCodes.goal_request_invalid, 400, message);
}

function goalsRoot(workspace: string): string {
  return path.join(workspace, ...GOAL_ROOT_SEGMENTS);
}

function goalDir(workspace: string, goalId: string): string {
  return path.join(goalsRoot(workspace), goalId);
}

function goalFile(workspace: string, goalId: string): string {
  return path.join(goalDir(workspace, goalId), "goal.json");
}

function activityDir(workspace: string, goalId: string): string {
  return path.join(goalDir(workspace, goalId), "activity");
}

function activityFile(workspace: string, goalId: string, activityId: string): string {
  return path.join(activityDir(workspace, goalId), `${activityId}.json`);
}

async function ensureRealDirectories(workspace: string): Promise<void> {
  const root = path.resolve(workspace);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw goalError("workspace must be a real directory for local goal state");
  }
  let current = root;
  for (const segment of GOAL_ROOT_SEGMENTS) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw goalError("local goal state path must not contain symbolic links");
      }
    } catch (error) {
      if (error instanceof OrgApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw goalError("local goal state path is unreadable");
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw goalError("local goal state directory could not be created");
        }
      }
      const created = await fs.lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw goalError("local goal directory creation raced with an unsafe path");
      }
    }
    if (segment !== ".digital-employee") await fs.chmod(current, 0o700);
  }
}

async function ensureGoalDirectories(workspace: string, goalId: string): Promise<void> {
  const dir = goalDir(workspace, goalId);
  const actDir = activityDir(workspace, goalId);
  for (const segment of [dir, actDir]) {
    try {
      const stat = await fs.lstat(segment);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw goalError("goal directory path must not contain symbolic links");
      }
    } catch (error) {
      if (error instanceof OrgApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw goalError("goal directory path is unreadable");
      try {
        await fs.mkdir(segment, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw goalError("goal directory could not be created");
        }
      }
      const created = await fs.lstat(segment);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw goalError("goal directory creation raced with an unsafe path");
      }
    }
    await fs.chmod(segment, 0o700);
  }
}

async function readBoundedJson(file: string, maxBytes: number): Promise<unknown> {
  let stable;
  try {
    stable = await readStableBoundedFile(file, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    if (error instanceof StableReadError) {
      throw goalError("local goal record is not a stable bounded regular file");
    }
    throw goalError("local goal record is unreadable");
  }
  try {
    return JSON.parse(decodeStableUtf8(stable.buffer)) as unknown;
  } catch {
    throw goalError("local goal record is not valid JSON");
  }
}

function toSummary(goal: Goal): GoalSummary {
  const { branches: _, ...rest } = goal;
  return { ...rest, branchCount: goal.branches.length };
}

const HEALTH_SEVERITY: Record<GoalHealthStatus, number> = {
  on_track: 3,
  at_risk: 2,
  blocked: 1,
  unknown: 0,
};

export function computeHealthFromTurns(goal: Goal, turns: readonly TurnRecord[]): GoalHealthStatus {
  if (goal.branches.length === 0) return goal.health;
  let worst: GoalHealthStatus | null = null;
  for (const branch of goal.branches) {
    const bound = turns.filter((t) => t.goalId === goal.goalId && t.branchId === branch.branchId);
    if (bound.length === 0) continue;
    let branchHealth: GoalHealthStatus = "on_track";
    for (const turn of bound) {
      if (turn.status === "failed" || turn.status === "indeterminate") {
        branchHealth = "at_risk";
        break;
      }
    }
    if (worst === null || HEALTH_SEVERITY[branchHealth] < HEALTH_SEVERITY[worst]) {
      worst = branchHealth;
    }
  }
  return worst ?? "unknown";
}

export class GoalStore {
  private readonly locks = new Map<string, Promise<void>>();

  async create(workspace: string, request: unknown, now = new Date().toISOString()): Promise<Goal> {
    const parsed = validateGoalCreateRequest(request);
    if (!parsed.ok) throw goalRequestInvalid(parsed.message);

    return this.exclusive(`goals\0${path.resolve(workspace)}`, async () => {
      await ensureRealDirectories(workspace);
      const existing = await this.listGoalIds(workspace);
      if (existing.length >= MAX_GOALS) {
        throw goalError("workspace goal count reached its bounded capacity");
      }
      const goalId = crypto.randomUUID();
      await ensureGoalDirectories(workspace, goalId);

      const goal: Goal = {
        schemaVersion: GOAL_SCHEMA_VERSION,
        goalId,
        title: parsed.value.title,
        description: parsed.value.description,
        acceptanceCriteria: parsed.value.acceptanceCriteria ?? [],
        status: "open",
        health: "unknown",
        branches: [],
        createdAt: now,
        updatedAt: now,
      };

      try {
        await atomicWriteJson(goalFile(workspace, goalId), goal, MAX_GOAL_RECORD_BYTES, nodeAtomicTurnWriteOperations, goalError);
      } catch (error) {
        if (error instanceof OrgApiError) throw error;
        throw goalError("local goal record could not be persisted atomically", error);
      }

      const activity: GoalActivity = {
        schemaVersion: GOAL_ACTIVITY_SCHEMA_VERSION,
        activityId: crypto.randomUUID(),
        goalId,
        kind: "created",
        detail: `Goal "${goal.title}" created`,
        createdAt: now,
      };
      await this.appendActivity(workspace, goalId, activity);
      return goal;
    });
  }

  async list(workspace: string): Promise<GoalSummary[]> {
    await ensureRealDirectories(workspace);
    const ids = await this.listGoalIds(workspace);
    const summaries: GoalSummary[] = [];
    for (const id of ids) {
      try {
        const raw = await readBoundedJson(goalFile(workspace, id), MAX_GOAL_RECORD_BYTES);
        const parsed = validateGoal(raw);
        if (parsed.ok) summaries.push(toSummary(parsed.value));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt, "en"));
  }

  async get(workspace: string, goalId: string): Promise<Goal> {
    if (!GOAL_ID_PATTERN.test(goalId) && !goalId.includes("-")) {
      throw goalMissing();
    }
    const raw = await readBoundedJson(goalFile(workspace, goalId), MAX_GOAL_RECORD_BYTES).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw goalMissing();
      throw error;
    });
    const parsed = validateGoal(raw);
    if (!parsed.ok) throw goalError("goal record failed validation");
    return parsed.value;
  }

  async getDetail(workspace: string, goalId: string, turns?: readonly TurnRecord[]): Promise<{ goal: Goal; activity: GoalActivity[] }> {
    const goal = await this.get(workspace, goalId);
    const activity = await this.readActivity(workspace, goalId);
    if (turns !== undefined && goal.branches.length > 0) {
      const computed = computeHealthFromTurns(goal, turns);
      if (computed !== goal.health) {
        const now = new Date().toISOString();
        const updated: Goal = { ...goal, health: computed, updatedAt: now };
        try {
          await atomicWriteJson(goalFile(workspace, goalId), updated, MAX_GOAL_RECORD_BYTES, nodeAtomicTurnWriteOperations, goalError);
        } catch (error) {
          if (error instanceof OrgApiError) throw error;
          throw goalError("local goal record could not be persisted atomically", error);
        }
        const healthActivity: GoalActivity = {
          schemaVersion: GOAL_ACTIVITY_SCHEMA_VERSION,
          activityId: crypto.randomUUID(),
          goalId,
          kind: "health_changed",
          detail: `health: ${goal.health} → ${computed}`,
          createdAt: now,
        };
        await this.appendActivity(workspace, goalId, healthActivity);
        return { goal: updated, activity: [...activity, healthActivity] };
      }
    }
    return { goal, activity };
  }

  async update(workspace: string, goalId: string, request: unknown, now = new Date().toISOString()): Promise<Goal> {
    const parsed = validateGoalUpdateRequest(request);
    if (!parsed.ok) throw goalRequestInvalid(parsed.message);

    return this.exclusive(`goal\0${path.resolve(workspace)}\0${goalId}`, async () => {
      const existing = await this.get(workspace, goalId);

      if (parsed.value.status !== undefined && !canTransitionGoalStatus(existing.status, parsed.value.status)) {
        throw goalConflict(`cannot transition goal status from ${existing.status} to ${parsed.value.status}`);
      }

      const updated: Goal = {
        ...existing,
        ...(parsed.value.title !== undefined ? { title: parsed.value.title } : {}),
        ...(parsed.value.description !== undefined ? { description: parsed.value.description } : {}),
        ...(parsed.value.acceptanceCriteria !== undefined ? { acceptanceCriteria: parsed.value.acceptanceCriteria } : {}),
        ...(parsed.value.status !== undefined ? { status: parsed.value.status } : {}),
        ...(parsed.value.health !== undefined ? { health: parsed.value.health } : {}),
        updatedAt: now,
      };

      try {
        await atomicWriteJson(goalFile(workspace, goalId), updated, MAX_GOAL_RECORD_BYTES, nodeAtomicTurnWriteOperations, goalError);
      } catch (error) {
        if (error instanceof OrgApiError) throw error;
        throw goalError("local goal record could not be persisted atomically", error);
      }

      const changes: string[] = [];
      if (parsed.value.status !== undefined && parsed.value.status !== existing.status) {
        changes.push(`status: ${existing.status} → ${parsed.value.status}`);
      }
      if (parsed.value.health !== undefined && parsed.value.health !== existing.health) {
        changes.push(`health: ${existing.health} → ${parsed.value.health}`);
      }
      if (parsed.value.title !== undefined) changes.push("title updated");
      if (parsed.value.description !== undefined) changes.push("description updated");
      if (parsed.value.acceptanceCriteria !== undefined) changes.push("acceptance criteria updated");

      const activity: GoalActivity = {
        schemaVersion: GOAL_ACTIVITY_SCHEMA_VERSION,
        activityId: crypto.randomUUID(),
        goalId,
        kind: changes.some((c) => c.startsWith("status:")) ? "status_changed" : "updated",
        detail: changes.length > 0 ? changes.join("; ") : "Goal updated",
        createdAt: now,
      };
      await this.appendActivity(workspace, goalId, activity);
      return updated;
    });
  }

  async delete(workspace: string, goalId: string): Promise<void> {
    return this.exclusive(`goal\0${path.resolve(workspace)}\0${goalId}`, async () => {
      await this.get(workspace, goalId);
      const dir = goalDir(workspace, goalId);
      await fs.rm(dir, { recursive: true, force: true });
    });
  }

  private async listGoalIds(workspace: string): Promise<string[]> {
    const root = goalsRoot(workspace);
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw goalError("goal index is unreadable");
    }
    if (entries.length > MAX_GOALS * 2) throw goalError("goal index exceeds its bound");
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (!entry.name.match(/^[a-f0-9-]{36}$/)) continue;
      ids.push(entry.name);
    }
    return ids;
  }

  private async readActivity(workspace: string, goalId: string): Promise<GoalActivity[]> {
    const dir = activityDir(workspace, goalId);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw goalError("goal activity index is unreadable");
    }
    if (entries.length > GOAL_MAX_ACTIVITY_ENTRIES * 2) throw goalError("goal activity index exceeds its bound");
    const activities: GoalActivity[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
      try {
        const raw = await readBoundedJson(path.join(dir, entry.name), MAX_GOAL_ACTIVITY_BYTES);
        const parsed = validateGoalActivity(raw);
        if (parsed.ok) activities.push(parsed.value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return activities.sort((a, b) => a.createdAt.localeCompare(b.createdAt, "en"));
  }

  private async appendActivity(workspace: string, goalId: string, activity: GoalActivity): Promise<void> {
    const existing = await this.readActivity(workspace, goalId);
    if (existing.length >= GOAL_MAX_ACTIVITY_ENTRIES) {
      const trimmed = existing.slice(existing.length - GOAL_MAX_ACTIVITY_ENTRIES + 1);
      const dir = activityDir(workspace, goalId);
      const toDelete = existing.slice(0, existing.length - GOAL_MAX_ACTIVITY_ENTRIES + 1);
      for (const old of toDelete) {
        await fs.unlink(activityFile(workspace, goalId, old.activityId)).catch(() => {});
      }
      void trimmed;
    }
    try {
      await atomicWriteJson(
        activityFile(workspace, goalId, activity.activityId),
        activity,
        MAX_GOAL_ACTIVITY_BYTES,
        nodeAtomicTurnWriteOperations,
        goalError,
      );
    } catch (error) {
      if (error instanceof OrgApiError) throw error;
      throw goalError("goal activity record could not be persisted atomically", error);
    }
  }

  private async exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.locks.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

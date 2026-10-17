import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  GOAL_ACTIVITY_SCHEMA_VERSION,
  GOAL_MAX_ACTIVITY_ENTRIES,
  GOAL_MAX_TASK_ACCEPTANCES,
  GOAL_SCHEMA_VERSION,
  GOAL_TASK_ACCEPTANCE_SCHEMA_VERSION,
  OrgApiError,
  canTransitionGoalStatus,
  errorCodes,
  validateGoal,
  validateGoalActivity,
  validateGoalCreateRequest,
  validateGoalUpdateRequest,
  validateGoalTaskAcceptanceCreateRequest,
  validateAcceptanceDecisionInput,
  type Goal,
  type GoalActivity,
  type GoalDetail,
  type GoalHealthStatus,
  type GoalSummary,
  type GoalTaskExecution,
  type GoalTaskAcceptanceRecord,
  type GoalTaskDelivery,
  type GoalTaskDeliveryUnavailable,
} from "@roleweave/shared";
import { StableReadError, decodeStableUtf8, readStableBoundedFile } from "../stable-read.js";
import { atomicWriteJson, nodeAtomicTurnWriteOperations, TurnStore, type AtomicTurnWriteOperations } from "../turns/store.js";
import type { TurnRecord } from "@roleweave/shared";
import { askLaya, type LayaAsk } from "../laya/client.js";
import { layaEnabled } from "../laya/config.js";

const GOAL_ROOT_SEGMENTS = [".roleweave", "goals"];
const MAX_GOALS = 64;
// 64 bounded work items can exceed the previous 32 KiB record size.
const MAX_GOAL_RECORD_BYTES = 8 * 1024 * 1024;
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
    if (segment !== ".roleweave") await fs.chmod(current, 0o700);
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
  const { branches: _, workItems: _workItems, taskAcceptances: _acceptances, ...rest } = goal;
  return { ...rest, branchCount: goal.branches.length };
}

const HEALTH_SEVERITY: Record<GoalHealthStatus, number> = {
  on_track: 3,
  at_risk: 2,
  blocked: 1,
  unknown: 0,
};

/** Canonical JSON binds the review to the full saved output, including structured replies. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function taskTurns(goal: Goal, taskId: string, turns: readonly TurnRecord[]): TurnRecord[] {
  return turns.filter(turn => turn.goalId === goal.goalId && turn.branchId === taskId)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.turnId.localeCompare(right.turnId, "en"));
}

export function projectTaskDeliveries(goal: Goal, turns: readonly TurnRecord[]): {
  taskDeliveries: Record<string, GoalTaskDelivery>;
  taskDeliveryUnavailable: Record<string, GoalTaskDeliveryUnavailable>;
} {
  const taskDeliveries: Record<string, GoalTaskDelivery> = Object.create(null);
  const taskDeliveryUnavailable: Record<string, GoalTaskDeliveryUnavailable> = Object.create(null);
  for (const item of goal.workItems ?? []) {
    const turn = taskTurns(goal, item.taskId, turns).at(-1);
    if (!turn) continue;
    if (turn.status !== "completed" || !item.assigneePositionId || turn.positionId !== item.assigneePositionId) {
      taskDeliveryUnavailable[item.taskId] = "execution_incomplete";
    } else if (!turn.conversationRef || turn.conversationRef !== turn.conversationId || turn.groupRef) {
      taskDeliveryUnavailable[item.taskId] = "session_required";
    } else if (turn.output === undefined || (typeof turn.output === "string" && !turn.output.trim())) {
      taskDeliveryUnavailable[item.taskId] = "output_missing";
    } else {
      taskDeliveries[item.taskId] = { source: { positionId: turn.positionId, turnId: turn.turnId,
        sessionId: turn.conversationRef, outputDigest: digest(turn.output) }, output: turn.output, completedAt: turn.updatedAt };
    }
  }
  return { taskDeliveries, taskDeliveryUnavailable };
}

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

export function projectTaskExecutions(goal: Goal, turns: readonly TurnRecord[], isRunning: (turn: TurnRecord) => boolean = () => false): Record<string, GoalTaskExecution> {
  const latest = new Map<string, TurnRecord>();
  const tasks = new Map((goal.workItems ?? []).map((item) => [item.taskId, item]));
  for (const turn of turns) {
    if (turn.goalId !== goal.goalId || !turn.branchId) continue;
    const item = tasks.get(turn.branchId);
    if (!item?.assigneePositionId || turn.positionId !== item.assigneePositionId) continue;
    const previous = latest.get(item.taskId);
    // Start time identifies the newest attempt, even if an older attempt finishes later.
    if (!previous || Date.parse(turn.createdAt) > Date.parse(previous.createdAt)
      || (turn.createdAt === previous.createdAt && turn.turnId > previous.turnId)) {
      latest.set(item.taskId, turn);
    }
  }
  return Object.fromEntries([...latest].map(([taskId, turn]) => [taskId, {
    turnId: turn.turnId,
    positionId: turn.positionId,
    ...(turn.conversationRef !== undefined && turn.conversationRef === turn.conversationId && !turn.groupRef ? { sessionId: turn.conversationRef } : {}),
    status: turn.status === "running" && !isRunning(turn) ? "indeterminate" : turn.status,
    startedAt: turn.createdAt,
    ...(turn.status === "running" ? {} : { completedAt: turn.updatedAt }),
  }]));
}

function heuristicBranchHealth(bound: readonly TurnRecord[]): GoalHealthStatus {
  for (const turn of bound) {
    if (turn.status === "failed" || turn.status === "indeterminate") return "at_risk";
  }
  return "on_track";
}

const GOAL_HEALTH_OPTIONS = ["on_track", "at_risk", "blocked", "unknown"] as const;

function isGoalHealthStatus(value: string): value is GoalHealthStatus {
  return (GOAL_HEALTH_OPTIONS as readonly string[]).includes(value);
}

function branchJudgmentState(bound: readonly TurnRecord[]) {
  return bound.slice(0, 12).map((turn) => {
    const entry: { status: TurnRecord["status"]; errorCode?: string } = { status: turn.status };
    if (typeof turn.error?.code === "string" && turn.error.code.length > 0) {
      entry.errorCode = turn.error.code;
    }
    return entry;
  });
}

export interface ResolveGoalHealthDeps {
  env?: NodeJS.Dict<string>;
  ask?: LayaAsk;
  log?: (entry: Record<string, unknown>) => void;
}

/** Persisted health is always computeHealthFromTurns. */
export async function resolveGoalHealth(
  goal: Goal,
  turns: readonly TurnRecord[],
  _deps: ResolveGoalHealthDeps = {},
): Promise<GoalHealthStatus> {
  return computeHealthFromTurns(goal, turns);
}

/**
 * Advisory Laya overlay. Invalid/external options never apply. A Choice of
 * on_track/unknown cannot clear failed/indeterminate. Null when disabled,
 * failed, or nothing valid to overlay.
 */
export async function resolveLayaHealthOverlay(
  goal: Goal,
  turns: readonly TurnRecord[],
  deps: ResolveGoalHealthDeps = {},
): Promise<GoalHealthStatus | null> {
  const env = deps.env ?? process.env;
  if (!layaEnabled(env) || goal.branches.length === 0) return null;

  const ask = deps.ask ?? ((request) => askLaya(request, { env }));
  const log = deps.log ?? ((entry) => console.info("[laya]", JSON.stringify(entry)));

  try {
    let worst: GoalHealthStatus | null = null;
    let applied = false;
    for (const branch of goal.branches) {
      const bound = turns.filter((t) => t.goalId === goal.goalId && t.branchId === branch.branchId);
      if (bound.length === 0) continue;
      const fallback = heuristicBranchHealth(bound);
      let branchHealth = fallback;
      const answers = await ask({
        state: { goalId: goal.goalId, branchId: branch.branchId, turns: branchJudgmentState(bound) },
        questions: {
          health: {
            type: "choice",
            instructions:
              "Classify this goal branch. blocked = cannot proceed without a human or external fix. at_risk = failing or indeterminate work. on_track = advancing. unknown = not enough evidence. Do not treat a cancelled turn as failure by itself.",
            criteria: {
              on_track: "Bound turns are completing and the branch is advancing",
              at_risk: "Failed or indeterminate turns show the branch is slipping",
              blocked: "The branch cannot continue without intervention",
              unknown: "Not enough bound turn evidence",
            },
          },
        },
      });
      const answer = answers?.health;
      const selected = answer?.type === "choice" ? answer.selected : undefined;
      const usedLaya = typeof selected === "string" && isGoalHealthStatus(selected);
      const clearsFailedBranch =
        fallback === "at_risk" && selected !== "at_risk" && selected !== "blocked";
      if (usedLaya && !clearsFailedBranch) {
        branchHealth = selected;
        applied = true;
      }
      log({
        goalId: goal.goalId,
        branchId: branch.branchId,
        option: branchHealth,
        heuristic: fallback,
        overlay: usedLaya && !clearsFailedBranch ? selected : null,
        probability: answer?.type === "choice" ? answer.probabilities[selected ?? ""] : undefined,
        confidence: answer?.type === "choice" ? answer.confidence : undefined,
        fallback: branchHealth === fallback,
      });
      if (worst === null || HEALTH_SEVERITY[branchHealth] < HEALTH_SEVERITY[worst]) worst = branchHealth;
    }
    return applied ? worst : null;
  } catch {
    return null;
  }
}

export class GoalStore {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly history = new TurnStore();

  constructor(private readonly options: {
    /** Server-owned history reader; requests can never supply execution facts. */
    readTurns?: (workspace: string) => Promise<readonly TurnRecord[]>;
    acceptanceWriteOperations?: AtomicTurnWriteOperations;
  } = {}) {}

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
    if (!GOAL_ID_PATTERN.test(goalId)) {
      throw goalMissing();
    }
    await ensureRealDirectories(workspace);
    try {
      const stat = await fs.lstat(goalDir(workspace, goalId));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw goalError("local goal record directory must be real");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw goalMissing();
      throw error;
    }
    const raw = await readBoundedJson(goalFile(workspace, goalId), MAX_GOAL_RECORD_BYTES).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw goalMissing();
      throw error;
    });
    const parsed = validateGoal(raw);
    if (!parsed.ok) throw goalError("goal record failed validation");
    return parsed.value;
  }

  async getDetail(workspace: string, goalId: string, turns?: readonly TurnRecord[], isRunning?: (turn: TurnRecord) => boolean, deps: ResolveGoalHealthDeps = {}): Promise<GoalDetail> {
    // Health remains durable for list/detail consistency, but shares the edit
    // lock so a background refresh cannot overwrite a newer project plan.
    return this.exclusive(`goal\0${path.resolve(workspace)}\0${goalId}`, async () => {
      let goal = await this.get(workspace, goalId);
      const activity = await this.readActivity(workspace, goalId);
      if (turns === undefined) return { goal, activity, executionUnavailable: true };
      const health = computeHealthFromTurns(goal, turns);
      if (health !== goal.health) {
        const updatedAt = new Date(Math.max(Date.now(), Date.parse(goal.updatedAt) + 1)).toISOString();
        const healthActivity: GoalActivity = {
          schemaVersion: GOAL_ACTIVITY_SCHEMA_VERSION,
          activityId: crypto.randomUUID(),
          goalId,
          kind: "health_changed",
          detail: `health: ${goal.health} → ${health}`,
          createdAt: updatedAt,
        };
        goal = { ...goal, health, updatedAt };
        await atomicWriteJson(goalFile(workspace, goalId), goal, MAX_GOAL_RECORD_BYTES, nodeAtomicTurnWriteOperations, goalError);
        await this.appendActivity(workspace, goalId, healthActivity);
        activity.push(healthActivity);
      }
      const overlay = await resolveLayaHealthOverlay(goal, turns, deps);
      return {
        goal,
        activity,
        taskExecutions: projectTaskExecutions(goal, turns, isRunning),
        ...projectTaskDeliveries(goal, turns),
        ...(overlay != null && overlay !== goal.health ? { healthOverlay: overlay } : {}),
      };
    });
  }

  async update(workspace: string, goalId: string, request: unknown, now = new Date().toISOString()): Promise<Goal> {
    const parsed = validateGoalUpdateRequest(request);
    if (!parsed.ok) throw goalRequestInvalid(parsed.message);

    return this.exclusive(`goal\0${path.resolve(workspace)}\0${goalId}`, async () => {
      const existing = await this.get(workspace, goalId);

      if (parsed.value.expectedUpdatedAt !== undefined && parsed.value.expectedUpdatedAt !== existing.updatedAt) {
        throw goalConflict("goal changed since it was loaded; refresh before saving work items");
      }
      if (parsed.value.workItems?.some((item) => existing.branches.some((branch) => branch.branchId === item.taskId))) {
        throw goalRequestInvalid("work item identifiers must be distinct from existing branch identifiers");
      }

      if (parsed.value.status !== undefined && !canTransitionGoalStatus(existing.status, parsed.value.status)) {
        throw goalConflict(`cannot transition goal status from ${existing.status} to ${parsed.value.status}`);
      }

      if (parsed.value.workItems?.some(item => item.status === "done")) {
        // A history-read failure must not degrade to an unexecuted manual task.
        const turns = await this.readTurns(workspace);
        for (const item of parsed.value.workItems) {
          if (item.status !== "done") continue;
          const previous = existing.workItems?.find(candidate => candidate.taskId === item.taskId);
          const bound = taskTurns(existing, item.taskId, turns);
          const priorDecisions = existing.taskAcceptances?.filter(record => record.taskId === item.taskId) ?? [];
          if (bound.length === 0 && priorDecisions.length === 0) continue; // Legacy manual plans.
          const accepted = priorDecisions.at(-1);
          const latest = bound.at(-1);
          const unchangedPlan = previous?.status === "done" && canonicalJson({ ...previous, status: "done" }) === canonicalJson(item)
            && canonicalJson(parsed.value.acceptanceCriteria ?? existing.acceptanceCriteria) === canonicalJson(existing.acceptanceCriteria);
          if (!unchangedPlan || accepted?.decision !== "accepted" || !latest || latest.status !== "completed"
            || latest.turnId !== accepted.source.turnId || latest.positionId !== accepted.source.positionId
            || item.assigneePositionId !== accepted.source.positionId || digest(latest.output) !== accepted.source.outputDigest
            || canonicalJson(accepted.criteriaSnapshot) !== canonicalJson(existing.acceptanceCriteria)) {
            throw goalConflict("executed work items require a current human acceptance; submit the task acceptance decision instead of patching done");
          }
        }
      }

      const updated: Goal = {
        ...existing,
        ...(parsed.value.title !== undefined ? { title: parsed.value.title } : {}),
        ...(parsed.value.description !== undefined ? { description: parsed.value.description } : {}),
        ...(parsed.value.acceptanceCriteria !== undefined ? { acceptanceCriteria: parsed.value.acceptanceCriteria } : {}),
        ...(parsed.value.status !== undefined ? { status: parsed.value.status } : {}),
        ...(parsed.value.health !== undefined ? { health: parsed.value.health } : {}),
        ...(parsed.value.workItems !== undefined ? { workItems: parsed.value.workItems } : {}),
        // Two writes in the same millisecond must still produce distinct revisions.
        updatedAt: new Date(Math.max(Date.parse(now), Date.parse(existing.updatedAt) + 1)).toISOString(),
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
      if (parsed.value.workItems !== undefined) changes.push("work items updated");

      const activity: GoalActivity = {
        schemaVersion: GOAL_ACTIVITY_SCHEMA_VERSION,
        activityId: crypto.randomUUID(),
        goalId,
        kind: changes.some((c) => c.startsWith("status:")) ? "status_changed" : "updated",
        detail: changes.length > 0 ? changes.join("; ") : "Goal updated",
        createdAt: updated.updatedAt,
      };
      await this.appendActivity(workspace, goalId, activity);
      return updated;
    });
  }

  async acceptTask(workspace: string, goalId: string, taskId: string, request: unknown, actor: string,
    now = new Date().toISOString()): Promise<GoalTaskAcceptanceRecord> {
    if (!actor || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(actor)) {
      throw new OrgApiError(errorCodes.unauthorized, 403, "a trusted operator is required for task acceptance");
    }
    if (!GOAL_ID_PATTERN.test(taskId)) throw goalRequestInvalid("taskId must be a safe identifier");
    const parsed = validateGoalTaskAcceptanceCreateRequest(request);
    if (!parsed.ok) throw goalRequestInvalid(parsed.message);
    const value = parsed.value;
    if (path.resolve(value.expectedWorkspacePath) !== path.resolve(workspace)) throw goalConflict("workspace changed; reload before accepting a delivery");
    const requestDigest = digest({ goalId, taskId, actor, ...value });
    return this.exclusive(`goal\0${path.resolve(workspace)}\0${goalId}`, async () => {
      const goal = await this.get(workspace, goalId);
      const replay = goal.taskAcceptances?.find(record => record.idempotencyKey === value.idempotencyKey);
      if (replay) {
        if (replay.requestDigest !== requestDigest) throw goalConflict("acceptance idempotency key was already used for another payload");
        return replay;
      }
      if (value.expectedUpdatedAt !== goal.updatedAt) throw goalConflict("goal plan changed; reload before accepting a delivery");
      const task = goal.workItems?.find(item => item.taskId === taskId);
      if (!task) throw goalRequestInvalid("task does not belong to this goal plan");
      const turns = await this.readTurns(workspace);
      const delivery = projectTaskDeliveries(goal, turns).taskDeliveries[taskId];
      if (!delivery || canonicalJson(delivery.source) !== canonicalJson(value.source)) {
        throw goalConflict("delivery changed or is not a completed personal-session turn for this task; reload before deciding");
      }
      const verdict = validateAcceptanceDecisionInput({ criteriaCount: goal.acceptanceCriteria.length, verdicts: value.verdicts,
        decision: value.decision, ...(value.note !== undefined ? { note: value.note } : {}) });
      if (!verdict.ok) throw goalRequestInvalid(verdict.message);
      if ((goal.taskAcceptances?.length ?? 0) >= GOAL_MAX_TASK_ACCEPTANCES) throw goalConflict("task acceptance history reached its bounded capacity");
      const decidedAt = new Date(Math.max(Date.parse(now), Date.parse(goal.updatedAt) + 1)).toISOString();
      const record: GoalTaskAcceptanceRecord = { schemaVersion: GOAL_TASK_ACCEPTANCE_SCHEMA_VERSION, scope: "goal-task",
        acceptanceId: crypto.randomUUID(), goalId, taskId, planUpdatedAt: goal.updatedAt, workspacePath: path.resolve(workspace),
        criteriaSnapshot: [...goal.acceptanceCriteria], source: delivery.source, decision: value.decision,
        verdicts: value.verdicts, ...(value.note !== undefined ? { note: value.note } : {}),
        decidedBy: actor, decidedAt, idempotencyKey: value.idempotencyKey, requestDigest };
      const updated: Goal = { ...goal, workItems: goal.workItems!.map(item => item.taskId === taskId
        ? { ...item, status: value.decision === "accepted" ? "done" : "review" } : item),
        taskAcceptances: [...(goal.taskAcceptances ?? []), record], updatedAt: decidedAt };
      // One fsync+rename transaction is the durable authority for both verdict and status.
      // No second activity file is required to reconstruct acceptance after a restart.
      try {
        await atomicWriteJson(goalFile(workspace, goalId), updated, MAX_GOAL_RECORD_BYTES,
          this.options.acceptanceWriteOperations ?? nodeAtomicTurnWriteOperations, goalError);
      } catch (error) {
        if (error instanceof OrgApiError) throw error;
        throw goalError("task acceptance could not be persisted atomically", error);
      }
      return record;
    });
  }

  private readTurns(workspace: string): Promise<readonly TurnRecord[]> {
    return this.options.readTurns ? this.options.readTurns(workspace) : this.history.reportRecords(workspace);
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

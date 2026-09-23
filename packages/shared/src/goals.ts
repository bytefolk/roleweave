import type { TurnRecordStatus } from "./turns.js";

/**
 * Goal contracts (v1).
 *
 * A Goal is a user-owned, durable collaboration spine that ties together
 * sessions, turns, groups, and reports across positions. This is a shared,
 * pure contract slice — types, constants, and validators only.
 *
 * Validators are fail-closed: object keys are allowlisted, enums are closed,
 * text is bounded, and state transitions are guarded.
 */

export const GOAL_SCHEMA_VERSION = "goal.v1" as const;
export const GOAL_ACTIVITY_SCHEMA_VERSION = "goal-activity.v1" as const;

export const GOAL_MAX_TITLE_LENGTH = 256;
export const GOAL_MAX_TEXT_LENGTH = 4_096;
export const GOAL_MAX_SHORT_TEXT_LENGTH = 256;
export const GOAL_MAX_CRITERIA_ITEMS = 16;
export const GOAL_MAX_BRANCHES = 32;
export const GOAL_MAX_ACTIVITY_ENTRIES = 128;
export const GOAL_MAX_LIST_ITEMS = 64;
export const GOAL_MAX_WORK_ITEMS = 64;

export const goalWorkItemStatuses = ["todo", "in_progress", "blocked", "review", "done"] as const;
export type GoalWorkItemStatus = (typeof goalWorkItemStatuses)[number];
export const goalWorkItemPriorities = ["low", "normal", "high"] as const;
export type GoalWorkItemPriority = (typeof goalWorkItemPriorities)[number];

/** Human-owned plan. Execution facts are projected separately from turn records. */
export interface GoalWorkItem {
  taskId: string;
  title: string;
  description?: string;
  status: GoalWorkItemStatus;
  priority: GoalWorkItemPriority;
  assigneePositionId?: string;
  startDate?: string;
  dueDate?: string;
}

export interface GoalTaskExecution {
  turnId: string;
  positionId: string;
  status: TurnRecordStatus;
  startedAt?: string;
  completedAt?: string;
}

export const goalStatuses = ["open", "in_progress", "completed", "cancelled"] as const;
export type GoalStatus = (typeof goalStatuses)[number];

export const goalHealthStatuses = ["on_track", "at_risk", "blocked", "unknown"] as const;
export type GoalHealthStatus = (typeof goalHealthStatuses)[number];

export const goalBranchStatuses = ["open", "in_progress", "completed", "cancelled"] as const;
export type GoalBranchStatus = (typeof goalBranchStatuses)[number];

export const goalActivityKinds = [
  "created",
  "updated",
  "status_changed",
  "health_changed",
  "branch_added",
  "branch_updated",
  "note",
] as const;
export type GoalActivityKind = (typeof goalActivityKinds)[number];

export interface GoalBranch {
  branchId: string;
  title: string;
  status: GoalBranchStatus;
  positionId?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Goal {
  schemaVersion: typeof GOAL_SCHEMA_VERSION;
  goalId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: GoalStatus;
  health: GoalHealthStatus;
  branches: GoalBranch[];
  /** Optional so existing goal.v1 files remain valid without migration. */
  workItems?: GoalWorkItem[];
  createdAt: string;
  updatedAt: string;
}

export interface GoalActivity {
  schemaVersion: typeof GOAL_ACTIVITY_SCHEMA_VERSION;
  activityId: string;
  goalId: string;
  kind: GoalActivityKind;
  detail: string;
  createdAt: string;
}

export type GoalSummary = Omit<Goal, "branches" | "workItems"> & { branchCount: number };

export interface GoalDetail {
  goal: Goal;
  activity: GoalActivity[];
  taskExecutions?: Record<string, GoalTaskExecution>;
  /** A failed turn-history read must never look like an empty execution history. */
  executionUnavailable?: boolean;
}

export interface GoalsCreateRequest {
  title: string;
  description: string;
  acceptanceCriteria?: string[];
}

export interface GoalsUpdateRequest {
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  status?: GoalStatus;
  health?: GoalHealthStatus;
  workItems?: GoalWorkItem[];
  /** Required for replacing workItems; stale edits return HTTP 409. */
  expectedUpdatedAt?: string;
}

export interface GoalsCreateResponse {
  goalId: string;
}

export interface GoalsListResponse {
  goals: GoalSummary[];
}

export type GoalsDetailResponse = GoalDetail;

const allowedGoalTransitions: Record<GoalStatus, readonly GoalStatus[]> = {
  open: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled", "open"],
  completed: ["open"],
  cancelled: ["open"],
};

export function canTransitionGoalStatus(from: GoalStatus, to: GoalStatus): boolean {
  if (from === to) return true;
  return allowedGoalTransitions[from]?.includes(to) ?? false;
}

// ── Validators ──────────────────────────────────────────────────────────────

export type GoalValidationCode =
  | "goal_invalid"
  | "goal_unknown_field"
  | "goal_empty_string"
  | "goal_text_too_long"
  | "goal_invalid_enum"
  | "goal_duplicate_reference"
  | "goal_invalid_transition"
  | "goal_too_many_items";

export type GoalValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: GoalValidationCode; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: GoalValidationCode, message: string): { ok: false; code: GoalValidationCode; message: string } {
  return { ok: false, code, message };
}

function keysMatch(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key));
}

function nonEmptyText(
  value: unknown,
  field: string,
  maxLength = GOAL_MAX_TEXT_LENGTH,
): GoalValidationResult<string> {
  if (typeof value !== "string" || value.trim().length === 0) return fail("goal_empty_string", `${field} must be a non-empty string`);
  if (value.length > maxLength) return fail("goal_text_too_long", `${field} exceeds its text bound`);
  if ([...value].some((ch) => ch.charCodeAt(0) < 0x20 && ch !== "\n" && ch !== "\r" && ch !== "\t")) {
    return fail("goal_invalid", `${field} contains a control character`);
  }
  return { ok: true, value };
}

function identifier(value: unknown, field: string): GoalValidationResult<string> {
  const result = nonEmptyText(value, field, GOAL_MAX_SHORT_TEXT_LENGTH);
  if (!result.ok) return result;
  if (/\s/.test(result.value)) return fail("goal_invalid", `${field} must not contain whitespace`);
  return result;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): GoalValidationResult<T> {
  if (typeof value !== "string" || !values.includes(value as T)) return fail("goal_invalid_enum", `${field} is outside the allowlist`);
  return { ok: true, value: value as T };
}

function iso8601(value: unknown, field: string): GoalValidationResult<string> {
  if (typeof value !== "string") return fail("goal_invalid", `${field} must be a string`);
  if (value.length > GOAL_MAX_SHORT_TEXT_LENGTH) return fail("goal_text_too_long", `${field} exceeds its text bound`);
  if (Number.isNaN(Date.parse(value))) return fail("goal_invalid", `${field} is not a valid ISO-8601 timestamp`);
  return { ok: true, value };
}

function boundedList(value: unknown, field: string, max: number): GoalValidationResult<unknown[]> {
  if (!Array.isArray(value)) return fail("goal_invalid", `${field} must be an array`);
  if (value.length > max) return fail("goal_too_many_items", `${field} has too many items (max ${max})`);
  return { ok: true, value };
}

function validateBranch(raw: unknown, field: string): GoalValidationResult<GoalBranch> {
  if (!isRecord(raw) || !keysMatch(raw, ["branchId", "title", "status", "createdAt", "updatedAt"], ["positionId", "sessionId"])) {
    return fail("goal_unknown_field", `${field} has unexpected or missing fields`);
  }
  const branchId = identifier(raw.branchId, `${field}.branchId`);
  if (!branchId.ok) return branchId;
  const title = nonEmptyText(raw.title, `${field}.title`, GOAL_MAX_TITLE_LENGTH);
  if (!title.ok) return title;
  const status = enumValue(raw.status, goalBranchStatuses, `${field}.status`);
  if (!status.ok) return status;
  const createdAt = iso8601(raw.createdAt, `${field}.createdAt`);
  if (!createdAt.ok) return createdAt;
  const updatedAt = iso8601(raw.updatedAt, `${field}.updatedAt`);
  if (!updatedAt.ok) return updatedAt;

  const branch: GoalBranch = {
    branchId: branchId.value,
    title: title.value,
    status: status.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  };

  if (raw.positionId !== undefined) {
    const pid = identifier(raw.positionId, `${field}.positionId`);
    if (!pid.ok) return pid;
    branch.positionId = pid.value;
  }
  if (raw.sessionId !== undefined) {
    const sid = identifier(raw.sessionId, `${field}.sessionId`);
    if (!sid.ok) return sid;
    branch.sessionId = sid.value;
  }
  return { ok: true, value: branch };
}

function validateBranches(raw: unknown): GoalValidationResult<GoalBranch[]> {
  const list = boundedList(raw, "branches", GOAL_MAX_BRANCHES);
  if (!list.ok) return list;
  const branches: GoalBranch[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < list.value.length; i++) {
    const parsed = validateBranch(list.value[i], `branches[${i}]`);
    if (!parsed.ok) return fail(parsed.code, `${parsed.message}`);
    if (ids.has(parsed.value.branchId)) return fail("goal_duplicate_reference", `branches[${i}].branchId is a duplicate`);
    ids.add(parsed.value.branchId);
    branches.push(parsed.value);
  }
  return { ok: true, value: branches };
}

function validateCriteria(raw: unknown): GoalValidationResult<string[]> {
  const list = boundedList(raw, "acceptanceCriteria", GOAL_MAX_CRITERIA_ITEMS);
  if (!list.ok) return list;
  const items: string[] = [];
  for (let i = 0; i < list.value.length; i++) {
    const item = nonEmptyText(list.value[i], `acceptanceCriteria[${i}]`, GOAL_MAX_TEXT_LENGTH);
    if (!item.ok) return item;
    items.push(item.value);
  }
  return { ok: true, value: items };
}

/** Date-only values are calendar dates, never local-midnight timestamps. */
function calendarDate(value: unknown, field: string): GoalValidationResult<string> {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) {
    return fail("goal_invalid", `${field} must be a YYYY-MM-DD calendar date`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return fail("goal_invalid", `${field} is not a real calendar date`);
  }
  return { ok: true, value };
}

export function validateGoalWorkItems(raw: unknown): GoalValidationResult<GoalWorkItem[]> {
  const list = boundedList(raw, "workItems", GOAL_MAX_WORK_ITEMS);
  if (!list.ok) return list;
  const ids = new Set<string>();
  const items: GoalWorkItem[] = [];
  for (let index = 0; index < list.value.length; index += 1) {
    const item = list.value[index];
    const field = `workItems[${index}]`;
    if (!isRecord(item) || !keysMatch(item, ["taskId", "title", "status", "priority"], ["description", "assigneePositionId", "startDate", "dueDate"])) {
      return fail("goal_unknown_field", `${field} has unexpected or missing fields`);
    }
    // Match the existing turn branchId contract so every task can be executed.
    if (typeof item.taskId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.taskId)) {
      return fail("goal_invalid", `${field}.taskId must be a safe identifier up to 64 characters`);
    }
    if (ids.has(item.taskId)) return fail("goal_duplicate_reference", `${field}.taskId is a duplicate`);
    ids.add(item.taskId);
    const title = nonEmptyText(item.title, `${field}.title`, GOAL_MAX_TITLE_LENGTH);
    if (!title.ok) return title;
    const status = enumValue(item.status, goalWorkItemStatuses, `${field}.status`);
    if (!status.ok) return status;
    const priority = enumValue(item.priority, goalWorkItemPriorities, `${field}.priority`);
    if (!priority.ok) return priority;
    const result: GoalWorkItem = { taskId: item.taskId, title: title.value, status: status.value, priority: priority.value };
    if (item.description !== undefined) {
      const description = nonEmptyText(item.description, `${field}.description`);
      if (!description.ok) return description;
      result.description = description.value;
    }
    if (item.assigneePositionId !== undefined) {
      if (typeof item.assigneePositionId !== "string" || item.assigneePositionId.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.assigneePositionId)) {
        return fail("goal_invalid", `${field}.assigneePositionId must be a valid position identifier`);
      }
      result.assigneePositionId = item.assigneePositionId;
    }
    for (const key of ["startDate", "dueDate"] as const) {
      if (item[key] !== undefined) {
        const date = calendarDate(item[key], `${field}.${key}`);
        if (!date.ok) return date;
        result[key] = date.value;
      }
    }
    if (result.startDate && result.dueDate && result.startDate > result.dueDate) {
      return fail("goal_invalid", `${field}.startDate must not be after dueDate`);
    }
    items.push(result);
  }
  return { ok: true, value: items };
}

export function validateGoal(raw: unknown): GoalValidationResult<Goal> {
  if (!isRecord(raw) || !keysMatch(raw, ["schemaVersion", "goalId", "title", "description", "acceptanceCriteria", "status", "health", "branches", "createdAt", "updatedAt"], ["workItems"])) {
    return fail("goal_unknown_field", "goal has unexpected or missing fields");
  }
  if (raw.schemaVersion !== GOAL_SCHEMA_VERSION) return fail("goal_invalid", "goal.schemaVersion is not supported");
  const goalId = identifier(raw.goalId, "goal.goalId");
  if (!goalId.ok) return goalId;
  const title = nonEmptyText(raw.title, "goal.title", GOAL_MAX_TITLE_LENGTH);
  if (!title.ok) return title;
  const description = nonEmptyText(raw.description, "goal.description");
  if (!description.ok) return description;
  const criteria = validateCriteria(raw.acceptanceCriteria);
  if (!criteria.ok) return criteria;
  const status = enumValue(raw.status, goalStatuses, "goal.status");
  if (!status.ok) return status;
  const health = enumValue(raw.health, goalHealthStatuses, "goal.health");
  if (!health.ok) return health;
  const branches = validateBranches(raw.branches);
  if (!branches.ok) return branches;
  const createdAt = iso8601(raw.createdAt, "goal.createdAt");
  if (!createdAt.ok) return createdAt;
  const updatedAt = iso8601(raw.updatedAt, "goal.updatedAt");
  if (!updatedAt.ok) return updatedAt;
  const workItems = raw.workItems === undefined ? undefined : validateGoalWorkItems(raw.workItems);
  if (workItems && !workItems.ok) return workItems;
  if (workItems?.ok && workItems.value.some((item) => branches.value.some((branch) => branch.branchId === item.taskId))) {
    return fail("goal_duplicate_reference", "work item identifiers must be distinct from existing branch identifiers");
  }

  return {
    ok: true,
    value: {
      schemaVersion: GOAL_SCHEMA_VERSION,
      goalId: goalId.value,
      title: title.value,
      description: description.value,
      acceptanceCriteria: criteria.value,
      status: status.value,
      health: health.value,
      branches: branches.value,
      ...(workItems?.ok ? { workItems: workItems.value } : {}),
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
    },
  };
}

export function validateGoalActivity(raw: unknown): GoalValidationResult<GoalActivity> {
  if (!isRecord(raw) || !keysMatch(raw, ["schemaVersion", "activityId", "goalId", "kind", "detail", "createdAt"])) {
    return fail("goal_unknown_field", "goalActivity has unexpected or missing fields");
  }
  if (raw.schemaVersion !== GOAL_ACTIVITY_SCHEMA_VERSION) return fail("goal_invalid", "goalActivity.schemaVersion is not supported");
  const activityId = identifier(raw.activityId, "goalActivity.activityId");
  if (!activityId.ok) return activityId;
  const goalId = identifier(raw.goalId, "goalActivity.goalId");
  if (!goalId.ok) return goalId;
  const kind = enumValue(raw.kind, goalActivityKinds, "goalActivity.kind");
  if (!kind.ok) return kind;
  const detail = nonEmptyText(raw.detail, "goalActivity.detail", GOAL_MAX_TEXT_LENGTH);
  if (!detail.ok) return detail;
  const createdAt = iso8601(raw.createdAt, "goalActivity.createdAt");
  if (!createdAt.ok) return createdAt;

  return {
    ok: true,
    value: {
      schemaVersion: GOAL_ACTIVITY_SCHEMA_VERSION,
      activityId: activityId.value,
      goalId: goalId.value,
      kind: kind.value,
      detail: detail.value,
      createdAt: createdAt.value,
    },
  };
}

export function validateGoalCreateRequest(raw: unknown): GoalValidationResult<GoalsCreateRequest> {
  if (!isRecord(raw) || !keysMatch(raw, ["title", "description"], ["acceptanceCriteria"])) {
    return fail("goal_unknown_field", "create request has unexpected or missing fields");
  }
  const title = nonEmptyText(raw.title, "title", GOAL_MAX_TITLE_LENGTH);
  if (!title.ok) return title;
  const description = nonEmptyText(raw.description, "description");
  if (!description.ok) return description;

  const result: GoalsCreateRequest = { title: title.value, description: description.value };

  if (raw.acceptanceCriteria !== undefined) {
    const criteria = validateCriteria(raw.acceptanceCriteria);
    if (!criteria.ok) return criteria;
    result.acceptanceCriteria = criteria.value;
  }
  return { ok: true, value: result };
}

export function validateGoalUpdateRequest(raw: unknown): GoalValidationResult<GoalsUpdateRequest> {
  if (!isRecord(raw) || Object.keys(raw).length === 0) return fail("goal_invalid", "update request must not be empty");
  const allowed = new Set(["title", "description", "acceptanceCriteria", "status", "health", "workItems", "expectedUpdatedAt"]);
  if (Object.keys(raw).some((k) => !allowed.has(k))) return fail("goal_unknown_field", "update request has unexpected fields");

  const result: GoalsUpdateRequest = {};

  if (raw.expectedUpdatedAt !== undefined) {
    const timestamp = iso8601(raw.expectedUpdatedAt, "expectedUpdatedAt");
    if (!timestamp.ok) return timestamp;
    result.expectedUpdatedAt = timestamp.value;
  }
  if (raw.workItems !== undefined) {
    if (result.expectedUpdatedAt === undefined) return fail("goal_invalid", "workItems updates require expectedUpdatedAt");
    const workItems = validateGoalWorkItems(raw.workItems);
    if (!workItems.ok) return workItems;
    result.workItems = workItems.value;
  }

  if (raw.title !== undefined) {
    const title = nonEmptyText(raw.title, "title", GOAL_MAX_TITLE_LENGTH);
    if (!title.ok) return title;
    result.title = title.value;
  }
  if (raw.description !== undefined) {
    const desc = nonEmptyText(raw.description, "description");
    if (!desc.ok) return desc;
    result.description = desc.value;
  }
  if (raw.acceptanceCriteria !== undefined) {
    const criteria = validateCriteria(raw.acceptanceCriteria);
    if (!criteria.ok) return criteria;
    result.acceptanceCriteria = criteria.value;
  }
  if (raw.status !== undefined) {
    const status = enumValue(raw.status, goalStatuses, "status");
    if (!status.ok) return status;
    result.status = status.value;
  }
  if (raw.health !== undefined) {
    const health = enumValue(raw.health, goalHealthStatuses, "health");
    if (!health.ok) return health;
    result.health = health.value;
  }
  if (Object.keys(result).every((key) => key === "expectedUpdatedAt")) return fail("goal_invalid", "update request must change a field");
  return { ok: true, value: result };
}

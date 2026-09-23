// Goal IPC validators (#222). Main-process fail-closed boundary mirroring
// the route shapes in routes/goals.ts.
const GOAL_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_TITLE_LENGTH = 256;
const MAX_TEXT_LENGTH = 4096;
const MAX_CRITERIA_ITEMS = 16;
const MAX_WORK_ITEMS = 64;

function invalid(code, message) {
  return { status: 400, body: { code, message, retryable: false } };
}

function validateGoalId(goalId) {
  return typeof goalId === "string" && goalId.length > 0 && GOAL_ID.test(goalId);
}

function nonEmptyText(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
}

function calendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateWorkItems(value) {
  if (!Array.isArray(value) || value.length > MAX_WORK_ITEMS) return false;
  const ids = new Set();
  const allowed = new Set(["taskId", "title", "description", "status", "priority", "assigneePositionId", "startDate", "dueDate"]);
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some((key) => !allowed.has(key))) return false;
    if (typeof item.taskId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.taskId) || ids.has(item.taskId)) return false;
    ids.add(item.taskId);
    if (!nonEmptyText(item.title, MAX_TITLE_LENGTH)) return false;
    if (!["todo", "in_progress", "blocked", "review", "done"].includes(item.status)) return false;
    if (!["low", "normal", "high"].includes(item.priority)) return false;
    if (item.description !== undefined && !nonEmptyText(item.description, MAX_TEXT_LENGTH)) return false;
    if (item.assigneePositionId !== undefined && (typeof item.assigneePositionId !== "string"
      || item.assigneePositionId.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.assigneePositionId))) return false;
    if (item.startDate !== undefined && !calendarDate(item.startDate)) return false;
    if (item.dueDate !== undefined && !calendarDate(item.dueDate)) return false;
    if (item.startDate && item.dueDate && item.startDate > item.dueDate) return false;
  }
  return true;
}

function validateGoalCreateRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: invalid("goal_request_invalid", "goal create requires an object") };
  }
  const keys = Object.keys(value).sort();
  const allowed = [
    "acceptanceCriteria",
    "acceptanceCriteria,description",
    "acceptanceCriteria,description,title",
    "acceptanceCriteria,title",
    "description",
    "description,title",
    "title",
  ];
  if (!allowed.includes(keys.join(","))) {
    return { ok: false, response: invalid("goal_request_invalid", "goal create accepts title, description, and optional acceptanceCriteria") };
  }
  if (!nonEmptyText(value.title, MAX_TITLE_LENGTH)) {
    return { ok: false, response: invalid("goal_request_invalid", "title must be a non-empty string up to 256 characters") };
  }
  if (!nonEmptyText(value.description, MAX_TEXT_LENGTH)) {
    return { ok: false, response: invalid("goal_request_invalid", "description must be a non-empty string up to 4096 characters") };
  }
  const request = { title: value.title, description: value.description };
  if (value.acceptanceCriteria !== undefined) {
    if (!Array.isArray(value.acceptanceCriteria) || value.acceptanceCriteria.length > MAX_CRITERIA_ITEMS) {
      return { ok: false, response: invalid("goal_request_invalid", `acceptanceCriteria must be an array of up to ${MAX_CRITERIA_ITEMS} items`) };
    }
    if (value.acceptanceCriteria.some((item) => !nonEmptyText(item, MAX_TEXT_LENGTH))) {
      return { ok: false, response: invalid("goal_request_invalid", "each acceptanceCriteria item must be a non-empty string") };
    }
    request.acceptanceCriteria = value.acceptanceCriteria;
  }
  return { ok: true, request };
}

function validateGoalUpdateRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: invalid("goal_request_invalid", "goal update requires an object") };
  }
  const allowed = new Set(["title", "description", "acceptanceCriteria", "status", "health", "workItems", "expectedUpdatedAt"]);
  if (Object.keys(value).length === 0 || Object.keys(value).some((k) => !allowed.has(k))) {
    return { ok: false, response: invalid("goal_request_invalid", "goal update has empty or unknown fields") };
  }
  const request = {};
  if (value.expectedUpdatedAt !== undefined) {
    if (typeof value.expectedUpdatedAt !== "string" || value.expectedUpdatedAt.length > 256 || Number.isNaN(Date.parse(value.expectedUpdatedAt))) {
      return { ok: false, response: invalid("goal_request_invalid", "expectedUpdatedAt must be a valid timestamp") };
    }
    request.expectedUpdatedAt = value.expectedUpdatedAt;
  }
  if (value.workItems !== undefined) {
    if (request.expectedUpdatedAt === undefined) return { ok: false, response: invalid("goal_request_invalid", "workItems updates require expectedUpdatedAt") };
    if (!validateWorkItems(value.workItems)) return { ok: false, response: invalid("goal_request_invalid", "workItems must contain up to 64 unique tasks with valid fields and calendar dates") };
    request.workItems = value.workItems;
  }
  if (value.title !== undefined) {
    if (!nonEmptyText(value.title, MAX_TITLE_LENGTH)) return { ok: false, response: invalid("goal_request_invalid", "title must be a non-empty string up to 256 characters") };
    request.title = value.title;
  }
  if (value.description !== undefined) {
    if (!nonEmptyText(value.description, MAX_TEXT_LENGTH)) return { ok: false, response: invalid("goal_request_invalid", "description must be a non-empty string up to 4096 characters") };
    request.description = value.description;
  }
  if (value.acceptanceCriteria !== undefined) {
    if (!Array.isArray(value.acceptanceCriteria) || value.acceptanceCriteria.length > MAX_CRITERIA_ITEMS) {
      return { ok: false, response: invalid("goal_request_invalid", `acceptanceCriteria must be an array of up to ${MAX_CRITERIA_ITEMS} items`) };
    }
    if (value.acceptanceCriteria.some((item) => !nonEmptyText(item, MAX_TEXT_LENGTH))) {
      return { ok: false, response: invalid("goal_request_invalid", "each acceptanceCriteria item must be a non-empty string") };
    }
    request.acceptanceCriteria = value.acceptanceCriteria;
  }
  if (value.status !== undefined) {
    if (!["open", "in_progress", "completed", "cancelled"].includes(value.status)) {
      return { ok: false, response: invalid("goal_request_invalid", "status must be open, in_progress, completed, or cancelled") };
    }
    request.status = value.status;
  }
  if (value.health !== undefined) {
    if (!["on_track", "at_risk", "blocked", "unknown"].includes(value.health)) {
      return { ok: false, response: invalid("goal_request_invalid", "health must be on_track, at_risk, blocked, or unknown") };
    }
    request.health = value.health;
  }
  if (Object.keys(request).every((key) => key === "expectedUpdatedAt")) {
    return { ok: false, response: invalid("goal_request_invalid", "goal update must change a field") };
  }
  return { ok: true, request };
}

function goalPath(goalId, suffix = "") {
  return validateGoalId(goalId) ? `/goals/${encodeURIComponent(goalId)}${suffix}` : null;
}

module.exports = {
  goalPath,
  validateGoalId,
  validateGoalCreateRequest,
  validateGoalUpdateRequest,
};

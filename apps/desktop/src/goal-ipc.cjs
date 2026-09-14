// Goal IPC validators (#222). Main-process fail-closed boundary mirroring
// the route shapes in routes/goals.ts.
const GOAL_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_TITLE_LENGTH = 256;
const MAX_TEXT_LENGTH = 4096;
const MAX_CRITERIA_ITEMS = 16;

function invalid(code, message) {
  return { status: 400, body: { code, message, retryable: false } };
}

function validateGoalId(goalId) {
  return typeof goalId === "string" && goalId.length > 0 && GOAL_ID.test(goalId);
}

function nonEmptyText(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
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
  const allowed = new Set(["title", "description", "acceptanceCriteria", "status", "health"]);
  if (Object.keys(value).length === 0 || Object.keys(value).some((k) => !allowed.has(k))) {
    return { ok: false, response: invalid("goal_request_invalid", "goal update accepts only title, description, acceptanceCriteria, status, health") };
  }
  const request = {};
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

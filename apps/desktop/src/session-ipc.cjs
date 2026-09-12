const { isPositionId } = require("@roleweave/shared/position-id");
const { validatePendingApproval } = require("./approval-ipc.cjs");

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const { TURN_ENGINE_IDS, turnEngineMessage } = require("@roleweave/shared/turn-engines");
const TURN_ENGINES = new Set(TURN_ENGINE_IDS);
const MAX_INPUT_BYTES = 256 * 1024;

function invalid(code, message) {
  return { status: 400, body: { code, message, retryable: false } };
}

function validateSessionId(sessionId) {
  return typeof sessionId === "string" && SESSION_ID.test(sessionId);
}

function validateSessionCreateRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "positionId" || !isPositionId(value.positionId)) {
    return { ok: false, response: invalid("session_request_invalid", "session create accepts exactly a valid positionId") };
  }
  return { ok: true, request: { positionId: value.positionId } };
}

function validateSessionTurnRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: invalid("turn_request_invalid", "session turn must be an object") };
  }
  const allowedKeys = new Set(["sessionId", "input", "engine", "pendingApproval", "goalId", "branchId"]);
  if (Object.keys(value).some((k) => !allowedKeys.has(k))) {
    return {
      ok: false,
      response: invalid("turn_request_invalid", "session turn accepts sessionId, input, engine, and optional pendingApproval, goalId, branchId"),
    };
  }
  if (!validateSessionId(value.sessionId)) {
    return { ok: false, response: invalid("session_request_invalid", "sessionId is invalid") };
  }
  if (typeof value.input !== "string" || value.input.trim().length === 0 ||
      Buffer.byteLength(value.input, "utf8") > MAX_INPUT_BYTES) {
    return { ok: false, response: invalid("turn_request_invalid", "input must be non-empty and no larger than 256 KiB") };
  }
  if (typeof value.engine !== "string" || !TURN_ENGINES.has(value.engine)) {
    return { ok: false, response: invalid("turn_engine_unsupported", `engine must be ${turnEngineMessage()}`) };
  }
  const GOAL_ID = /^[a-zA-Z0-9_-]{1,64}$/;
  if (value.goalId !== undefined && (typeof value.goalId !== "string" || !GOAL_ID.test(value.goalId))) {
    return { ok: false, response: invalid("turn_request_invalid", "goalId must be a bounded alphanumeric string") };
  }
  if (value.branchId !== undefined && (typeof value.branchId !== "string" || !GOAL_ID.test(value.branchId))) {
    return { ok: false, response: invalid("turn_request_invalid", "branchId must be a bounded alphanumeric string") };
  }
  let pendingApproval;
  if (value.pendingApproval !== undefined) {
    const checked = validatePendingApproval(value.pendingApproval);
    if (!checked.ok) return { ok: false, response: checked.response };
    pendingApproval = checked.value;
  }
  return {
    ok: true,
    sessionId: value.sessionId,
    request: {
      input: value.input,
      engine: value.engine,
      ...(pendingApproval !== undefined ? { pendingApproval } : {}),
      ...(value.goalId !== undefined ? { goalId: value.goalId } : {}),
      ...(value.branchId !== undefined ? { branchId: value.branchId } : {}),
    },
  };
}

function validateSessionContextRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "enabled,sessionId" ||
      !validateSessionId(value.sessionId) || typeof value.enabled !== "boolean") {
    return { ok: false, response: invalid("session_request_invalid", "session context accepts exactly sessionId and enabled boolean") };
  }
  return { ok: true, sessionId: value.sessionId, request: { enabled: value.enabled } };
}

function sessionListPath(positionId) {
  return isPositionId(positionId) ? `/sessions?positionId=${encodeURIComponent(positionId)}` : null;
}

function sessionPath(sessionId, suffix = "") {
  return validateSessionId(sessionId) ? `/sessions/${sessionId}${suffix}` : null;
}

module.exports = {
  sessionListPath,
  sessionPath,
  validateSessionCreateRequest,
  validateSessionContextRequest,
  validateSessionId,
  validateSessionTurnRequest,
};

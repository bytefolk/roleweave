const { isPositionId } = require("@roleweave/shared/position-id");
const { validatePendingApproval } = require("./approval-ipc.cjs");
const MAX_INPUT_BYTES = 256 * 1024;
const TURN_ENGINES = new Set(["qoder", "claude-code", "claude-local"]);

function invalid(message) {
  return { status: 400, body: { code: "turn_request_invalid", message, retryable: false } };
}

function validatePositionId(positionId) {
  return isPositionId(positionId);
}

function validateCreateTurnRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: invalid("turn request must be an object") };
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "engine,input,positionId" && keys.join(",") !== "engine,input,pendingApproval,positionId") {
    return {
      ok: false,
      response: invalid("turn request accepts exactly positionId, input, engine, and optional pendingApproval"),
    };
  }
  if (!validatePositionId(value.positionId)) {
    return { ok: false, response: invalid("positionId is invalid") };
  }
  if (
    typeof value.input !== "string" ||
    value.input.trim().length === 0 ||
    Buffer.byteLength(value.input, "utf8") > MAX_INPUT_BYTES
  ) {
    return { ok: false, response: invalid("input must be non-empty and no larger than 256 KiB") };
  }
  if (typeof value.engine !== "string" || !TURN_ENGINES.has(value.engine)) {
    return { ok: false, response: invalid("engine must be qoder, claude-code, or claude-local") };
  }
  let pendingApproval;
  if (value.pendingApproval !== undefined) {
    const checked = validatePendingApproval(value.pendingApproval);
    if (!checked.ok) return checked;
    pendingApproval = checked.value;
  }
  return {
    ok: true,
    request: {
      positionId: value.positionId,
      input: value.input,
      engine: value.engine,
      ...(pendingApproval !== undefined ? { pendingApproval } : {}),
    },
  };
}

function turnHistoryPath(positionId) {
  if (!validatePositionId(positionId)) return null;
  return `/turns?positionId=${encodeURIComponent(positionId)}`;
}

function validateCancelRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: invalid("cancel request must be an object") };
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "positionId") {
    return { ok: false, response: invalid("cancel request accepts exactly {positionId}") };
  }
  if (!validatePositionId(value.positionId)) {
    return { ok: false, response: invalid("positionId is invalid") };
  }
  return { ok: true, request: { positionId: value.positionId } };
}

module.exports = { turnHistoryPath, validateCancelRequest, validateCreateTurnRequest };

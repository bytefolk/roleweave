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
  const keys = Object.keys(value).sort().join(",");
  if (!["positionId", "positionId,workspacePath", "positionId,turnId,workspacePath"].includes(keys)) {
    return { ok: false, response: invalid("cancel request accepts positionId and optional workspacePath/turnId owner") };
  }
  if (!validatePositionId(value.positionId)) {
    return { ok: false, response: invalid("positionId is invalid") };
  }
  if ("workspacePath" in value && (typeof value.workspacePath !== "string" || value.workspacePath.trim().length === 0 || value.workspacePath.includes("\0") || Buffer.byteLength(value.workspacePath, "utf8") > 4096)) {
    return { ok: false, response: invalid("workspacePath must be a bounded non-empty owner key") };
  }
  if ("turnId" in value && (typeof value.turnId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.turnId))) {
    return { ok: false, response: invalid("turnId must be a bounded safe identifier") };
  }
  return { ok: true, request: { positionId: value.positionId,
    ...("workspacePath" in value ? { workspacePath: value.workspacePath } : {}),
    ...("turnId" in value ? { turnId: value.turnId } : {}),
  } };
}

module.exports = { turnHistoryPath, validateCancelRequest, validateCreateTurnRequest };

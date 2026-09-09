// IPC boundary gate for POST /hire (#33). Mirrors the server-side first gate
// at reduced depth: shape only, fail-closed. The control plane remains the
// authoritative validator for hire-request.v1alpha1 inputs.
const { isPositionId } = require("@roleweave/shared/position-id");

const MODES = new Set(["read_only", "approval_required"]);
const KNOWN_KEYS = new Set(["positionId", "name", "description", "reportTo", "mode", "budget", "permissions", "prompt", "memorySources", "deadline"]);
// Mirrors the control plane's MAX_DESCRIPTION_CHARACTERS (#92), which in turn
// mirrors digital-employee's 1024-code-unit SKILL.md frontmatter bound.
const MAX_DESCRIPTION_CHARACTERS = 1024;

function invalid(message) {
  return { status: 400, body: { code: "hire_request_invalid", message, retryable: false } };
}

function validateHireRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: invalid("hire request must be an object") };
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_KEYS.has(key)) {
      return { ok: false, response: invalid(`unknown field: ${key}`) };
    }
  }
  if (!isPositionId(value.positionId)) {
    return { ok: false, response: invalid("positionId is invalid") };
  }
  for (const key of ["name", "description"]) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0) {
      return { ok: false, response: invalid(`${key} must be a non-empty string`) };
    }
  }
  if (value.description.trim().length > MAX_DESCRIPTION_CHARACTERS) {
    return {
      ok: false,
      response: invalid(`description must be at most ${MAX_DESCRIPTION_CHARACTERS} characters`),
    };
  }
  if (value.reportTo !== null && !isPositionId(value.reportTo)) {
    return { ok: false, response: invalid("reportTo must be a position id or null") };
  }
  if (!MODES.has(value.mode)) {
    return { ok: false, response: invalid("mode must be read_only or approval_required") };
  }
  if (value.budget === null || typeof value.budget !== "object" || Array.isArray(value.budget)) {
    return { ok: false, response: invalid("budget is required") };
  }
  if (value.deadline !== undefined && typeof value.deadline !== "string") {
    return { ok: false, response: invalid("deadline must be a string") };
  }
  return { ok: true, request: value };
}

module.exports = { validateHireRequest };

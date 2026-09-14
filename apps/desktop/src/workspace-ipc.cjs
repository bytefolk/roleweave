// Main-process boundary gate for project bootstrap. The native parent-folder
// picker supplies the path; the control plane still validates the workspace
// contract and never overwrites an existing project directory.
const path = require("node:path");
const { TURN_ENGINE_IDS, turnEngineMessage } = require("@roleweave/shared/turn-engines");

const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PROJECT_ID_LENGTH = 48;
const MAX_DESCRIPTION_CHARACTERS = 1024;
const TURN_ENGINES = new Set(TURN_ENGINE_IDS);
const KNOWN_KEYS = new Set(["parentPath", "projectId", "business", "description", "agentEngine"]);

function invalid(message) {
  return { status: 400, body: { code: "workspace_invalid", message, retryable: false } };
}

function validateWorkspaceCreateRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: invalid("workspace create request must be an object") };
  }
  if (Object.keys(value).some((key) => !KNOWN_KEYS.has(key))) {
    return { ok: false, response: invalid("workspace create accepts projectId, business, description, and optional agentEngine") };
  }
  // The renderer intentionally omits parentPath: Electron obtains it from the
  // native picker below this boundary. Accept a legacy supplied path too, but
  // main.js always overwrites it with the actual picker result.
  if (value.parentPath !== undefined && (typeof value.parentPath !== "string" || !path.isAbsolute(value.parentPath) || value.parentPath.trim().length === 0)) {
    return { ok: false, response: invalid("parentPath must be an absolute directory path") };
  }
  if (typeof value.projectId !== "string" || value.projectId.length > MAX_PROJECT_ID_LENGTH || !PROJECT_ID.test(value.projectId)) {
    return { ok: false, response: invalid("projectId must be lowercase words joined by hyphens") };
  }
  if (typeof value.business !== "string" || value.business.trim().length === 0) {
    return { ok: false, response: invalid("business must be a non-empty name") };
  }
  if (typeof value.description !== "string" || value.description.trim().length > MAX_DESCRIPTION_CHARACTERS) {
    return { ok: false, response: invalid(`description must be at most ${MAX_DESCRIPTION_CHARACTERS} characters`) };
  }
  if (value.agentEngine !== undefined && (typeof value.agentEngine !== "string" || !TURN_ENGINES.has(value.agentEngine))) {
    return { ok: false, response: invalid(`agentEngine must be ${turnEngineMessage()}`) };
  }
  return {
    ok: true,
    request: {
      projectId: value.projectId,
      business: value.business.trim(),
      description: value.description.trim(),
      ...(value.parentPath === undefined ? {} : { parentPath: value.parentPath.trim() }),
      ...(value.agentEngine === undefined ? {} : { agentEngine: value.agentEngine }),
    },
  };
}

module.exports = { validateWorkspaceCreateRequest };

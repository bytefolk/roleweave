// Main-process boundary gate for project bootstrap. The native parent-folder
// picker supplies the path; the control plane still validates the workspace
// contract and never overwrites an existing project directory.
const path = require("node:path");

const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PROJECT_ID_LENGTH = 48;
const MAX_DESCRIPTION_CHARACTERS = 1024;

function invalid(message) {
  return { status: 400, body: { code: "workspace_invalid", message, retryable: false } };
}

function validateWorkspaceCreateRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: invalid("workspace create request must be an object") };
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "business,description,parentPath,projectId") {
    return { ok: false, response: invalid("workspace create accepts parentPath, projectId, business and description") };
  }
  if (typeof value.parentPath !== "string" || !path.isAbsolute(value.parentPath) || value.parentPath.trim().length === 0) {
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
  return {
    ok: true,
    request: {
      parentPath: value.parentPath.trim(),
      projectId: value.projectId,
      business: value.business.trim(),
      description: value.description.trim(),
    },
  };
}

module.exports = { validateWorkspaceCreateRequest };

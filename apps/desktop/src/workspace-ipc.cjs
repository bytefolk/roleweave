// Main-process boundary gate for project bootstrap. The native parent-folder
// picker supplies the path; the control plane still validates the workspace
// contract and never overwrites an existing project directory.
const path = require("node:path");
const { serverPathForWorkspace } = require("./control-plane-launch.cjs");
const { writeLastWorkspacePath } = require("./last-workspace.cjs");
const { workspaceDialogOptions } = require("./runtime-settings.cjs");

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
  if (keys !== "business,description,projectId") {
    return { ok: false, response: invalid("workspace create accepts projectId, business and description; choose the parent directory in the folder picker") };
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
      projectId: value.projectId,
      business: value.business.trim(),
      description: value.description.trim(),
    },
  };
}

function rememberWorkspace(userDataPath, nativePath) {
  try {
    // Keep the picker path, including its WSL distribution, for a later reopen.
    writeLastWorkspacePath(userDataPath, nativePath);
  } catch {
    // A successfully opened project remains usable if persistence fails.
  }
}

async function openWorkspaceWithPicker({ pickDirectory, apiRequest, env, userDataPath }) {
  const picked = await pickDirectory(workspaceDialogOptions(env));
  if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
  const dir = picked.filePaths[0];
  let serverPath;
  try { serverPath = serverPathForWorkspace(dir, env); }
  catch (error) { return invalid(error.message); }
  const res = await apiRequest("/workspace/open", {
    method: "POST", body: { path: serverPath },
  });
  if (res.status === 200) rememberWorkspace(userDataPath, dir);
  return res;
}

async function createWorkspaceWithPicker({ request, pickDirectory, apiRequest, env, userDataPath }) {
  const validated = validateWorkspaceCreateRequest(request);
  if (!validated.ok) return validated.response;
  const picked = await pickDirectory(workspaceDialogOptions(env, true));
  if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
  const parentPath = picked.filePaths[0];
  let serverParentPath;
  try { serverParentPath = serverPathForWorkspace(parentPath, env); }
  catch (error) { return invalid(error.message); }
  const res = await apiRequest("/workspace/create", {
    method: "POST", body: { ...validated.request, parentPath: serverParentPath },
  });
  if (res.status === 201 && res.body?.path) {
    const pathApi = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(parentPath) ? path.win32 : path;
    rememberWorkspace(userDataPath, pathApi.join(parentPath, validated.request.projectId));
  }
  return res;
}

module.exports = { validateWorkspaceCreateRequest, openWorkspaceWithPicker, createWorkspaceWithPicker };

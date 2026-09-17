// Main-process boundary gate for project bootstrap and workspace reveal. The
// native parent-folder picker supplies the path; the control plane still
// validates the workspace contract and never overwrites an existing project
// directory. Reveal asks the control plane which workspace is open instead of
// trusting a renderer-supplied path.
const path = require("node:path");
const { controlPlaneMode, serverPathForWorkspace } = require("./control-plane-launch.cjs");
const { writeLastWorkspacePath } = require("./last-workspace.cjs");
const { workspaceDialogOptions } = require("./runtime-settings.cjs");
const { TURN_ENGINE_IDS, turnEngineMessage } = require("@roleweave/shared/turn-engines");

const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PROJECT_ID_LENGTH = 48;
const MAX_DESCRIPTION_CHARACTERS = 1024;
const TURN_ENGINES = new Set(TURN_ENGINE_IDS);
const KNOWN_KEYS = new Set(["projectId", "business", "description", "agentEngine"]);

function invalid(message) {
  return { status: 400, body: { code: "workspace_invalid", message, retryable: false } };
}

function validateWorkspaceCreateRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: invalid("workspace create request must be an object") };
  }
  if (Object.keys(value).some((key) => !KNOWN_KEYS.has(key))) {
    return { ok: false, response: invalid("workspace create accepts projectId, business, description, and optional agentEngine; choose the parent directory in the folder picker") };
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
      ...(value.agentEngine === undefined ? {} : { agentEngine: value.agentEngine }),
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

/**
 * Map the control-plane workspace path back to a path the native shell can
 * open. In WSL mode the control plane reports a Linux path; Windows Explorer
 * reaches the same directory through the distribution's UNC share, which is
 * the same share the native folder picker offers.
 */
function nativePathForServerPath(serverPath, env) {
  if (controlPlaneMode(env) !== "wsl") return serverPath;
  const distro = env.ROLEWEAVE_WSL_DISTRO ?? "";
  if (typeof distro !== "string" || distro.length === 0) {
    throw new Error("WSL mode needs a configured distribution to reveal the workspace");
  }
  if (typeof serverPath !== "string" || !serverPath.startsWith("/") || /[\x00-\x1f]/.test(serverPath)) {
    throw new Error("workspace path is not an absolute WSL path");
  }
  if (serverPath.split("/").includes("..")) {
    throw new Error("workspace path cannot traverse its distribution root");
  }
  return `\\\\wsl.localhost\\${distro}${serverPath.replace(/\//g, "\\")}`;
}

/**
 * Reveal the currently open workspace in the OS file manager (Finder on
 * macOS, Explorer on Windows). Takes no renderer-supplied path on purpose:
 * the main process asks the control plane which workspace is open, so the
 * shell only ever opens the directory the user already opened here.
 * `openPath` is Electron's `shell.openPath`, which resolves to an empty
 * string on success and to an error message on failure.
 */
async function revealWorkspaceInFileManager({ apiRequest, env, openPath }) {
  const res = await apiRequest("/workspace");
  if (res.status !== 200 || res.body?.open !== true || typeof res.body.path !== "string" || res.body.path.length === 0) {
    return { opened: false, reason: "workspace_not_open" };
  }
  let target;
  try {
    target = nativePathForServerPath(res.body.path, env);
  } catch (error) {
    return { opened: false, reason: String(error.message ?? error) };
  }
  const failure = await openPath(target);
  if (failure) return { opened: false, reason: String(failure) };
  return { opened: true, path: target };
}

module.exports = {
  validateWorkspaceCreateRequest,
  openWorkspaceWithPicker,
  createWorkspaceWithPicker,
  nativePathForServerPath,
  revealWorkspaceInFileManager,
};

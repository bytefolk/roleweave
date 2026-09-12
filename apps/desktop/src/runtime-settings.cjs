const fs = require("node:fs");
const path = require("node:path");
const { controlPlaneMode } = require("./control-plane-launch.cjs");

function validateRuntimeSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["mode", "distro", "nodePath", "homePath"].includes(key)) ||
      !["native", "wsl"].includes(value.mode)) {
    throw new Error("Invalid local runtime settings");
  }
  for (const key of ["distro", "nodePath", "homePath"]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || !value[key].trim() ||
        value[key].length > 4096 || /[\x00-\x1f\x7f]/.test(value[key])) {
      throw new Error(`Invalid runtime setting: ${key}`);
    }
  }
  if (value.distro !== undefined && /[\\/]/.test(value.distro)) {
    throw new Error("WSL distribution must be a name");
  }
  for (const key of ["nodePath", "homePath"]) {
    if (value[key] !== undefined && !value[key].startsWith("/")) {
      throw new Error(`${key} must be an absolute Linux path`);
    }
  }
  return value;
}

function runtimeEnvironment(env, userDataPath, platform = process.platform) {
  if (platform !== "win32") return { ...env };
  const file = path.join(userDataPath, "runtime-settings.json");
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { ...env };
    throw new Error("Cannot read local runtime settings", { cause: error });
  }
  const settings = validateRuntimeSettings(value);
  const next = { ...env };
  // An explicit launch environment remains the operator's override.
  next.ROLEWEAVE_CONTROL_PLANE_MODE = env.ROLEWEAVE_CONTROL_PLANE_MODE ??
    env.ORG_WORKBENCH_CONTROL_PLANE ?? settings.mode;
  for (const [key, name] of [["distro", "ROLEWEAVE_WSL_DISTRO"],
    ["nodePath", "ROLEWEAVE_WSL_NODE"], ["homePath", "ROLEWEAVE_WSL_HOME"]]) {
    if (settings[key] !== undefined && next[name] === undefined) next[name] = settings[key];
  }
  return next;
}

function runtimeDescription(env) {
  const mode = controlPlaneMode(env);
  return { mode, distro: mode === "wsl" ? env.ROLEWEAVE_WSL_DISTRO ?? null : null };
}

function workspaceDialogOptions(env, creating = false) {
  const options = {
    title: creating ? "选择项目保存位置" : "打开 RoleWeave 工作区",
    properties: creating ? ["openDirectory", "createDirectory"] : ["openDirectory"],
  };
  if (controlPlaneMode(env) === "wsl") {
    const distro = env.ROLEWEAVE_WSL_DISTRO;
    options.title += distro ? ` (WSL · ${distro})` : " (WSL)";
    const directory = env.ROLEWEAVE_WSL_HOME ?? "/home";
    options.defaultPath = distro
      ? `\\\\wsl.localhost\\${distro}${directory.replace(/\//g, "\\")}`
      : "\\\\wsl.localhost";
  }
  return options;
}

module.exports = { runtimeEnvironment, runtimeDescription, validateRuntimeSettings, workspaceDialogOptions };

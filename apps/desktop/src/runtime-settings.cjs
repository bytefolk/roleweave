const fs = require("node:fs");
const path = require("node:path");

/** Read the shell-owned runtime selection before starting the control plane. */
function runtimeSettingsEnvironment(userDataPath, env) {
  const file = path.join(userDataPath, "runtime-settings.json");
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("无法读取运行环境设置 runtime-settings.json", { cause: error });
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("运行环境设置必须是一个 JSON 对象");
  }
  const overrides = {};
  if (settings.mode !== undefined) {
    if (settings.mode !== "native" && settings.mode !== "wsl") {
      throw new Error("运行环境 mode 必须是 native 或 wsl");
    }
    if (env.ROLEWEAVE_CONTROL_PLANE_MODE === undefined && env.ORG_WORKBENCH_CONTROL_PLANE === undefined) {
      overrides.ROLEWEAVE_CONTROL_PLANE_MODE = settings.mode;
    }
  }
  for (const [field, variable] of [
    ["distro", "ROLEWEAVE_WSL_DISTRO"],
    ["nodePath", "ROLEWEAVE_WSL_NODE_PATH"],
    ["homePath", "ROLEWEAVE_WSL_HOME"],
  ]) {
    const value = settings[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) {
      throw new Error(`运行环境 ${field} 无效`);
    }
    if ((field === "nodePath" || field === "homePath") && !path.posix.isAbsolute(value)) {
      throw new Error(`运行环境 ${field} 必须是 WSL 绝对路径`);
    }
    if (env[variable] === undefined) overrides[variable] = value;
  }
  return overrides;
}

module.exports = { runtimeSettingsEnvironment };

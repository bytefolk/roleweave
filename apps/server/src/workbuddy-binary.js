// @ts-check

import fs from "node:fs";
import path from "node:path";

/**
 * Resolve a candidate to its executable regular-file target.
 * Mirrors the Qoder/Claude/Codex resolvers: follows symlinks, verifies isFile + X_OK.
 *
 * @param {string} candidate
 * @returns {string | null}
 */
function executableTarget(candidate) {
  try {
    const resolved = fs.realpathSync(candidate);
    if (!fs.statSync(resolved).isFile()) return null;
    fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string | null}
 */
function findOnPath(name, env, platform) {
  const pathValue = env.PATH ?? "";
  if (pathValue.length === 0) return null;
  const extensions = platform === "win32" && path.extname(name).length === 0
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const found = executableTarget(path.join(directory, `${name}${extension}`));
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Keep the operator-selected model an inert value for WorkBuddy's `--model`
 * argument. A leading option marker, control character or unbounded value must
 * fail before spawn rather than turning into an opaque CLI parsing failure.
 *
 * @param {string | undefined} value
 * @returns {string | null | undefined} the value, `null` when it must be
 *   rejected, `undefined` when the operator pinned no model at all
 */
export function validatedWorkbuddyModel(value) {
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) return null;
  return value;
}

/**
 * Resolve the WorkBuddy (CodeBuddy Code) CLI executable without invoking a
 * shell or inspecting account state. Resolution order mirrors the existing
 * resolvers:
 *
 * 1. explicit `DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND` (authoritative; invalid fails closed),
 * 2. `codebuddy` / `codebuddy-code` / `cbc` from PATH,
 * 3. known per-platform desktop install paths (the CLI ships with the
 *    WorkBuddy desktop app and is not on PATH by default).
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} [platform]
 * @returns {string | null}
 */
export function resolveWorkbuddyExecutable(env, platform = process.platform) {
  const explicit = (env.DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND ?? "").trim();
  if (explicit.length > 0) {
    if (/[\u0000-\u001f\u007f]/.test(explicit)) return null;
    const pathLike = path.isAbsolute(explicit) || explicit.includes("/") || explicit.includes("\\");
    return pathLike ? executableTarget(path.resolve(explicit)) : findOnPath(explicit, env, platform);
  }

  for (const name of ["codebuddy", "codebuddy-code", "cbc"]) {
    const fromPath = findOnPath(name, env, platform);
    if (fromPath !== null) return fromPath;
  }

  if (platform === "win32") {
    const programFiles = env["ProgramFiles"] ?? env.PROGRAMFILES ?? "";
    if (path.isAbsolute(programFiles) && !/[\0\r\n]/.test(programFiles)) {
      for (const candidate of [
        path.join(programFiles, "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"),
        path.join(programFiles, "Tencent", "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"),
      ]) {
        const found = executableTarget(candidate);
        if (found !== null) return found;
      }
    }
    const localAppData = env.LOCALAPPDATA ?? "";
    if (path.isAbsolute(localAppData) && !/[\0\r\n]/.test(localAppData)) {
      for (const candidate of [
        path.join(localAppData, "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"),
        path.join(localAppData, "Programs", "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"),
      ]) {
        const found = executableTarget(candidate);
        if (found !== null) return found;
      }
    }
  }

  if (platform === "darwin") {
    const systemInstall = executableTarget("/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy");
    const home = env.HOME ?? "";
    if (path.isAbsolute(home) && !/[\0\r\n]/.test(home)) {
      for (const candidate of [
        path.join(home, "Applications", "WorkBuddy.app", "Contents", "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy"),
      ]) {
        const found = executableTarget(candidate);
        if (found !== null) return found;
      }
    }
    if (systemInstall !== null) return systemInstall;
  }

  return null;
}

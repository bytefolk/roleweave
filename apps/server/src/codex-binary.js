// @ts-check

import fs from "node:fs";
import path from "node:path";

/**
 * Resolve a candidate to its executable regular-file target.
 * Mirrors the Qoder and Claude resolvers: follows symlinks, verifies isFile + X_OK.
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
 * Keep the operator-selected model an inert value for Codex's `--model`
 * argument. A leading option marker, control character or unbounded value must
 * fail before spawn rather than turning into an opaque CLI parsing failure.
 *
 * This lives beside the resolver because both Codex callers need it and both
 * already import this module: bin/qoder-engine.mjs enforces it before spawn,
 * and routes/health.ts applies it as preflight so a guaranteed-failing Host is
 * not reported ready. #236 landed the health copy as a second implementation;
 * the #238 review measured that health growing *stricter* than the engine was
 * untested in either suite, so `OPENAI_MODEL=gpt-5:prod` could have been
 * reported illegal while the engine ran it. That is the same file pair and the
 * same failure mode as windows-launcher.js (see its header, #221) — one
 * implementation is the fix, not a cross-check of two.
 *
 * @param {string | undefined} value
 * @returns {string | null | undefined} the value, `null` when it must be
 *   rejected, `undefined` when the operator pinned no model at all
 */
export function validatedCodexModel(value) {
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) return null;
  return value;
}

/**
 * Resolve the Codex executable without invoking a shell or inspecting account
 * state. Resolution order mirrors the Qoder and Claude contracts:
 *
 * 1. explicit `DIGITAL_EMPLOYEE_CODEX_COMMAND` (authoritative; invalid fails closed),
 * 2. `codex` from PATH,
 * 3. supported per-user install paths for Finder-launched apps.
 *
 * Only exact candidate paths are checked; no home-directory scan is performed.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} [platform]
 * @returns {string | null}
 */
export function resolveCodexExecutable(env, platform = process.platform) {
  const explicit = (env.DIGITAL_EMPLOYEE_CODEX_COMMAND ?? "").trim();
  if (explicit.length > 0) {
    if (explicit.includes("\0")) return null;
    const pathLike = path.isAbsolute(explicit) || explicit.includes("/") || explicit.includes("\\");
    return pathLike ? executableTarget(path.resolve(explicit)) : findOnPath(explicit, env, platform);
  }

  const fromPath = findOnPath("codex", env, platform);
  if (fromPath !== null) return fromPath;

  if (platform === "darwin") {
    const home = env.HOME ?? "";
    if (path.isAbsolute(home) && !/[\0\r\n]/.test(home)) {
      for (const candidate of [
        path.join(home, ".local", "bin", "codex"),
        path.join(home, ".npm-global", "bin", "codex"),
      ]) {
        const found = executableTarget(candidate);
        if (found !== null) return found;
      }
    }
  }
  return null;
}

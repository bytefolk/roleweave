// @ts-check

import fs from "node:fs";
import path from "node:path";

/** @param {string} candidate @returns {string | null} */
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

/** @param {string} name @param {NodeJS.ProcessEnv} env @param {NodeJS.Platform} platform @returns {string | null} */
function findOnPath(name, env, platform) {
  const pathValue = env.PATH ?? "";
  const extensions = platform === "win32" && path.extname(name).length === 0
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of pathValue.split(platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    for (const extension of extensions) {
      const found = executableTarget(path.join(directory, `${name}${extension}`));
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Resolve Gemini CLI without a shell. An explicit override is authoritative:
 * it must resolve to an executable, rather than falling back to an unrelated
 * executable on PATH.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} [platform]
 * @returns {string | null}
 */
export function resolveGeminiExecutable(env, platform = process.platform) {
  const explicit = (env.DIGITAL_EMPLOYEE_GEMINI_COMMAND ?? "").trim();
  if (explicit) {
    if (/[\u0000-\u001f\u007f]/.test(explicit)) return null;
    const pathLike = path.isAbsolute(explicit) || explicit.includes("/") || explicit.includes("\\");
    return pathLike ? executableTarget(path.resolve(explicit)) : findOnPath(explicit, env, platform);
  }
  return findOnPath("gemini", env, platform);
}

/**
 * Gemini's `--model` input is passed as a separate argument, never a shell string.
 * @param {string | undefined} value
 * @returns {string | null | undefined}
 */
export function validatedGeminiModel(value) {
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) return null;
  return value;
}

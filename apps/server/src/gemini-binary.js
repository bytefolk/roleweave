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

/** @typedef {"gemini" | "antigravity"} GeminiClientKind */

/** @param {string} command @returns {GeminiClientKind} */
function inferredClientKind(command) {
  const base = path.basename(command).replace(/\.(?:cmd|bat|exe)$/i, "").toLowerCase();
  return base === "agy" || base === "antigravity" ? "antigravity" : "gemini";
}

/**
 * Resolve either supported Google Agent client. Gemini CLI remains the first
 * choice when both are installed; Antigravity CLI is discovered through its
 * official `agy` launcher (plus the documented legacy `antigravity` alias).
 * An explicit command may select its protocol with
 * DIGITAL_EMPLOYEE_GEMINI_CLIENT=gemini|antigravity; otherwise its basename is
 * used. This keeps arbitrary wrapper scripts usable without executing --help.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} [platform]
 * @returns {{ command: string, client: GeminiClientKind } | null}
 */
export function resolveGeminiClient(env, platform = process.platform) {
  const explicit = (env.DIGITAL_EMPLOYEE_GEMINI_COMMAND ?? "").trim();
  if (explicit) {
    if (/[\u0000-\u001f\u007f]/.test(explicit)) return null;
    const pathLike = path.isAbsolute(explicit) || explicit.includes("/") || explicit.includes("\\");
    const command = pathLike ? executableTarget(path.resolve(explicit)) : findOnPath(explicit, env, platform);
    if (command === null) return null;
    const selected = env.DIGITAL_EMPLOYEE_GEMINI_CLIENT;
    if (selected !== undefined && selected !== "gemini" && selected !== "antigravity") return null;
    return { command, client: selected ?? inferredClientKind(explicit) };
  }
  const gemini = findOnPath("gemini", env, platform);
  if (gemini !== null) return { command: gemini, client: "gemini" };
  for (const name of ["agy", "antigravity"]) {
    const command = findOnPath(name, env, platform);
    if (command !== null) return { command, client: "antigravity" };
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
  return resolveGeminiClient(env, platform)?.command ?? null;
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

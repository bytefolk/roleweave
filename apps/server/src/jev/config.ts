/** Laya System One. Off unless the operator opts in. Empty / missing / "0" / "false" stay off. */

/** Fixed local Laya origin. Overlay/preview never target TypeSafe Jev. */
export const LAYA_ENDPOINT = "http://127.0.0.1:8000/v1/systemone";
/** @deprecated Use LAYA_ENDPOINT. Kept so existing imports keep compiling during the swap. */
export const JEV_ENDPOINT = LAYA_ENDPOINT;

const TRUTHY = new Set(["1", "true", "yes"]);

function envPick(env: NodeJS.Dict<string>, primary: string, fallback: string): string | undefined {
  const left = env[primary];
  if (typeof left === "string" && left.trim() !== "") return left;
  const right = env[fallback];
  if (typeof right === "string" && right.trim() !== "") return right;
  return undefined;
}

function flagOn(raw: string | undefined): boolean {
  return TRUTHY.has((raw ?? "").trim().toLowerCase());
}

/** Prefers ROLEWEAVE_LAYA_ENABLED; ROLEWEAVE_JEV_ENABLED remains a compatible alias. */
export function layaEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  if (Object.prototype.hasOwnProperty.call(env, "ROLEWEAVE_LAYA_ENABLED")) {
    return flagOn(env.ROLEWEAVE_LAYA_ENABLED);
  }
  return flagOn(env.ROLEWEAVE_JEV_ENABLED);
}

/** @deprecated Use layaEnabled. */
export const jevEnabled = layaEnabled;

export function layaRequestConfig(env: NodeJS.Dict<string> = process.env): {
  url: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
} | null {
  if (!layaEnabled(env)) return null;
  const timeoutRaw = Number(envPick(env, "ROLEWEAVE_LAYA_TIMEOUT_MS", "ROLEWEAVE_JEV_TIMEOUT_MS"));
  const modelRaw = envPick(env, "ROLEWEAVE_LAYA_MODEL", "ROLEWEAVE_JEV_MODEL")?.trim() ?? "";
  const model = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(modelRaw) ? modelRaw : "laya";
  const urlRaw = envPick(env, "ROLEWEAVE_LAYA_URL", "ROLEWEAVE_JEV_URL")?.trim() || LAYA_ENDPOINT;
  return {
    url: urlRaw.replace(/\/$/, ""),
    apiKey: envPick(env, "ROLEWEAVE_LAYA_API_KEY", "ROLEWEAVE_JEV_API_KEY")?.trim() ?? "",
    model,
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, 10_000) : 1_500,
  };
}

/** @deprecated Use layaRequestConfig. */
export const jevRequestConfig = layaRequestConfig;

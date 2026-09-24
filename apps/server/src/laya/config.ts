export const LAYA_ENDPOINT = "http://127.0.0.1:18081/v1/systemone";

/** Local Laya remains opt-in so ordinary reads never acquire inference latency. */
export function layaEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  const value = env.ROLEWEAVE_LAYA_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function layaModel(env: NodeJS.Dict<string> = process.env): string {
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(env.ROLEWEAVE_LAYA_MODEL ?? "")
    ? env.ROLEWEAVE_LAYA_MODEL!
    : "typed-decisions";
}

export function isLoopbackEndpoint(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") &&
      url.pathname === "/v1/systemone" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function layaRequestConfig(env: NodeJS.Dict<string> = process.env): {
  url: string;
  model: string;
  timeoutMs: number;
} | null {
  if (!layaEnabled(env)) return null;
  const candidate = (env.ROLEWEAVE_LAYA_URL?.trim() || LAYA_ENDPOINT).replace(/\/$/u, "");
  const timeoutRaw = Number(env.ROLEWEAVE_LAYA_TIMEOUT_MS);
  return {
    url: isLoopbackEndpoint(candidate) ? candidate : LAYA_ENDPOINT,
    model: layaModel(env),
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, 10_000) : 2_000,
  };
}

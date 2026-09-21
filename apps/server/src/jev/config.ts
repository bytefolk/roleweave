/** Jev is off unless the operator opts in. Empty / missing / "0" / "false" stay off. */
export function jevEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  const value = env.ROLEWEAVE_JEV_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function jevRequestConfig(env: NodeJS.Dict<string> = process.env): {
  url: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
} | null {
  if (!jevEnabled(env)) return null;
  const apiKey = env.ROLEWEAVE_JEV_API_KEY?.trim() ?? "";
  if (!apiKey) return null;
  const timeoutRaw = Number(env.ROLEWEAVE_JEV_TIMEOUT_MS);
  return {
    url: (env.ROLEWEAVE_JEV_URL?.trim() || "https://api.typesafe.ai/v1/systemone").replace(/\/$/, ""),
    apiKey,
    model: env.ROLEWEAVE_JEV_MODEL?.trim() || "jev-latest",
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, 10_000) : 1_500,
  };
}

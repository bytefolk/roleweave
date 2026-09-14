import type { DriveObject } from "@roleweave/shared";

/** The mem /v1/files record contract consumed by both reads and compatibility probes. */
export function normalizeMemFile(value: unknown): DriveObject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(raw.id) ||
    typeof raw.name !== "string" || raw.name.length === 0 ||
    typeof raw.size !== "number" || !Number.isSafeInteger(raw.size) || raw.size < 0 ||
    typeof raw.mime !== "string" || raw.mime.length === 0 ||
    typeof raw.created_at !== "string" || !Number.isFinite(Date.parse(raw.created_at)) ||
    (raw.summary != null && typeof raw.summary !== "string") ||
    (raw.caption != null && typeof raw.caption !== "string")
  ) {
    return null;
  }
  const summary = typeof raw.summary === "string" && raw.summary !== ""
    ? raw.summary
    : typeof raw.caption === "string" ? raw.caption : "";
  return {
    id: raw.id,
    name: raw.name,
    size: raw.size,
    mime: raw.mime,
    createdAt: raw.created_at,
    ...(summary !== "" ? { summary } : {}),
  };
}

import crypto from "node:crypto";

export function digest(text: string): string {
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}
/** Stable object ordering; array order continues to express source/criteria order. */
export function serializeContextPayload(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
    : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, ordered(child)])) : item;
  return JSON.stringify(ordered(value));
}

import type { DocPlaneListEntry } from "@roleweave/shared";

export const isDocumentId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

interface UpstreamListEntry {
  id?: unknown;
  title?: unknown;
  icon?: unknown;
  updatedAt?: unknown;
  starred?: unknown;
}
export function normalizeDocEntry(raw: unknown): DocPlaneListEntry | null {
  if (raw === null || typeof raw !== "object") return null;
  const item = raw as UpstreamListEntry;
  if (typeof item.id !== "string" || !isDocumentId(item.id)) return null;
  if (typeof item.title !== "string") return null;
  if (typeof item.updatedAt !== "string") return null;
  return {
    id: item.id,
    title: item.title,
    icon: typeof item.icon === "string" ? item.icon : null,
    updatedAt: item.updatedAt,
    starred: item.starred === true,
  };
}

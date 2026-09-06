import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ORG_LAYOUT_ROOT_KEY,
  ORG_LAYOUT_SCHEMA_VERSION,
} from "@roleweave/shared";
import type { OrgLayoutFile, OrgRole } from "@roleweave/shared";

export const LAYOUT_FILE = path.join(".digital-employee", "org-layout.v1.json");

export function emptyLayout(): OrgLayoutFile {
  return { schemaVersion: ORG_LAYOUT_SCHEMA_VERSION, updatedAt: "", order: {} };
}

/** Missing or unreadable overlay = empty layout (zero migration, D-32-1). */
export async function readLayout(workspaceDir: string): Promise<OrgLayoutFile> {
  let text: string;
  try {
    text = await fs.readFile(path.join(workspaceDir, LAYOUT_FILE), "utf8");
  } catch {
    return emptyLayout();
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.schemaVersion !== ORG_LAYOUT_SCHEMA_VERSION) return emptyLayout();
    const order: Record<string, string[]> = {};
    if (typeof parsed.order === "object" && parsed.order !== null) {
      for (const [key, value] of Object.entries(parsed.order as Record<string, unknown>)) {
        if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
          order[key] = value as string[];
        }
      }
    }
    return {
      schemaVersion: ORG_LAYOUT_SCHEMA_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      order,
    };
  } catch {
    return emptyLayout();
  }
}

export async function writeLayoutAtomic(
  workspaceDir: string,
  layout: OrgLayoutFile,
): Promise<void> {
  const file = path.join(workspaceDir, LAYOUT_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(layout, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export function parentKey(reportTo: string | null): string {
  return reportTo === null ? ORG_LAYOUT_ROOT_KEY : reportTo;
}

/**
 * D-32-3 reconciliation: drop ids that no longer exist, drop parent keys that
 * are no longer parents, append newly-seen children at the end of their
 * parent's list (alphabetical among themselves). Manual ordering survives
 * qoder sync because sync never touches the overlay file.
 */
export function reconcileLayout(
  roles: OrgRole[],
  layout: OrgLayoutFile,
): { layout: OrgLayoutFile; changed: boolean } {
  const childrenByParent = new Map<string, string[]>();
  for (const role of roles) {
    const key = parentKey(role.reportTo);
    const list = childrenByParent.get(key) ?? [];
    list.push(role.id);
    childrenByParent.set(key, list);
  }
  const order: Record<string, string[]> = {};
  let changed = false;
  for (const [key, children] of childrenByParent) {
    const present = new Set(children);
    const kept = (layout.order[key] ?? []).filter((id) => present.has(id));
    const missing = children
      .filter((id) => !kept.includes(id))
      .sort((a, b) => a.localeCompare(b, "en"));
    order[key] = [...kept, ...missing];
    const previous = layout.order[key];
    if (
      previous === undefined ||
      previous.length !== order[key].length ||
      order[key].some((id, index) => previous[index] !== id)
    ) {
      changed = true;
    }
  }
  for (const key of Object.keys(layout.order)) {
    if (!(key in order)) changed = true;
  }
  if (!changed) return { layout, changed: false };
  return {
    layout: { schemaVersion: ORG_LAYOUT_SCHEMA_VERSION, updatedAt: layout.updatedAt, order },
    changed: true,
  };
}

/** Overlay-ordered child ids; unknown ids appended alphabetically (fallback). */
export function orderChildren(
  childIds: string[],
  layout: OrgLayoutFile,
  key: string,
): string[] {
  const list = layout.order[key];
  if (!list) return [...childIds].sort((a, b) => a.localeCompare(b, "en"));
  const present = new Set(childIds);
  const known = list.filter((id) => present.has(id));
  const missing = childIds
    .filter((id) => !list.includes(id))
    .sort((a, b) => a.localeCompare(b, "en"));
  return [...known, ...missing];
}

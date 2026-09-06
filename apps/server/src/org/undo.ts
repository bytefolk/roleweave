import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MovePositionChange, OrgLayoutFile } from "@roleweave/shared";

export const UNDO_FILE = path.join(".digital-employee", "org-undo.v1.json");

/**
 * Single-step undo state (#32 AC-005): the inverse moves of the last
 * drag adjustment plus the layout overlay as it was before. Structural
 * add/delete manifests clear the entry (those restore via BackupTray).
 */
export interface OrgUndoEntry {
  schemaVersion: "org-undo.v1";
  savedAt: string;
  inverseMoves: MovePositionChange[];
  previousLayout: OrgLayoutFile;
}

export async function readUndoEntry(workspaceDir: string): Promise<OrgUndoEntry | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(workspaceDir, UNDO_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as OrgUndoEntry;
    if (parsed.schemaVersion !== "org-undo.v1" || !Array.isArray(parsed.inverseMoves)) {
      return null;
    }
    if (
      typeof parsed.previousLayout !== "object" ||
      parsed.previousLayout === null ||
      typeof parsed.previousLayout.order !== "object"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeUndoEntryAtomic(
  workspaceDir: string,
  entry: OrgUndoEntry,
): Promise<void> {
  const file = path.join(workspaceDir, UNDO_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function clearUndoEntry(workspaceDir: string): Promise<void> {
  await fs.rm(path.join(workspaceDir, UNDO_FILE), { force: true });
}

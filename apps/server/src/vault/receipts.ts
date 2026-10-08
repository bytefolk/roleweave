import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { OrgApiError, errorCodes, isPositionId } from "@roleweave/shared";
import type { VaultUsageNote, VaultUsageResponse } from "@roleweave/shared";
import type { OpenWorkspace } from "../workspace-state.js";
import { validateVaultPath } from "./store.js";
import { readVaultFile } from "./file-read.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^sha256:[0-9a-f]{64}$/;
const MAX_BYTES = 128 * 1024;
interface Receipt { schemaVersion: "vault-usage.v1"; positionId: string; turnId: string; capturedAt: string; notes: VaultUsageNote[] }
const invalid = () => new OrgApiError(errorCodes.vault_request_invalid, 400, "Invalid notebook usage request");
const missing = () => new OrgApiError(errorCodes.vault_note_missing, 404, "A notebook usage receipt is unavailable");
const failed = () => new OrgApiError(errorCodes.vault_storage_failed, 500, "Notebook usage receipt could not be verified");
function identity(positionId: string, turnId: string) { if (!isPositionId(positionId) || !UUID.test(turnId)) throw invalid(); }
function validNotes(value: unknown): value is VaultUsageNote[] {
  if (!Array.isArray(value) || value.length > 4) return false;
  try {
    for (const note of value) {
      if (!note || typeof note !== "object" || Object.keys(note).sort().join(",") !== "excerpt,noteId,path,ref,version" ||
          typeof note.noteId !== "string" || !UUID.test(note.noteId) || note.ref !== "vault://notes/" + note.noteId ||
          typeof note.version !== "string" || !SHA.test(note.version) || typeof note.excerpt !== "string" || Buffer.byteLength(note.excerpt) > 8 * 1024) return false;
      validateVaultPath(note.path, false);
    }
    return Buffer.byteLength(JSON.stringify(value)) <= MAX_BYTES - 1024;
  } catch { return false; }
}
async function directory(file: string) { const st = await fs.lstat(file); if (!st.isDirectory() || st.isSymbolicLink()) throw failed(); }
async function receiptRoot(workspace: OpenWorkspace, create: boolean) {
  let current = path.resolve(workspace.dir); await directory(current);
  for (const segment of [".roleweave", "vault", "receipts"]) {
    current = path.join(current, segment);
    if (create) try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw failed(); }
    await directory(current);
  }
  return current;
}
async function read(root: string, file: string): Promise<Receipt> {
  const bytes = await readVaultFile(root, file, MAX_BYTES, { unsafe: failed, changed: failed, limit: failed });
  let value: Receipt; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw failed(); }
  if (value.schemaVersion !== "vault-usage.v1" || !isPositionId(value.positionId) || !UUID.test(value.turnId) || !Number.isFinite(Date.parse(value.capturedAt)) || !validNotes(value.notes)) throw failed();
  return value;
}

/** Receipt evidence lives alongside turns; the frozen TurnRecord stays intact. */
export async function recordVaultUsage(workspace: OpenWorkspace, positionId: string, turnId: string, notes: VaultUsageNote[]): Promise<void> {
  identity(positionId, turnId); if (!validNotes(notes)) throw invalid();
  const root = await receiptRoot(workspace, true); const file = path.join(root, turnId + ".json");
  const value: Receipt = { schemaVersion: "vault-usage.v1", positionId, turnId, capturedAt: new Date().toISOString(), notes };
  const temp = path.join(root, ".receipt-" + crypto.randomUUID() + ".tmp");
  try {
    await fs.writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    try { await fs.link(temp, file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw failed();
      const existing = await read(workspace.dir, file); if (existing.positionId !== positionId || existing.turnId !== turnId || JSON.stringify(existing.notes) !== JSON.stringify(notes)) throw failed();
    }
  } finally { await fs.unlink(temp).catch(() => {}); }
}
export async function readVaultUsage(workspace: OpenWorkspace, positionId: string, turnId: string): Promise<VaultUsageResponse> {
  identity(positionId, turnId);
  let value: Receipt;
  try { value = await read(workspace.dir, path.join(await receiptRoot(workspace, false), turnId + ".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missing(); throw error; }
  // This identity was captured only after begin persisted this position's turn.
  // Session turns do not have a duplicate position-history record to query.
  if (value.turnId !== turnId || value.positionId !== positionId) throw missing();
  return { notes: value.notes };
}

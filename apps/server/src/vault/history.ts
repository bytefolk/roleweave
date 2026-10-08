import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { OrgApiError, errorCodes, VAULT_MAX_NOTE_BYTES } from "@roleweave/shared";
import type { VaultHistoryVersion } from "@roleweave/shared";
import type { OpenWorkspace } from "../workspace-state.js";
import { readVaultFile } from "./file-read.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_FILE = /^[a-f0-9]{64}\.json$/;
const MAX_RECORD = VAULT_MAX_NOTE_BYTES * 6 + 4096;
const MAX_HISTORY = 64 * 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const failure = () => new OrgApiError(errorCodes.vault_storage_failed, 500, "Note history requires recovery");
const hash = (content: string) => "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
function id(noteId: string): void { if (!UUID.test(noteId)) throw new OrgApiError(errorCodes.vault_request_invalid, 400, "Invalid note identity"); }
function root(workspace: OpenWorkspace): string { return path.join(path.resolve(workspace.dir), ".roleweave", "vault", "history"); }
async function directory(file: string) { const stat = await fs.lstat(file); if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure(); }
async function ensure(workspace: OpenWorkspace, noteId: string): Promise<string> {
  id(noteId); let current = path.resolve(workspace.dir); await directory(current);
  for (const segment of [".roleweave", "vault", "history", noteId]) {
    current = path.join(current, segment); try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw failure(); }
    await directory(current);
  }
  return current;
}
interface Stored { file: string; noteId: string; bytes: number; createdAt: string; version: string }
async function records(workspace: OpenWorkspace): Promise<Stored[]> {
  const base = root(workspace); try { await directory(base); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const output: Stored[] = [];
  for (const entry of await fs.readdir(base, { withFileTypes: true })) {
    if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw failure();
    const noteDir = path.join(base, entry.name); await directory(noteDir);
    for (const leaf of await fs.readdir(noteDir, { withFileTypes: true })) {
      if (leaf.isSymbolicLink()) throw failure();
      if (leaf.name.startsWith(".version-") && leaf.name.endsWith(".tmp")) continue;
      if (!VERSION_FILE.test(leaf.name) || !leaf.isFile() || leaf.isSymbolicLink()) throw failure();
      const file = path.join(noteDir, leaf.name); const before = await fs.lstat(file); if (before.size > MAX_RECORD || before.isSymbolicLink()) throw failure();
      output.push({ file, noteId: entry.name, bytes: before.size, createdAt: before.mtime.toISOString(), version: "sha256:" + leaf.name.slice(0, -5) });
    }
  }
  return output;
}
async function unlinkOwned(workspace: OpenWorkspace, entry: Stored): Promise<void> {
  id(entry.noteId); const base = root(workspace); const file = path.resolve(entry.file); const expected = path.join(base, entry.noteId, entry.version.slice(7) + ".json");
  if (file !== expected || !VERSION_FILE.test(path.basename(file))) throw failure();
  await directory(base); await directory(path.dirname(file)); const st = await fs.lstat(file); if (!st.isFile() || st.isSymbolicLink()) throw failure(); await fs.unlink(file);
}
export async function recordNoteVersion(workspace: OpenWorkspace, noteId: string, notePath: string, content: string): Promise<void> {
  id(noteId); if (Buffer.byteLength(content) > VAULT_MAX_NOTE_BYTES || typeof notePath !== "string" || notePath.length > 1024) throw failure();
  const noteDir = await ensure(workspace, noteId); const version = hash(content); const target = path.join(noteDir, version.slice(7) + ".json");
  const record: VaultHistoryVersion = { version, path: notePath, createdAt: new Date().toISOString(), content };
  const temp = path.join(noteDir, ".version-" + crypto.randomUUID() + ".tmp");
  try {
    await fs.writeFile(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    try { await fs.link(temp, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const st = await fs.lstat(target); if (!st.isFile() || st.isSymbolicLink()) throw failure(); }
  } finally { await fs.unlink(temp).catch(() => {}); }
  const all = (await records(workspace)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.file.localeCompare(a.file));
  const remove = new Set<Stored>(); const counts = new Map<string, number>();
  for (const entry of all) { const count = (counts.get(entry.noteId) ?? 0) + 1; counts.set(entry.noteId, count); if (count > 32) remove.add(entry); }
  let size = all.filter(entry => !remove.has(entry)).reduce((n, entry) => n + entry.bytes, 0);
  for (const entry of [...all].reverse()) { if (size <= MAX_HISTORY) break; if (!remove.has(entry)) { remove.add(entry); size -= entry.bytes; } }
  for (const entry of remove) await unlinkOwned(workspace, entry);
}
export async function history(workspace: OpenWorkspace, noteId: string): Promise<VaultHistoryVersion[]> {
  id(noteId); const found = (await records(workspace)).filter(entry => entry.noteId === noteId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.file.localeCompare(a.file));
  const versions: VaultHistoryVersion[] = [];
  let responseBytes = Buffer.byteLength(JSON.stringify({ schemaVersion: "vault-history.v1", noteId, versions: [] }));
  for (const entry of found) {
    if (versions.length >= 20 || responseBytes + entry.bytes + 1 > MAX_RESPONSE) break;
    let value: VaultHistoryVersion;
    try { value = JSON.parse((await readVaultFile(workspace.dir, entry.file, MAX_RECORD, { unsafe: failure, changed: failure, limit: failure })).toString("utf8")); } catch { throw failure(); }
    if (typeof value.content !== "string" || Buffer.byteLength(value.content) > VAULT_MAX_NOTE_BYTES || value.version !== entry.version || hash(value.content) !== value.version ||
        typeof value.path !== "string" || value.path.length > 1024 || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw failure();
    const record = { version: value.version, path: value.path, createdAt: value.createdAt, content: value.content };
    responseBytes += Buffer.byteLength(JSON.stringify(record)) + 1; if (responseBytes > MAX_RESPONSE) break;
    versions.push(record);
  }
  return versions;
}

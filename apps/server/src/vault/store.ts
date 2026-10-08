import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { TextDecoder } from "node:util";
import { OrgApiError, errorCodes, isPositionId, VAULT_MAX_NOTE_BYTES, VAULT_MAX_ACTIVE_BYTES, VAULT_MAX_NOTES, VAULT_NOTE_SCHEMA_VERSION, VAULT_LIST_SCHEMA_VERSION } from "@roleweave/shared";
import type { VaultNote, VaultNoteResponse, VaultListOptions, VaultListResponse, VaultCreateRequest, VaultSourceRef, VaultBindingsResponse, VaultSourceResponse, LocalVaultSnapshot, VaultSnapshotEntry, VaultImageResponse, VaultHistoryResponse } from "@roleweave/shared";
import type { OpenWorkspace } from "../workspace-state.js";
import { resolvePositionPackageDir } from "../context-sources.js";
import { validateRaster } from "../services/drive-preview.js";
import { history, recordNoteVersion } from "./history.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^sha256:[a-f0-9]{64}$/;
const INDEX_LIMIT = 24 * 1024 * 1024;
const JOURNAL_LIMIT = 128 * 1024 * 1024;
const LEGACY_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml"]);
const locks = new Map<string, Promise<void>>();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const now = () => new Date().toISOString();
export const contentVersion = (content: string | Buffer): string => "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
const invalid = () => new OrgApiError(errorCodes.vault_request_invalid, 400, "Invalid vault request");
const forbidden = () => new OrgApiError(errorCodes.vault_path_forbidden, 403, "The path is outside the permitted vault files");
const conflict = () => new OrgApiError(errorCodes.vault_conflict, 409, "The vault changed; reload before saving");
const missing = () => new OrgApiError(errorCodes.vault_note_missing, 404, "The note is unavailable");
const limit = () => new OrgApiError(errorCodes.vault_limit_exceeded, 413, "The vault exceeds its file or byte limit");
const storage = () => new OrgApiError(errorCodes.vault_storage_failed, 500, "Vault metadata or files require recovery");
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const pathKey = (value: string) => value.normalize("NFC").toLowerCase();

interface LegacyLocation { positionId: string; path: string; root: string }
interface Entry {
  noteId: string; path: string; archived: boolean; deleted: boolean; revision: number;
  hash: string; size: number; modifiedAt: string; properties: Record<string, unknown>;
  legacy?: LegacyLocation;
}
interface Index { schemaVersion: "vault-index.v1"; vaultId: string; title: string; revision: number; updatedAt: string; entries: Entry[]; bindings: Record<string, string[]> }
interface State { index: Index; contents: Map<string, string> }
const boundIds = (index: Index, positionId: string): string[] => Object.hasOwn(index.bindings, positionId) ? index.bindings[positionId]! : [];

export function validateVaultPath(value: unknown, markdown = true): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 512 || value.startsWith("/") || /[\\\x00-\x1f\x7f:*?"<>|]/u.test(value)) throw invalid();
  for (const segment of value.split("/")) {
    if (!segment || segment.startsWith(".") || /[ .]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) throw forbidden();
  }
  if (markdown && !/\.(?:md|markdown)$/iu.test(value)) throw invalid();
  return value;
}
function validateContent(value: unknown): string {
  if (typeof value !== "string" || Buffer.from(value, "utf8").toString("utf8") !== value) throw invalid();
  if (Buffer.byteLength(value, "utf8") > VAULT_MAX_NOTE_BYTES) throw limit();
  return value;
}
function assertId(value: unknown): asserts value is string { if (typeof value !== "string" || !UUID.test(value)) throw invalid(); }
function source(value: unknown): VaultSourceRef | undefined {
  if (value === undefined) return undefined;
  if (!plain(value) || Object.keys(value).some(key => !["positionId", "sessionId", "turnId"].includes(key))) throw invalid();
  for (const v of Object.values(value)) if (typeof v !== "string" || !v || v.length > 128 || /[\x00-\x20\x7f]/.test(v)) throw invalid();
  return value as VaultSourceRef;
}
function displaySource(value: unknown): VaultSourceRef | undefined { try { return source(value); } catch { return undefined; } }
function roleExists(workspace: OpenWorkspace, id: string): void {
  if (!isPositionId(id)) throw invalid();
  if (!workspace.organization.roles.some(role => role.id === id)) throw new OrgApiError(errorCodes.position_missing, 404, "The position is unavailable");
}
function roots(workspace: OpenWorkspace) {
  const root = path.resolve(workspace.dir);
  return { root, notes: path.join(root, "notes"), sidecar: path.join(root, ".roleweave", "vault"), index: path.join(root, ".roleweave", "vault", "index.json"), archive: path.join(root, ".roleweave", "vault", "archive") };
}
async function statOrNull(file: string) { try { return await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
async function realDirectory(file: string): Promise<void> { const st = await fs.lstat(file); if (!st.isDirectory() || st.isSymbolicLink()) throw forbidden(); }
async function ensureDirectories(root: string, relative: string): Promise<void> {
  await realDirectory(root); let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await realDirectory(current);
  }
}
async function regularChain(root: string, file: string): Promise<void> {
  const relative = path.relative(root, file); if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw forbidden();
  await realDirectory(root); let current = root; const pieces = relative.split(path.sep);
  for (let i = 0; i < pieces.length; i++) {
    current = path.join(current, pieces[i]!); const st = await fs.lstat(current);
    if (st.isSymbolicLink() || (i === pieces.length - 1 ? !st.isFile() : !st.isDirectory())) throw forbidden();
  }
}
async function readBytes(root: string, file: string, maxBytes: number): Promise<Buffer> {
  await regularChain(root, file); const before = await fs.lstat(file); if (before.size > maxBytes) throw limit();
  const handle = await fs.open(file, "r");
  try {
    const opened = await handle.stat(); if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile()) throw conflict();
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, before.size + 1)); let bytes = 0;
    while (bytes < buffer.length) { const chunk = await handle.read(buffer, bytes, buffer.length - bytes, bytes); if (!chunk.bytesRead) break; bytes += chunk.bytesRead; }
    if (bytes > maxBytes) throw limit();
    const after = await fs.lstat(file); const final = await handle.stat();
    if (after.size > maxBytes || final.size > maxBytes) throw limit();
    if (after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev || after.size !== bytes || final.size !== bytes || after.mtimeMs !== before.mtimeMs) throw conflict();
    return Buffer.from(buffer.subarray(0, bytes));
  } finally { await handle.close(); }
}
async function readText(root: string, file: string): Promise<string> { try { return decoder.decode(await readBytes(root, file, VAULT_MAX_NOTE_BYTES)); } catch (error) { if (error instanceof TypeError) throw storage(); throw error; } }
async function atomicJson(file: string, value: unknown, maxBytes = INDEX_LIMIT): Promise<void> {
  const temp = path.join(path.dirname(file), ".index-" + crypto.randomUUID() + ".tmp");
  const text = JSON.stringify(value); if (Buffer.byteLength(text) > maxBytes) throw limit();
  try { await fs.writeFile(temp, text, { flag: "wx", mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}
async function saveIndex(workspace: OpenWorkspace, index: Index): Promise<void> { await atomicJson(roots(workspace).index, index); }
function touch(index: Index, entry?: Entry): void { index.revision++; index.updatedAt = now(); if (entry) entry.revision = index.revision; }
async function withLock<T>(workspace: OpenWorkspace, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(workspace.dir); const previous = locks.get(key) ?? Promise.resolve(); let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; }); const chain = previous.then(() => next); locks.set(key, chain);
  await previous;
  try { return await action(); } catch (error) {
    if (error instanceof OrgApiError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missing();
    throw storage();
  } finally { release(); if (locks.get(key) === chain) locks.delete(key); }
}
function physical(workspace: OpenWorkspace, entry: Entry): { root: string; file: string } {
  const r = roots(workspace);
  if (entry.legacy) {
    const role = workspace.organization.roles.find(role => role.id === entry.legacy!.positionId);
    const root = role ? resolvePositionPackageDir(workspace.dir, role) : path.join(r.root, entry.legacy.root);
    const relative = path.relative(r.root, root); if (relative.startsWith("..") || path.isAbsolute(relative)) throw forbidden();
    return { root, file: path.join(root, entry.legacy.path) };
  }
  return entry.archived ? { root: r.archive, file: path.join(r.archive, entry.noteId + ".md") } : { root: r.notes, file: path.join(r.notes, entry.path) };
}
function validateIndex(value: unknown): Index {
  if (!plain(value) || value.schemaVersion !== "vault-index.v1" || typeof value.vaultId !== "string" || !UUID.test(value.vaultId) || typeof value.title !== "string" ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || typeof value.updatedAt !== "string" || !Array.isArray(value.entries) || value.entries.length > VAULT_MAX_NOTES || !plain(value.bindings)) throw storage();
  const ids = new Set<string>();
  for (const raw of value.entries) {
    if (!plain(raw) || typeof raw.noteId !== "string" || !UUID.test(raw.noteId) || ids.has(raw.noteId) || typeof raw.path !== "string" || typeof raw.archived !== "boolean" || typeof raw.deleted !== "boolean" ||
        typeof raw.hash !== "string" || !HASH.test(raw.hash) || !Number.isSafeInteger(raw.size) || typeof raw.modifiedAt !== "string" || !Number.isSafeInteger(raw.revision) || !plain(raw.properties)) throw storage();
    ids.add(raw.noteId); validateVaultPath(raw.path, !raw.legacy);
    if (raw.legacy) {
      if (!plain(raw.legacy) || typeof raw.legacy.positionId !== "string" || typeof raw.legacy.path !== "string" || typeof raw.legacy.root !== "string" || !raw.legacy.path.startsWith("knowledge/") || !raw.legacy.root.startsWith("positions/")) throw storage();
      validateVaultPath(raw.legacy.path, false); validateVaultPath(raw.legacy.root, false);
    }
  }
  for (const noteIds of Object.values(value.bindings)) if (!Array.isArray(noteIds) || noteIds.some(id => typeof id !== "string" || !ids.has(id))) throw storage();
  return value as unknown as Index;
}
async function walk(root: string, relative = ""): Promise<string[]> {
  const stat = await statOrNull(root); if (!stat) return []; if (!stat.isDirectory() || stat.isSymbolicLink()) throw forbidden();
  const output: string[] = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const name = path.posix.join(relative.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) output.push(...await walk(root, name)); else if (entry.isFile()) output.push(name);
    if (output.length > VAULT_MAX_NOTES * 4) throw limit();
  }
  return output;
}
async function ensureLayout(workspace: OpenWorkspace): Promise<void> {
  const r = roots(workspace); await ensureDirectories(r.root, "notes");
  await ensureDirectories(r.root, path.join(".roleweave", "vault", "archive"));
}
async function load(workspace: OpenWorkspace): Promise<State> {
  await ensureLayout(workspace); await recoverJournal(workspace);
  const r = roots(workspace); const st = await statOrNull(r.index);
  let index: Index;
  if (st) { const bytes = await readBytes(r.sidecar, r.index, INDEX_LIMIT); try { index = validateIndex(JSON.parse(bytes.toString("utf8"))); } catch { throw storage(); } }
  else index = { schemaVersion: "vault-index.v1", vaultId: crypto.randomUUID(), title: path.basename(r.root), revision: 0, updatedAt: now(), entries: [], bindings: {} };
  const before = JSON.stringify(index); const contents = new Map<string, string>(); const seen = new Set<string>(); const paths = new Set<string>();
  const discover = async (notePath: string, body: string, legacy?: LegacyLocation) => {
    validateVaultPath(notePath, !legacy); const key = pathKey(notePath); const locationKey = (legacy ? "legacy:" : "note:") + key; if (paths.has(locationKey)) throw conflict(); paths.add(locationKey);
    let entry = index.entries.find(item => !item.deleted && !item.archived && pathKey(item.path) === key && Boolean(item.legacy) === Boolean(legacy));
    const hash = contentVersion(body);
    if (!entry) {
      if (index.entries.length >= VAULT_MAX_NOTES) throw limit();
      entry = { noteId: crypto.randomUUID(), path: notePath, archived: false, deleted: false, revision: 0, hash, size: Buffer.byteLength(body), modifiedAt: now(), properties: {}, ...(legacy ? { legacy } : {}) };
      index.entries.push(entry); touch(index, entry);
      if (legacy) index.bindings[legacy.positionId] = [...new Set([...boundIds(index, legacy.positionId), entry.noteId])];
    } else if (entry.hash !== hash || entry.path !== notePath) {
      entry.path = notePath; entry.hash = hash; entry.size = Buffer.byteLength(body); entry.modifiedAt = now(); touch(index, entry);
    }
    if (legacy) entry.legacy = legacy;
    seen.add(entry.noteId); contents.set(entry.noteId, body);
  };
  for (const file of await walk(r.notes)) {
    if (!/\.(md|markdown)$/i.test(file)) continue;
    await discover(file, await readText(r.notes, path.join(r.notes, file)));
  }
  for (const role of workspace.organization.roles) {
    const dir = resolvePositionPackageDir(workspace.dir, role); const relativeRoot = path.relative(r.root, dir).split(path.sep).join("/");
    if (!relativeRoot.startsWith("positions/") || relativeRoot.split("/").includes("..")) continue;
    for (const file of await walk(path.join(dir, "knowledge"))) {
      if (!LEGACY_EXTENSIONS.has(path.posix.extname(file).toLowerCase())) continue;
      const legacyPath = "knowledge/" + file;
      await discover("positions/" + role.id + "/" + legacyPath, await readText(dir, path.join(dir, legacyPath)), { positionId: role.id, path: legacyPath, root: relativeRoot });
    }
  }
  for (const entry of index.entries) {
    if (entry.deleted) continue;
    if (entry.archived) {
      const location = physical(workspace, entry); if (!await statOrNull(location.file)) { entry.deleted = true; touch(index, entry); continue; }
      const body = await readText(location.root, location.file); const hash = contentVersion(body);
      if (entry.hash !== hash) { entry.hash = hash; entry.size = Buffer.byteLength(body); entry.modifiedAt = now(); touch(index, entry); }
      seen.add(entry.noteId); contents.set(entry.noteId, body);
    } else if (!seen.has(entry.noteId)) { entry.deleted = true; touch(index, entry); }
  }
  const bytes = index.entries.filter(entry => !entry.deleted && !entry.legacy).reduce((total, entry) => total + entry.size, 0);
  if (bytes > VAULT_MAX_ACTIVE_BYTES) throw limit();
  if (!st || before !== JSON.stringify(index)) await saveIndex(workspace, index);
  return { index, contents };
}
function descriptor(state: State, entry: Entry): VaultNote {
  const body = state.contents.get(entry.noteId) ?? "";
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const ref = { uri: "vault://notes/" + entry.noteId, version: entry.hash }; const provenance = displaySource(entry.properties.source);
  return { noteId: entry.noteId, path: entry.path, title: (heading || path.posix.basename(entry.path).replace(/\.(md|markdown)$/i, "")).slice(0, 256), size: entry.size, version: entry.hash,
    modifiedAt: entry.modifiedAt, archived: entry.archived, readOnly: Boolean(entry.legacy), positionIds: Object.entries(state.index.bindings).filter(([, ids]) => ids.includes(entry.noteId)).map(([id]) => id), ref,
    ...(entry.legacy ? { legacy: { positionId: entry.legacy.positionId, path: entry.legacy.path } } : {}), ...(provenance ? { source: provenance } : {}) };
}
function get(state: State, id: unknown): Entry { assertId(id); const entry = state.index.entries.find(item => item.noteId === id && !item.deleted); if (!entry || !state.contents.has(entry.noteId)) throw missing(); return entry; }
function response(state: State, entry: Entry): VaultNoteResponse { return { schemaVersion: VAULT_NOTE_SCHEMA_VERSION, note: descriptor(state, entry), content: state.contents.get(entry.noteId)! }; }
function expect(entry: Entry, version?: unknown): void { if (version !== undefined && (typeof version !== "string" || !HASH.test(version))) throw invalid(); if (version !== undefined && version !== entry.hash) throw conflict(); }
function mutable(entry: Entry): void { if (entry.legacy) throw new OrgApiError(errorCodes.vault_legacy_read_only, 409, "Migrate this legacy note explicitly before changing it"); }
function availablePath(state: State, notePath: string, except?: string): void { if (state.index.entries.some(entry => !entry.deleted && !entry.archived && !entry.legacy && entry.noteId !== except && pathKey(entry.path) === pathKey(notePath))) throw conflict(); }
async function writeNew(workspace: OpenWorkspace, notePath: string, content: string): Promise<void> {
  const r = roots(workspace); const target = path.join(r.notes, notePath); await ensureDirectories(r.notes, path.dirname(notePath));
  try { await fs.writeFile(target, content, { flag: "wx", mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict(); throw error; }
}
async function replace(root: string, file: string, content: string, expectedVersion?: string): Promise<void> {
  await regularChain(root, file); const temp = path.join(path.dirname(file), ".vault-write-" + crypto.randomUUID());
  try { await fs.writeFile(temp, content, { flag: "wx", mode: 0o600 }); if (expectedVersion !== undefined && contentVersion(await readText(root, file)) !== expectedVersion) throw conflict(); await fs.rename(temp, file); } finally { await fs.unlink(temp).catch(() => {}); }
}
async function moveNoReplace(root: string, sourceFile: string, destination: string): Promise<void> {
  await regularChain(root, sourceFile);
  try { await fs.link(sourceFile, destination); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict(); throw error; }
  try { await fs.unlink(sourceFile); } catch (error) { await fs.unlink(destination).catch(() => {}); throw error; }
}

export async function listVaultNotes(workspace: OpenWorkspace, options: VaultListOptions = {}): Promise<VaultListResponse> {
  return withLock(workspace, async () => {
    if (options.positionId) roleExists(workspace, options.positionId);
    const state = await load(workspace); const query = (options.q ?? "").normalize("NFC").toLowerCase(); if (query.length > 256) throw invalid();
    const ids = options.positionId ? new Set(boundIds(state.index, options.positionId)) : null;
    const notes = state.index.entries.filter(entry => !entry.deleted && entry.archived === Boolean(options.archived) && (options.includeLegacy !== false || !entry.legacy) && (!ids || ids.has(entry.noteId)))
      .filter(entry => !query || (entry.path + "\n" + (state.contents.get(entry.noteId) ?? "")).normalize("NFC").toLowerCase().includes(query)).map(entry => descriptor(state, entry)).sort((a, b) => a.path.localeCompare(b.path));
    return { schemaVersion: VAULT_LIST_SCHEMA_VERSION, notes };
  });
}
export async function readVaultNote(workspace: OpenWorkspace, noteId: string): Promise<VaultNoteResponse> { return withLock(workspace, async () => { const state = await load(workspace); return response(state, get(state, noteId)); }); }
export async function createVaultNote(workspace: OpenWorkspace, request: VaultCreateRequest): Promise<VaultNoteResponse> {
  return withLock(workspace, async () => {
    const notePath = validateVaultPath(request.path); const body = validateContent(request.content); const ref = source(request.source); const positions = request.positionIds ?? [];
    if (!Array.isArray(positions) || positions.length > 128 || positions.some(id => typeof id !== "string")) throw invalid(); for (const id of positions) roleExists(workspace, id);
    const state = await load(workspace); availablePath(state, notePath); if (state.index.entries.length >= VAULT_MAX_NOTES || state.index.entries.filter(e => !e.deleted && !e.legacy).reduce((n, e) => n + e.size, Buffer.byteLength(body)) > VAULT_MAX_ACTIVE_BYTES) throw limit();
    await writeNew(workspace, notePath, body);
    const entry: Entry = { noteId: crypto.randomUUID(), path: notePath, hash: contentVersion(body), size: Buffer.byteLength(body), modifiedAt: now(), archived: false, deleted: false, revision: 0, properties: ref ? { source: ref } : {} };
    state.index.entries.push(entry); state.contents.set(entry.noteId, body); touch(state.index, entry);
    for (const id of positions) state.index.bindings[id] = [...new Set([...boundIds(state.index, id), entry.noteId])];
    await saveIndex(workspace, state.index); return response(state, entry);
  });
}
export async function writeVaultNote(workspace: OpenWorkspace, request: { noteId: string; content: string; expectedVersion: string }): Promise<VaultNoteResponse> {
  return withLock(workspace, async () => {
    const body = validateContent(request.content); if (!request.expectedVersion) throw invalid(); const state = await load(workspace); const entry = get(state, request.noteId); mutable(entry); expect(entry, request.expectedVersion);
    if (state.index.entries.filter(e => !e.deleted && !e.legacy && e.noteId !== entry.noteId).reduce((n, e) => n + e.size, Buffer.byteLength(body)) > VAULT_MAX_ACTIVE_BYTES) throw limit();
    const location = physical(workspace, entry); if (contentVersion(await readText(location.root, location.file)) !== request.expectedVersion) throw conflict();
    await recordNoteVersion(workspace, entry.noteId, entry.path, state.contents.get(entry.noteId)!);
    await replace(location.root, location.file, body, request.expectedVersion); entry.hash = contentVersion(body); entry.size = Buffer.byteLength(body); entry.modifiedAt = now(); state.contents.set(entry.noteId, body); touch(state.index, entry); await saveIndex(workspace, state.index); return response(state, entry);
  });
}
export async function renameVaultNote(workspace: OpenWorkspace, request: { noteId: string; path: string; expectedVersion?: string }): Promise<VaultNoteResponse> {
  return withLock(workspace, async () => { const notePath = validateVaultPath(request.path); const state = await load(workspace); const entry = get(state, request.noteId); mutable(entry); expect(entry, request.expectedVersion); availablePath(state, notePath, entry.noteId);
    if (entry.path !== notePath) await recordNoteVersion(workspace, entry.noteId, entry.path, state.contents.get(entry.noteId)!);
    const r = roots(workspace); const from = path.join(r.notes, entry.path); const to = path.join(r.notes, notePath); const moving = !entry.archived && entry.path !== notePath;
    if (moving) await ensureDirectories(r.notes, path.dirname(notePath));
    await mutateFilesAndIndex(workspace, state, moving ? [{ file: from, beforeHash: entry.hash, afterHash: null }, { file: to, beforeHash: null, afterHash: entry.hash }] : [], async () => {
      if (moving) await moveNoReplace(r.notes, from, to);
      entry.path = notePath; entry.modifiedAt = now(); touch(state.index, entry);
    }); return response(state, entry); });
}
export async function archiveVaultNote(workspace: OpenWorkspace, request: { noteId: string; expectedVersion?: string }, restore = false): Promise<VaultNoteResponse> {
  return withLock(workspace, async () => { const state = await load(workspace); const entry = get(state, request.noteId); mutable(entry); expect(entry, request.expectedVersion);
    if (entry.archived === !restore) return response(state, entry); const r = roots(workspace); const from = physical(workspace, entry);
    if (restore) { availablePath(state, entry.path, entry.noteId); await ensureDirectories(r.notes, path.dirname(entry.path)); }
    const to = restore ? path.join(r.notes, entry.path) : path.join(r.archive, entry.noteId + ".md");
    await mutateFilesAndIndex(workspace, state, [{ file: from.file, beforeHash: entry.hash, afterHash: null }, { file: to, beforeHash: null, afterHash: entry.hash }], async () => {
      await moveNoReplace(from.root, from.file, to);
      entry.archived = !restore; entry.modifiedAt = now(); touch(state.index, entry);
    }); return response(state, entry); });
}
export async function deleteVaultNote(workspace: OpenWorkspace, request: { noteId: string; expectedVersion?: string }): Promise<{ noteId: string; deleted: true }> {
  return withLock(workspace, async () => { const state = await load(workspace); const entry = get(state, request.noteId); mutable(entry); expect(entry, request.expectedVersion); if (!entry.archived) throw conflict();
    const location = physical(workspace, entry);
    await mutateFilesAndIndex(workspace, state, [{ file: location.file, beforeHash: entry.hash, afterHash: null }], async () => {
      await regularChain(location.root, location.file); await fs.unlink(location.file); entry.deleted = true; touch(state.index, entry);
    }); return { noteId: entry.noteId, deleted: true }; });
}
export async function migrateLegacyVaultNote(workspace: OpenWorkspace, request: { noteId: string; path: string; expectedVersion: string }): Promise<VaultNoteResponse> {
  return withLock(workspace, async () => { const notePath = validateVaultPath(request.path); const state = await load(workspace); const entry = get(state, request.noteId); if (!entry.legacy) throw invalid(); expect(entry, request.expectedVersion); availablePath(state, notePath);
    const from = physical(workspace, entry); const r = roots(workspace); const to = path.join(r.notes, notePath); await ensureDirectories(r.notes, path.dirname(notePath));
    await mutateFilesAndIndex(workspace, state, [{ file: from.file, beforeHash: entry.hash, afterHash: null }, { file: to, beforeHash: null, afterHash: entry.hash }], async () => {
      await moveNoReplace(from.root, from.file, to);
      entry.properties.legacyRef = { positionId: entry.legacy!.positionId, path: entry.legacy!.path }; delete entry.legacy; entry.path = notePath; entry.modifiedAt = now(); touch(state.index, entry);
    }); return response(state, entry); });
}
export async function vaultBindings(workspace: OpenWorkspace, positionId?: string): Promise<VaultBindingsResponse> {
  return withLock(workspace, async () => { if (positionId) roleExists(workspace, positionId); const { index } = await load(workspace); return { schemaVersion: "vault-bindings.v1", bindings: (positionId ? [positionId] : Object.keys(index.bindings)).map(id => ({ positionId: id, noteIds: [...boundIds(index, id)] })) }; });
}
export async function bindVaultNotes(workspace: OpenWorkspace, positionId: string, noteIds: string[]): Promise<VaultBindingsResponse> {
  return withLock(workspace, async () => { roleExists(workspace, positionId); if (!Array.isArray(noteIds) || noteIds.length > VAULT_MAX_NOTES) throw invalid(); const state = await load(workspace); for (const id of noteIds) { const entry = get(state, id); if (entry.archived) throw conflict(); }
    state.index.bindings[positionId] = [...new Set(noteIds)]; touch(state.index); await saveIndex(workspace, state.index); return { schemaVersion: "vault-bindings.v1", bindings: [{ positionId, noteIds: state.index.bindings[positionId]! }] }; });
}
export async function vaultSource(workspace: OpenWorkspace, positionId?: string): Promise<VaultSourceResponse> {
  return withLock(workspace, async () => { if (positionId) roleExists(workspace, positionId); const { index } = await load(workspace); const ids = positionId ? new Set(boundIds(index, positionId)) : null; const entries = index.entries.filter(e => !e.deleted && !e.archived && (!ids || ids.has(e.noteId)));
    return { schemaVersion: "vault-source.v1", vaultId: index.vaultId, title: index.title, root: "notes", noteCount: entries.filter(e => !e.legacy).length, legacyCount: entries.filter(e => e.legacy).length, bindingCount: positionId ? boundIds(index, positionId).length : Object.values(index.bindings).reduce((n, ids) => n + ids.length, 0) }; });
}
export async function resolveVaultNote(workspace: OpenWorkspace, uri: string): Promise<VaultNoteResponse> {
  const match = /^vault:\/\/notes\/([0-9a-f-]+)$/i.exec(uri); if (match) return readVaultNote(workspace, match[1]!);
  const legacy = /^owb-doc:\/\/([^/]+)\/(knowledge\/.+)$/.exec(uri); if (!legacy) throw invalid();
  return withLock(workspace, async () => { const state = await load(workspace); const entry = state.index.entries.find(item => !item.deleted &&
    (item.legacy && item.legacy.positionId === legacy[1] && item.legacy.path === legacy[2] || plain(item.properties.legacyRef) && item.properties.legacyRef.positionId === legacy[1] && item.properties.legacyRef.path === legacy[2]));
    if (!entry) throw missing(); return response(state, entry); });
}
/** Server-owned runtime seam: only active, explicitly associated note bodies. */
export async function readPositionVaultNotes(workspace: OpenWorkspace, positionId: string): Promise<Array<VaultNoteResponse & { readPath: string }>> {
  return withLock(workspace, async () => { roleExists(workspace, positionId); const state = await load(workspace); const ids = new Set(boundIds(state.index, positionId));
    return state.index.entries.filter(e => !e.deleted && !e.archived && ids.has(e.noteId)).map(entry => { const location = physical(workspace, entry); return { ...response(state, entry), readPath: path.relative(roots(workspace).root, location.file).split(path.sep).join("/") }; }); });
}
export async function readVaultHistory(workspace: OpenWorkspace, noteId: string): Promise<VaultHistoryResponse> {
  return withLock(workspace, async () => { const state = await load(workspace); get(state, noteId); return { schemaVersion: "vault-history.v1", noteId, versions: await history(workspace, noteId) }; });
}
export async function readVaultImage(workspace: OpenWorkspace, imagePath: string, notePath?: string): Promise<VaultImageResponse> {
  return withLock(workspace, async () => { if (imagePath.startsWith("/") || imagePath.includes("\\") || imagePath.includes(":")) throw forbidden();
    const relative = imagePath.startsWith("assets/") || !notePath ? imagePath : path.posix.join(path.posix.dirname(validateVaultPath(notePath, false)), imagePath);
    const safe = validateVaultPath(path.posix.normalize(relative), false); const extension = path.posix.extname(safe).toLowerCase();
    const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" } as const)[extension as ".png"];
    if (!mime) throw invalid(); const r = roots(workspace); const bytes = await readBytes(r.notes, path.join(r.notes, safe), 8 * 1024 * 1024); validateRaster(bytes, mime);
    return { preview: { path: safe, mime, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` } }; });
}

function snapshot(state: State): LocalVaultSnapshot {
  const entries: VaultSnapshotEntry[] = state.index.entries.filter(e => !e.legacy).map(entry => ({ noteId: entry.noteId, path: entry.path, content: entry.deleted ? "" : state.contents.get(entry.noteId)!, revision: entry.revision, deleted: entry.deleted,
    properties: { ...entry.properties, archived: entry.archived, positionIds: Object.entries(state.index.bindings).filter(([, ids]) => ids.includes(entry.noteId)).map(([id]) => id) } })).sort((a, b) => a.noteId.localeCompare(b.noteId));
  const body = { schemaVersion: "vault-snapshot.v1" as const, vaultId: state.index.vaultId, title: state.index.title, revision: state.index.revision, updatedAt: state.index.updatedAt, entries };
  return { ...body, expectedHash: contentVersion(JSON.stringify({ vaultId: body.vaultId, title: body.title, entries, bindings: state.index.bindings })) };
}
export async function exportLocalVaultSnapshot(workspace: OpenWorkspace): Promise<LocalVaultSnapshot> { return withLock(workspace, async () => snapshot(await load(workspace))); }

interface Journal { phase: "prepared" | "writing"; index: Index; files: Array<{ path: string; content: string | null; afterHash: string | null }> }
function journalPath(value: string, index?: Index): string {
  if (/^\.roleweave\/vault\/archive\/[0-9a-f-]+\.md$/i.test(value)) { assertId(path.posix.basename(value, ".md")); return value; }
  // Only explicit legacy migrations may journal their already-indexed source.
  if (index?.entries.some(entry => entry.legacy && value === path.posix.join(entry.legacy.root, entry.legacy.path))) { validateVaultPath(value, false); return value; }
  if (!value.startsWith("notes/")) throw storage(); validateVaultPath(value.slice("notes/".length)); return value;
}
async function recoverJournal(workspace: OpenWorkspace): Promise<void> {
  const r = roots(workspace); const file = path.join(r.sidecar, "apply-journal.json"); if (!await statOrNull(file)) return;
  let journal: Journal; try { journal = JSON.parse((await readBytes(r.sidecar, file, JOURNAL_LIMIT)).toString("utf8")); validateIndex(journal.index); } catch { throw storage(); }
  if (journal.phase === "prepared") { await fs.unlink(file); return; }
  if (journal.phase !== "writing") throw storage();
  if (!Array.isArray(journal.files) || journal.files.length > VAULT_MAX_NOTES * 2) throw storage();
  for (const item of journal.files) {
    journalPath(item.path, journal.index); if (item.afterHash !== null && (typeof item.afterHash !== "string" || !HASH.test(item.afterHash))) throw storage();
    const target = path.join(r.root, item.path); const current = await statOrNull(target);
    // Restore only our post-image. An Obsidian/external edit after the failed
    // transaction is retained, rather than overwritten by the backup.
    const currentHash = current ? contentVersion(await readText(r.root, target)) : null;
    if (currentHash !== item.afterHash) continue;
    if (item.content === null) { if (current) { await regularChain(r.root, target); await fs.unlink(target); } }
    else { validateContent(item.content); await ensureDirectories(r.root, path.dirname(item.path)); const st = await statOrNull(target); if (st) await replace(r.root, target, item.content); else await fs.writeFile(target, item.content, { flag: "wx", mode: 0o600 }); }
  }
  await saveIndex(workspace, journal.index); await fs.unlink(file);
}
/** File moves and their identities commit together, including after an I/O
 * failure or process restart. Reuse the snapshot pre-image recovery journal. */
async function mutateFilesAndIndex(workspace: OpenWorkspace, state: State, changes: Array<{ file: string; beforeHash: string | null; afterHash: string | null }>, action: () => Promise<void>): Promise<void> {
  if (changes.length === 0) { await action(); await saveIndex(workspace, state.index); return; }
  const r = roots(workspace); const journalFile = path.join(r.sidecar, "apply-journal.json");
  const journal: Journal = { phase: "prepared", index: structuredClone(state.index), files: [] };
  for (const change of changes) {
    const relative = path.relative(r.root, change.file).split(path.sep).join("/"); journalPath(relative, journal.index);
    const current = await statOrNull(change.file); const content = current ? await readText(r.root, change.file) : null;
    if ((content === null ? null : contentVersion(content)) !== change.beforeHash) throw conflict();
    journal.files.push({ path: relative, content, afterHash: change.afterHash });
  }
  await atomicJson(journalFile, journal, JOURNAL_LIMIT);
  try {
    for (const item of journal.files) {
      const target = path.join(r.root, item.path); const current = await statOrNull(target); const hash = current ? contentVersion(await readText(r.root, target)) : null;
      if (hash !== (item.content === null ? null : contentVersion(item.content))) throw conflict();
    }
    journal.phase = "writing"; await atomicJson(journalFile, journal, JOURNAL_LIMIT);
    await action(); await saveIndex(workspace, state.index); await fs.unlink(journalFile);
  } catch (error) { await recoverJournal(workspace).catch(() => {}); throw error; }
}
/** Full-snapshot apply with a durable pre-image journal and local content CAS.
 * Remote properties cannot enlarge local role bindings; legacy files are untouched. */
export async function applyLocalVaultSnapshot(workspace: OpenWorkspace, incoming: Omit<LocalVaultSnapshot, "expectedHash">, options: { expectedHash: string }): Promise<LocalVaultSnapshot> {
  return withLock(workspace, async () => {
    const state = await load(workspace); const current = snapshot(state); if (!HASH.test(options.expectedHash) || current.expectedHash !== options.expectedHash) throw conflict();
    if (incoming.schemaVersion !== "vault-snapshot.v1" || incoming.vaultId !== state.index.vaultId || !Array.isArray(incoming.entries) || incoming.entries.length > VAULT_MAX_NOTES || typeof incoming.title !== "string" || Buffer.byteLength(incoming.title) > 256 || /[\x00-\x1f\x7f]/.test(incoming.title)) throw invalid();
    const ids = new Set<string>(); const activePaths = new Set<string>(); let total = 0;
    for (const item of incoming.entries) { assertId(item.noteId); if (ids.has(item.noteId) || typeof item.deleted !== "boolean" || !Number.isSafeInteger(item.revision) || item.revision < 0 || state.index.entries.some(e => e.legacy && e.noteId === item.noteId)) throw invalid(); ids.add(item.noteId); validateVaultPath(item.path); validateContent(item.content); if (item.deleted && item.content !== "") throw invalid();
      if (item.properties !== undefined && (!plain(item.properties) || Buffer.byteLength(JSON.stringify(item.properties)) > 16 * 1024)) throw invalid();
      if (!item.deleted) { if (activePaths.has(pathKey(item.path))) throw conflict(); activePaths.add(pathKey(item.path)); total += Buffer.byteLength(item.content); }
    }
    // A full remote snapshot must explicitly retain or tombstone local heads;
    // merely omitting an unsynced local note is never permission to erase it.
    if (state.index.entries.some(entry => !entry.legacy && !entry.deleted && !ids.has(entry.noteId))) throw conflict();
    if (total > VAULT_MAX_ACTIVE_BYTES) throw limit();
    const r = roots(workspace); const next = structuredClone(state.index); const affected = new Set<string>(); const ownedPaths = new Set<string>(); const writes = new Map<string, string>();
    for (const old of next.entries.filter(e => !e.legacy && !e.deleted)) { const relative = path.relative(r.root, physical(workspace, old).file).split(path.sep).join("/"); affected.add(relative); ownedPaths.add(relative); }
    next.entries = next.entries.filter(e => e.legacy);
    for (const item of incoming.entries) {
      const properties = { ...(item.properties ?? {}) }; delete properties.positionIds;
      const previous = state.index.entries.find(entry => entry.noteId === item.noteId && !entry.legacy);
      if (previous?.properties.legacyRef) properties.legacyRef = previous.properties.legacyRef; else delete properties.legacyRef;
      const archived = properties.archived === true;
      const entry: Entry = { noteId: item.noteId, path: item.path, archived, deleted: item.deleted, revision: 0, hash: contentVersion(item.content), size: Buffer.byteLength(item.content), modifiedAt: now(), properties };
      next.entries.push(entry); if (next.entries.length > VAULT_MAX_NOTES) throw limit();
      if (!entry.deleted) { const relative = path.relative(r.root, physical(workspace, entry).file).split(path.sep).join("/"); affected.add(relative); writes.set(relative, item.content); }
    }
    next.title = incoming.title; touch(next); for (const entry of next.entries.filter(e => !e.legacy)) entry.revision = next.revision;
    for (const id of Object.keys(next.bindings)) next.bindings[id] = next.bindings[id]!.filter(noteId => next.entries.some(entry => entry.noteId === noteId && !entry.deleted));
    const beforeFiles: Journal["files"] = [];
    for (const relative of affected) { journalPath(relative); const absolute = path.join(r.root, relative); const st = await statOrNull(absolute); if (st && !ownedPaths.has(relative)) throw conflict(); beforeFiles.push({ path: relative, content: st ? await readText(r.root, absolute) : null, afterHash: writes.has(relative) ? contentVersion(writes.get(relative)!) : null }); }
    const journalFile = path.join(r.sidecar, "apply-journal.json"); const journal: Journal = { phase: "prepared", index: state.index, files: beforeFiles }; await atomicJson(journalFile, journal, JOURNAL_LIMIT);
    try {
      // Re-check every pre-image just before changing any file.
      for (const before of beforeFiles) { const absolute = path.join(r.root, before.path); const st = await statOrNull(absolute); if (before.content === null ? st !== null : !st || contentVersion(await readText(r.root, absolute)) !== contentVersion(before.content)) throw conflict(); }
      journal.phase = "writing"; await atomicJson(journalFile, journal, JOURNAL_LIMIT);
      for (const entry of state.index.entries.filter(e => !e.legacy && !e.deleted)) {
        const original = state.contents.get(entry.noteId)!; const replacement = incoming.entries.find(item => item.noteId === entry.noteId);
        if (!replacement || replacement.deleted || replacement.content !== original || replacement.path !== entry.path) await recordNoteVersion(workspace, entry.noteId, entry.path, original);
      }
      for (const relative of affected) {
        const absolute = path.join(r.root, relative); const content = writes.get(relative); const st = await statOrNull(absolute);
        const preimage = beforeFiles.find(item => item.path === relative)!;
        if (preimage.content === null ? st !== null : !st || contentVersion(await readText(r.root, absolute)) !== contentVersion(preimage.content)) throw conflict();
        if (content === undefined) { if (st) { await regularChain(r.root, absolute); await fs.unlink(absolute); } }
        else { await ensureDirectories(r.root, path.dirname(relative)); if (st) await replace(r.root, absolute, content, contentVersion(preimage.content!)); else await fs.writeFile(absolute, content, { flag: "wx", mode: 0o600 }); }
      }
      await saveIndex(workspace, next); await fs.unlink(journalFile);
    } catch (error) { await recoverJournal(workspace); throw error; }
    return snapshot(await load(workspace));
  });
}

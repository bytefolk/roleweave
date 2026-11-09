import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import type { OpenWorkspace } from "../workspace-state.js";
import type { ServiceConnection } from "../services/connections.js";
import { normalizeServiceUrl } from "../services/connections.js";
import { previewMime, validateRaster } from "../services/drive-preview.js";
import { validateVaultPath } from "./store.js";
import { readVaultFile } from "./file-read.js";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_BATCH_BYTES = 128 * 1024 * 1024;
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const MAX_ASSETS = 2048;
const MAX_NOTE_ASSETS = 64;
const TIMEOUT_MS = 30_000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const locks = new Map<string, Promise<void>>();
const invalid = () => new OrgApiError(errorCodes.vault_request_invalid, 400, "Invalid Vault attachment");
const conflict = () => new OrgApiError(errorCodes.vault_conflict, 409, "The Vault attachment changed; existing files were preserved");
const limit = () => new OrgApiError(errorCodes.vault_limit_exceeded, 413, "Vault attachment exceeds the byte or count limit");
const unsafe = () => new OrgApiError(errorCodes.vault_path_forbidden, 403, "The attachment path is outside the permitted Vault files");
const unavailable = () => new OrgApiError(errorCodes.service_upstream_failed, 502, "Mem attachment storage is unavailable or returned an invalid response", true);
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const MIME_BY_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".svg": "image/svg+xml",
  ".zip": "application/zip", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".wav": "audio/wav" };

export interface VaultAssetReference { path: string; fileId: string; mime: string; sha256: string; size?: number; name?: string }
interface AssetRecord extends VaultAssetReference { size: number; name: string }
interface Ledger { schemaVersion: "vault-assets.v1"; assets: AssetRecord[] }
interface AttachmentEntry { path: string; content: string; deleted?: boolean; properties?: Record<string, unknown> }
interface MemFile { id: string; name: string; mime: string; size: number; sha256: string }

async function locked<T>(workspace: OpenWorkspace, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(workspace.dir); const before = locks.get(key) ?? Promise.resolve(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const next = before.then(() => gate); locks.set(key, next);
  await before;
  try { return await action(); }
  catch (error) { if (error instanceof OrgApiError) throw error; throw new OrgApiError(errorCodes.vault_storage_failed, 500, "Vault attachments could not be persisted"); }
  finally { release(); if (locks.get(key) === next) locks.delete(key); }
}

function capturedConnection(connection: ServiceConnection): ServiceConnection {
  if (connection.kind !== "mem" || typeof connection.workspaceId !== "string" || !UUID.test(connection.workspaceId)) throw invalid();
  return { ...connection, apiUrl: normalizeServiceUrl(connection.apiUrl) };
}
function headers(connection: ServiceConnection): Record<string, string> {
  return { accept: "application/json", ...(connection.token ? { authorization: `Bearer ${connection.token}` } : {}), "X-Workspace-ID": connection.workspaceId! };
}
function target(connection: ServiceConnection, route: string): string {
  const result = new URL(connection.apiUrl + route); if (result.origin !== new URL(connection.apiUrl).origin) throw invalid(); return result.href;
}
function mime(value: unknown): string {
  if (typeof value !== "string") throw invalid();
  const type = value.split(";", 1)[0]!.trim().toLowerCase();
  if (type.length > 128 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) throw invalid();
  return type;
}
function safeAssetPath(value: unknown): string {
  const result = validateVaultPath(value, false);
  if (!result.startsWith("assets/") || result === "assets/") throw unsafe();
  return result;
}
function memFile(value: unknown, expectedID?: string): MemFile {
  if (!plain(value) || typeof value.id !== "string" || !ID.test(value.id) || expectedID !== undefined && value.id !== expectedID ||
      typeof value.name !== "string" || !value.name || Buffer.byteLength(value.name) > 512 || /[\\/\x00-\x1f\x7f]/u.test(value.name) ||
      !Number.isSafeInteger(value.size) || (value.size as number) < 0 || typeof value.sha256 !== "string" || !SHA.test(value.sha256)) throw unavailable();
  if ((value.size as number) > MAX_FILE_BYTES) throw limit();
  return { id: value.id, name: value.name, mime: mime(value.mime), size: value.size as number, sha256: value.sha256 };
}
async function responseBytes(response: Response, maximum: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); throw limit(); }
  const parts: Uint8Array[] = []; let size = 0; const reader = response.body?.getReader();
  if (reader) {
    try { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw limit(); } parts.push(result.value); } }
    finally { reader.releaseLock(); }
  }
  return Buffer.concat(parts, size);
}
async function requestJSON(connection: ServiceConnection, route: string, init?: RequestInit): Promise<unknown> {
  try {
    const response = await fetch(target(connection, route), { ...init, headers: headers(connection), redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) { await response.body?.cancel(); throw unavailable(); }
    const bytes = await responseBytes(response, 256 * 1024);
    try { return JSON.parse(bytes.toString("utf8")); } catch { throw unavailable(); }
  } catch (error) { if (error instanceof OrgApiError) throw error; throw unavailable(); }
}
async function download(connection: ServiceConnection, fileId: string, expected?: VaultAssetReference): Promise<{ file: MemFile; bytes: Buffer }> {
  if (!ID.test(fileId)) throw invalid();
  const file = memFile(await requestJSON(connection, `/v1/files/${encodeURIComponent(fileId)}`), fileId);
  if (expected && (expected.sha256 !== file.sha256 || expected.mime !== file.mime || expected.size !== undefined && expected.size !== file.size)) throw conflict();
  try {
    const response = await fetch(target(connection, `/v1/files/${encodeURIComponent(fileId)}/content`),
      { headers: headers(connection), redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
    const bytes = await responseBytes(response, MAX_FILE_BYTES);
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw unavailable();
    const raster = previewMime(file.mime); if (raster) validateRaster(bytes, raster);
    return { file, bytes };
  } catch (error) { if (error instanceof OrgApiError) throw error; throw unavailable(); }
}

async function stat(file: string) { try { return await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
async function ensureDirectory(root: string, relative: string): Promise<void> {
  const start = await fs.lstat(root); if (!start.isDirectory() || start.isSymbolicLink()) throw unsafe();
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await fs.lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw unsafe();
  }
}
async function safeLocalRead(workspace: OpenWorkspace, relative: string, maximum = MAX_FILE_BYTES): Promise<Buffer | null> {
  const root = path.resolve(workspace.dir);
  try { return await readVaultFile(root, path.join(root, relative), maximum, { unsafe, changed: conflict, limit }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function loadLedger(workspace: OpenWorkspace): Promise<Ledger> {
  await ensureDirectory(path.resolve(workspace.dir), path.join(".roleweave", "vault"));
  const bytes = await safeLocalRead(workspace, path.join(".roleweave", "vault", "assets.json"), MAX_LEDGER_BYTES);
  if (!bytes) return { schemaVersion: "vault-assets.v1", assets: [] };
  let raw: unknown; try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw invalid(); }
  if (!plain(raw) || raw.schemaVersion !== "vault-assets.v1" || !Array.isArray(raw.assets) || raw.assets.length > MAX_ASSETS) throw invalid();
  const seen = new Set<string>(); const assets = raw.assets.map(value => {
    const asset = reference(value);
    if (asset.size === undefined || asset.name === undefined || seen.has(asset.path.normalize("NFC").toLowerCase())) throw invalid();
    seen.add(asset.path.normalize("NFC").toLowerCase()); return asset as AssetRecord;
  });
  return { schemaVersion: "vault-assets.v1", assets };
}
async function saveLedger(workspace: OpenWorkspace, ledger: Ledger): Promise<void> {
  if (ledger.assets.length > MAX_ASSETS) throw limit();
  const value = JSON.stringify(ledger); if (Buffer.byteLength(value) > MAX_LEDGER_BYTES) throw limit();
  const dir = path.join(path.resolve(workspace.dir), ".roleweave", "vault"); const file = path.join(dir, "assets.json");
  const existing = await stat(file); if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw unsafe();
  const temp = path.join(dir, ".asset-index-" + crypto.randomUUID() + ".tmp");
  try { await fs.writeFile(temp, value, { flag: "wx", mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}
function record(ledger: Ledger, asset: AssetRecord): void {
  const index = ledger.assets.findIndex(value => value.path.normalize("NFC").toLowerCase() === asset.path.normalize("NFC").toLowerCase());
  if (index >= 0) ledger.assets[index] = asset; else ledger.assets.push(asset);
  if (ledger.assets.length > MAX_ASSETS) throw limit();
}
async function writeNewAsset(workspace: OpenWorkspace, assetPath: string, bytes: Buffer, expectedHash: string): Promise<void> {
  safeAssetPath(assetPath); return writeNewRelative(workspace, path.join("notes", assetPath), bytes, expectedHash);
}
async function writeNewRelative(workspace: OpenWorkspace, relative: string, bytes: Buffer, expectedHash: string): Promise<void> {
  const old = await safeLocalRead(workspace, relative);
  if (old) { if (digest(old) !== expectedHash) throw conflict(); return; }
  const root = path.resolve(workspace.dir); const destination = path.join(root, relative);
  await ensureDirectory(root, path.dirname(relative));
  const temp = path.join(path.dirname(destination), ".asset-" + crypto.randomUUID() + ".tmp");
  try {
    await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
    try { await fs.link(temp, destination); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const concurrent = await safeLocalRead(workspace, relative); if (!concurrent || digest(concurrent) !== expectedHash) throw conflict();
    }
  } finally { await fs.unlink(temp).catch(() => {}); }
}

const assetKey = (value: string) => value.normalize("NFC").toLowerCase();
function assertDeclaredAssetAliases(entries: readonly AttachmentEntry[]): void {
  const aliases = new Map<string, Map<string, Set<string>>>();
  for (const entry of entries) {
    if (entry.deleted) continue;
    const mentioned = new Set(referencedVaultAssetPaths(entry).map(assetKey));
    const current = new Map<string, string>();
    for (const asset of references(entry)) {
      const key = assetKey(asset.path); if (!mentioned.has(key)) continue;
      const previous = current.get(key); if (previous && previous !== asset.sha256) throw conflict();
      current.set(key, asset.sha256);
      let paths = aliases.get(key); if (!paths) { paths = new Map(); aliases.set(key, paths); }
      for (const [source, hashes] of paths) if (source !== asset.path && [...hashes].some(hash => hash !== asset.sha256)) throw conflict();
      let hashes = paths.get(asset.path); if (!hashes) { hashes = new Set(); paths.set(asset.path, hashes); } hashes.add(asset.sha256);
    }
  }
}
async function assertLocalAssetAliases(workspace: OpenWorkspace, entries: readonly AttachmentEntry[]): Promise<void> {
  const aliases = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.deleted || entry.properties?.archived === true) continue;
    for (const assetPath of referencedVaultAssetPaths(entry)) {
      const key = assetKey(assetPath); let paths = aliases.get(key);
      if (!paths) { paths = new Set(); aliases.set(key, paths); } paths.add(assetPath);
    }
  }
  // Portable filenames may alias on another OS. Verify all distinct local
  // sources before uploading or rewriting either source's references.
  for (const paths of aliases.values()) {
    if (paths.size < 2) continue;
    let hash: string | undefined;
    for (const assetPath of paths) {
      const bytes = await safeLocalRead(workspace, path.join("notes", assetPath)); if (!bytes) continue;
      const next = digest(bytes); if (hash && hash !== next) throw conflict(); hash = next;
    }
  }
}
function assetExtension(type: string, name: string): string {
  const raster = previewMime(type);
  return raster ? ({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" } as const)[raster]
    : /^\.[a-z0-9]{1,12}$/i.test(path.posix.extname(name)) ? path.posix.extname(name).toLowerCase() : ".bin";
}
function versionPath(sha256: string, type: string, name: string): string {
  if (!SHA.test(sha256)) throw invalid();
  return safeAssetPath(`assets/${sha256}${assetExtension(type, name)}`);
}
function versionHash(assetPath: string): string | null {
  return /^assets\/([a-f0-9]{64})\.[a-z0-9]{1,12}$/i.exec(assetPath)?.[1]?.toLowerCase() ?? null;
}
function resolveAssetTarget(notePath: string, raw: string): string | null {
  let value = raw.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith("//") || value.startsWith("#")) return null;
  value = value.split("#", 1)[0]!; try { value = decodeURIComponent(value); } catch { throw invalid(); }
  if (!value.includes("assets/")) return null;
  if (value.startsWith("/") || value.includes("\\") || value.includes(":")) throw unsafe();
  return safeAssetPath(path.posix.normalize(value.startsWith("assets/") ? value : path.posix.join(path.posix.dirname(notePath), value)));
}
function rewriteAssetTargets(entry: AttachmentEntry, mappings: ReadonlyMap<string, string>): string {
  let content = entry.content.replace(/!?\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\)\r\n]+?))(?:\s+["'][^\r\n]*["'])?\s*\)/gu, (full: string, angled: string | undefined, bare: string | undefined) => {
    const targetText = (angled ?? bare ?? "").replace(/\s+["'].*["']\s*$/u, "").trim();
    const source = resolveAssetTarget(entry.path, targetText); const replacement = source ? mappings.get(assetKey(source)) : undefined;
    if (!replacement) return full;
    const fragment = targetText.includes("#") ? targetText.slice(targetText.indexOf("#")) : "";
    const relative = path.posix.relative(path.posix.dirname(entry.path), replacement);
    const targetStart = full.indexOf("](") + 2; const offset = full.indexOf(targetText, targetStart);
    return offset < targetStart ? full : full.slice(0, offset) + relative + fragment + full.slice(offset + targetText.length);
  });
  content = content.replace(/!?\[\[([^\]\r\n]+)\]\]/gu, (full: string, inner: string) => {
    const targetText = inner.split("|", 1)[0]!.trim(); const source = resolveAssetTarget(entry.path, targetText);
    const replacement = source ? mappings.get(assetKey(source)) : undefined;
    if (!replacement) return full;
    const fragment = targetText.includes("#") ? targetText.slice(targetText.indexOf("#")) : "";
    const offset = full.indexOf(targetText, full.indexOf("[[") + 2);
    return full.slice(0, offset) + replacement + fragment + full.slice(offset + targetText.length);
  });
  return content;
}

/** Pure normalization for remote/base snapshots, before a three-way merge.
 * File references are data; normalization never fetches a URL or grants access. */
export function normalizeVaultAssetReferences<T extends AttachmentEntry>(entries: readonly T[]): Array<T & { properties?: Record<string, unknown> }> {
  assertDeclaredAssetAliases(entries);
  return entries.map(entry => {
    if (entry.deleted) return { ...entry };
    const mentioned = new Set(referencedVaultAssetPaths(entry).map(assetKey)); const mappings = new Map<string, string>(); const assets: VaultAssetReference[] = [];
    for (const asset of references(entry)) {
      if (!mentioned.has(assetKey(asset.path))) continue;
      const canonical = versionPath(asset.sha256, asset.mime, asset.name ?? asset.path);
      mappings.set(assetKey(asset.path), canonical); assets.push({ ...asset, path: canonical });
    }
    return { ...entry, content: rewriteAssetTargets(entry, mappings), properties: { ...(entry.properties ?? {}), assets } };
  });
}

async function stageVersion(workspace: OpenWorkspace, bytes: Buffer, assetPath: string): Promise<void> {
  await writeNewRelative(workspace, path.join(".roleweave", "vault", "asset-edit-backups", path.posix.basename(assetPath)), bytes, digest(bytes));
}

/** Restore a hash-addressed original after its edit is preserved separately.
 * A rename captures the actual inode, then its content is verified. Original
 * bytes are installed with exclusive linking, never over a later editor file.
 * The moved inode is retained privately, including writes through an editor's
 * already-open descriptor; no user edit is discarded on success or failure. */
async function restoreCanonical(workspace: OpenWorkspace, assetPath: string, expectedEditedHash: string, originalBytes: Buffer): Promise<void> {
  const relative = path.join("notes", safeAssetPath(assetPath));
  const current = await safeLocalRead(workspace, relative);
  if (!current || digest(current) !== expectedEditedHash) throw conflict();
  const root = path.resolve(workspace.dir); const backupDir = path.join(".roleweave", "vault", "asset-edit-backups");
  await ensureDirectory(root, backupDir);
  const backupRelative = path.join(backupDir, "edited-" + crypto.randomUUID() + path.posix.extname(assetPath));
  const original = path.join(root, relative); const backup = path.join(root, backupRelative);
  await fs.rename(original, backup);
  const moved = await safeLocalRead(workspace, backupRelative);
  if (!moved || digest(moved) !== expectedEditedHash) {
    try { await fs.link(backup, original); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    throw conflict();
  }
  await writeNewRelative(workspace, relative, originalBytes, digest(originalBytes));
}

async function ensureVersion(workspace: OpenWorkspace, asset: AssetRecord, bytes: Buffer): Promise<void> {
  const old = await safeLocalRead(workspace, path.join("notes", asset.path));
  if (old && digest(old) !== asset.sha256) {
    const changedPath = versionPath(digest(old), asset.mime, asset.name);
    await stageVersion(workspace, old, changedPath);
    await restoreCanonical(workspace, asset.path, digest(old), bytes);
  } else await writeNewAsset(workspace, asset.path, bytes, asset.sha256);
}

function reference(value: unknown): VaultAssetReference {
  if (!plain(value) || typeof value.fileId !== "string" || !ID.test(value.fileId) || typeof value.sha256 !== "string" || !SHA.test(value.sha256) ||
      value.size !== undefined && (!Number.isSafeInteger(value.size) || (value.size as number) < 0 || (value.size as number) > MAX_FILE_BYTES) ||
      value.name !== undefined && (typeof value.name !== "string" || Buffer.byteLength(value.name) > 512 || /[\x00-\x1f\x7f]/u.test(value.name))) throw invalid();
  const assetPath = safeAssetPath(value.path); const stem = versionHash(assetPath);
  if (stem && stem !== value.sha256) throw invalid();
  return { path: assetPath, fileId: value.fileId, sha256: value.sha256, mime: mime(value.mime),
    ...(value.size === undefined ? {} : { size: value.size as number }), ...(value.name === undefined ? {} : { name: value.name as string }) };
}
function references(entry: AttachmentEntry): VaultAssetReference[] {
  const value = entry.properties?.assets; if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_NOTE_ASSETS) throw invalid();
  return value.map(reference);
}

/** Markdown links and Obsidian wiki embeds; remote URLs never become requests. */
export function referencedVaultAssetPaths(entry: AttachmentEntry): string[] {
  validateVaultPath(entry.path, false); const candidates: string[] = [];
  for (const match of entry.content.matchAll(/!?\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\)\r\n]+?))(?:\s+["'][^\r\n]*["'])?\s*\)/gu)) {
    candidates.push((match[1] ?? match[2] ?? "").replace(/\s+["'].*["']\s*$/u, "").trim());
  }
  for (const match of entry.content.matchAll(/!?\[\[([^\]\r\n]+)\]\]/gu)) candidates.push(match[1]!.split("|", 1)[0]!.trim());
  const result = new Set<string>();
  for (let value of candidates) {
    if (!value || /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith("//") || value.startsWith("#")) continue;
    value = value.split("#", 1)[0]!; try { value = decodeURIComponent(value); } catch { throw invalid(); }
    if (!value.includes("assets/") && !value.startsWith("assets/")) continue;
    if (value.startsWith("/") || value.includes("\\") || value.includes(":")) throw unsafe();
    const relative = value.startsWith("assets/") ? value : path.posix.join(path.posix.dirname(entry.path), value);
    result.add(safeAssetPath(path.posix.normalize(relative)));
  }
  if (result.size > MAX_NOTE_ASSETS) throw limit();
  return [...result];
}

export async function attachMemAsset(workspace: OpenWorkspace, rawConnection: ServiceConnection, fileId: string): Promise<{ path: string; mime: string; name: string }> {
  const connection = capturedConnection(rawConnection);
  return locked(workspace, async () => {
    const { file, bytes } = await download(connection, fileId);
    const assetPath = versionPath(file.sha256, file.mime, file.name);
    const ledger = await loadLedger(workspace);
    await writeNewAsset(workspace, assetPath, bytes, file.sha256);
    record(ledger, { path: assetPath, fileId: file.id, mime: file.mime, sha256: file.sha256, size: file.size, name: file.name });
    await saveLedger(workspace, ledger);
    return { path: assetPath, mime: file.mime, name: file.name };
  });
}

export async function prepareVaultAttachments<T extends AttachmentEntry>(workspace: OpenWorkspace, entries: readonly T[], rawConnection: ServiceConnection, vaultId: string): Promise<Array<T & { properties?: Record<string, unknown> }>> {
  const connection = capturedConnection(rawConnection); if (!UUID.test(vaultId)) throw invalid();
  return locked(workspace, async () => {
    assertDeclaredAssetAliases(entries);
    await assertLocalAssetAliases(workspace, entries);
    const ledger = await loadLedger(workspace); let batchBytes = 0; let capturedBytes = 0;
    const jobs = new Map<string, { path: string; hash: string; bytes: Buffer | null; previous?: VaultAssetReference; asset: AssetRecord; restore?: VaultAssetReference }>();
    const output: Array<T & { properties?: Record<string, unknown> }> = [];
    // Capture all referenced pre-images before repairing any canonical file.
    // This also supports two hash-named images edited into each other's bytes.
    for (const entry of entries) {
      if (entry.deleted || entry.properties?.archived === true) continue;
      const old = references(entry);
      for (const assetPath of referencedVaultAssetPaths(entry)) {
        const key = assetKey(assetPath); if (jobs.has(key)) continue;
        const bytes = await safeLocalRead(workspace, path.join("notes", assetPath));
        const previous = old.find(value => assetKey(value.path) === key) ?? ledger.assets.find(value => assetKey(value.path) === key);
        if (bytes === null) {
          if (!previous) throw new OrgApiError(errorCodes.vault_note_missing, 404, "A referenced Vault attachment is unavailable");
          const asset = { ...previous, path: versionPath(previous.sha256, previous.mime, previous.name ?? previous.path), size: previous.size ?? 0, name: previous.name ?? path.posix.basename(assetPath) };
          jobs.set(key, { path: assetPath, hash: previous.sha256, bytes: null, previous, asset }); continue;
        }
        const hash = digest(bytes); const type = MIME_BY_EXT[path.posix.extname(assetPath).toLowerCase()] ?? previous?.mime ?? "application/octet-stream";
        const raster = previewMime(type); if (raster) validateRaster(bytes, raster);
        const canonical = versionPath(hash, type, assetPath);
        const cached = ledger.assets.find(value => value.path === canonical && value.sha256 === hash) ?? (previous?.sha256 === hash ? previous : undefined);
        let asset: AssetRecord;
        if (cached && (cached.size === undefined || cached.size === bytes.length)) {
          asset = { ...cached, path: canonical, size: bytes.length, name: cached.name ?? path.posix.basename(assetPath) };
        } else {
        batchBytes += bytes.length; if (batchBytes > MAX_BATCH_BYTES) throw limit();
        const name = path.posix.basename(assetPath);
        const form = new FormData(); form.append("file", new Blob([Uint8Array.from(bytes).buffer], { type }), name);
        form.append("path", `/Vaults/${vaultId}/assets`); form.append("source_metadata", JSON.stringify({ source_kind: "api", source_name: "RoleWeave Vault" }));
        const uploaded = await requestJSON(connection, "/v1/files", { method: "POST", body: form });
        if (!plain(uploaded) || typeof uploaded.deduped !== "boolean") throw unavailable();
        const file = memFile(uploaded.file); if (file.sha256 !== hash || file.size !== bytes.length) throw unavailable();
        const current = await safeLocalRead(workspace, path.join("notes", assetPath)); if (!current || digest(current) !== hash) throw conflict();
        asset = { path: versionPath(hash, file.mime, assetPath), fileId: file.id, sha256: hash, mime: file.mime, size: file.size, name };
        }
        const stem = versionHash(assetPath);
        const restore = stem && stem !== hash ? ledger.assets.find(value => assetKey(value.path) === key && value.sha256 === stem) ??
          (previous?.sha256 === stem ? previous : undefined) : undefined;
        if (stem && stem !== hash && !restore) throw conflict();
        const retain = asset.path !== assetPath || Boolean(restore);
        if (retain) {
          capturedBytes += bytes.length; if (capturedBytes > MAX_BATCH_BYTES) throw limit(); await stageVersion(workspace, bytes, asset.path);
          const destination = await safeLocalRead(workspace, path.join("notes", asset.path));
          // Materialize immediately when free. If another captured canonical
          // edit occupies it, the staged hash version survives until repair.
          if (!destination || digest(destination) === hash) await writeNewAsset(workspace, asset.path, bytes, hash);
        }
        jobs.set(key, { path: assetPath, hash, bytes: retain ? bytes : null, previous, asset, restore });
        record(ledger, asset);
      }
    }
    // A failed old-blob read can be retried without re-uploading the preserved
    // edit. The original canonical metadata is retained at its old path.
    await saveLedger(workspace, ledger);
    for (const job of jobs.values()) if (job.restore && job.bytes) {
      const current = await safeLocalRead(workspace, path.join("notes", job.path));
      // Another job may already have restored the same immutable version.
      if (current && digest(current) === job.restore.sha256) continue;
      const original = await download(connection, job.restore.fileId, job.restore);
      await restoreCanonical(workspace, job.path, job.hash, original.bytes);
      record(ledger, { ...job.restore, path: job.path, name: job.restore.name ?? original.file.name, size: original.file.size });
    }
    for (const job of jobs.values()) if (job.bytes) await ensureVersion(workspace, job.asset, job.bytes);
    for (const entry of entries) {
      if (entry.deleted) { output.push({ ...entry }); continue; }
      if (entry.properties?.archived === true) { output.push(normalizeVaultAssetReferences([entry])[0]!); continue; }
      const mappings = new Map<string, string>(); const assets: VaultAssetReference[] = [];
      for (const assetPath of referencedVaultAssetPaths(entry)) {
        const job = jobs.get(assetKey(assetPath))!;
        mappings.set(assetKey(assetPath), job.asset.path);
        // Absent remote originals keep optional size absent rather than
        // asserting zero bytes without a verified download.
        assets.push(job.bytes === null && job.previous?.size === undefined && job.asset.size === 0 ?
          { path: job.asset.path, fileId: job.asset.fileId, mime: job.asset.mime, sha256: job.asset.sha256, name: job.asset.name } : job.asset);
      }
      const properties = { ...(entry.properties ?? {}), assets };
      if (Buffer.byteLength(JSON.stringify(properties)) > 16 * 1024) throw limit();
      output.push({ ...entry, content: rewriteAssetTargets(entry, mappings), properties });
    }
    await saveLedger(workspace, ledger); return output;
  });
}

export async function hydrateVaultAttachments<T extends AttachmentEntry>(workspace: OpenWorkspace, entries: readonly T[], rawConnection: ServiceConnection): Promise<void> {
  const connection = capturedConnection(rawConnection);
  return locked(workspace, async () => {
    const ledger = await loadLedger(workspace); const assets = new Map<string, VaultAssetReference>(); let batchBytes = 0;
    for (const entry of entries) {
      if (entry.deleted) continue;
      const mentioned = new Set(referencedVaultAssetPaths(entry));
      for (const asset of references(entry)) {
        if (!mentioned.has(asset.path)) continue;
        const old = assets.get(asset.path); if (old && old.sha256 !== asset.sha256) throw conflict();
        assets.set(asset.path, asset);
      }
    }
    if (assets.size > MAX_ASSETS) throw limit();
    // Check every existing pre-image before downloading/writing new assets.
    for (const asset of assets.values()) {
      const bytes = await safeLocalRead(workspace, path.join("notes", asset.path));
      if (bytes && digest(bytes) !== asset.sha256) throw conflict();
    }
    for (const asset of assets.values()) {
      const local = await safeLocalRead(workspace, path.join("notes", asset.path));
      if (local) { if (digest(local) !== asset.sha256) throw conflict(); continue; }
      const { file, bytes } = await download(connection, asset.fileId, asset);
      batchBytes += bytes.length; if (batchBytes > MAX_BATCH_BYTES) throw limit();
      await writeNewAsset(workspace, asset.path, bytes, asset.sha256);
      record(ledger, { ...asset, size: file.size, name: file.name });
    }
    await saveLedger(workspace, ledger);
  });
}

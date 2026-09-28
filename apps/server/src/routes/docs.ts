import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ASSET_RECORD_SCHEMA_VERSION,
  DOCS_ARCHIVE_SCHEMA_VERSION,
  DOCS_CREATE_SCHEMA_VERSION,
  DOCS_DELETE_SCHEMA_VERSION,
  DOCS_FILE_LIST_SCHEMA_VERSION,
  DOCS_FILE_SCHEMA_VERSION,
  DOCS_RENAME_SCHEMA_VERSION,
  DOCS_RESOLVE_SCHEMA_VERSION,
  DOCS_RESTORE_SCHEMA_VERSION,
  MAX_DOC_CREATE_BYTES,
  formatDocRefUri,
  parseDocRef,
  OrgApiError,
  errorCodes,
  isPositionId,
} from "@roleweave/shared";
import type {
  AssetRecord,
  DocsArchiveResponse,
  DocsCreateResponse,
  DocsDeleteResponse,
  DocsFileEntry,
  DocsFileListResponse,
  DocsFileResponse,
  DocsRenameResponse,
  DocsResolveResponse,
  DocsRestoreResponse,
} from "@roleweave/shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import { appendAssetIndex, writeAssetRecord } from "../assets/store.js";
import type { ControlPlaneContext } from "../context.js";
import { resolvePositionPackageDir } from "../context-sources.js";
import { readJsonBody, sendJson } from "../http.js";

/**
 * Read-only document file routing (#35 S2, DS-35-001 rev-1 §5).
 *
 * Guards are fail-closed and modeled on the repository storage discipline:
 * reads resolve strictly inside the role's bound package under `positions/`,
 * symlinks are refused,
 * only allowlisted text extensions are served, and oversized files are
 * rejected rather than streamed.
 */

/** Text extensions a position document may carry; everything else is refused. */
const READABLE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml"]);

/** Hard cap for a served document; larger files are refused, not streamed. */
export const MAX_DOC_FILE_BYTES = 256 * 1024;

function requirePositionDir(ctx: ControlPlaneContext, positionId: string): string {
  if (positionId === "" || !isPositionId(positionId)) {
    throw new OrgApiError(errorCodes.docs_request_invalid, 400, `invalid position id: ${positionId}`);
  }
  const ws = ctx.workspace.requireOpen();
  const role = ws.organization.roles.find((entry) => entry.id === positionId);
  if (!role) {
    throw new OrgApiError(errorCodes.position_missing, 404, `position not found: ${positionId}`);
  }
  return resolvePositionPackageDir(ws.dir, role);
}

/** Resolve a relative doc path strictly inside the position dir; refuse escapes. */
function resolveDocPath(positionDir: string, rawPath: string): string {
  if (rawPath === "") {
    throw new OrgApiError(errorCodes.docs_request_invalid, 400, "path parameter is required");
  }
  const resolved = path.resolve(positionDir, rawPath);
  const relative = path.relative(positionDir, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new OrgApiError(errorCodes.docs_forbidden, 403, `path escapes the position directory: ${rawPath}`);
  }
  if (relative.split(path.sep).some((segment) => segment.startsWith("."))) {
    throw new OrgApiError(errorCodes.docs_forbidden, 403, `hidden path segments are not routable: ${rawPath}`);
  }
  return resolved;
}

/** Recursively list regular files; symlinks and hidden entries are excluded. */
async function walkFiles(dir: string, base: string, entries: DocsFileEntry[]): Promise<void> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    const absolute = path.join(dir, dirent.name);
    if (dirent.isSymbolicLink()) continue;
    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) {
      await walkFiles(absolute, base, entries);
      continue;
    }
    if (!stat.isFile()) continue;
    entries.push({
      path: path.relative(base, absolute).split(path.sep).join("/"),
      kind: "file",
      size: stat.size,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
    });
  }
}

const ARCHIVE_DIR = ".owb-docs-archive";
const mutationLocks = new Map<string, Promise<void>>();

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertMutableKnowledgePath(rawPath: string): string {
  const posixPath = assertCreatePath(rawPath);
  if (posixPath === "SKILL.md" || !posixPath.startsWith("knowledge/")) {
    throw new OrgApiError(errorCodes.docs_forbidden, 403, "bound package files stay read-only");
  }
  return posixPath;
}

function archiveRoot(positionDir: string): string {
  return path.join(positionDir, ARCHIVE_DIR);
}

/** Resolve a knowledge path inside the hidden archive dir; refuse escapes. */
function resolveArchivePath(positionDir: string, posixPath: string): string {
  const root = archiveRoot(positionDir);
  const resolved = path.resolve(root, posixPath);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new OrgApiError(errorCodes.docs_forbidden, 403, `path escapes the archive directory: ${posixPath}`);
  }
  if (relative.split(path.sep).some((segment) => segment.startsWith("."))) {
    throw new OrgApiError(errorCodes.docs_forbidden, 403, `hidden path segments are not routable: ${posixPath}`);
  }
  return resolved;
}

function parseArchivedFlag(url: URL): boolean {
  const values = url.searchParams.getAll("archived");
  if (values.length === 0) return false;
  if (values.length > 1) {
    throw invalidRequest("archived must not be repeated");
  }
  const value = values[0];
  if (value === "1") return true;
  if (value === "0") return false;
  throw invalidRequest("archived must be 1 or omitted");
}

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function assertRealDirectory(dir: string, message: string): Promise<void> {
  const stat = await lstatOrNull(dir);
  if (!stat) {
    throw new OrgApiError(errorCodes.docs_missing, 404, message);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new OrgApiError(errorCodes.docs_forbidden, 403, "symlinks are not mutable");
  }
}

async function assertRealFileChain(root: string, target: string, rawPath: string): Promise<void> {
  await assertRealDirectory(root, "position directory missing");
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new OrgApiError(errorCodes.docs_forbidden, 403, `path escapes the position directory: ${rawPath}`);
  }
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]!);
    const isLeaf = i === segments.length - 1;
    const stat = await lstatOrNull(current);
    if (!stat) {
      throw new OrgApiError(errorCodes.docs_missing, 404, `document not found: ${rawPath}`);
    }
    if (stat.isSymbolicLink()) {
      throw new OrgApiError(errorCodes.docs_forbidden, 403, `symlinks are not mutable: ${rawPath}`);
    }
    if (isLeaf) {
      if (!stat.isFile()) {
        throw new OrgApiError(errorCodes.docs_missing, 404, `not a document file: ${rawPath}`);
      }
    } else if (!stat.isDirectory()) {
      throw new OrgApiError(errorCodes.docs_forbidden, 403, `path is not a real directory: ${rawPath}`);
    }
  }
}

async function assertRealDirChain(root: string, dir: string, rawPath: string): Promise<void> {
  await assertRealDirectory(root, "position directory missing");
  const relative = path.relative(root, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new OrgApiError(errorCodes.docs_forbidden, 403, `path escapes the position directory: ${rawPath}`);
  }
  if (relative === "") return;
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await assertRealDirectory(current, `path is not a real directory: ${rawPath}`);
  }
}

async function assertOrCreateRealArchiveRoot(positionDir: string): Promise<string> {
  const root = archiveRoot(positionDir);
  const existing = await lstatOrNull(root);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new OrgApiError(errorCodes.docs_forbidden, 403, "archive root must be a real directory");
    }
    return root;
  }
  try {
    await fs.mkdir(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const created = await lstatOrNull(root);
  if (!created || created.isSymbolicLink() || !created.isDirectory()) {
    throw new OrgApiError(errorCodes.docs_forbidden, 403, "archive root must be a real directory");
  }
  return root;
}

async function atomicReplaceRegularFile(target: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(target), `.owb-docs-write-${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tmp, "wx", 0o600);
    await handle.writeFile(content, "utf8");
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
  await fs.chmod(target, 0o600);
}

async function moveNoReplace(source: string, dest: string, destPath: string): Promise<void> {
  try {
    await fs.link(source, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new OrgApiError(errorCodes.docs_exists, 409, `document already exists: ${destPath}`);
    }
    throw error;
  }
  await fs.unlink(source);
}

async function withPositionLock<T>(positionId: string, work: () => Promise<T>): Promise<T> {
  const previous = mutationLocks.get(positionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  mutationLocks.set(positionId, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (mutationLocks.get(positionId) === tail) mutationLocks.delete(positionId);
  }
}

export async function handleDocsList(ctx: ControlPlaneContext, res: ServerResponse, url: URL): Promise<void> {
  const archived = parseArchivedFlag(url);
  const positionId = url.searchParams.get("position") ?? "";
  const positionDir = requirePositionDir(ctx, positionId);
  const files: DocsFileEntry[] = [];
  const root = archived ? archiveRoot(positionDir) : positionDir;
  if (archived) {
    const archiveStat = await lstatOrNull(root);
    if (!archiveStat) {
      sendJson(res, 200, { schemaVersion: DOCS_FILE_LIST_SCHEMA_VERSION, positionId, files: [] });
      return;
    }
    if (archiveStat.isSymbolicLink() || !archiveStat.isDirectory()) {
      throw new OrgApiError(errorCodes.docs_forbidden, 403, "archive root must be a real directory");
    }
  }
  try {
    await walkFiles(root, root, files);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (archived) {
        sendJson(res, 200, { schemaVersion: DOCS_FILE_LIST_SCHEMA_VERSION, positionId, files: [] });
        return;
      }
      throw new OrgApiError(errorCodes.docs_missing, 404, `position directory missing: ${positionId}`);
    }
    throw error;
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const body: DocsFileListResponse = {
    schemaVersion: DOCS_FILE_LIST_SCHEMA_VERSION,
    positionId,
    files,
  };
  sendJson(res, 200, body);
}

export async function handleDocsRead(ctx: ControlPlaneContext, res: ServerResponse, url: URL): Promise<void> {
  const archived = parseArchivedFlag(url);
  const positionId = url.searchParams.get("position") ?? "";
  const rawPath = url.searchParams.get("path") ?? "";
  const positionDir = requirePositionDir(ctx, positionId);
  const posixPath = archived ? assertMutableKnowledgePath(rawPath) : rawPath;
  const resolved = archived ? resolveArchivePath(positionDir, posixPath) : resolveDocPath(positionDir, posixPath);
  if (archived) {
    await assertRealDirectory(archiveRoot(positionDir), "archive root must be a real directory");
    await assertRealFileChain(archiveRoot(positionDir), resolved, posixPath);
  }

  let stat;
  try {
    const lstat = await fs.lstat(resolved);
    if (lstat.isSymbolicLink()) {
      throw new OrgApiError(errorCodes.docs_forbidden, 403, `symlinks are not routable: ${rawPath}`);
    }
    stat = lstat;
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OrgApiError(errorCodes.docs_missing, 404, `document not found: ${rawPath}`);
    }
    throw error;
  }
  if (!stat.isFile()) {
    throw new OrgApiError(errorCodes.docs_missing, 404, `not a document file: ${rawPath}`);
  }
  const extension = path.extname(resolved).toLowerCase();
  if (!READABLE_EXTENSIONS.has(extension)) {
    throw new OrgApiError(errorCodes.docs_forbidden, 403, `extension not routable: ${extension}`);
  }
  if (stat.size > MAX_DOC_FILE_BYTES) {
    throw new OrgApiError(errorCodes.docs_forbidden, 403, `document exceeds ${MAX_DOC_FILE_BYTES} bytes: ${rawPath}`);
  }
  const content = await fs.readFile(resolved, "utf8");
  const modifiedAt = new Date(stat.mtimeMs).toISOString();
  const body: DocsFileResponse = {
    schemaVersion: DOCS_FILE_SCHEMA_VERSION,
    positionId,
    path: archived
      ? posixPath
      : path.relative(positionDir, resolved).split(path.sep).join("/"),
    content,
    version: modifiedAt,
    size: stat.size,
    modifiedAt,
  };
  sendJson(res, 200, body);
}

/**
 * S4 creation/reference surface (#35 S4, DS-35-001 rev-1 §3/§5/§6).
 *
 * Creation is naming-plus-landing only: no editor, no overwrite. The file
 * write reuses the S2 path guards, opens with `wx` at 0600, and registers
 * an additive `asset-record.v1` (kind `doc`) plus index entry so #36 can
 * consume the frozen contract unchanged. Resolution turns a
 * `doc-ref.v1alpha1` back into a positioned path with deterministic states:
 * 400 doc_ref_invalid / 404 docs_missing / 200 docs-resolve.v1.
 */

/** Segment guard mirroring the shared doc-ref URI segment pattern. */
const CREATE_SEGMENT_PATTERN = /^(?!\.)[A-Za-z0-9._-]+$/;
const DOC_REF_URI_EXTRACT = /^owb-doc:\/\/([^/]+)\/(.+)$/;

function invalidRequest(message: string): OrgApiError {
  return new OrgApiError(errorCodes.docs_request_invalid, 400, message);
}

function assertCreatePath(rawPath: string): string {
  if (rawPath === "" || rawPath.length > 512) {
    throw invalidRequest("path must be a non-empty relative doc path of at most 512 characters");
  }
  if (rawPath.startsWith("/") || rawPath.includes("\\")) {
    throw invalidRequest("path must be relative and POSIX-style");
  }
  const segments = rawPath.split("/");
  for (const segment of segments) {
    if (!CREATE_SEGMENT_PATTERN.test(segment)) {
      throw invalidRequest(`path segment is not a routable doc name: ${segment}`);
    }
  }
  const extension = path.posix.extname(rawPath).toLowerCase();
  if (!READABLE_EXTENSIONS.has(extension)) {
    throw invalidRequest(`extension not creatable: ${extension}`);
  }
  return rawPath;
}

/** Walk from the position dir to the parent, creating missing dirs at 0700. */
async function ensureDocParentDirs(positionDir: string, target: string): Promise<void> {
  const parent = path.dirname(target);
  const relative = path.relative(positionDir, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new OrgApiError(errorCodes.docs_forbidden, 403, "creation target escapes the position directory");
  }
  let current = positionDir;
  const segments = relative === "" ? [] : relative.split(path.sep);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new OrgApiError(errorCodes.docs_forbidden, 403, "creation path must not contain symbolic links");
      }
    } catch (error) {
      if (error instanceof OrgApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      const created = await fs.lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new OrgApiError(errorCodes.docs_forbidden, 403, "creation directory raced with an unsafe path");
      }
    }
  }
}

function parseCreateRequest(raw: unknown): { positionId: string; path: string; content: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidRequest("body must be an object");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "content,path,positionId") {
    throw invalidRequest("body must carry exactly {positionId, path, content}");
  }
  if (typeof record.positionId !== "string" || typeof record.path !== "string" || typeof record.content !== "string") {
    throw invalidRequest("positionId, path and content must be strings");
  }
  return { positionId: record.positionId, path: record.path, content: record.content };
}

export async function handleDocsCreate(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { positionId, path: rawPath, content } = parseCreateRequest(await readJsonBody<unknown>(req));
  const posixPath = assertCreatePath(rawPath);
  if (Buffer.byteLength(content, "utf8") > MAX_DOC_CREATE_BYTES) {
    throw invalidRequest(`content exceeds ${MAX_DOC_CREATE_BYTES} bytes`);
  }
  const positionDir = requirePositionDir(ctx, positionId);
  const target = resolveDocPath(positionDir, posixPath);
  await ensureDocParentDirs(positionDir, target);

  let preExisting: boolean;
  try {
    await fs.lstat(target);
    preExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") preExisting = false;
    else throw error;
  }
  if (preExisting) {
    throw new OrgApiError(errorCodes.docs_exists, 409, `document already exists: ${posixPath}`);
  }

  let handle;
  try {
    handle = await fs.open(target, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new OrgApiError(errorCodes.docs_exists, 409, `document already exists: ${posixPath}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  await fs.chmod(target, 0o600);
  const stat = await fs.lstat(target);
  const modifiedAt = new Date(stat.mtimeMs).toISOString();

  const assetId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const docRef = { uri: formatDocRefUri(positionId, posixPath), version: modifiedAt };
  const record: AssetRecord = {
    schemaVersion: ASSET_RECORD_SCHEMA_VERSION,
    assetId,
    kind: "doc",
    title: path.posix.basename(posixPath),
    createdAt,
    sourceRef: { positionId },
    docRef,
  };
  await writeAssetRecord(ctx.workspace.requireOpen().dir, record);
  await appendAssetIndex(ctx.workspace.requireOpen().dir, {
    assetId,
    kind: record.kind,
    title: record.title,
    createdAt,
    docRef,
  });

  const body: DocsCreateResponse = {
    schemaVersion: DOCS_CREATE_SCHEMA_VERSION,
    positionId,
    path: posixPath,
    version: modifiedAt,
    size: stat.size,
    assetId,
  };
  sendJson(res, 201, body);
}

export async function handleDocsResolve(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readJsonBody<unknown>(req);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidRequest("body must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "ref") {
    throw invalidRequest("body must carry exactly {ref}");
  }
  const parsed = parseDocRef(record.ref);
  if (!parsed.ok) {
    throw new OrgApiError(errorCodes.doc_ref_invalid, 400, parsed.message);
  }
  const match = DOC_REF_URI_EXTRACT.exec(parsed.ref.uri);
  if (!match) {
    throw new OrgApiError(errorCodes.doc_ref_invalid, 400, "doc-ref uri is not an owb-doc uri");
  }
  const positionId = match[1]!;
  const rawPath = match[2]!;

  let positionDir: string;
  try {
    positionDir = requirePositionDir(ctx, positionId);
  } catch (error) {
    if (error instanceof OrgApiError && error.code === errorCodes.position_missing) {
      throw new OrgApiError(errorCodes.docs_missing, 404, `position not found: ${positionId}`);
    }
    throw error;
  }
  const resolved = resolveDocPath(positionDir, rawPath);

  let stat;
  try {
    const lstat = await fs.lstat(resolved);
    if (lstat.isSymbolicLink()) {
      throw new OrgApiError(errorCodes.docs_forbidden, 403, `symlinks are not resolvable: ${rawPath}`);
    }
    stat = lstat;
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OrgApiError(errorCodes.docs_missing, 404, `document not found: ${rawPath}`);
    }
    throw error;
  }
  if (!stat.isFile()) {
    throw new OrgApiError(errorCodes.docs_missing, 404, `not a document file: ${rawPath}`);
  }
  const extension = path.extname(resolved).toLowerCase();
  if (!READABLE_EXTENSIONS.has(extension)) {
    throw new OrgApiError(errorCodes.docs_forbidden, 403, `extension not resolvable: ${extension}`);
  }

  const body: DocsResolveResponse = {
    schemaVersion: DOCS_RESOLVE_SCHEMA_VERSION,
    ref: parsed.ref,
    resolved: {
      positionId,
      path: rawPath,
      size: stat.size,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
    },
  };
  sendJson(res, 200, body);
}

function parsePositionPathBody(raw: unknown, keys: string): { positionId: string; path: string; archived?: boolean } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidRequest("body must be an object");
  }
  const record = raw as Record<string, unknown>;
  const actual = Object.keys(record).sort().join(",");
  if (actual !== keys) {
    throw invalidRequest(`body must carry exactly {${keys.split(",").join(", ")}}`);
  }
  if (typeof record.positionId !== "string" || typeof record.path !== "string") {
    throw invalidRequest("positionId and path must be strings");
  }
  const parsed: { positionId: string; path: string; archived?: boolean } = {
    positionId: record.positionId,
    path: record.path,
  };
  if (record.archived !== undefined) {
    if (typeof record.archived !== "boolean") {
      throw invalidRequest("archived must be a boolean");
    }
    parsed.archived = record.archived;
  }
  return parsed;
}

export async function handleDocsWrite(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { positionId, path: rawPath, content } = parseCreateRequest(await readJsonBody<unknown>(req));
  const posixPath = assertMutableKnowledgePath(rawPath);
  if (Buffer.byteLength(content, "utf8") > MAX_DOC_CREATE_BYTES) {
    throw invalidRequest(`content exceeds ${MAX_DOC_CREATE_BYTES} bytes`);
  }
  await withPositionLock(positionId, async () => {
    const positionDir = requirePositionDir(ctx, positionId);
    const target = resolveDocPath(positionDir, posixPath);
    await assertRealFileChain(positionDir, target, posixPath);
    await atomicReplaceRegularFile(target, content);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new OrgApiError(errorCodes.docs_forbidden, 403, `symlinks are not mutable: ${posixPath}`);
    }
    const modifiedAt = new Date(stat.mtimeMs).toISOString();
    const body: DocsFileResponse = {
      schemaVersion: DOCS_FILE_SCHEMA_VERSION,
      positionId,
      path: posixPath,
      content,
      version: modifiedAt,
      size: stat.size,
      modifiedAt,
    };
    sendJson(res, 200, body);
  });
}

export async function handleDocsRename(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readJsonBody<unknown>(req);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidRequest("body must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "from,positionId,to") {
    throw invalidRequest("body must carry exactly {positionId, from, to}");
  }
  if (
    typeof record.positionId !== "string" ||
    typeof record.from !== "string" ||
    typeof record.to !== "string"
  ) {
    throw invalidRequest("positionId, from and to must be strings");
  }
  const positionId = record.positionId;
  const fromPath = assertMutableKnowledgePath(record.from);
  const toPath = assertMutableKnowledgePath(record.to);
  await withPositionLock(positionId, async () => {
    const positionDir = requirePositionDir(ctx, positionId);
    const fromResolved = resolveDocPath(positionDir, fromPath);
    const toResolved = resolveDocPath(positionDir, toPath);
    await assertRealFileChain(positionDir, fromResolved, fromPath);
    await ensureDocParentDirs(positionDir, toResolved);
    await assertRealDirChain(positionDir, path.dirname(toResolved), toPath);
    await moveNoReplace(fromResolved, toResolved, toPath);
    const body: DocsRenameResponse = {
      schemaVersion: DOCS_RENAME_SCHEMA_VERSION,
      positionId,
      from: fromPath,
      to: toPath,
    };
    sendJson(res, 200, body);
  });
}

export async function handleDocsArchive(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { positionId, path: rawPath } = parsePositionPathBody(
    await readJsonBody<unknown>(req),
    "path,positionId",
  );
  const posixPath = assertMutableKnowledgePath(rawPath);
  await withPositionLock(positionId, async () => {
    const positionDir = requirePositionDir(ctx, positionId);
    const source = resolveDocPath(positionDir, posixPath);
    await assertRealFileChain(positionDir, source, posixPath);
    const root = await assertOrCreateRealArchiveRoot(positionDir);
    const dest = resolveArchivePath(positionDir, posixPath);
    await ensureDocParentDirs(root, dest);
    await assertRealDirChain(root, path.dirname(dest), posixPath);
    await moveNoReplace(source, dest, posixPath);
    const body: DocsArchiveResponse = {
      schemaVersion: DOCS_ARCHIVE_SCHEMA_VERSION,
      positionId,
      path: posixPath,
    };
    sendJson(res, 200, body);
  });
}

export async function handleDocsRestore(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { positionId, path: rawPath } = parsePositionPathBody(
    await readJsonBody<unknown>(req),
    "path,positionId",
  );
  const posixPath = assertMutableKnowledgePath(rawPath);
  await withPositionLock(positionId, async () => {
    const positionDir = requirePositionDir(ctx, positionId);
    const root = archiveRoot(positionDir);
    await assertRealDirectory(root, "archive root must be a real directory");
    const source = resolveArchivePath(positionDir, posixPath);
    const dest = resolveDocPath(positionDir, posixPath);
    await assertRealFileChain(root, source, posixPath);
    await ensureDocParentDirs(positionDir, dest);
    await assertRealDirChain(positionDir, path.dirname(dest), posixPath);
    await moveNoReplace(source, dest, posixPath);
    const body: DocsRestoreResponse = {
      schemaVersion: DOCS_RESTORE_SCHEMA_VERSION,
      positionId,
      path: posixPath,
    };
    sendJson(res, 200, body);
  });
}

export async function handleDocsDelete(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readJsonBody<unknown>(req);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidRequest("body must be an object");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "path,positionId" && keys !== "archived,path,positionId") {
    throw invalidRequest("body must carry exactly {positionId, path} or {positionId, path, archived}");
  }
  if (typeof record.positionId !== "string" || typeof record.path !== "string") {
    throw invalidRequest("positionId and path must be strings");
  }
  if (record.archived !== undefined && typeof record.archived !== "boolean") {
    throw invalidRequest("archived must be a boolean");
  }
  const positionId = record.positionId;
  const posixPath = assertMutableKnowledgePath(record.path);
  await withPositionLock(positionId, async () => {
    const positionDir = requirePositionDir(ctx, positionId);
    if (record.archived) {
      const root = archiveRoot(positionDir);
      await assertRealDirectory(root, "archive root must be a real directory");
      const target = resolveArchivePath(positionDir, posixPath);
      await assertRealFileChain(root, target, posixPath);
      await fs.unlink(target);
    } else {
      const target = resolveDocPath(positionDir, posixPath);
      await assertRealFileChain(positionDir, target, posixPath);
      await fs.unlink(target);
    }
    const body: DocsDeleteResponse = {
      schemaVersion: DOCS_DELETE_SCHEMA_VERSION,
      positionId,
      path: posixPath,
    };
    sendJson(res, 200, body);
  });
}

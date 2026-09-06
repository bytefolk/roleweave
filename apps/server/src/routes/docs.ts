import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ASSET_RECORD_SCHEMA_VERSION,
  DOCS_CREATE_SCHEMA_VERSION,
  DOCS_FILE_LIST_SCHEMA_VERSION,
  DOCS_FILE_SCHEMA_VERSION,
  DOCS_RESOLVE_SCHEMA_VERSION,
  MAX_DOC_CREATE_BYTES,
  formatDocRefUri,
  parseDocRef,
  OrgApiError,
  errorCodes,
  isPositionId,
} from "@roleweave/shared";
import type {
  AssetRecord,
  DocsCreateResponse,
  DocsFileEntry,
  DocsFileListResponse,
  DocsFileResponse,
  DocsResolveResponse,
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

export async function handleDocsList(ctx: ControlPlaneContext, res: ServerResponse, url: URL): Promise<void> {
  const positionId = url.searchParams.get("position") ?? "";
  const positionDir = requirePositionDir(ctx, positionId);
  const files: DocsFileEntry[] = [];
  try {
    await walkFiles(positionDir, positionDir, files);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
  const positionId = url.searchParams.get("position") ?? "";
  const rawPath = url.searchParams.get("path") ?? "";
  const positionDir = requirePositionDir(ctx, positionId);
  const resolved = resolveDocPath(positionDir, rawPath);

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
    path: path.relative(positionDir, resolved).split(path.sep).join("/"),
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

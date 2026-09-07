/**
 * Document file routing contract (#35 S2/S4, DS-35-001 rev-1 §3/§5/§6).
 *
 * Strictly additive: listing and reading position document files
 * (SKILL.md / knowledge / schemas), plus the S4 minimal create surface
 * and the frozen `doc-ref.v1alpha1` reference contract. No editor, no
 * drive semantics — index/search/chat-jump belong to #36.
 */

// Browser-safe mirror of the frozen digital-employee positionId contract
// (packages/shared/position-id.cjs); the Node-only .cjs twin cannot be
// imported here because the renderer bundles this module.
const DOC_REF_POSITION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOC_REF_MAX_POSITION_ID_LENGTH = 64;

function isDocRefPositionId(value: string): boolean {
  return value.length <= DOC_REF_MAX_POSITION_ID_LENGTH && DOC_REF_POSITION_ID_PATTERN.test(value);
}

export const DOCS_FILE_LIST_SCHEMA_VERSION = "docs-file-list.v1" as const;
export const DOCS_FILE_SCHEMA_VERSION = "docs-file.v1" as const;

/** One listed entry under a position's package directory. */
export interface DocsFileEntry {
  /** POSIX-style path relative to the position directory (e.g. `SKILL.md`, `knowledge/README.md`). */
  path: string;
  kind: "file";
  size: number;
  /** File-level version provenance: last-modified time, ISO 8601. */
  modifiedAt: string;
}

export interface DocsFileListResponse {
  schemaVersion: typeof DOCS_FILE_LIST_SCHEMA_VERSION;
  positionId: string;
  /** Deterministic: sorted by `path`, symlinks excluded (fail-closed guard). */
  files: DocsFileEntry[];
}

export interface DocsFileResponse {
  schemaVersion: typeof DOCS_FILE_SCHEMA_VERSION;
  positionId: string;
  path: string;
  /** UTF-8 text content; the route only serves allowlisted text extensions. */
  content: string;
  /** File-level version (mtime ISO 8601) — not edit history. */
  version: string;
  size: number;
  modifiedAt: string;
}

/**
 * Creation + reference contracts (#35 S4, DS-35-001 rev-1 §3/§5; asset shape
 * aligned verbatim with DS-36-001 rev-1 §3 so #36 consumes it unchanged).
 *
 * `doc-ref.v1alpha1` is the frozen cross-surface reference: stable parse,
 * serializable, no drive semantics. The parser is pure — existence checks
 * live in the server resolve route.
 */

export const DOC_REF_SCHEMA_VERSION = "doc-ref.v1alpha1" as const;
export const DOC_REF_URI_SCHEME = "owb-doc" as const;
export const ASSET_RECORD_SCHEMA_VERSION = "asset-record.v1" as const;
export const DOCS_CREATE_SCHEMA_VERSION = "docs-create.v1" as const;
export const DOCS_RESOLVE_SCHEMA_VERSION = "docs-resolve.v1" as const;
/** Creation payload cap, mirroring the S2 read guard (256 KiB). */
export const MAX_DOC_CREATE_BYTES = 256 * 1024;

/** Frozen reference shape — exactly these keys, serializable, no drive semantics. */
export interface DocRef {
  /** `owb-doc://<positionId>/<posix-relative-path>` */
  uri: string;
  anchor?: string;
  version?: string;
}

export type AssetKind = "doc" | "conversation-excerpt" | "decision";

export interface AssetSourceRef {
  sessionId?: string;
  positionId?: string;
  conversationRef?: string;
}

/** exactKeys-strict; extra fields are rejected (DS-36-001 rev-1 §3, #52 style). */
export interface AssetRecord {
  schemaVersion: typeof ASSET_RECORD_SCHEMA_VERSION;
  assetId: string;
  kind: AssetKind;
  title: string;
  createdAt: string;
  sourceRef: AssetSourceRef;
  docRef?: DocRef;
}

/**
 * Asset-layer foundation surface (#36 S1, DS-36-001 rev-1 §5). Strictly
 * additive over the #35 S4 frozen pieces: `doc` assets stay produced
 * exclusively by document creation, so the create entrypoint only admits the
 * non-document kinds; creation responses reuse `asset-record.v1` verbatim.
 */
export const ASSETS_LIST_SCHEMA_VERSION = "assets-list.v1" as const;

export type AssetCreateKind = Exclude<AssetKind, "doc">;

export interface AssetsCreateRequest {
  kind: AssetCreateKind;
  title: string;
  sourceRef?: AssetSourceRef;
}

export interface AssetsListResponse {
  schemaVersion: typeof ASSETS_LIST_SCHEMA_VERSION;
  /** Deterministic: rebuilt from the landed records, sorted by createdAt then assetId. */
  assets: AssetRecord[];
}

export interface DocsCreateRequest {
  positionId: string;
  path: string;
  content: string;
}

export interface DocsCreateResponse {
  schemaVersion: typeof DOCS_CREATE_SCHEMA_VERSION;
  positionId: string;
  path: string;
  /** File-level version (mtime ISO 8601) — not edit history. */
  version: string;
  size: number;
  assetId: string;
}

export interface DocsResolveRequest {
  ref: DocRef;
}

export interface DocsResolveResponse {
  schemaVersion: typeof DOCS_RESOLVE_SCHEMA_VERSION;
  ref: DocRef;
  resolved: {
    positionId: string;
    path: string;
    size: number;
    modifiedAt: string;
  };
}

export type DocRefParseResult =
  | { ok: true; ref: DocRef }
  | { ok: false; code: "doc_ref_invalid"; message: string };

const URI_PATTERN = /^owb-doc:\/\/([^/]+)\/(.+)$/;
const PATH_SEGMENT_PATTERN = /^(?!\.)[A-Za-z0-9._-]+$/;
const ANCHOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compose the frozen uri for a position document path. */
export function formatDocRefUri(positionId: string, path: string): string {
  return `${DOC_REF_URI_SCHEME}://${positionId}/${path}`;
}

/**
 * Pure three-state-safe parser: structural validation only. Existence and
 * anchor resolution against real files belong to the server resolve route.
 */
export function parseDocRef(raw: unknown): DocRefParseResult {
  if (!isRecord(raw)) return { ok: false, code: "doc_ref_invalid", message: "doc-ref must be an object" };
  const keys = Object.keys(raw);
  const allowed = ["uri", "anchor", "version"];
  if (keys.some((key) => !allowed.includes(key)) || typeof raw.uri !== "string") {
    return { ok: false, code: "doc_ref_invalid", message: "doc-ref requires exactly {uri, anchor?, version?}" };
  }
  const match = URI_PATTERN.exec(raw.uri);
  if (!match) return { ok: false, code: "doc_ref_invalid", message: "doc-ref uri must be owb-doc://<positionId>/<path>" };
  const positionId = match[1] ?? "";
  const refPath = match[2] ?? "";
  if (refPath === "" || !isDocRefPositionId(positionId)) {
    return { ok: false, code: "doc_ref_invalid", message: "doc-ref uri carries a malformed position id" };
  }
  const segments = refPath.split("/");
  if (segments.some((segment) => !PATH_SEGMENT_PATTERN.test(segment))) {
    return { ok: false, code: "doc_ref_invalid", message: "doc-ref uri path has an unsafe segment" };
  }
  const ref: DocRef = { uri: raw.uri };
  if (raw.anchor !== undefined) {
    if (typeof raw.anchor !== "string" || !ANCHOR_PATTERN.test(raw.anchor)) {
      return { ok: false, code: "doc_ref_invalid", message: "doc-ref anchor is malformed" };
    }
    ref.anchor = raw.anchor;
  }
  if (raw.version !== undefined) {
    if (typeof raw.version !== "string" || raw.version.length === 0 || raw.version.length > 128) {
      return { ok: false, code: "doc_ref_invalid", message: "doc-ref version is malformed" };
    }
    ref.version = raw.version;
  }
  return { ok: true, ref };
}

/** exactKeys validator for the frozen asset record (kind allowlist enforced). */
export function parseAssetRecord(raw: unknown): { ok: boolean; record?: AssetRecord; message?: string } {
  if (!isRecord(raw)) return { ok: false, message: "asset-record must be an object" };
  const keys = Object.keys(raw).sort().join(",");
  const withDoc = "assetId,createdAt,docRef,kind,schemaVersion,sourceRef,title";
  const withoutDoc = "assetId,createdAt,kind,schemaVersion,sourceRef,title";
  if (keys !== withDoc && keys !== withoutDoc) {
    return { ok: false, message: "asset-record has unexpected or missing keys" };
  }
  if (raw.schemaVersion !== ASSET_RECORD_SCHEMA_VERSION) return { ok: false, message: "asset-record schemaVersion mismatch" };
  if (typeof raw.assetId !== "string" || raw.assetId.length === 0) return { ok: false, message: "assetId required" };
  if (raw.kind !== "doc" && raw.kind !== "conversation-excerpt" && raw.kind !== "decision") {
    return { ok: false, message: "asset kind outside the frozen allowlist" };
  }
  if (typeof raw.title !== "string" || raw.title.length === 0) return { ok: false, message: "title required" };
  if (typeof raw.createdAt !== "string" || raw.createdAt.length === 0) return { ok: false, message: "createdAt required" };
  if (!isRecord(raw.sourceRef)) return { ok: false, message: "sourceRef required" };
  const sourceKeys = Object.keys(raw.sourceRef);
  if (sourceKeys.some((key) => !["sessionId", "positionId", "conversationRef"].includes(key))) {
    return { ok: false, message: "sourceRef has unexpected keys" };
  }
  for (const key of sourceKeys) {
    if (typeof (raw.sourceRef as Record<string, unknown>)[key] !== "string") return { ok: false, message: `sourceRef.${key} must be a string` };
  }
  const record: AssetRecord = {
    schemaVersion: ASSET_RECORD_SCHEMA_VERSION,
    assetId: raw.assetId,
    kind: raw.kind,
    title: raw.title,
    createdAt: raw.createdAt,
    sourceRef: raw.sourceRef as AssetSourceRef,
  };
  if (raw.docRef !== undefined) {
    const parsed = parseDocRef(raw.docRef);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    record.docRef = parsed.ref;
  }
  return { ok: true, record };
}

/**
 * External doc-plane bridge contract (#35 R2 MVP).
 *
 * The org-workbench control plane exposes a thin proxy over the upstream
 * `bytefolk/doc` HTTP API so the renderer can list and preview documents
 * without direct browser access (CORS/PAT stay on the shell). The upstream
 * response shape is deliberately trimmed to the fields the desktop UI needs
 * today; the server flattens TipTap JSON into a UTF-8 markdown-ish body so
 * the existing DocViewer renders it unchanged.
 *
 * When the shell has no upstream configured (`ORG_WORKBENCH_DOC_URL` plus
 * `ORG_WORKBENCH_DOC_TOKEN`), the proxy fails closed with
 * `doc_plane_unconfigured` and the renderer surfaces a configuration guide.
 * Set `ORG_WORKBENCH_DOC_MOCK=1` only for a deterministic local fixture.
 * bytefolk/doc's v1 detail route returns TipTap JSON, so this proxy flattens
 * it via a best-effort walker for the existing markdown reader.
 */

export const DOC_PLANE_LIST_SCHEMA_VERSION = "doc-plane-list.v1alpha1" as const;
export const DOC_PLANE_DETAIL_SCHEMA_VERSION = "doc-plane-detail.v1alpha1" as const;

/**
 * Where the payload came from — the renderer surfaces the source so users
 * can tell "real upstream" from "mock fixture" at a glance.
 */
export type DocPlaneSource = "upstream" | "mock";

export interface DocPlaneListEntry {
  /** Upstream document id (opaque to the shell). */
  id: string;
  /** Human title as reported by the upstream `data[].title`. */
  title: string;
  /** Optional emoji/icon; upstream returns `null` when absent. */
  icon: string | null;
  /** ISO-8601 last-updated timestamp (upstream `updatedAt`). */
  updatedAt: string;
  /** Whether the upstream marks the document as starred by the token owner. */
  starred: boolean;
}

export interface DocPlaneListResponse {
  schemaVersion: typeof DOC_PLANE_LIST_SCHEMA_VERSION;
  /** Provenance: real upstream call vs. bundled mock fixture. */
  source: DocPlaneSource;
  entries: DocPlaneListEntry[];
}

export interface DocPlaneDetailResponse {
  schemaVersion: typeof DOC_PLANE_DETAIL_SCHEMA_VERSION;
  source: DocPlaneSource;
  id: string;
  title: string;
  icon: string | null;
  updatedAt: string;
  /**
   * UTF-8 body suitable for the DocViewer. When the upstream returns TipTap
   * JSON the server best-effort-flattens paragraphs/headings into markdown;
   * when the mock fixture is in play the body is plain markdown.
   */
  content: string;
}

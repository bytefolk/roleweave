/**
 * Drive (mem) contract types for the workbench control-plane proxy.
 *
 * The workbench does not re-implement the mem Memory Plane; it proxies a
 * bounded read/list surface plus an upload stub to a configured `MEM_URL`
 * (bytefolk/mem `memd` HTTP API, `/v1/files`). When `MEM_URL` is unset the
 * server returns a `drive_not_configured` error; the renderer must not replace
 * that state with local fixture data.
 *
 * Contract is deliberately narrow — one card per object, no ranking or
 * embedding surface — so the workbench never pretends to own the memory
 * plane. Fields mirror the mem API's file record verbatim to avoid a lossy
 * translation layer.
 */

export const DRIVE_OBJECT_LIST_SCHEMA_VERSION = "drive-object-list.v1" as const;
export const DRIVE_OBJECT_SCHEMA_VERSION = "drive-object.v1" as const;

/** One listed object in the mem drive. */
export interface DriveObject {
  /** Stable mem file id (uuid-ish string returned by memd). */
  id: string;
  /** Human-readable name (mem `name` or trailing path segment). */
  name: string;
  /** Size in bytes; mem returns integer bytes. */
  size: number;
  /** MIME type (mem `mime`); "application/octet-stream" is the fallback. */
  mime: string;
  /** ISO 8601 created-at timestamp (mem `created_at`). */
  createdAt: string;
  /** Optional short caption/summary surfaced by mem when indexing is done. */
  summary?: string;
}

export interface DriveObjectListResponse {
  schemaVersion: typeof DRIVE_OBJECT_LIST_SCHEMA_VERSION;
  /** Deterministic order: newest `createdAt` first, mem-supplied order preserved. */
  objects: DriveObject[];
  /** Kept for wire compatibility; connected responses always set this false. */
  mocked: boolean;
}

export interface DriveObjectDetailResponse {
  schemaVersion: typeof DRIVE_OBJECT_SCHEMA_VERSION;
  object: DriveObject;
  mocked: boolean;
}

export interface DriveUploadRequest {
  /** Absolute local path chosen through the OS file picker; validated by main. */
  filePath: string;
}

export interface DriveUploadResponse {
  /** Uploads are stubbed until the mem contract is pinned; `stub` is always true today. */
  stub: true;
  filePath: string;
  message: string;
}

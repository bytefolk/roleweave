import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { DRIVE_UPLOAD_MAX_BYTES, DRIVE_UPLOAD_SCHEMA_VERSION, DRIVE_UPLOAD_TIMEOUT_MS, OrgApiError, errorCodes } from "@roleweave/shared";
import type { DriveUploadResponse } from "@roleweave/shared";
import type { ServiceConnection } from "./connections.js";
import { normalizeServiceUrl } from "./connections.js";
import { normalizeMemFile } from "./mem-contract.js";

export interface DriveUploadInput { name: string; mime: string; bytes: Buffer }
const MAX_REPLY_BYTES = 64 * 1024;
const invalid = () => new OrgApiError(errorCodes.drive_request_invalid, 400, "Upload requires a bounded filename, MIME type and exact binary Content-Length");
const unavailable = () => new OrgApiError(errorCodes.drive_upstream_unavailable, 502, "Mem upload could not be confirmed; check the file list before trying again");
const badReply = () => new OrgApiError(errorCodes.drive_upstream_failed, 502, "Mem returned an invalid upload response; check the file list before trying again");

export function driveUploadMetadata(url: URL): { name: string; mime: string } {
  if ([...url.searchParams.keys()].some(key => !["name", "mime"].includes(key)) ||
      url.searchParams.getAll("name").length !== 1 || url.searchParams.getAll("mime").length !== 1) throw invalid();
  const name = url.searchParams.get("name")!;
  const mime = url.searchParams.get("mime")!;
  if (!name || name === "." || name === ".." || Buffer.byteLength(name) > 512 ||
      /[\\/\x00-\x1f\x7f]/u.test(name) || Buffer.from(name).toString("utf8") !== name ||
      mime.length > 128 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) throw invalid();
  return { name, mime };
}

/** Binary transport keeps Windows picker paths out of the WSL control plane. */
export async function readDriveUpload(req: IncomingMessage, url: URL): Promise<DriveUploadInput> {
  const metadata = driveUploadMetadata(url);
  const rawLength = req.headers["content-length"];
  if (req.headers["content-type"] !== "application/octet-stream" || typeof rawLength !== "string" ||
      !/^\d+$/.test(rawLength) || req.headers["transfer-encoding"] !== undefined) throw invalid();
  const expected = Number(rawLength);
  if (!Number.isSafeInteger(expected)) throw invalid();
  if (expected > DRIVE_UPLOAD_MAX_BYTES) throw new OrgApiError(errorCodes.drive_upload_too_large, 413, "Uploads are limited to 32 MiB; use Mem for larger files");
  const timer = setTimeout(() => req.destroy(), DRIVE_UPLOAD_TIMEOUT_MS);
  const chunks: Buffer[] = []; let length = 0;
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > expected || length > DRIVE_UPLOAD_MAX_BYTES) throw invalid();
      chunks.push(bytes);
    }
    if (length !== expected) throw invalid();
    return { ...metadata, bytes: Buffer.concat(chunks, length) };
  } finally { clearTimeout(timer); }
}

export async function uploadMemFile(connection: ServiceConnection, input: DriveUploadInput): Promise<DriveUploadResponse> {
  const base = normalizeServiceUrl(connection.apiUrl);
  const query = new URLSearchParams({ stream: "1", name: input.name, mime: input.mime, size: String(input.bytes.length), path: "/" });
  const headers: Record<string, string> = { accept: "application/json", "content-type": input.mime };
  if (connection.token) headers.authorization = `Bearer ${connection.token}`;
  if (connection.workspaceId) headers["X-Workspace-ID"] = connection.workspaceId;
  try {
    const response = await fetch(`${base}/v1/files?${query}`, {
      method: "POST", headers, body: new Uint8Array(input.bytes), redirect: "error", signal: AbortSignal.timeout(DRIVE_UPLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new OrgApiError(errorCodes.drive_auth_expired, 401, "Mem credentials are invalid or expired; update the API token in service settings");
      if (response.status === 403) throw new OrgApiError(errorCodes.drive_permission_denied, 403, "Mem denied this upload; check write permission and workspace access");
      if (response.status === 413) throw new OrgApiError(errorCodes.drive_upload_too_large, 413, "Mem rejected the upload size; use the Mem management window");
      throw new OrgApiError(errorCodes.drive_upstream_failed, response.status >= 400 && response.status < 500 ? response.status : 502, "Mem rejected the upload");
    }
    if (!response.headers.get("content-type")?.includes("application/json") || Number(response.headers.get("content-length")) > MAX_REPLY_BYTES) {
      await response.body?.cancel(); throw badReply();
    }
    const chunks: Uint8Array[] = []; let length = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try { while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.length;
        if (length > MAX_REPLY_BYTES) { await reader.cancel(); throw badReply(); }
        chunks.push(chunk.value);
      } } finally { reader.releaseLock(); }
    }
    let raw: { file?: unknown; deduped?: unknown };
    try { raw = JSON.parse(Buffer.concat(chunks, length).toString("utf8")); } catch { throw badReply(); }
    const object = normalizeMemFile(raw?.file);
    const hash = createHash("sha256").update(input.bytes).digest("hex");
    if (!object || typeof raw.deduped !== "boolean" || object.size !== input.bytes.length ||
        (raw.file as Record<string, unknown>).sha256 !== hash ||
        (!raw.deduped && object.name !== input.name)) throw badReply();
    return { schemaVersion: DRIVE_UPLOAD_SCHEMA_VERSION, object, deduped: raw.deduped };
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    throw unavailable();
  }
}

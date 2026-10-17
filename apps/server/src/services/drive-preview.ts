import { DRIVE_PREVIEW_MAX_BYTES, DRIVE_PREVIEW_MIME_TYPES, OrgApiError, errorCodes } from "@roleweave/shared";
import type { DriveObject, DriveObjectPreview, DrivePreviewMime } from "@roleweave/shared";
import { normalizeServiceUrl, SERVICE_TIMEOUT_MS } from "./connections.js";
import type { ServiceConnection } from "./connections.js";

const MAX_SIDE = 16_384;
const MAX_PIXELS = 40_000_000;
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const invalid = () => new OrgApiError(errorCodes.drive_preview_invalid, 502, "The file is not a valid supported raster preview");
const tooLarge = () => new OrgApiError(errorCodes.drive_preview_too_large, 413, "Image preview exceeds the size limit");
export function previewMime(value: string): DrivePreviewMime | null {
  const mime = value.split(";", 1)[0]!.trim().toLowerCase();
  return (DRIVE_PREVIEW_MIME_TYPES as readonly string[]).includes(mime) ? mime as DrivePreviewMime : null;
}
function checkCanvas(width: number, height: number): void {
  if (width < 1 || height < 1) throw invalid();
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw tooLarge();
}
function jpegCanvas(bytes: Buffer): [number, number] {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw invalid();
  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset++] !== 0xff) throw invalid();
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9 || marker === 0x00) throw invalid();
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw invalid();
    if (JPEG_SOF.has(marker)) {
      if (length < 8) throw invalid();
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  throw invalid();
}

/** Verify raster signatures and header dimensions; browser decoding remains
 * responsible for unsupported/corrupt compressed pixels. No vector is admitted. */
export function validateRaster(bytes: Buffer, mime: DrivePreviewMime): void {
  let width: number; let height: number;
  if (mime === "image/png") {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature) || bytes.readUInt32BE(8) !== 13 ||
        bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(bytes.length - 12) !== 0 ||
        bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND") throw invalid();
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (mime === "image/jpeg") {
    [width, height] = jpegCanvas(bytes);
  } else if (mime === "image/gif") {
    if (bytes.length < 14 || !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) || bytes.at(-1) !== 0x3b) throw invalid();
    width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
  } else {
    if (bytes.length < 25 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP" ||
        bytes.readUInt32LE(4) !== bytes.length - 8) throw invalid();
    const chunk = bytes.toString("ascii", 12, 16); const length = bytes.readUInt32LE(16);
    if (length > bytes.length - 20) throw invalid();
    if (chunk === "VP8X" && length >= 10 && bytes.length >= 30) {
      width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1;
    } else if (chunk === "VP8L" && length >= 5 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (chunk === "VP8 " && length >= 10 && bytes.length >= 30 &&
        bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    } else throw invalid();
  }
  checkCanvas(width, height);
}

export async function fetchMemImagePreview(connection: ServiceConnection, object: DriveObject, timeoutMs = SERVICE_TIMEOUT_MS): Promise<DriveObjectPreview> {
  const mime = previewMime(object.mime);
  if (mime === null) throw new OrgApiError(errorCodes.drive_preview_unsupported, 415, "Image previews support PNG, JPEG, WebP and GIF");
  if (object.size > DRIVE_PREVIEW_MAX_BYTES) throw tooLarge();
  if (timeoutMs <= 0) throw new OrgApiError(errorCodes.drive_upstream_unavailable, 502, "mem image preview timed out", true);
  const base = normalizeServiceUrl(connection.apiUrl);
  const target = new URL(`${base}/v1/files/${encodeURIComponent(object.id)}/content`);
  if (target.origin !== new URL(base).origin) throw invalid();
  const headers: Record<string, string> = { accept: DRIVE_PREVIEW_MIME_TYPES.join(", ") };
  if (connection.token) headers.authorization = `Bearer ${connection.token}`;
  if (connection.workspaceId) headers["X-Workspace-ID"] = connection.workspaceId;
  try {
    const response = await fetch(target, { headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new OrgApiError(errorCodes.drive_upstream_failed, response.status >= 400 && response.status < 500 ? response.status : 502, `mem preview upstream failed: ${response.status}`);
    }
    if (previewMime(response.headers.get("content-type") ?? "") !== mime) { await response.body?.cancel(); throw invalid(); }
    if (Number(response.headers.get("content-length")) > DRIVE_PREVIEW_MAX_BYTES) { await response.body?.cancel(); throw tooLarge(); }
    const chunks: Uint8Array[] = []; let length = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > DRIVE_PREVIEW_MAX_BYTES) { await reader.cancel(); throw tooLarge(); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== object.size) throw invalid();
    validateRaster(bytes, mime);
    return { objectId: object.id, mime, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` };
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    throw new OrgApiError(errorCodes.drive_upstream_unavailable, 502, "mem image preview is unavailable or timed out", true);
  }
}

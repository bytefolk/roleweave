import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_FILE_NAME_LENGTH,
  ATTACHMENT_MAX_SINGLE_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
} from "@roleweave/shared";
import type { AttachmentMimeType } from "@roleweave/shared";
import { OrgApiError, errorCodes } from "@roleweave/shared";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertAttachmentId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new OrgApiError(errorCodes.attachment_request_invalid, 400, "attachment id must be a UUID");
  }
  return value;
}

export function assertAttachmentMimeType(value: unknown): AttachmentMimeType {
  if (typeof value !== "string" || !(ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(value)) {
    throw new OrgApiError(
      errorCodes.attachment_type_unsupported,
      400,
      `unsupported MIME type; allowed: ${ATTACHMENT_ALLOWED_MIME_TYPES.join(", ")}`,
    );
  }
  return value as AttachmentMimeType;
}

export function assertAttachmentFileName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > ATTACHMENT_MAX_FILE_NAME_LENGTH) {
    throw new OrgApiError(
      errorCodes.attachment_request_invalid,
      400,
      `fileName must be 1–${ATTACHMENT_MAX_FILE_NAME_LENGTH} characters`,
    );
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new OrgApiError(errorCodes.attachment_request_invalid, 400, "fileName must not contain path separators");
  }
  return value;
}

export function assertAttachmentSize(sizeBytes: unknown): number {
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new OrgApiError(errorCodes.attachment_request_invalid, 400, "sizeBytes must be a non-negative integer");
  }
  if (sizeBytes > ATTACHMENT_MAX_SINGLE_BYTES) {
    throw new OrgApiError(
      errorCodes.attachment_too_large,
      400,
      `single attachment exceeds ${ATTACHMENT_MAX_SINGLE_BYTES} bytes`,
    );
  }
  return sizeBytes;
}

export function assertAttachmentBatch(files: { sizeBytes: number }[]): void {
  if (files.length > ATTACHMENT_MAX_COUNT) {
    throw new OrgApiError(
      errorCodes.attachment_count_exceeded,
      400,
      `at most ${ATTACHMENT_MAX_COUNT} attachments per turn`,
    );
  }
  const total = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  if (total > ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new OrgApiError(
      errorCodes.attachment_total_size_exceeded,
      400,
      `total attachment size exceeds ${ATTACHMENT_MAX_TOTAL_BYTES} bytes`,
    );
  }
}

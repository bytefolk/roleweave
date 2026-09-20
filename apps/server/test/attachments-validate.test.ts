import assert from "node:assert/strict";
import test from "node:test";
import { OrgApiError, errorCodes, ATTACHMENT_MAX_SINGLE_BYTES, ATTACHMENT_MAX_TOTAL_BYTES } from "@roleweave/shared";
import {
  assertAttachmentBatch,
  assertAttachmentFileName,
  assertAttachmentId,
  assertAttachmentMimeType,
  assertAttachmentSize,
} from "../src/attachments/validate.js";

test("validate rejects path separators, bad ids, unsupported types, and oversize files", () => {
  assert.equal(assertAttachmentId("22222222-2222-4222-8222-222222222222"), "22222222-2222-4222-8222-222222222222");
  assert.throws(() => assertAttachmentId("not-a-uuid"), (error: unknown) => error instanceof OrgApiError && error.code === errorCodes.attachment_request_invalid);
  assert.equal(assertAttachmentMimeType("application/pdf"), "application/pdf");
  assert.throws(() => assertAttachmentMimeType("text/plain"), (error: unknown) => error instanceof OrgApiError && error.code === errorCodes.attachment_type_unsupported);
  assert.throws(() => assertAttachmentFileName("../secret.png"), (error: unknown) => error instanceof OrgApiError && error.code === errorCodes.attachment_request_invalid);
  assert.throws(() => assertAttachmentSize(ATTACHMENT_MAX_SINGLE_BYTES + 1), (error: unknown) => error instanceof OrgApiError && error.code === errorCodes.attachment_too_large);
});

test("validate enforces per-turn count and total size on the server", () => {
  assertAttachmentBatch([{ sizeBytes: 4 }, { sizeBytes: 4 }]);
  assert.throws(
    () => assertAttachmentBatch(Array.from({ length: 6 }, () => ({ sizeBytes: 1 }))),
    (error: unknown) => error instanceof OrgApiError && error.code === errorCodes.attachment_count_exceeded,
  );
  assert.throws(
    () => assertAttachmentBatch([
      { sizeBytes: ATTACHMENT_MAX_TOTAL_BYTES - 1 },
      { sizeBytes: 2 },
    ]),
    (error: unknown) => error instanceof OrgApiError && error.code === errorCodes.attachment_total_size_exceeded,
  );
});

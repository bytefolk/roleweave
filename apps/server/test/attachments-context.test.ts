import assert from "node:assert/strict";
import test from "node:test";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import type { TurnAttachment } from "@roleweave/shared";
import { buildAttachmentContext } from "../src/routes/turns.js";
import { attachmentFilePath } from "../src/attachments/store.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const workspace = "/tmp/owb-attach-ctx";

function pdfWithExtractedText(): TurnAttachment {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    fileName: "spec.pdf",
    mimeType: "application/pdf",
    sizeBytes: 12,
    extractedText: {
      schemaVersion: "attachment-text.v1",
      pages: [{ pageNumber: 1, text: "this extracted page must not enter the engine input" }],
    },
  };
}

test("buildAttachmentContext lists paths only and never inlines extracted PDF text", () => {
  const att = pdfWithExtractedText();
  const assembled = buildAttachmentContext([att], workspace, sessionId, "please review");
  const expectedPath = attachmentFilePath(workspace, sessionId, att.id);
  assert.match(assembled, /\[Attached files\]/);
  assert.match(assembled, /spec\.pdf/);
  assert.match(assembled, /please review/);
  assert.equal(assembled.includes(expectedPath), true);
  assert.equal(assembled.includes("this extracted page must not enter the engine input"), false);
  assert.ok(Buffer.byteLength(assembled, "utf8") < 256 * 1024);
});

test("buildAttachmentContext rejects context that would exceed the 256 KiB input budget", () => {
  const huge: TurnAttachment = {
    id: "33333333-3333-4333-8333-333333333333",
    fileName: `${"a".repeat(300 * 1024)}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 1,
  };
  assert.throws(
    () => buildAttachmentContext([huge], workspace, sessionId, "hi"),
    (error: unknown) => error instanceof OrgApiError && error.code === errorCodes.turn_request_invalid,
  );
});

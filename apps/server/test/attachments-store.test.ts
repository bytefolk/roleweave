import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OrgApiError } from "@roleweave/shared";
import { readAttachmentMeta, saveAttachment } from "../src/attachments/store.js";

test("rejects symlink attachment files and requires metadata/file consistency", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "owb-attach-"));
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const attachmentId = "22222222-2222-4222-8222-222222222222";
  const meta = {
    id: attachmentId,
    fileName: "note.png",
    mimeType: "image/png" as const,
    sizeBytes: 4,
  };
  const payload = Buffer.from("abcd");
  await saveAttachment(workspace, sessionId, meta, payload);
  const loaded = await readAttachmentMeta(workspace, sessionId, attachmentId);
  assert.equal(loaded.id, attachmentId);
  assert.equal(loaded.sizeBytes, 4);

  const filePath = path.join(
    workspace,
    ".roleweave/sessions",
    sessionId,
    "attachments",
    attachmentId,
    "file",
  );
  await fs.rm(filePath);
  const outside = path.join(workspace, "outside");
  await fs.writeFile(outside, "hijack");
  await fs.symlink(outside, filePath);
  await assert.rejects(() => readAttachmentMeta(workspace, sessionId, attachmentId), OrgApiError);
});

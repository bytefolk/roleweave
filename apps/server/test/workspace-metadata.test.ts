import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readAttachmentMeta, attachmentFilePath } from "../src/attachments/store.js";
import { migrateRoleWeaveState } from "../src/workspace-metadata.js";

for (const existingRoot of [false, true]) {
  test(`legacy attachments remain readable after ${existingRoot ? "merging" : "adopting"} metadata`, async (t) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "owb-migration-"));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const attachmentId = "22222222-2222-4222-8222-222222222222";
    const legacy = path.join(workspace, ".digital-employee", "workbench");
    const attachment = path.join(legacy, "sessions", sessionId, "attachments", attachmentId);
    const meta = { id: attachmentId, fileName: "note.png", mimeType: "image/png", sizeBytes: 4 };
    await fs.mkdir(attachment, { recursive: true });
    await fs.writeFile(path.join(attachment, "meta.json"), JSON.stringify(meta));
    await fs.writeFile(path.join(attachment, "file"), "abcd");
    if (existingRoot) {
      await fs.mkdir(path.join(workspace, ".roleweave", "sessions"), { recursive: true });
      await fs.writeFile(path.join(workspace, ".roleweave", "config.json"), "existing");
    }
    await migrateRoleWeaveState(workspace);
    assert.deepEqual(await readAttachmentMeta(workspace, sessionId, attachmentId), meta);
    assert.equal(await fs.readFile(attachmentFilePath(workspace, sessionId, attachmentId), "utf8"), "abcd");
    await assert.rejects(fs.access(legacy), { code: "ENOENT" });
    if (existingRoot) assert.equal(await fs.readFile(path.join(workspace, ".roleweave", "config.json"), "utf8"), "existing");
  });
}

test("metadata merge preserves existing files and retains legacy conflicts", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "owb-migration-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const legacy = path.join(workspace, ".digital-employee", "workbench", "sessions");
  const current = path.join(workspace, ".roleweave", "sessions");
  await fs.mkdir(legacy, { recursive: true });
  await fs.mkdir(current, { recursive: true });
  await fs.writeFile(path.join(legacy, "same.json"), "legacy");
  await fs.writeFile(path.join(current, "same.json"), "current");
  await fs.writeFile(path.join(legacy, "new.json"), "moved");
  await migrateRoleWeaveState(workspace);
  assert.equal(await fs.readFile(path.join(legacy, "same.json"), "utf8"), "legacy");
  assert.equal(await fs.readFile(path.join(current, "same.json"), "utf8"), "current");
  assert.equal(await fs.readFile(path.join(current, "new.json"), "utf8"), "moved");
});

for (const linkedPath of ["legacy-parent", "destination"]) {
  test(`metadata migration rejects a linked ${linkedPath} without moving external files`, async (t) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "owb-migration-"));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const workspace = path.join(temporary, "workspace");
    const outside = path.join(temporary, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    const legacy = path.join(workspace, ".digital-employee", "workbench", "sessions");
    if (linkedPath === "legacy-parent") {
      await fs.symlink(outside, path.join(workspace, ".digital-employee"), "dir");
    } else {
      await fs.mkdir(path.join(workspace, ".roleweave"));
      await fs.symlink(outside, path.join(workspace, ".roleweave", "sessions"), "dir");
    }
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "attachment.json"), "preserved");
    await assert.rejects(migrateRoleWeaveState(workspace), /must be a real directory/);
    assert.equal(await fs.readFile(path.join(legacy, "attachment.json"), "utf8"), "preserved");
    await assert.rejects(fs.access(path.join(outside, "attachment.json")), { code: "ENOENT" });
  });
}

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { VaultListResponse, VaultNoteResponse } from "@roleweave/shared";
import { VAULT_MAX_NOTE_BYTES } from "@roleweave/shared";
import { api, copyExampleWorkspace, startTestServer, assertPosixMode } from "./helpers.js";
import { WorkspaceState } from "../src/workspace-state.js";
import { archiveVaultNote, applyLocalVaultSnapshot, bindVaultNotes, contentVersion, createVaultNote, deleteVaultNote, exportLocalVaultSnapshot, listVaultNotes, migrateLegacyVaultNote, readPositionVaultNotes, readVaultNote, renameVaultNote, resolveVaultNote, readVaultHistory, writeVaultNote } from "../src/vault/store.js";
import { recordNoteVersion } from "../src/vault/history.js";

async function removeFixture(dir: string) { const resolved = path.resolve(dir); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.match(path.basename(resolved), /^owb-workspace-/); await fs.rm(resolved, { recursive: true, force: true }); }
async function fixture() { const dir = await copyExampleWorkspace(); const holder = new WorkspaceState(); const workspace = await holder.openWorkspace(dir); return { dir, workspace, close: () => removeFixture(dir) }; }

test("vault routes are boot-authenticated and workspace owned; Unicode notes live as unmodified Markdown", async () => {
  const f = await fixture(); const server = await startTestServer();
  try {
    await server.ctx.workspace.openWorkspace(f.dir);
    assert.equal((await api(server.baseUrl, "/vault/list")).status, 401);
    const created = await api(server.baseUrl, "/vault/create", { method: "POST", token: server.token, body: { path: "项目 笔记/客户 偏好.md", content: "# 客户偏好\n\n只用邮件，不用电话。\n", source: { positionId: "repo-owner", sessionId: "source-session", turnId: "source-turn" } } });
    assert.equal(created.status, 201); const body = created.body as VaultNoteResponse;
    assert.match(body.note.noteId, /^[0-9a-f-]{36}$/); assert.equal(body.note.path, "项目 笔记/客户 偏好.md"); assert.equal(body.note.title, "客户偏好"); assert.equal(body.note.version, contentVersion(body.content));
    assert.deepEqual(body.note.source, { positionId: "repo-owner", sessionId: "source-session", turnId: "source-turn" });
    assert.equal(await fs.readFile(path.join(f.dir, "notes", body.note.path), "utf8"), body.content);
    assert.equal(body.content.includes(body.note.noteId), false); await assertPosixMode(path.join(f.dir, ".roleweave/vault/index.json"), 0o600);
    const listed = await api(server.baseUrl, "/vault/list?q=" + encodeURIComponent("只用邮件") + "&includeLegacy=false", { token: server.token });
    assert.equal(listed.status, 200); assert.deepEqual((listed.body as VaultListResponse).notes.map(note => note.noteId), [body.note.noteId]);
    const resolved = await api(server.baseUrl, "/vault/resolve", { method: "POST", token: server.token, body: { uri: body.note.ref.uri } }); assert.equal((resolved.body as VaultNoteResponse).content, body.content);
  } finally { await server.close(); await f.close(); }
});

test("content SHA CAS catches external edits and routes preserve identity across rename/archive/restore", async () => {
  const f = await fixture(); const server = await startTestServer();
  try {
    await server.ctx.workspace.openWorkspace(f.dir);
    const original = await createVaultNote(f.workspace, { path: "原始.md", content: "# original" });
    await fs.writeFile(path.join(f.dir, "notes/原始.md"), "# external edit");
    const stale = await api(server.baseUrl, "/vault/write", { method: "PUT", token: server.token, body: { noteId: original.note.noteId, expectedVersion: original.note.version, content: "overwrite" } });
    assert.equal(stale.status, 409); assert.equal((stale.body as { code: string }).code, "vault_conflict"); assert.equal(await fs.readFile(path.join(f.dir, "notes/原始.md"), "utf8"), "# external edit");
    const fresh = await readVaultNote(f.workspace, original.note.noteId); assert.equal(fresh.note.noteId, original.note.noteId); assert.equal(fresh.note.version, contentVersion("# external edit"));
    const renamed = await api(server.baseUrl, "/vault/rename", { method: "POST", token: server.token, body: { noteId: fresh.note.noteId, path: "文件夹/重命名 笔记.md", expectedVersion: fresh.note.version } }); assert.equal(renamed.status, 200); assert.equal((renamed.body as VaultNoteResponse).note.noteId, original.note.noteId);
    const archived = await api(server.baseUrl, "/vault/archive", { method: "POST", token: server.token, body: { noteId: fresh.note.noteId } }); assert.equal((archived.body as VaultNoteResponse).note.archived, true);
    assert.equal((await listVaultNotes(f.workspace, { includeLegacy: false })).notes.length, 0);
    assert.equal((await listVaultNotes(f.workspace, { archived: true, includeLegacy: false })).notes[0]!.noteId, fresh.note.noteId);
    const restored = await api(server.baseUrl, "/vault/restore", { method: "POST", token: server.token, body: { noteId: fresh.note.noteId } }); assert.equal((restored.body as VaultNoteResponse).note.archived, false);
    assert.equal((restored.body as VaultNoteResponse).content, "# external edit");
  } finally { await server.close(); await f.close(); }
});

test("legacy knowledge is virtually indexed without copies, then only explicit migration moves it and keeps aliases", async () => {
  const f = await fixture(); const server = await startTestServer();
  try {
    await server.ctx.workspace.openWorkspace(f.dir);
    const originalFile = path.join(f.dir, "positions/repo-owner/knowledge/README.md"); const original = await fs.readFile(originalFile, "utf8");
    const legacy = (await listVaultNotes(f.workspace)).notes.find(note => note.legacy?.positionId === "repo-owner" && note.legacy.path === "knowledge/README.md")!;
    assert.ok(legacy.readOnly); assert.ok(legacy.positionIds.includes("repo-owner")); assert.deepEqual(await fs.readdir(path.join(f.dir, "notes")), []);
    const denied = await api(server.baseUrl, "/vault/write", { method: "PUT", token: server.token, body: { noteId: legacy.noteId, content: "no", expectedVersion: legacy.version } }); assert.equal(denied.status, 409);
    const migrated = await api(server.baseUrl, "/vault/migrate", { method: "POST", token: server.token, body: { noteId: legacy.noteId, path: "迁移/旧知识.md", expectedVersion: legacy.version } });
    assert.equal(migrated.status, 200); assert.equal((migrated.body as VaultNoteResponse).note.noteId, legacy.noteId); assert.equal((migrated.body as VaultNoteResponse).note.readOnly, false);
    await assert.rejects(fs.stat(originalFile), { code: "ENOENT" }); assert.equal(await fs.readFile(path.join(f.dir, "notes/迁移/旧知识.md"), "utf8"), original);
    assert.equal((await resolveVaultNote(f.workspace, "owb-doc://repo-owner/knowledge/README.md")).note.noteId, legacy.noteId);
  } finally { await server.close(); await f.close(); }
});

test("role references point to the same note and the runtime seam returns only active allowed reads", async () => {
  const f = await fixture();
  try {
    const a = await createVaultNote(f.workspace, { path: "团队SOP.md", content: "# shared" }); const b = await createVaultNote(f.workspace, { path: "个人.md", content: "# personal" });
    await bindVaultNotes(f.workspace, "repo-owner", [a.note.noteId]); await bindVaultNotes(f.workspace, "issue-researcher", [a.note.noteId]);
    const owner = await readPositionVaultNotes(f.workspace, "repo-owner"); const research = await readPositionVaultNotes(f.workspace, "issue-researcher");
    assert.equal(owner.length, 1); assert.equal(owner[0]!.readPath, "notes/团队SOP.md"); assert.equal(research[0]!.note.noteId, a.note.noteId); assert.equal(owner.some(note => note.note.noteId === b.note.noteId), false);
    await archiveVaultNote(f.workspace, { noteId: a.note.noteId }); assert.deepEqual(await readPositionVaultNotes(f.workspace, "repo-owner"), []);
  } finally { await f.close(); }
});

test("snapshot local CAS prevents lost external edits and remote metadata cannot grant roles", async () => {
  const f = await fixture();
  try {
    const note = await createVaultNote(f.workspace, { path: "同步.md", content: "local" }); const before = await exportLocalVaultSnapshot(f.workspace);
    const incoming = { ...before, entries: before.entries.map(entry => ({ ...entry, content: "remote", properties: { positionIds: ["issue-researcher"] } })) };
    await fs.writeFile(path.join(f.dir, "notes/同步.md"), "new local edit");
    await assert.rejects(applyLocalVaultSnapshot(f.workspace, incoming, { expectedHash: before.expectedHash }), { code: "vault_conflict" });
    assert.equal((await readVaultNote(f.workspace, note.note.noteId)).content, "new local edit");
    const fresh = await exportLocalVaultSnapshot(f.workspace); const result = await applyLocalVaultSnapshot(f.workspace, { ...incoming, entries: incoming.entries }, { expectedHash: fresh.expectedHash });
    assert.equal(result.entries[0]!.content, "remote"); const roleNotes = await readPositionVaultNotes(f.workspace, "issue-researcher"); assert.equal(roleNotes.some(item => item.note.noteId === note.note.noteId), false);
    assert.equal(result.entries.length, 1, "legacy source bodies must never be duplicated into sync snapshots");
  } finally { await f.close(); }
});

test("archived apply journal recovers its post-image but retains later external edits", async () => {
  const f = await fixture();
  try {
    const created = await createVaultNote(f.workspace, { path: "归档.md", content: "original archive" }); await archiveVaultNote(f.workspace, { noteId: created.note.noteId });
    const indexFile = path.join(f.dir, ".roleweave/vault/index.json"); const oldIndex = JSON.parse(await fs.readFile(indexFile, "utf8"));
    const relative = ".roleweave/vault/archive/" + created.note.noteId + ".md"; const archive = path.join(f.dir, relative); const journal = path.join(f.dir, ".roleweave/vault/apply-journal.json");
    await fs.writeFile(archive, "partial remote apply"); await fs.writeFile(journal, JSON.stringify({ phase: "writing", index: oldIndex, files: [{ path: relative, content: "original archive", afterHash: contentVersion("partial remote apply") }] }));
    assert.equal((await readVaultNote(f.workspace, created.note.noteId)).content, "original archive"); await assert.rejects(fs.stat(journal), { code: "ENOENT" });
    await fs.writeFile(archive, "later Obsidian edit"); await fs.writeFile(journal, JSON.stringify({ phase: "writing", index: oldIndex, files: [{ path: relative, content: "original archive", afterHash: contentVersion("partial remote apply") }] }));
    assert.equal((await readVaultNote(f.workspace, created.note.noteId)).content, "later Obsidian edit");
  } finally { await f.close(); }
});

test("archived note and a new note at the same filename remain distinct and restore refuses replacement", async () => {
  const f = await fixture();
  try {
    const old = await createVaultNote(f.workspace, { path: "同名.md", content: "old" }); await archiveVaultNote(f.workspace, { noteId: old.note.noteId });
    const active = await createVaultNote(f.workspace, { path: "同名.md", content: "new" }); assert.notEqual(active.note.noteId, old.note.noteId);
    assert.equal((await readVaultNote(f.workspace, old.note.noteId)).content, "old"); assert.equal((await readVaultNote(f.workspace, active.note.noteId)).content, "new");
    await assert.rejects(archiveVaultNote(f.workspace, { noteId: old.note.noteId }, true), { code: "vault_conflict" });
  } finally { await f.close(); }
});

test("unsafe paths, case collisions, oversized notes and symlink targets fail without writing outside notes", async () => {
  const f = await fixture();
  try {
    for (const name of ["../outside.md", "/absolute.md", ".roleweave/hidden.md", "a\\b.md", "foo/NUL.md", "colon:name.md", "a./note.md"]) await assert.rejects(createVaultNote(f.workspace, { path: name, content: "bad" }));
    await createVaultNote(f.workspace, { path: "Case.md", content: "one" }); await assert.rejects(createVaultNote(f.workspace, { path: "case.md", content: "two" }), { code: "vault_conflict" });
    await assert.rejects(createVaultNote(f.workspace, { path: "large.md", content: "x".repeat(VAULT_MAX_NOTE_BYTES + 1) }), { code: "vault_limit_exceeded" });
    if (process.platform !== "win32") { await fs.symlink(f.dir, path.join(f.dir, "notes/escape")); await assert.rejects(createVaultNote(f.workspace, { path: "escape/outside.md", content: "bad" }), { code: "vault_path_forbidden" }); }
  } finally { await f.close(); }
});

test("image route resolves safe note-relative raster assets and blocks traversal/vector files", async () => {
  const f = await fixture(); const server = await startTestServer();
  try {
    await server.ctx.workspace.openWorkspace(f.dir); await fs.mkdir(path.join(f.dir, "notes/assets"), { recursive: true });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64"); await fs.writeFile(path.join(f.dir, "notes/assets/图片.png"), png);
    const image = await api(server.baseUrl, "/vault/image?path=" + encodeURIComponent("../assets/图片.png") + "&notePath=" + encodeURIComponent("项目/笔记.md"), { token: server.token }); assert.equal(image.status, 200);
    assert.equal((image.body as { preview: { path: string; dataUrl: string } }).preview.path, "assets/图片.png");
    for (const name of ["../../secret.png", "https://remote.invalid/image.png", "assets/script.svg"]) assert.ok((await api(server.baseUrl, "/vault/image?path=" + encodeURIComponent(name), { token: server.token })).status >= 400);
  } finally { await server.close(); await f.close(); }
});

test("history captures prior bodies privately, bounds 32 files/20 results, and restoration uses current hash CAS", async () => {
  const f = await fixture(); const server = await startTestServer();
  try {
    await server.ctx.workspace.openWorkspace(f.dir); let current = await createVaultNote(f.workspace, { path: "历史 笔记.md", content: "version 0" });
    for (let n = 1; n <= 35; n++) current = await writeVaultNote(f.workspace, { noteId: current.note.noteId, content: "version " + n, expectedVersion: current.note.version });
    const directory = path.join(f.dir, ".roleweave/vault/history", current.note.noteId);
    const files = await fs.readdir(directory); assert.equal(files.length, 32); for (const file of files) await assertPosixMode(path.join(directory, file), 0o600);
    const result = await api(server.baseUrl, "/vault/history?noteId=" + current.note.noteId, { token: server.token }); assert.equal(result.status, 200);
    const body = result.body as { versions: Array<{ content: string; version: string }> }; assert.equal(body.versions.length, 20); assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 8 * 1024 * 1024);
    assert.ok(body.versions.some(version => version.content === "version 34"));
    const previous = body.versions.find(version => version.content === "version 34")!;
    current = await writeVaultNote(f.workspace, { noteId: current.note.noteId, content: previous.content, expectedVersion: current.note.version }); assert.equal(current.content, "version 34");
    assert.equal((await api(server.baseUrl, "/vault/history?noteId=00000000-0000-4000-8000-000000000001", { token: server.token })).status, 404);
  } finally { await server.close(); await f.close(); }
});

test("history deduplicates by SHA and global byte pruning leaves a bounded response", async () => {
  const f = await fixture();
  try {
    const a = await createVaultNote(f.workspace, { path: "大历史.md", content: "current" }); const b = await createVaultNote(f.workspace, { path: "第二历史.md", content: "current" });
    await recordNoteVersion(f.workspace, a.note.noteId, a.note.path, "duplicate"); await recordNoteVersion(f.workspace, a.note.noteId, a.note.path, "duplicate");
    assert.equal((await fs.readdir(path.join(f.dir, ".roleweave/vault/history", a.note.noteId))).length, 1);
    for (const id of [a.note.noteId, b.note.noteId]) await fs.mkdir(path.join(f.dir, ".roleweave/vault/history", id), { recursive: true, mode: 0o700 });
    for (let n = 0; n < 64; n++) {
      const id = n < 32 ? a.note.noteId : b.note.noteId; const content = String(n).padStart(4, "0") + "x".repeat(VAULT_MAX_NOTE_BYTES - 4); const version = contentVersion(content);
      await fs.writeFile(path.join(f.dir, ".roleweave/vault/history", id, version.slice(7) + ".json"), JSON.stringify({ version, path: "大历史.md", createdAt: new Date().toISOString(), content }), { mode: 0o600 });
    }
    await recordNoteVersion(f.workspace, a.note.noteId, a.note.path, "trigger pruning");
    let size = 0; for (const id of [a.note.noteId, b.note.noteId]) for (const name of await fs.readdir(path.join(f.dir, ".roleweave/vault/history", id))) size += (await fs.stat(path.join(f.dir, ".roleweave/vault/history", id, name))).size;
    assert.ok(size <= 64 * 1024 * 1024); const history = await readVaultHistory(f.workspace, b.note.noteId); assert.ok(Buffer.byteLength(JSON.stringify(history)) <= 8 * 1024 * 1024);
  } finally { await f.close(); }
});

test("SHA write CAS is rechecked after history capture and temporary output creation", async () => {
  const f = await fixture(); const originalWrite = fs.writeFile;
  try {
    const note = await createVaultNote(f.workspace, { path: "竞态.md", content: "original" }); const target = path.join(f.dir, "notes/竞态.md");
    fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => { await originalWrite(...args); if (String(args[0]).includes(".vault-write-")) await originalWrite(target, "external edit while saving"); }) as typeof fs.writeFile;
    await assert.rejects(writeVaultNote(f.workspace, { noteId: note.note.noteId, expectedVersion: note.note.version, content: "must not overwrite" }), { code: "vault_conflict" });
    assert.equal(await fs.readFile(target, "utf8"), "external edit while saving");
  } finally { fs.writeFile = originalWrite; await f.close(); }
});

test("file moves and deletion retain their identity and content when the index commit fails", async () => {
  for (const operation of ["archive", "restore", "rename", "migrate", "delete"] as const) {
    const f = await fixture(); const originalRename = fs.rename;
    try {
      let note: VaultNoteResponse;
      if (operation === "migrate") {
        const legacy = (await listVaultNotes(f.workspace)).notes.find(item => item.legacy?.positionId === "repo-owner")!;
        assert.ok(legacy); note = await readVaultNote(f.workspace, legacy.noteId);
      } else note = await createVaultNote(f.workspace, { path: "事务 原文.md", content: "keep this exact body", positionIds: ["repo-owner"] });
      if (operation === "restore" || operation === "delete") note = await archiveVaultNote(f.workspace, { noteId: note.note.noteId });
      const indexFile = path.join(f.dir, ".roleweave/vault/index.json"); let failed = false;
      fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
        if (!failed && String(args[1]) === indexFile) { failed = true; throw Object.assign(new Error("fixture index failure"), { code: "EIO" }); }
        return originalRename(...args);
      }) as typeof fs.rename;
      const request = { noteId: note.note.noteId, expectedVersion: note.note.version };
      await assert.rejects(operation === "archive" ? archiveVaultNote(f.workspace, request) : operation === "restore" ? archiveVaultNote(f.workspace, request, true) : operation === "rename" ? renameVaultNote(f.workspace, { ...request, path: "事务 新名.md" }) : operation === "migrate" ? migrateLegacyVaultNote(f.workspace, { ...request, path: "迁移 原文.md" }) : deleteVaultNote(f.workspace, request), { code: "vault_storage_failed" });
      fs.rename = originalRename; assert.equal(failed, true);
      const recovered = await readVaultNote(f.workspace, note.note.noteId);
      assert.equal(recovered.content, note.content, operation); assert.equal(recovered.note.path, note.note.path, operation); assert.equal(recovered.note.archived, note.note.archived, operation); assert.deepEqual(recovered.note.legacy, note.note.legacy, operation);
      assert.ok(recovered.note.positionIds.includes("repo-owner"), operation);
      const snapshot = await exportLocalVaultSnapshot(f.workspace); const head = snapshot.entries.find(item => item.noteId === note.note.noteId);
      if (operation !== "migrate") { assert.ok(head); assert.equal(head.deleted, false); assert.equal(head.content, note.content); }
      await assert.rejects(fs.lstat(path.join(f.dir, ".roleweave/vault/apply-journal.json")), { code: "ENOENT" });
    } finally { fs.rename = originalRename; await f.close(); }
  }
});

test("a retained move journal recovers after restart and keeps a later external edit as another note", async () => {
  const f = await fixture(); const originalRename = fs.rename;
  try {
    const note = await createVaultNote(f.workspace, { path: "移动前.md", content: "original body", positionIds: ["repo-owner"] });
    const indexFile = path.join(f.dir, ".roleweave/vault/index.json"); const renamed = path.join(f.dir, "notes/移动后.md"); let edited = false;
    fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]) === indexFile) { if (!edited) { edited = true; await fs.writeFile(renamed, "external edit after move"); } throw Object.assign(new Error("fixture persistent metadata failure"), { code: "EIO" }); }
      return originalRename(...args);
    }) as typeof fs.rename;
    await assert.rejects(renameVaultNote(f.workspace, { noteId: note.note.noteId, path: "移动后.md", expectedVersion: note.note.version }), { code: "vault_storage_failed" });
    await fs.lstat(path.join(f.dir, ".roleweave/vault/apply-journal.json"));
    fs.rename = originalRename;
    const reopened = await new WorkspaceState().openWorkspace(f.dir);
    const recovered = await readVaultNote(reopened, note.note.noteId); assert.equal(recovered.content, "original body"); assert.equal(recovered.note.path, "移动前.md");
    const extra = (await listVaultNotes(reopened, { includeLegacy: false })).notes.find(item => item.path === "移动后.md")!;
    assert.ok(extra); assert.notEqual(extra.noteId, note.note.noteId); assert.equal((await readVaultNote(reopened, extra.noteId)).content, "external edit after move");
    assert.equal((await exportLocalVaultSnapshot(reopened)).entries.find(item => item.noteId === note.note.noteId)!.deleted, false);
  } finally { fs.rename = originalRename; await f.close(); }
});

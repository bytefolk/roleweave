import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import type { VaultUsageNote, VaultUsageResponse, WorkbenchSession, TurnRecord } from "@roleweave/shared";
import { api, assertPosixMode, copyExampleWorkspace, startTestServer } from "./helpers.js";
import { createVaultNote, contentVersion } from "../src/vault/store.js";
import { recordVaultUsage, readVaultUsage } from "../src/vault/receipts.js";

async function dispose(dir: string) { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.match(path.basename(dir), /^owb-workspace-/); await fs.rm(dir, { recursive: true, force: true }); }

test("personal-session turns persist exact injected notes outside the frozen turn schema", async () => {
  const server = await startTestServer(); const dir = await copyExampleWorkspace();
  try {
    const workspace = await server.ctx.workspace.openWorkspace(dir);
    const note = await createVaultNote(workspace, { path: "客户偏好.md", content: "# 客户偏好\n请用邮件 API_KEY=must-not-leak", positionIds: ["repo-owner"] });
    const session = await api(server.baseUrl, "/sessions", { method: "POST", token: server.token, body: { positionId: "repo-owner" } });
    const sessionId = (session.body as WorkbenchSession).sessionId;
    const executed = await api(server.baseUrl, `/sessions/${sessionId}/turns`, { method: "POST", token: server.token, body: { input: "请根据客户偏好继续", engine: "qoder" } });
    assert.equal(executed.status, 200); const turn = executed.body as TurnRecord; assert.equal(turn.status, "completed"); assert.equal(Object.hasOwn(turn, "vaultUsage"), false);
    const receipt = await api(server.baseUrl, `/vault/used?positionId=repo-owner&turnId=${turn.turnId}`, { token: server.token });
    assert.equal(receipt.status, 200); const notes = (receipt.body as VaultUsageResponse).notes;
    const used = notes.find(item => item.noteId === note.note.noteId)!; assert.ok(used); assert.equal(used.ref, note.note.ref.uri); assert.equal(used.version, note.note.version);
    assert.match(used.excerpt, /客户偏好/); assert.doesNotMatch(used.excerpt, /must-not-leak/);
    await assertPosixMode(path.join(dir, ".roleweave/vault/receipts", turn.turnId + ".json"), 0o600);
    assert.equal((await api(server.baseUrl, `/vault/used?positionId=issue-researcher&turnId=${turn.turnId}`, { token: server.token })).status, 404);
    assert.equal((await api(server.baseUrl, `/vault/used?positionId=repo-owner&turnId=${turn.turnId}`)).status, 401);
  } finally { await server.ctx.contextExporter.waitForIdle(); await server.close(); await dispose(dir); }
});

test("usage identity is immutable, bounded and rejects arbitrary filesystem paths", async () => {
  const server = await startTestServer(); const dir = await copyExampleWorkspace();
  try {
    const workspace = await server.ctx.workspace.openWorkspace(dir); const turnId = crypto.randomUUID(); const noteId = crypto.randomUUID();
    const notes: VaultUsageNote[] = [{ noteId, path: "中文 笔记.md", ref: "vault://notes/" + noteId, version: contentVersion("text"), excerpt: "public excerpt" }];
    await recordVaultUsage(workspace, "repo-owner", turnId, notes); await recordVaultUsage(workspace, "repo-owner", turnId, notes);
    assert.deepEqual((await readVaultUsage(workspace, "repo-owner", turnId)).notes, notes);
    await assert.rejects(recordVaultUsage(workspace, "repo-owner", turnId, [{ ...notes[0]!, excerpt: "changed evidence" }]), { code: "vault_storage_failed" });
    await assert.rejects(recordVaultUsage(workspace, "repo-owner", "../arbitrary", notes), { code: "vault_request_invalid" });
    await assert.rejects(recordVaultUsage(workspace, "repo-owner", crypto.randomUUID(), [{ ...notes[0]!, ref: "https://outside.invalid" }]), { code: "vault_request_invalid" });
    await assert.rejects(recordVaultUsage(workspace, "repo-owner", crypto.randomUUID(), [{ ...notes[0]!, excerpt: "x".repeat(8193) }]), { code: "vault_request_invalid" });
    await assert.rejects(readVaultUsage(workspace, "repo-owner", crypto.randomUUID()), { code: "vault_note_missing" });
  } finally { await server.close(); await dispose(dir); }
});

test("usage receipt rejects symlinked storage rather than writing beyond the workspace", { skip: process.platform === "win32" }, async () => {
  const server = await startTestServer(); const dir = await copyExampleWorkspace();
  try {
    const workspace = await server.ctx.workspace.openWorkspace(dir); await fs.mkdir(path.join(dir, ".roleweave/vault"), { recursive: true });
    await fs.symlink(dir, path.join(dir, ".roleweave/vault/receipts"));
    await assert.rejects(recordVaultUsage(workspace, "repo-owner", crypto.randomUUID(), []), { code: "vault_storage_failed" });
  } finally { await server.close(); await dispose(dir); }
});

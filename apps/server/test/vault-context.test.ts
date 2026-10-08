import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createVaultNote, archiveVaultNote } from "../src/vault/store.js";
import { assembleVaultContext } from "../src/vault/context.js";
import { noteFromTurn } from "../src/vault/from-turn.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";
import type { TurnRunDriver, WorkbenchSession, TurnRecord } from "@roleweave/shared";

test("Vault context admits only associated active notes, ranks task facts and remains byte bounded", async () => {
  const server = await startTestServer(); const dir = await copyExampleWorkspace();
  try {
    const ws = await server.ctx.workspace.openWorkspace(dir);
    const important = await createVaultNote(ws, { path: "金毛方案.md", content: "# 草地上的金毛\n" + "中文🥳".repeat(9000) + "\nAPI_KEY=must-hide", positionIds: ["repo-owner"] });
    const archived = await createVaultNote(ws, { path: "金毛旧方案.md", content: "archived-secret", positionIds: ["repo-owner"] });
    await archiveVaultNote(ws, { noteId: archived.note.noteId });
    await createVaultNote(ws, { path: "另一岗位的金毛.md", content: "another-position-secret", positionIds: ["issue-researcher"] });
    for (let i = 0; i < 5; i++) await createVaultNote(ws, { path: `普通${i}.md`, content: `普通资料 ${i}`, positionIds: ["repo-owner"] });
    const input = "请按草地金毛方案继续，当前用户请求必须保留。";
    const result = await assembleVaultContext(ws, "repo-owner", input);
    assert.equal(result.notes[0]?.noteId, important.note.noteId);
    assert.ok(result.notes.length <= 4);
    assert.ok(result.notes.every(note => Buffer.byteLength(note.excerpt, "utf8") <= 8 * 1024));
    assert.ok(Buffer.byteLength(result.input, "utf8") - Buffer.byteLength(input, "utf8") <= 32 * 1024);
    assert.ok(result.input.endsWith(input)); assert.match(result.input, /untrusted reference material/);
    assert.doesNotMatch(result.input, /archived-secret|another-position-secret|must-hide|\uFFFD/);
    assert.equal(result.notes[0]?.version, important.note.version); assert.match(result.notes[0]!.ref, /^vault:\/\/notes\//);
    const full = "x".repeat(256 * 1024);
    const noRoom = await assembleVaultContext(ws, "repo-owner", full);
    assert.equal(noRoom.input, full); assert.deepEqual(noRoom.notes, []);
  } finally { await server.close(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
});

test("note from turn finds personal-session source and copies only public surfaces with provenance", async () => {
  const driver: TurnRunDriver = { async turnRun() {
    const timestamp = new Date().toISOString(); const output = { text: "公开结论 <analysis>private-chain</analysis> API_KEY=privatecredential", reasoning: "hidden-object-field", events: "private-tool-event" };
    return { status: "trusted", diagnostic: "", events: [
      { type: "run.started", runId: "source-run", timestamp },
      { type: "run.completed", runId: "source-run", timestamp, output, terminalReason: "goal_met" },
    ] };
  } };
  const server = await startTestServer(undefined, driver); const dir = await copyExampleWorkspace();
  try {
    await server.ctx.workspace.openWorkspace(dir);
    const session = await api(server.baseUrl, "/sessions", { method: "POST", token: server.token, body: { positionId: "repo-owner" } });
    assert.equal(session.status, 201);
    const sessionId = (session.body as WorkbenchSession).sessionId;
    const turn = await api(server.baseUrl, `/sessions/${sessionId}/turns`, { method: "POST", token: server.token, body: { input: "原始公开输入", engine: "qoder" } });
    assert.equal(turn.status, 200); const saved = turn.body as TurnRecord; assert.equal(saved.status, "completed");
    const note = await noteFromTurn(server.ctx, { positionId: "repo-owner", turnId: saved.turnId, path: "会话/已确认结论.md" });
    assert.match(note.content, /原始公开输入|公开结论/); assert.match(note.content, new RegExp(sessionId));
    assert.doesNotMatch(note.content, /private-chain|hidden-object-field|private-tool-event|privatecredential/);
    assert.deepEqual(note.note.source, { positionId: "repo-owner", turnId: saved.turnId, sessionId });
    assert.deepEqual(note.note.positionIds, ["repo-owner"]);
    await assert.rejects(noteFromTurn(server.ctx, { positionId: "repo-owner", turnId: "invented-turn", path: "伪造来源.md", content: "claim" }), /completed, persisted/);
    await assert.rejects(noteFromTurn(server.ctx, { positionId: "issue-researcher", turnId: saved.turnId, path: "跨员工伪造.md" }), /completed, persisted/);
  } finally { await server.ctx.contextExporter.waitForIdle(); await server.close(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
});

test("failed or interrupted turns cannot become verified notes", async () => {
  const driver: TurnRunDriver = { async turnRun() {
    const timestamp = new Date().toISOString();
    return { status: "trusted", diagnostic: "", events: [{ type: "run.started", runId: "failed", timestamp },
      { type: "run.failed", runId: "failed", timestamp, error: { code: "fixture_failed", message: "No verified result", retryable: false, terminalReason: "engine_internal_error" } }] };
  } };
  const server = await startTestServer(undefined, driver); const dir = await copyExampleWorkspace();
  try {
    await server.ctx.workspace.openWorkspace(dir);
    const turn = await api(server.baseUrl, "/turns", { method: "POST", token: server.token, body: { positionId: "repo-owner", input: "fail safely", engine: "qoder" } });
    const record = turn.body as TurnRecord; assert.equal(record.status, "failed");
    await assert.rejects(noteFromTurn(server.ctx, { positionId: "repo-owner", turnId: record.turnId, path: "不可确认.md", content: "incorrect success" }), /completed, persisted/);
  } finally { await server.close(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
});

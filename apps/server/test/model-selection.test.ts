import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import type { TurnRecord, TurnRunRequest, TurnRunResult, WorkbenchSession } from "@roleweave/shared";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";
import { readPositionAgentBinding, resolvePositionAgentEngine } from "../src/agent-binding.js";
import type { SessionStore } from "../src/sessions/store.js";
import type { TurnStore } from "../src/turns/store.js";

test("legacy engine migration ignores failed history and keeps the requested engine", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } })).status, 200);
    const failed = {
      turnId: "failed-legacy-turn",
      status: "failed",
      engine: "claude-local",
      createdAt: "2026-09-13T00:00:00.000Z",
    } as unknown as TurnRecord;
    const turnStore = {
      history: async () => ({ turns: [failed] }),
      sessionHistory: async () => ({ turns: [] }),
    } as unknown as TurnStore;
    const sessionStore = { list: async () => ({ sessions: [] }) } as unknown as SessionStore;
    const engine = await resolvePositionAgentEngine(
      server.ctx.workspace.requireOpen(),
      "repo-owner",
      "qoder",
      turnStore,
      sessionStore,
    );
    assert.equal(engine, "qoder");
    assert.equal((await readPositionAgentBinding(server.ctx.workspace.requireOpen(), "repo-owner"))?.engine, "qoder");
  } finally {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("operator can bind an imported employee to Codex before its first task", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } })).status, 200);
    const select = await api(server.baseUrl, "/positions/repo-owner/agent-engine", { method: "PATCH", token: server.token, body: { engine: "codex" } });
    assert.equal(select.status, 200);
    assert.equal((select.body as { agentEngine: string }).agentEngine, "codex");
    assert.equal((await readPositionAgentBinding(server.ctx.workspace.requireOpen(), "repo-owner"))?.locked, true);
    const locked = await api(server.baseUrl, "/positions/repo-owner/agent-engine", { method: "PATCH", token: server.token, body: { engine: "qoder" } });
    assert.equal(locked.status, 409);
    assert.equal((await api(server.baseUrl, "/positions/repo-owner/agent-engine", { method: "PATCH", token: server.token, body: { engine: "not-an-engine" } })).status, 400);
  } finally {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("employee model selection persists, reaches the driver, and preserves the same session context", async () => {
  const seen: TurnRunRequest[] = [];
  const server = await startTestServer(undefined, { async turnRun(request) {
    seen.push(request);
    const timestamp = new Date().toISOString();
    const events: TurnRunResult["events"] = [
      { type: "run.started", runId: request.envelope.turnId, timestamp },
      { type: "usage", runId: request.envelope.turnId, timestamp, inputTokens: 30, outputTokens: 12 },
      { type: "run.completed", runId: request.envelope.turnId, timestamp, output: "remember the cobalt milestone", terminalReason: "goal_met" },
    ];
    return { status: "trusted", events, diagnostic: "" };
  } });
  const workspace = await copyExampleWorkspace();
  server.ctx.config.bundledElectronEngine = true;
  const call = (url: string, method: string, body: unknown) => api(server.baseUrl, url, { method, body, token: server.token });
  try {
    assert.equal((await call("/workspace/open", "POST", { path: workspace })).status, 200);
    assert.equal((await call("/positions/repo-owner/model", "PATCH", { model: "efficient" })).status, 400);
    assert.equal(await readPositionAgentBinding(server.ctx.workspace.requireOpen(), "repo-owner"), null);
    await resolvePositionAgentEngine(server.ctx.workspace.requireOpen(), "repo-owner", "qoder", server.ctx.turnStore, server.ctx.sessionStore);
    const session = (await call("/sessions", "POST", { positionId: "repo-owner" })).body as WorkbenchSession;
    assert.equal((await call("/positions/repo-owner/model", "PATCH", { model: "efficient" })).status, 200);
    const first = (await call(`/sessions/${session.sessionId}/turns`, "POST", { engine: "qoder", input: "Remember cobalt" })).body as TurnRecord;
    assert.equal(first.model, "efficient");
    assert.equal(seen[0]!.model, "efficient");
    assert.equal((await call("/positions/repo-owner/model", "PATCH", { model: "performance" })).status, 200);
    const second = (await call(`/sessions/${session.sessionId}/turns`, "POST", { engine: "qoder", input: "What milestone?" })).body as TurnRecord;
    assert.equal(second.model, "performance");
    assert.equal(second.conversationRef, session.sessionId);
    assert.equal(second.threadContext?.sourceTurnCount, 1);
    assert.match(JSON.stringify(seen[1]!.envelope), /cobalt/);
    assert.equal((await readPositionAgentBinding(server.ctx.workspace.requireOpen(), "repo-owner"))?.model, "performance");
    const history = await api(server.baseUrl, `/sessions/${session.sessionId}/turns`, { token: server.token });
    assert.equal(history.status, 200);
    assert.deepEqual((history.body as { turns: TurnRecord[] }).turns.map((turn) => turn.model), ["efficient", "performance"]);
    for (const body of [{ model: "" }, { model: "--inject" }, { model: "auto", engine: "codex" }]) {
      assert.equal((await call("/positions/repo-owner/model", "PATCH", body)).status, 400);
    }
    const release = server.ctx.runningTurns.reserve(workspace, "repo-owner", "inflight");
    try { assert.equal((await call("/positions/repo-owner/model", "PATCH", { model: "auto" })).status, 409); }
    finally { release.release(); }
    assert.equal((await call("/positions/repo-owner/model", "PATCH", { model: "custom/研发 小模型 (BYOK)" })).status, 200);
    assert.equal((await call(`/sessions/${session.sessionId}/context`, "PATCH", { enabled: false })).status, 200);
    const isolated = (await call(`/sessions/${session.sessionId}/turns`, "POST", { engine: "qoder", input: "New question" })).body as TurnRecord;
    assert.equal(isolated.threadContext?.sourceTurnCount, 0);
    assert.equal(isolated.threadContext?.contextBytes, 0);
    assert.equal(isolated.model, "custom/研发 小模型 (BYOK)");
    assert.equal(seen.at(-1)?.model, "custom/研发 小模型 (BYOK)");
    const customHistory = await api(server.baseUrl, `/sessions/${session.sessionId}/turns`, { token: server.token });
    assert.equal((customHistory.body as { turns: TurnRecord[] }).turns.at(-1)?.model, "custom/研发 小模型 (BYOK)");
  } finally {
    await server.ctx.contextExporter.waitForIdle();
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

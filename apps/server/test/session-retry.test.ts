import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import type { TurnRecord, TurnRunDriver, TurnRunRequest, TurnRunResult, WorkbenchSession } from "@roleweave/shared";
import { isTurnRecord, TurnStore } from "../src/turns/store.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

class RetryDriver implements TurnRunDriver {
  calls: TurnRunRequest[] = [];
  outcome: "failed" | "completed" | "indeterminate" | "approval" = "failed";
  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    this.calls.push(request);
    if (this.outcome === "indeterminate") return { status: "indeterminate", events: [], diagnostic: "", code: "connection_lost" };
    const timestamp = new Date().toISOString();
    const runId = request.envelope.turnId;
    const events: TurnRunResult["events"] = [{ type: "run.started", runId, timestamp }];
    if (this.outcome === "approval") events.push({ type: "approval.requested", runId, timestamp, approvalId: "approval-1", action: { kind: "write", description: "write a file" } });
    events.push(this.outcome === "completed" ? { type: "run.completed", runId, timestamp, output: "done", terminalReason: "goal_met" } : { type: "run.failed", runId, timestamp, error: { code: this.outcome === "approval" ? "engine.approval_required" : "engine_error", message: "failed", retryable: true, terminalReason: "engine_internal_error" } });
    for (const event of events) request.onEvent?.(event);
    return { status: "trusted", events, diagnostic: "" };
  }
}

for (const originalStatus of ["failed", "indeterminate"] as const) {
  test(`explicit ${originalStatus} session retry creates a linked new record and survives store reload`, async () => {
    const workspace = await copyExampleWorkspace();
    const driver = new RetryDriver();
    driver.outcome = originalStatus;
    const server = await startTestServer(undefined, driver);
    try {
      assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } })).status, 200);
      const session = (await api(server.baseUrl, "/sessions", { method: "POST", token: server.token, body: { positionId: "repo-owner" } })).body as WorkbenchSession;
      const endpoint = `/sessions/${session.sessionId}/turns`;
      const original = (await api(server.baseUrl, endpoint, { method: "POST", token: server.token, body: { input: "original request", engine: "qoder" } })).body as TurnRecord;
      assert.equal(original.status, originalStatus);
      assert.equal(driver.calls.length, 1, "failed and unknown turns are never automatically retried");
      driver.outcome = "completed";
      const result = await api(server.baseUrl, endpoint, { method: "POST", token: server.token, body: { input: original.input, engine: "qoder", retryOf: original.turnId } });
      assert.equal(result.status, 200);
      const retry = result.body as TurnRecord & { retryOf?: string };
      assert.equal(retry.retryOf, original.turnId);
      assert.equal(isTurnRecord(retry), true);
      for (const invalid of ["../escape", "", null, 42, retry.turnId]) {
        assert.equal(isTurnRecord({ ...retry, retryOf: invalid }), false);
      }
      assert.notEqual(retry.turnId, original.turnId);
      assert.equal(retry.conversationId, original.conversationId);
      assert.equal(retry.positionId, original.positionId);
      const history = await new TurnStore().sessionHistory(workspace, session.sessionId, session.positionId, new Date().toISOString());
      assert.equal(history.turns.length, 2);
      assert.deepEqual(history.turns.find((turn) => turn.turnId === original.turnId), original);
      assert.deepEqual(history.turns.find((turn) => turn.turnId === retry.turnId), retry);
    } finally {
      await server.ctx.contextExporter.waitForIdle();
      await server.close();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
}

test("session retries reject cross-session, cross-employee, completed, edited, and approval references before invoking Host", async () => {
  const workspace = await copyExampleWorkspace();
  const driver = new RetryDriver();
  const server = await startTestServer(undefined, driver);
  try {
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } });
    const session = (await api(server.baseUrl, "/sessions", { method: "POST", token: server.token, body: { positionId: "repo-owner" } })).body as WorkbenchSession;
    const endpoint = `/sessions/${session.sessionId}/turns`;
    const post = (endpoint: string, body: unknown) => api(server.baseUrl, endpoint, { method: "POST", token: server.token, body });
    const original = (await post(endpoint, { input: "original", engine: "qoder" })).body as TurnRecord;
    const count = driver.calls.length;
    for (const retryOf of ["../escape", "", null, 42, "11111111-1111-4111-8111-111111111111"]) {
      const rejected = await post(endpoint, { input: "original", engine: "qoder", retryOf });
      assert.equal(rejected.status, 400);
      assert.equal((rejected.body as { code: string }).code, "turn_request_invalid");
    }
    assert.equal((await post(endpoint, { input: "edited task", engine: "qoder", retryOf: original.turnId })).status, 400);
    assert.equal(driver.calls.length, count);
    driver.outcome = "completed";
    const completed = (await post(endpoint, { input: "completed", engine: "qoder" })).body as TurnRecord;
    const rejectedCompleted = await post(endpoint, { input: completed.input, engine: "qoder", retryOf: completed.turnId });
    assert.equal(rejectedCompleted.status, 409);
    assert.equal((rejectedCompleted.body as { code: string }).code, "session_conflict");
    driver.outcome = "approval";
    const approval = (await post(endpoint, { input: "approval", engine: "qoder" })).body as TurnRecord;
    assert.equal((await post(endpoint, { input: approval.input, engine: "qoder", retryOf: approval.turnId })).status, 409);
    const successor = (await post(`/sessions/${session.sessionId}/rotate`, {})).body as WorkbenchSession;
    const other = (await post("/sessions", { positionId: "community-operator" })).body as WorkbenchSession;
    const beforeForbidden = driver.calls.length;
    for (const target of [successor, other]) {
      assert.ok(target.sessionId);
      const rejected = await post(`/sessions/${target.sessionId}/turns`, { input: original.input, engine: "qoder", retryOf: original.turnId });
      assert.equal(rejected.status, 400);
      assert.equal((rejected.body as { code: string }).code, "turn_request_invalid");
    }
    assert.equal(driver.calls.length, beforeForbidden);
  } finally {
    await server.ctx.contextExporter.waitForIdle();
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a running retry excludes overlapping retries and cannot itself be retried", async () => {
  const workspace = await copyExampleWorkspace();
  const driver = new RetryDriver();
  const server = await startTestServer(undefined, driver);
  let release!: () => void;
  let retry: ReturnType<typeof api> | undefined;
  try {
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } });
    const session = (await api(server.baseUrl, "/sessions", { method: "POST", token: server.token, body: { positionId: "repo-owner" } })).body as WorkbenchSession;
    const endpoint = `/sessions/${session.sessionId}/turns`;
    const original = (await api(server.baseUrl, endpoint, { method: "POST", token: server.token, body: { input: "retry work", engine: "qoder" } })).body as TurnRecord;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const previous = driver.turnRun.bind(driver);
    driver.outcome = "completed";
    driver.turnRun = async (request) => { began(); await gate; return previous(request); };
    const request = { method: "POST", token: server.token, body: { input: original.input, engine: "qoder", retryOf: original.turnId } };
    retry = api(server.baseUrl, endpoint, request);
    await started;
    const history = (await api(server.baseUrl, endpoint, { token: server.token })).body as { turns: TurnRecord[] };
    const running = history.turns.find((turn) => turn.status === "running")!;
    assert.ok(running);
    assert.equal((await api(server.baseUrl, endpoint, request)).status, 409);
    assert.equal((await api(server.baseUrl, endpoint, { ...request, body: { ...request.body, retryOf: running.turnId } })).status, 409);
    release();
    assert.equal((await retry).status, 200);
    assert.equal(driver.calls.length, 2);
  } finally {
    release?.();
    await retry;
    await server.ctx.contextExporter.waitForIdle();
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentTask } from "@roleweave/shared";
import { nodeAtomicTurnWriteOperations } from "../src/turns/store.js";
import { api, copyExampleWorkspace, startTestServer, type TestServer } from "./helpers.js";

function taskPath(workspace: string, task: AgentTask) {
  return path.join(workspace, ".roleweave", "tasks", `${task.taskId}.json`);
}

async function boardSnapshot(workspace: string): Promise<Record<string, string>> {
  const dir = path.join(workspace, ".roleweave", "tasks");
  const names = await fs.readdir(dir);
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await fs.readFile(path.join(dir, name), "utf8")])));
}

async function rejectWithoutMutation(server: TestServer, workspace: string, url: string, body: unknown, method = "PATCH") {
  const before = await boardSnapshot(workspace);
  const seq = server.ctx.bus.currentSeq;
  const response = await api(server.baseUrl, url, { method, token: server.token, body });
  assert.equal(response.status, 400, `${url} ${JSON.stringify(body)}: ${JSON.stringify(response.body)}`);
  assert.equal((response.body as { code: string }).code, "body_invalid");
  assert.deepEqual(await boardSnapshot(workspace), before, "rejected task requests must leave every file unchanged");
  assert.equal(server.ctx.bus.currentSeq, seq, "rejected task requests must not publish an update");
}

async function pendingCollaboration(server: TestServer, workspace: string) {
  const org = server.ctx.workspace.requireOpen().organization;
  return server.ctx.taskBoardStore.create(workspace, org, "release-engineer", { targetPositionId: org.owner, title: "review request" });
}

async function directTask(server: TestServer): Promise<AgentTask> {
  const response = await api(server.baseUrl, "/tasks", {
    method: "POST", token: server.token, body: { targetPositionId: "release-engineer", title: "release work" },
  });
  assert.equal(response.status, 201);
  return response.body as AgentTask;
}

async function patchTask(server: TestServer, task: AgentTask, action: "decision" | "status", body: unknown): Promise<AgentTask> {
  const response = await api(server.baseUrl, `/tasks/${task.taskId}/${action}`, { method: "PATCH", token: server.token, body });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body as AgentTask;
}

test("task HTTP routes reject malformed requests with 400 without persisting or publishing", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  await server.ctx.workspace.openWorkspace(workspace);
  const direct = await directTask(server);
  const pending = await pendingCollaboration(server, workspace);
  const validCreate = { targetPositionId: "release-engineer", title: "valid" };
  for (const body of [null, [], true, 42, "task", {}, { ...validCreate, urgent: "false" }, { ...validCreate, urgent: 1 },
    { ...validCreate, contractor: "false" }, { ...validCreate, contractor: null }, { ...validCreate, description: {} },
    { ...validCreate, description: "x".repeat(4097) }, { ...validCreate, title: [] }, { ...validCreate, targetPositionId: {} },
    { ...validCreate, targetPositionId: "missing-position" }]) {
    await rejectWithoutMutation(server, workspace, "/tasks", body, "POST");
  }
  for (const body of [null, [], true, "active", {}, { status: "bogus" }, { status: "queued" }, { status: "declined" },
    { status: true }, { status: ["active"] }, { status: {} }, { status: null }]) {
    await rejectWithoutMutation(server, workspace, `/tasks/${direct.taskId}/status`, body);
  }
  for (const body of [null, [], true, "accept", {}, { decision: "typo" }, { decision: "ACCEPT" },
    { decision: true }, { decision: ["accept"] }, { decision: {} }, { decision: null }]) {
    await rejectWithoutMutation(server, workspace, `/tasks/${pending.taskId}/decision`, body);
  }
  for (const status of ["active", "waiting", "done", "failed"]) {
    await rejectWithoutMutation(server, workspace, `/tasks/${pending.taskId}/status`, { status });
  }
  const list = await api(server.baseUrl, "/tasks", { token: server.token });
  assert.equal(list.status, 200);
  assert.equal((list.body as { tasks: AgentTask[] }).tasks.length, 2);
});

test("task HTTP routes preserve acceptance across waiting and keep terminal tasks terminal", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  await server.ctx.workspace.openWorkspace(workspace);

  const pending = await pendingCollaboration(server, workspace);
  const accepted = await patchTask(server, pending, "decision", { decision: "accept" });
  assert.equal(accepted.status, "queued");
  assert.ok(accepted.acceptedAt);
  const waiting = await patchTask(server, accepted, "status", { status: "waiting" });
  assert.equal(waiting.acceptedAt, accepted.acceptedAt);
  await rejectWithoutMutation(server, workspace, `/tasks/${waiting.taskId}/decision`, { decision: "decline" });
  const active = await patchTask(server, waiting, "status", { status: "active" });
  assert.equal(active.status, "active");
  await patchTask(server, active, "status", { status: "done" });

  for (const terminal of ["done", "failed", "declined"] as const) {
    const task = terminal === "declined" ? await pendingCollaboration(server, workspace) : await directTask(server);
    const ended = terminal === "declined"
      ? await patchTask(server, task, "decision", { decision: "decline" })
      : await patchTask(server, task, "status", { status: terminal });
    assert.equal(ended.status, terminal);
    for (const status of ["active", "waiting", "done", "failed", "queued", "declined"]) {
      await rejectWithoutMutation(server, workspace, `/tasks/${task.taskId}/status`, { status });
    }
    await rejectWithoutMutation(server, workspace, `/tasks/${task.taskId}/decision`, { decision: "accept" });
  }
});

test("legacy accepted collaborations retain acceptance when paused; unmarked waiting stays pending", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  await server.ctx.workspace.openWorkspace(workspace);
  for (const legacyStatus of ["queued", "active"] as const) {
    const pending = await pendingCollaboration(server, workspace);
    // Seed the old on-disk format directly; HTTP acceptance now always writes
    // acceptedAt and cannot produce this legacy fixture.
    const accepted: AgentTask = { ...pending, status: legacyStatus };
    await fs.writeFile(taskPath(workspace, accepted), JSON.stringify(accepted));
    const waiting = await patchTask(server, accepted, "status", { status: "waiting" });
    assert.equal(waiting.acceptedAt, accepted.updatedAt);
    const resumed = await patchTask(server, waiting, "status", { status: "active" });
    assert.equal(resumed.acceptedAt, waiting.acceptedAt);
  }
  const pending = await pendingCollaboration(server, workspace);
  await rejectWithoutMutation(server, workspace, `/tasks/${pending.taskId}/status`, { status: "active" });
});

test("concurrent HTTP updates cannot overwrite a completed task with waiting", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  await server.ctx.workspace.openWorkspace(workspace);
  const task = await directTask(server);
  await patchTask(server, task, "status", { status: "active" });
  const seq = server.ctx.bus.currentSeq;
  const originalRename = nodeAtomicTurnWriteOperations.rename;
  let sawCompletionWrite!: () => void;
  const completionWrite = new Promise<void>((resolve) => { sawCompletionWrite = resolve; });
  let releaseCompletion!: () => void;
  const canComplete = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  t.after(() => { releaseCompletion(); });
  t.mock.method(nodeAtomicTurnWriteOperations, "rename", async (source: string, target: string) => {
    if (target === taskPath(workspace, task)) {
      const record = JSON.parse(await fs.readFile(source, "utf8")) as AgentTask;
      if (record.status === "done") {
        sawCompletionWrite();
        await canComplete;
      }
    }
    await originalRename(source, target);
  });
  const finishing = api(server.baseUrl, `/tasks/${task.taskId}/status`, { method: "PATCH", token: server.token, body: { status: "done" } });
  await completionWrite;
  const waiting = api(server.baseUrl, `/tasks/${task.taskId}/status`, { method: "PATCH", token: server.token, body: { status: "waiting" } });
  // Keep the prior state on disk while a second real HTTP request enters. Without
  // a read/validate/write lock it can validate active and wrongly return 200.
  await delay(50);
  releaseCompletion();
  const [finishedResponse, waitingResponse] = await Promise.all([finishing, waiting]);
  assert.equal(finishedResponse.status, 200);
  assert.equal(waitingResponse.status, 400);
  assert.deepEqual(JSON.parse(await fs.readFile(taskPath(workspace, task), "utf8")), finishedResponse.body);
  assert.equal(server.ctx.bus.currentSeq, seq + 1);
});

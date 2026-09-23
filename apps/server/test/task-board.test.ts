import assert from "node:assert/strict";
import test from "node:test";
import { TaskBoardStore } from "../src/tasks/store.js";
import { copyExampleWorkspace } from "./helpers.js";
import fs from "node:fs/promises";
import path from "node:path";

const org = {
  schemaVersion: "workspace-org.v1" as const, business: "x", description: "x", owner: "owner", updatedAt: new Date().toISOString(),
  roles: [
    { id: "owner", name: "Owner", description: "", reportTo: null, package: { name: "o", version: "1", digest: "sha256:x", localReference: "x" }, mode: "read_only" as const, memoryScope: "/", toolAllow: [], toolDeny: [], budget: { perTask: { tokens: 10 }, perDay: { tokens: 100 } }, metadata: {} },
    { id: "lead", name: "Lead", description: "", reportTo: "owner", package: { name: "l", version: "1", digest: "sha256:x", localReference: "x" }, mode: "read_only" as const, memoryScope: "/", toolAllow: [], toolDeny: [], budget: { perTask: { tokens: 10 }, perDay: { tokens: 100 } }, metadata: {} },
    { id: "worker", name: "Worker", description: "", reportTo: "lead", package: { name: "w", version: "1", digest: "sha256:x", localReference: "x" }, mode: "read_only" as const, memoryScope: "/", toolAllow: [], toolDeny: [], budget: { perTask: { tokens: 10 }, perDay: { tokens: 100 } }, metadata: {} },
  ],
};

test("task board preserves displaced work and enforces owner/direct/peer authority", async () => {
  const workspace = await copyExampleWorkspace(); const store = new TaskBoardStore();
  const normal = await store.create(workspace, org, "lead", { targetPositionId: "worker", title: "normal" });
  const peer = await store.create(workspace, org, "worker", { targetPositionId: "lead", title: "ask" });
  const urgent = await store.create(workspace, org, "owner", { targetPositionId: "worker", title: "urgent", urgent: true });
  assert.equal(normal.status, "queued"); assert.equal(peer.status, "waiting"); assert.equal(peer.kind, "collaboration");
  assert.deepEqual((await store.list(workspace, "worker")).map((t) => t.title), ["urgent", "normal"]);
  const accepted = await store.decide(workspace, peer.taskId, org, "lead", { decision: "accept" });
  assert.equal(accepted.status, "queued");
  await assert.rejects(store.create(workspace, org, "lead", { actorPositionId: "owner", targetPositionId: "worker", title: "fake urgent", urgent: true } as never), /only the owner/);
  const pending = await store.create(workspace, org, "worker", { targetPositionId: "lead", title: "second ask" });
  await assert.rejects(store.decide(workspace, pending.taskId, org, "worker", { actorPositionId: "lead", decision: "accept" } as never), /receiving Agent or owner/);
  const ownerAccepted = await store.decide(workspace, pending.taskId, org, "owner", { decision: "accept" });
  assert.equal(ownerAccepted.status, "queued");
  assert.equal(await fs.readFile(path.join(workspace, ".roleweave", "tasks", `${normal.taskId}.json`), "utf8").then(Boolean), true);
});

test("contractor tasks stay outside mainline and charge the delegating Agent budget", async () => {
  const workspace = await copyExampleWorkspace(); const store = new TaskBoardStore();
  const task = await store.create(workspace, org, "lead", { targetPositionId: "worker", title: "edge research", contractor: true });
  assert.equal(task.kind, "contractor"); assert.equal(task.mainline, false); assert.equal(task.budgetOwnerPositionId, "lead");
});

test("task store rejects malformed persisted records before list or transition", async (t) => {
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await fs.rm(workspace, { recursive: true, force: true }); });
  const store = new TaskBoardStore();
  const task = await store.create(workspace, org, "lead", { targetPositionId: "worker", title: "normal" });
  const taskFile = path.join(workspace, ".roleweave", "tasks", `${task.taskId}.json`);
  for (const record of [null, [], { ...task, status: "bogus" }, { ...task, status: undefined }, { ...task, taskId: "other-task" },
    { ...task, kind: "unknown" }, { ...task, queueOrder: "first" }, { ...task, createdAt: 42 }, { ...task, acceptedAt: true }]) {
    const contents = JSON.stringify(record);
    await fs.writeFile(taskFile, contents);
    await assert.rejects(store.list(workspace), /invalid task record/);
    await assert.rejects(store.transition(workspace, task.taskId, org, "owner", { status: "active" }), /invalid task record/);
    assert.equal(await fs.readFile(taskFile, "utf8"), contents);
  }
});

test("task status updates require a current assignee or owner position", async (t) => {
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await fs.rm(workspace, { recursive: true, force: true }); });
  const store = new TaskBoardStore();
  const task = await store.create(workspace, org, "lead", { targetPositionId: "worker", title: "normal" });
  await assert.rejects(store.transition(workspace, task.taskId, org, "lead", { status: "done" }), /only the assignee or owner/);
  const withoutWorker = { ...org, roles: org.roles.filter((role) => role.id !== "worker") };
  await assert.rejects(store.transition(workspace, task.taskId, withoutWorker, "worker", { status: "active" }), /only the assignee or owner/);
  const active = await store.transition(workspace, task.taskId, org, "worker", { status: "active" });
  assert.equal(active.status, "active");
});

test("competing collaboration decisions serialize before checking pending status", async (t) => {
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await fs.rm(workspace, { recursive: true, force: true }); });
  const store = new TaskBoardStore();
  const task = await store.create(workspace, org, "worker", { targetPositionId: "lead", title: "peer request" });
  const decisions = await Promise.allSettled([
    store.decide(workspace, task.taskId, org, "owner", { decision: "decline" }),
    store.decide(workspace, task.taskId, org, "lead", { decision: "accept" }),
  ]);
  assert.equal(decisions[0]?.status, "fulfilled");
  assert.equal(decisions[1]?.status, "rejected");
  assert.equal((await store.list(workspace))[0]?.status, "declined");
});

test("task reads reject oversized, invalid UTF-8, and non-regular records as storage errors", async (t) => {
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await fs.rm(workspace, { recursive: true, force: true }); });
  const store = new TaskBoardStore();
  const task = await store.create(workspace, org, "lead", { targetPositionId: "worker", title: "normal" });
  const taskFile = path.join(workspace, ".roleweave", "tasks", `${task.taskId}.json`);
  const expectedError = { name: "OrgApiError", code: "internal", status: 500, message: "invalid task record" };
  const invalidUtf8 = Buffer.from(JSON.stringify({ ...task, description: "!" }));
  invalidUtf8[invalidUtf8.indexOf("!")] = 0xff;
  for (const payload of [Buffer.from(JSON.stringify(task) + " ".repeat(32 * 1024)), invalidUtf8]) {
    await fs.writeFile(taskFile, payload);
    await assert.rejects(store.list(workspace), expectedError);
    await assert.rejects(store.transition(workspace, task.taskId, org, "owner", { status: "active" }), expectedError);
    assert.deepEqual(await fs.readFile(taskFile), payload);
  }
  await fs.rm(taskFile);
  await fs.mkdir(taskFile);
  await assert.rejects(store.transition(workspace, task.taskId, org, "owner", { status: "active" }), expectedError);
});

test("task mutations refuse symlink records without modifying their targets", { skip: process.platform === "win32" }, async (t) => {
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await fs.rm(workspace, { recursive: true, force: true }); });
  const store = new TaskBoardStore();
  const task = await store.create(workspace, org, "lead", { targetPositionId: "worker", title: "normal" });
  const taskFile = path.join(workspace, ".roleweave", "tasks", `${task.taskId}.json`);
  const target = path.join(workspace, "task-copy.json");
  const contents = await fs.readFile(taskFile, "utf8");
  await fs.rename(taskFile, target);
  await fs.symlink(target, taskFile, "file");
  await assert.rejects(store.transition(workspace, task.taskId, org, "owner", { status: "active" }), {
    name: "OrgApiError", code: "internal", status: 500, message: "invalid task record",
  });
  assert.equal(await fs.readFile(target, "utf8"), contents);
});

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
  await assert.rejects(store.decide(workspace, pending.taskId, org, "worker", { actorPositionId: "lead", decision: "accept" } as never), /receiving Agent/);
  assert.equal(await fs.readFile(path.join(workspace, ".roleweave", "tasks", `${normal.taskId}.json`), "utf8").then(Boolean), true);
});

test("contractor tasks stay outside mainline and charge the delegating Agent budget", async () => {
  const workspace = await copyExampleWorkspace(); const store = new TaskBoardStore();
  const task = await store.create(workspace, org, "lead", { targetPositionId: "worker", title: "edge research", contractor: true });
  assert.equal(task.kind, "contractor"); assert.equal(task.mainline, false); assert.equal(task.budgetOwnerPositionId, "lead");
});

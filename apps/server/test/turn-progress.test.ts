import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import type { TurnRunDriver, TurnRunRequest, TurnRunResult } from "@roleweave/shared";
import { EventBus } from "../src/bus.js";
import { ProgressTracker } from "../src/turns/progress.js";
import { WORKBENCH_PROGRESS_STEPS, STALE_PROGRESS_MS } from "@roleweave/shared";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

class EventsThenIndeterminateDriver implements TurnRunDriver {
  constructor(private readonly code: string) {}
  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    const runId = "partial-run";
    const timestamp = new Date().toISOString();
    const events: TurnRunResult["events"] = [{ type: "run.started", runId, timestamp }];
    for (const event of events) request.onEvent?.(event);
    return { status: "indeterminate", events, diagnostic: "partial", code: this.code };
  }
}

class ThrowingAfterEventsDriver implements TurnRunDriver {
  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    request.onEvent?.({ type: "run.started", runId: "boom", timestamp: new Date().toISOString() });
    throw new Error("driver crashed");
  }
}

async function openWorkspace(baseUrl: string, token: string, dir: string): Promise<void> {
  const opened = await api(baseUrl, "/workspace/open", { method: "POST", token, body: { path: dir } });
  assert.equal(opened.status, 200);
}

test("progress tracker emits a step on every start/finish/fail and isolates turn ids", () => {
  const bus = new EventBus();
  const events: Array<{ type: string; payload: { taskId: string; stepIndex: number } }> = [];
  bus.subscribe((event) => {
    if (event.type === "turn.progress") events.push(event as typeof events[number]);
  });
  const tracker = new ProgressTracker(bus, () => 1_000);
  tracker.begin({ workspacePath: "/tmp/ws", taskId: "t-a", positionId: "pos-a", taskTitle: "A" });
  tracker.begin({ workspacePath: "/tmp/ws", taskId: "t-b", positionId: "pos-b", taskTitle: "B" });
  tracker.reportStepFinish("t-a", 0);
  tracker.reportStepStart("t-a", 1);
  tracker.reportStepFail("t-b", 0, "engine.timeout");
  const a = tracker.getSnapshot("t-a");
  const b = tracker.getSnapshot("t-b");
  assert.equal(a?.positionId, "pos-a");
  assert.equal(b?.positionId, "pos-b");
  assert.equal(a?.steps[0]?.status, "success");
  assert.equal(b?.steps[0]?.status, "failed");
  assert.equal(b?.overallStatus, "failed");
  assert.ok(events.every((event) => event.payload.taskId === "t-a" || event.payload.taskId === "t-b"));
  assert.ok(events.some((event) => event.payload.taskId === "t-a" && event.payload.stepIndex === 1));
});

test("progress tracker marks a running snapshot stuck after the stale window", () => {
  let now = 0;
  const tracker = new ProgressTracker(new EventBus(), () => now);
  tracker.begin({ workspacePath: "/tmp/ws", taskId: "t-stale", positionId: "pos" });
  now = STALE_PROGRESS_MS + 1;
  assert.equal(tracker.getSnapshot("t-stale")?.overallStatus, "stuck");
});

test("a failed streaming step stays failed and overall does not return to running", () => {
  const tracker = new ProgressTracker(new EventBus(), () => 1_000);
  tracker.begin({ workspacePath: "/tmp/ws", taskId: "t-fail", positionId: "pos" });
  tracker.reportStepFinish("t-fail", 0);
  tracker.reportStepStart("t-fail", 1);
  tracker.reportStepFinish("t-fail", 1);
  tracker.reportStepStart("t-fail", 2);
  tracker.reportStepFail("t-fail", 2, "turn_driver_failure");
  tracker.reportStepFinish("t-fail", 2);
  tracker.reportStepStart("t-fail", 3);
  tracker.reportStepFinish("t-fail", 3);
  const snapshot = tracker.getSnapshot("t-fail");
  assert.equal(snapshot?.steps[2]?.status, "failed");
  assert.equal(snapshot?.overallStatus, "failed");
});

test("failCurrent / abort marks overall failed", () => {
  const tracker = new ProgressTracker(new EventBus(), () => 1_000);
  tracker.begin({ workspacePath: "/tmp/ws", taskId: "t-abort", positionId: "pos" });
  tracker.reportStepStart("t-abort", 0);
  tracker.failCurrent("t-abort", "turn_cancelled");
  assert.equal(tracker.getSnapshot("t-abort")?.overallStatus, "failed");
  assert.equal(tracker.getSnapshot("t-abort")?.steps[0]?.status, "failed");
});

test("persisted snapshot can be loaded after a restart and served by GET", async () => {
  const workspace = await copyExampleWorkspace();
  const server = await startTestServer();
  try {
    const tracker = new ProgressTracker(new EventBus(), () => 1_000);
    tracker.begin({ workspacePath: workspace, taskId: "t-disk", positionId: "repo-owner" });
    tracker.reportStepFail("t-disk", 0, "engine.timeout");
    await tracker.persist(workspace, "repo-owner", "t-disk");
    const restarted = new ProgressTracker(new EventBus(), () => 1_000);
    const loaded = await restarted.loadPersisted(workspace, "repo-owner", "t-disk");
    assert.equal(loaded?.overallStatus, "failed");
    assert.equal(loaded?.steps[0]?.status, "failed");
    await openWorkspace(server.baseUrl, server.token, workspace);
    const one = await api(server.baseUrl, "/turns/progress/t-disk?positionId=repo-owner", { token: server.token });
    assert.equal(one.status, 200);
    assert.equal((one.body as { overallStatus: string }).overallStatus, "failed");
  } finally {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

async function postTurnProgress(
  turnDriver: TurnRunDriver,
): Promise<{ status: number; turnId: string; snapshot: { steps: Array<{ status: string }>; overallStatus: string; progress: number } }> {
  const server = await startTestServer(undefined, turnDriver);
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const created = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", input: "summarize open issues", engine: "qoder" },
    });
    assert.equal(created.status, 200);
    const turnId = (created.body as { turnId: string }).turnId;
    const one = await api(server.baseUrl, `/turns/progress/${turnId}?positionId=repo-owner`, { token: server.token });
    assert.equal(one.status, 200);
    return { status: created.status, turnId, snapshot: one.body as { steps: Array<{ status: string }>; overallStatus: string; progress: number } };
  } finally {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

test("POST /turns with forwarded events then indeterminate keeps streaming failed", async () => {
  const { snapshot } = await postTurnProgress(new EventsThenIndeterminateDriver("turn_cancelled"));
  assert.equal(snapshot.steps[2]?.status, "failed");
  assert.equal(snapshot.overallStatus, "failed");
  assert.notEqual(snapshot.steps[2]?.status, "success");
});

test("POST /turns driver throw after events keeps overall failed", async () => {
  const { snapshot } = await postTurnProgress(new ThrowingAfterEventsDriver());
  assert.equal(snapshot.steps[2]?.status, "failed");
  assert.equal(snapshot.overallStatus, "failed");
});

test("POST /turns reports all five workbench steps and GET /turns/progress lists them", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const created = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", input: "summarize open issues", engine: "qoder" },
    });
    assert.equal(created.status, 200);
    const turnId = (created.body as { turnId: string }).turnId;
    const list = await api(server.baseUrl, "/turns/progress", { token: server.token });
    assert.equal(list.status, 200);
    const snapshots = (list.body as { snapshots: Array<{ taskId: string; steps: Array<{ status: string }>; progress: number; overallStatus: string }> }).snapshots;
    const mine = snapshots.find((item) => item.taskId === turnId);
    assert.ok(mine, "snapshot must be listed after the turn");
    assert.equal(mine.steps.length, WORKBENCH_PROGRESS_STEPS.length);
    assert.ok(mine.steps.every((step) => step.status === "success" || step.status === "failed"));
    assert.equal(mine.overallStatus, "success");
    assert.equal(mine.progress, 100);
    const one = await api(server.baseUrl, `/turns/progress/${turnId}?positionId=repo-owner`, { token: server.token });
    assert.equal(one.status, 200);
    assert.equal((one.body as { taskId: string }).taskId, turnId);
    assert.equal((await api(server.baseUrl, "/reports", { token: server.token })).status, 200);
    assert.equal((await api(server.baseUrl, "/approvals", { token: server.token })).status, 200);
  } finally {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("GET /turns/progress lists a snapshot written before this process started", async () => {
  const workspace = await copyExampleWorkspace();
  const server = await startTestServer();
  try {
    const writer = new ProgressTracker(new EventBus(), () => 1_000);
    writer.begin({ workspacePath: workspace, taskId: "t-history", positionId: "repo-owner", taskTitle: "prior run" });
    writer.reportStepFail("t-history", 0, "engine.timeout");
    await writer.persist(workspace, "repo-owner", "t-history");
    await openWorkspace(server.baseUrl, server.token, workspace);
    const list = await api(server.baseUrl, "/turns/progress", { token: server.token });
    assert.equal(list.status, 200);
    const snapshots = (list.body as { snapshots: Array<{ taskId: string; overallStatus: string }> }).snapshots;
    const mine = snapshots.find((item) => item.taskId === "t-history");
    assert.ok(mine, "persisted history must appear on the list without a live Map entry");
    assert.equal(mine.overallStatus, "failed");
  } finally {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("three concurrent turns keep isolated snapshots", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const bodies = [
      { positionId: "repo-owner", input: "task-a" },
      { positionId: "issue-researcher", input: "task-b" },
      { positionId: "release-engineer", input: "task-c" },
    ];
    const created = await Promise.all(bodies.map((body) => api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { ...body, engine: "qoder" },
    })));
    for (const response of created) assert.equal(response.status, 200);
    const list = await api(server.baseUrl, "/turns/progress", { token: server.token });
    assert.equal(list.status, 200);
    const snapshots = (list.body as { snapshots: Array<{ taskId: string; positionId: string; taskTitle?: string; progress: number }> }).snapshots;
    for (const body of bodies) {
      const row = snapshots.find((item) => item.positionId === body.positionId);
      assert.ok(row, `${body.positionId} must have its own snapshot`);
      assert.equal(row.taskTitle, body.input);
      assert.equal(row.progress, 100);
      assert.equal(snapshots.filter((item) => item.taskId === row.taskId).length, 1);
    }
    const ids = new Set(created.map((response) => (response.body as { turnId: string }).turnId));
    assert.equal(ids.size, 3);
  } finally {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

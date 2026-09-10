import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import type { EngineEvent, GroupConversation, GroupTimeline, TurnRecord, TurnRunDriver, TurnRunRequest, TurnRunResult } from "@roleweave/shared";
import { api, copyExampleWorkspace, startTestServer, type TestServer } from "./helpers.js";

class ControlledDriver implements TurnRunDriver {
  calls: TurnRunRequest[] = [];
  private readonly pending = new Map<string, (result: TurnRunResult) => void>();
  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    this.calls.push(request);
    const started: EngineEvent = { type: "run.started", runId: request.envelope.turnId, timestamp: new Date().toISOString() };
    request.onEvent?.(started);
    return new Promise((resolve) => {
      this.pending.set(request.envelope.turnId, resolve);
      request.setAbort?.(() => {
        this.pending.delete(request.envelope.turnId);
        resolve({ status: "indeterminate", events: [started], diagnostic: "", code: "turn_cancelled" });
      });
    });
  }
  finish(index: number, output: string, failed = false): void {
    const request = this.calls[index]!;
    const finish = this.pending.get(request.envelope.turnId);
    if (!finish) return;
    this.pending.delete(request.envelope.turnId);
    const runId = request.envelope.turnId;
    const timestamp = new Date().toISOString();
    const started: EngineEvent = { type: "run.started", runId, timestamp };
    const terminal: EngineEvent = failed
      ? { type: "run.failed", runId, timestamp, error: { code: "engine.synthetic", message: "synthetic failure", retryable: false, terminalReason: "engine_internal_error" } }
      : { type: "run.completed", runId, timestamp, output, terminalReason: "goal_met" };
    request.onEvent?.(terminal);
    finish({ status: "trusted", events: [started, terminal], diagnostic: "" });
  }
  settleAll(): void { this.calls.forEach((_, index) => this.finish(index, "cleanup")); }
}

async function until(condition: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function open(server: TestServer, workspace: string): Promise<void> {
  const response = await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

async function setup(driver: ControlledDriver): Promise<{ server: TestServer; workspace: string; group: GroupConversation }> {
  const server = await startTestServer(undefined, driver);
  const workspace = await copyExampleWorkspace();
  await open(server, workspace);
  const created = await api(server.baseUrl, "/groups", { method: "POST", token: server.token, body: { memberPositionIds: ["repo-owner", "release-engineer"] } });
  assert.equal(created.status, 201);
  return { server, workspace, group: created.body as GroupConversation };
}

async function timeline(server: TestServer, group: GroupConversation): Promise<GroupTimeline> {
  const response = await api(server.baseUrl, "/groups/" + group.conversationRef + "/turns", { token: server.token });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body as GroupTimeline;
}

async function settled(server: TestServer, group: GroupConversation, count = 2): Promise<TurnRecord[]> {
  let turns: TurnRecord[] = [];
  await until(async () => {
    turns = (await timeline(server, group)).items.flatMap((item) => item.kind === "member" ? [item.turn] : []);
    return turns.length === count && turns.every((turn) => turn.status !== "running");
  }, "accepted group turns should become durable terminal records");
  return turns;
}

test("parallel dispatch starts both employees before either finishes and persists exact accepted identities", async () => {
  const driver = new ControlledDriver();
  const { server, workspace, group } = await setup(driver);
  try {
    const accepted = await api(server.baseUrl, "/groups/" + group.conversationRef + "/turns", {
      method: "POST", token: server.token, body: { input: "Prepare the release", engine: "qoder", mentions: group.members },
    });
    assert.equal(accepted.status, 202);
    assert.equal((accepted.body as { mode: string }).mode, "parallel");
    await until(() => driver.calls.length === 2, "both employees must start while neither has completed");
    const inFlight = await timeline(server, group);
    const user = inFlight.items.find((item) => item.kind === "user");
    assert.ok(user?.kind === "user");
    assert.deepEqual(user.spawns, (accepted.body as { spawns: unknown }).spawns);
    assert.equal(user.engine, "qoder");
    assert.equal(user.mode, "parallel");
    assert.equal(inFlight.items.filter((item) => item.kind === "member" && item.turn.status === "running").length, 2);
    driver.finish(1, "second employee done first");
    driver.finish(0, "first employee done");
    const turns = await settled(server, group);
    assert.deepEqual(new Set(turns.map((turn) => turn.turnId)), new Set(user.spawns?.map((spawn) => spawn.turnId)));
    assert.ok(turns.every((turn) => turn.status === "completed"));
  } finally { driver.settleAll(); await server.close(); await fs.rm(workspace, { recursive: true, force: true }); }
});

test("relay waits for trusted completion, forwards the draft, and keeps the user's original input", async () => {
  const driver = new ControlledDriver();
  const { server, workspace, group } = await setup(driver);
  try {
    const accepted = await api(server.baseUrl, "/groups/" + group.conversationRef + "/turns", {
      method: "POST", token: server.token, body: { input: "Write then review the report", engine: "qoder", mentions: group.members, mode: "relay" },
    });
    assert.equal(accepted.status, 202);
    await until(() => driver.calls.length === 1, "first relay employee should start");
    const before = await timeline(server, group);
    assert.equal(before.items.filter((item) => item.kind === "member").length, 1, "queued second step must not be marked interrupted while the dispatch is alive");
    assert.equal(driver.calls[0]!.positionId, "repo-owner");
    driver.finish(0, "DRAFT-FROM-WRITER-214");
    await until(() => driver.calls.length === 2, "reviewer should start after the writer completed");
    assert.equal(driver.calls[1]!.positionId, "release-engineer");
    assert.match(driver.calls[1]!.envelope.input, /DRAFT-FROM-WRITER-214/);
    assert.match(driver.calls[1]!.envelope.input, /handoff/);
    driver.finish(1, "Reviewed final report");
    const turns = await settled(server, group);
    assert.ok(turns.every((turn) => turn.input === "Write then review the report"));
    assert.ok(turns.every((turn) => turn.status === "completed"));
  } finally { driver.settleAll(); await server.close(); await fs.rm(workspace, { recursive: true, force: true }); }
});

for (const outcome of ["failure", "cancel"] as const) {
  test("relay " + outcome + " blocks later employees without inventing model calls and survives readback", async () => {
    const driver = new ControlledDriver();
    const { server, workspace, group } = await setup(driver);
    try {
      const accepted = await api(server.baseUrl, "/groups/" + group.conversationRef + "/turns", {
        method: "POST", token: server.token, body: { input: "Prepare and review", engine: "qoder", mentions: group.members, mode: "relay" },
      });
      assert.equal(accepted.status, 202);
      await until(() => driver.calls.length === 1, "writer should start");
      if (outcome === "failure") driver.finish(0, "", true);
      else {
        const cancelled = await api(server.baseUrl, "/turns/cancel", { method: "POST", token: server.token, body: { positionId: "repo-owner" } });
        assert.equal(cancelled.status, 200);
      }
      const turns = await settled(server, group);
      assert.equal(driver.calls.length, 1);
      const blocked = turns.find((turn) => turn.positionId === "release-engineer")!;
      assert.equal(blocked.status, "indeterminate");
      assert.equal(blocked.error?.code, "group_relay_blocked");
      assert.match(blocked.error?.message ?? "", /did not run/);
      assert.deepEqual(blocked.events, []);
      assert.equal(blocked.runId, undefined);
      const restarted = await startTestServer(undefined, driver);
      try {
        await open(restarted, workspace);
        const restored = await timeline(restarted, group);
        assert.equal(restored.items.filter((item) => item.kind === "member").length, 2);
        assert.equal(driver.calls.length, 1, "recovery must never repeat model calls");
      } finally { await restarted.close(); }
    } finally { driver.settleAll(); await server.close(); await fs.rm(workspace, { recursive: true, force: true }); }
  });
}

test("durable acceptance without a started turn recovers interrupted identities without replay", async () => {
  const driver = new ControlledDriver();
  const { server, workspace, group } = await setup(driver);
  try {
    const spawns = group.members.map((positionId) => ({ positionId, turnId: crypto.randomUUID() }));
    // Models a control-plane stop after the atomic acceptance write, before
    // the asynchronous spawn callback executes.
    await server.ctx.groupStore.appendMessage(workspace, group.conversationRef, {
      messageId: crypto.randomUUID(), input: "Accepted before shutdown", mentions: group.members,
      mode: "relay", engine: "claude-local", spawns, createdAt: new Date().toISOString(),
    });
    const restarted = await startTestServer(undefined, driver);
    try {
      await open(restarted, workspace);
      const restored = await settled(restarted, group);
      assert.equal(driver.calls.length, 0);
      assert.deepEqual(new Set(restored.map((turn) => turn.turnId)), new Set(spawns.map((spawn) => spawn.turnId)));
      assert.ok(restored.every((turn) => turn.engine === "claude-local" && turn.error?.code === "group_dispatch_interrupted" && turn.events.length === 0));
      assert.equal((await settled(restarted, group)).length, 2, "repeated readback must not duplicate records");
    } finally { await restarted.close(); }
  } finally { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); }
});

test("a busy employee cannot be overwritten and cancelling it leaves the other employee running", async () => {
  const driver = new ControlledDriver();
  const { server, workspace, group } = await setup(driver);
  try {
    await api(server.baseUrl, "/groups/" + group.conversationRef + "/turns", {
      method: "POST", token: server.token, body: { input: "Original writer task", engine: "qoder", mentions: ["repo-owner"] },
    });
    await until(() => driver.calls.length === 1, "writer must start");
    const partiallyAccepted = await api(server.baseUrl, "/groups/" + group.conversationRef + "/turns", {
      method: "POST", token: server.token, body: { input: "Independent group assignment", engine: "qoder", mentions: group.members },
    });
    assert.equal(partiallyAccepted.status, 202);
    await until(() => driver.calls.length === 2, "both employees must start");
    await until(async () => (await timeline(server, group)).items.some((item) => item.kind === "member" && item.turn.error?.code === "group_employee_busy"), "the overlapping group assignment must persist an explicit busy result");
    const duplicate = await api(server.baseUrl, "/turns", { method: "POST", token: server.token, body: { positionId: "repo-owner", input: "Duplicate", engine: "qoder" } });
    assert.equal(duplicate.status, 409);
    const cancellation = await api(server.baseUrl, "/turns/cancel", { method: "POST", token: server.token, body: { positionId: "repo-owner" } });
    assert.equal(cancellation.status, 200);
    await until(async () => (await timeline(server, group)).items.some((item) => item.kind === "member" && item.turn.positionId === "repo-owner" && item.turn.status === "indeterminate"), "the cancelled employee should settle");
    const reviewer = (await timeline(server, group)).items.find((item) => item.kind === "member" && item.turn.positionId === "release-engineer");
    assert.ok(reviewer?.kind === "member" && reviewer.turn.status === "running");
    driver.finish(driver.calls.findIndex((call) => call.positionId === "release-engineer"), "independent result");
    const turns = await settled(server, group, 3);
    assert.equal(turns.filter((turn) => turn.error?.code === "turn_cancelled").length, 1);
    assert.equal(turns.filter((turn) => turn.error?.code === "group_employee_busy").length, 1);
    assert.equal(driver.calls.length, 2);
  } finally { driver.settleAll(); await server.close(); await fs.rm(workspace, { recursive: true, force: true }); }
});

test("unsupported group execution modes fail before any task acceptance or model call", async () => {
  const driver = new ControlledDriver();
  const { server, workspace, group } = await setup(driver);
  try {
    for (const mode of ["broadcast", null, 1, {}]) {
      const response = await api(server.baseUrl, "/groups/" + group.conversationRef + "/turns", {
        method: "POST", token: server.token, body: { input: "Do not dispatch", engine: "qoder", mentions: group.members, mode },
      });
      assert.equal(response.status, 400);
    }
    assert.deepEqual((await timeline(server, group)).items, []);
    assert.equal(driver.calls.length, 0);
  } finally { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); }
});

test("changing workspaces while a relay runs cannot dispatch the next employee into the new project", async () => {
  const driver = new ControlledDriver();
  const { server, workspace, group } = await setup(driver);
  const otherWorkspace = await copyExampleWorkspace();
  try {
    await api(server.baseUrl, "/groups/" + group.conversationRef + "/turns", {
      method: "POST", token: server.token, body: { input: "Stay in this project", engine: "qoder", mentions: group.members, mode: "relay" },
    });
    await until(() => driver.calls.length === 1, "writer should start");
    await open(server, otherWorkspace);
    driver.finish(0, "Original project draft");
    await until(async () => {
      const history = await server.ctx.turnStore.history(workspace, "release-engineer", new Date().toISOString());
      return history.turns.some((turn) => turn.error?.code === "group_workspace_changed");
    }, "next step should settle against its original workspace");
    assert.equal(driver.calls.length, 1);
    await open(server, workspace);
    await settled(server, group);
  } finally { driver.settleAll(); await server.close(); await fs.rm(workspace, { recursive: true, force: true }); await fs.rm(otherWorkspace, { recursive: true, force: true }); }
});

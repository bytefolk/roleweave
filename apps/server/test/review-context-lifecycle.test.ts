import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";
import test from "node:test";
import type { TurnRecord, TurnRunDriver, TurnRunRequest, TurnRunResult } from "@roleweave/shared";
import { compactThreadContextHistory, materializeThreadContext } from "../src/turns/thread-context.js";
import { executeTurn } from "../src/routes/turns.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

const sink = (): ServerResponse => ({ setHeader() {}, writeHead() {}, end() {} }) as unknown as ServerResponse;
const now = "2026-09-09T00:00:00.000Z";

test("review #1 group context redacts credentials before an 8 KiB boundary and retains the receipt", () => {
  const secret = "sk-" + "a".repeat(40);
  const content = "x".repeat(8180) + " " + secret;
  const record = { turnId: "history", input: content, output: content, status: "completed", createdAt: now } as TurnRecord;
  const compact = compactThreadContextHistory([record]);
  const result = materializeThreadContext({ input: "continue", enabled: true, ...compact });
  assert.doesNotMatch(result.input, /sk-a+/, "even a shortened credential must never reach the next model");
  assert.equal(result.metadata.redacted, true, "a pre-sanitized projection must preserve redaction provenance");
  assert.equal(result.metadata.truncated, true);
});

test("review #1 session and group projections of identical context have identical redaction receipts", () => {
  const record = { turnId: "history", input: "TOKEN=fixture-private-token", output: "Bearer fixture-private-bearer", status: "completed", createdAt: now } as TurnRecord;
  const session = materializeThreadContext({ input: "continue", enabled: true, turns: [record] });
  const group = materializeThreadContext({ input: "continue", enabled: true, ...compactThreadContextHistory([record]) });
  assert.equal(group.input, session.input);
  assert.equal(group.metadata.contextDigest, session.metadata.contextDigest);
  assert.equal(group.metadata.redacted, true);
  assert.deepEqual(group.metadata, session.metadata);
});

class WaitingDriver implements TurnRunDriver {
  calls: TurnRunRequest[] = [];
  private releases: Array<() => void> = [];
  entered!: () => void;
  readonly started = new Promise<void>((resolve) => { this.entered = resolve; });
  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    this.calls.push(request);
    return new Promise((resolve) => {
      const release = () => resolve({ status: "indeterminate", events: [], diagnostic: "", code: "turn_cancelled" });
      this.releases.push(release);
      request.setAbort?.(release);
      this.entered();
    });
  }
  cleanup(): void { this.releases.forEach((release) => release()); }
}

test("review #3 an explicit turn owner remains cancellable after opening another workspace", async () => {
  const driver = new WaitingDriver();
  const server = await startTestServer(undefined, driver);
  const first = await copyExampleWorkspace();
  const second = await copyExampleWorkspace();
  let pending: Promise<TurnRecord> | undefined;
  try {
    await server.ctx.workspace.openWorkspace(first);
    pending = executeTurn(server.ctx, sink(), { positionId: "repo-owner", input: "original task", engine: "qoder" });
    await driver.started;
    await server.ctx.workspace.openWorkspace(second);
    const turnId = driver.calls[0]!.envelope.turnId;
    const cancelled = await api(server.baseUrl, "/turns/cancel", { method: "POST", token: server.token,
      body: { positionId: "repo-owner", workspacePath: first, turnId } });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal((await pending).error?.code, "turn_cancelled");
    await assert.rejects(fs.access(path.join(second, ".digital-employee", "workbench", "conversations")), { code: "ENOENT" });
  } finally { driver.cleanup(); await pending; await server.close(); await fs.rm(first, { recursive: true, force: true }); await fs.rm(second, { recursive: true, force: true }); }
});

for (const endpoint of ["rotate", "context"] as const) {
  test(`review #5 ${endpoint} rejects a live group turn for the session's employee`, async () => {
    const driver = new WaitingDriver();
    const server = await startTestServer(undefined, driver);
    const workspace = await copyExampleWorkspace();
    let pending: Promise<TurnRecord> | undefined;
    try {
      await server.ctx.workspace.openWorkspace(workspace);
      const session = await server.ctx.sessionStore.create(workspace, "repo-owner");
      const group = await server.ctx.groupStore.create({ workspace, sessionId: crypto.randomUUID(), members: ["repo-owner", "release-engineer"], now });
      const turnId = crypto.randomUUID();
      pending = executeTurn(server.ctx, sink(), { positionId: "repo-owner", input: "group task", engine: "qoder" }, undefined,
        { turnId, positionId: "repo-owner", engine: "qoder", groupRef: group.conversationRef, messageId: crypto.randomUUID() });
      await driver.started;
      const response = await api(server.baseUrl, `/sessions/${session.sessionId}/${endpoint}`, { method: endpoint === "rotate" ? "POST" : "PATCH", token: server.token,
        body: endpoint === "rotate" ? {} : { enabled: false } });
      assert.equal(response.status, 409, JSON.stringify(response.body));
      const unchanged = await server.ctx.sessionStore.get(workspace, session.sessionId);
      assert.equal(unchanged.status, "active");
      assert.equal(unchanged.threadContextEnabled, true);
    } finally { driver.cleanup(); await pending; await server.close(); await fs.rm(workspace, { recursive: true, force: true }); }
  });
}

test("review #4 group context isolates unrelated corruption and retains healthy accepted group results", async () => {
  const captured: TurnRunRequest[] = [];
  const driver: TurnRunDriver = { async turnRun(request) {
    captured.push(request);
    const events: TurnRunResult["events"] = [
      { type: "run.started", runId: request.envelope.turnId, timestamp: now },
      { type: "run.completed", runId: request.envelope.turnId, timestamp: now, output: "HEALTHY-GROUP-RESULT", terminalReason: "goal_met" },
    ];
    return { status: "trusted", events, diagnostic: "" };
  } };
  const server = await startTestServer(undefined, driver);
  const workspace = await copyExampleWorkspace();
  try {
    await server.ctx.workspace.openWorkspace(workspace);
    const group = await server.ctx.groupStore.create({ workspace, sessionId: crypto.randomUUID(), members: ["repo-owner", "release-engineer"], now });
    async function run(positionId: string): Promise<TurnRecord> {
      const turnId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      await server.ctx.groupStore.appendMessage(workspace, group.conversationRef, { messageId, input: "group background", mentions: [positionId], engine: "qoder", spawns: [{ positionId, turnId }], createdAt: now });
      return executeTurn(server.ctx, sink(), { positionId, input: "group background", engine: "qoder" }, undefined,
        { groupRef: group.conversationRef, messageId, turnId, positionId, engine: "qoder" });
    }
    await run("repo-owner");
    await server.ctx.turnStore.history(workspace, "release-engineer", now);
    const badFile = path.join(workspace, ".digital-employee", "workbench", "conversations", "release-engineer", "turns", "unrelated.json");
    await fs.writeFile(badFile, '{"personal":"CORRUPTED-PRIVATE-SECRET"');
    await run("repo-owner");
    assert.match(captured[1]!.envelope.input, /HEALTHY-GROUP-RESULT/);
    assert.doesNotMatch(captured[1]!.envelope.input, /CORRUPTED-PRIVATE-SECRET/);
    await fs.rm(badFile);
    const badGroup = await run("release-engineer");
    await fs.writeFile(path.join(workspace, ".digital-employee", "workbench", "conversations", "release-engineer", "turns", `${badGroup.turnId}.json`), '{"output":"CORRUPTED-GROUP-RESULT"');
    const next = await run("repo-owner");
    assert.match(captured.at(-1)!.envelope.input, /HEALTHY-GROUP-RESULT/);
    assert.doesNotMatch(captured.at(-1)!.envelope.input, /CORRUPTED-GROUP-RESULT/);
    assert.ok((next.threadContext?.omittedTurnCount ?? 0) >= 1, "a rejected group source is reflected as omitted context");
  } finally { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); }
});

test("review M6 completed personal content stays out of every group member prompt while same-group results remain available", async () => {
  const captured: TurnRunRequest[] = [];
  const driver: TurnRunDriver = { async turnRun(request) {
    captured.push(request);
    const output = request.envelope.input === "PERSONAL-PRIVATE-INPUT" ? "PERSONAL-PRIVATE-OUTPUT" : "HEALTHY-SHARED-GROUP-OUTPUT";
    return { status: "trusted", diagnostic: "", events: [
      { type: "run.started", runId: request.envelope.turnId, timestamp: now },
      { type: "run.completed", runId: request.envelope.turnId, timestamp: now, output, terminalReason: "goal_met" },
    ] };
  } };
  const server = await startTestServer(undefined, driver);
  const workspace = await copyExampleWorkspace();
  try {
    await server.ctx.workspace.openWorkspace(workspace);
    const personal = await executeTurn(server.ctx, sink(), { positionId: "repo-owner", input: "PERSONAL-PRIVATE-INPUT", engine: "qoder" });
    assert.equal(personal.status, "completed");
    assert.equal((await server.ctx.turnStore.history(workspace, "repo-owner", now)).turns[0]!.output, "PERSONAL-PRIVATE-OUTPUT", "privacy assertion must start from durable personal history");
    const group = await server.ctx.groupStore.create({ workspace, sessionId: crypto.randomUUID(), members: ["repo-owner", "release-engineer"], now });
    async function run(positionId: string): Promise<TurnRecord> {
      const turnId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      await server.ctx.groupStore.appendMessage(workspace, group.conversationRef, { messageId, input: "group task", mentions: [positionId], engine: "qoder", spawns: [{ positionId, turnId }], createdAt: now });
      return executeTurn(server.ctx, sink(), { positionId, input: "group task", engine: "qoder" }, undefined,
        { groupRef: group.conversationRef, messageId, turnId, positionId, engine: "qoder" });
    }
    await run("repo-owner");
    // Existing workspaces also contain legacy messages without accepted spawn
    // identities. Their fallback still needs the same privacy boundary.
    await server.ctx.groupStore.appendMessage(workspace, group.conversationRef, { messageId: crypto.randomUUID(), input: "legacy group task", mentions: group.members, createdAt: now });
    for (const member of group.members) {
      await run(member);
      const input = captured.at(-1)!.envelope.input;
      assert.doesNotMatch(input, /PERSONAL-PRIVATE-(?:INPUT|OUTPUT)/, member);
      assert.match(input, /HEALTHY-SHARED-GROUP-OUTPUT/, "positive control: healthy same-group context was really injected");
    }
  } finally { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); }
});

test("review #3 stale explicit owners cannot cancel a newer turn or cause arbitrary workspace filesystem access", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  let aborted = 0;
  const old = server.ctx.runningTurns.reserve(workspace, "repo-owner", "old-turn");
  old.release();
  const current = server.ctx.runningTurns.reserve(workspace, "repo-owner", "new-turn");
  current.setAbort(() => { aborted += 1; });
  try {
    const cancel = (body: unknown) => api(server.baseUrl, "/turns/cancel", { method: "POST", token: server.token, body });
    assert.equal((await cancel({ workspacePath: workspace, positionId: "repo-owner", turnId: "old-turn" })).status, 404);
    const absent = path.join(workspace, "must-not-be-opened");
    assert.equal((await cancel({ workspacePath: absent, positionId: "repo-owner", turnId: "new-turn" })).status, 404);
    await assert.rejects(fs.access(absent), { code: "ENOENT" });
    assert.equal(aborted, 0);
    assert.equal((await cancel({ workspacePath: workspace, positionId: "repo-owner", turnId: "new-turn" })).status, 200, "explicit owner works even without an open workspace");
    assert.equal(aborted, 1);
    for (const body of [ { positionId: "repo-owner", turnId: "new-turn" }, { workspacePath: workspace, positionId: "repo-owner", extra: true }, { workspacePath: "", positionId: "repo-owner" } ]) {
      assert.equal((await cancel(body)).status, 400);
    }
  } finally { current.release(); await server.close(); await fs.rm(workspace, { recursive: true, force: true }); }
});

for (const endpoint of ["rotate", "context"] as const) {
  test(`review #5 ${endpoint} excludes a new turn throughout the asynchronous lifecycle transaction`, async () => {
    const server = await startTestServer();
    const workspace = await copyExampleWorkspace();
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let mutation: ReturnType<typeof api> | undefined;
    try {
      await server.ctx.workspace.openWorkspace(workspace);
      const session = await server.ctx.sessionStore.create(workspace, "repo-owner");
      if (endpoint === "rotate") {
        const rotate = server.ctx.sessionStore.rotate.bind(server.ctx.sessionStore);
        server.ctx.sessionStore.rotate = async (...args) => { entered(); await gate; return rotate(...args); };
      } else {
        const setContext = server.ctx.sessionStore.setThreadContext.bind(server.ctx.sessionStore);
        server.ctx.sessionStore.setThreadContext = async (...args) => { entered(); await gate; return setContext(...args); };
      }
      mutation = api(server.baseUrl, `/sessions/${session.sessionId}/${endpoint}`, { method: endpoint === "rotate" ? "POST" : "PATCH", token: server.token, body: endpoint === "rotate" ? {} : { enabled: false } });
      await inside;
      const overlap = await api(server.baseUrl, "/turns", { method: "POST", token: server.token, body: { positionId: "repo-owner", input: "overlapping task", engine: "qoder" } });
      assert.equal(overlap.status, 409);
      const cancel = await api(server.baseUrl, "/turns/cancel", { method: "POST", token: server.token, body: { positionId: "repo-owner", workspacePath: workspace } });
      assert.equal(cancel.status, 404, "a lifecycle reservation is not a cancellable model turn");
      release();
      assert.equal((await mutation).status, endpoint === "rotate" ? 201 : 200);
      const subsequent = await api(server.baseUrl, "/turns", { method: "POST", token: server.token, body: { positionId: "repo-owner", input: "after mutation", engine: "qoder" } });
      assert.equal(subsequent.status, 200, "completed lifecycle mutation releases the shared employee slot");
    } finally { release(); await mutation; await server.close(); await fs.rm(workspace, { recursive: true, force: true }); }
  });
}

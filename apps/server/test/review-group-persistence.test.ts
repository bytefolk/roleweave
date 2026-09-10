import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { GroupConversation, GroupTimeline, SseEventEnvelope, TurnRecord } from "@roleweave/shared";
import { EventBus } from "../src/bus.js";
import { GroupStore } from "../src/groups/store.js";
import { TurnStore, nodeAtomicTurnWriteOperations, isTurnRecord, compareRfc3339Instants } from "../src/turns/store.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

const originalTime = "2026-09-01T00:00:00.000Z";
const digest = `sha256:${"0".repeat(64)}`;

for (const scope of ["position", "session"] as const) {
  test(`${scope} finish releases activity after an atomic write failure and permits retry`, async (t) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-finish-review-"));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    let failWrite = false;
    const store = new TurnStore({ atomicWriteOperations: {
      ...nodeAtomicTurnWriteOperations,
      async rename(source, target) {
        if (failWrite) throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
        await nodeAtomicTurnWriteOperations.rename(source, target);
      },
    } });
    const sessionId = crypto.randomUUID();
    const input = { workspace, positionId: "repo-owner", turnId: crypto.randomUUID(), engine: "qoder" as const,
      message: "Original task", envelopeDigest: digest, now: originalTime };
    const running = scope === "session" ? await store.beginSession({ ...input, sessionId }) : await store.begin(input);
    const terminal: TurnRecord = { ...running, status: "indeterminate", error: { code: "review_failure", message: "Synthetic failure", retryable: false } };
    failWrite = true;
    await assert.rejects(scope === "session" ? store.finishSession(workspace, sessionId, terminal) : store.finish(workspace, terminal), /persisted atomically/);
    failWrite = false;
    if (scope === "session") {
      assert.equal(store.hasActiveSessionTurns(workspace, sessionId), false, "failed persistence must not keep the session busy forever");
      await store.finishSession(workspace, sessionId, terminal);
      assert.equal((await store.sessionHistory(workspace, sessionId, input.positionId, originalTime)).turns[0]?.error?.code, "review_failure");
    } else {
      const restored = await store.history(workspace, input.positionId, originalTime);
      assert.equal(restored.turns[0]?.status, "indeterminate", "failed completion cannot remain an in-process active turn");
      await store.finish(workspace, terminal);
      assert.equal((await store.history(workspace, input.positionId, originalTime)).turns[0]?.error?.code, "review_failure");
    }
  });
}

test("a throwing event listener cannot abort delivery or poison later publication", () => {
  const bus = new EventBus();
  const seen: SseEventEnvelope[] = [];
  let failures = 0;
  bus.subscribe(() => { failures += 1; throw new Error("closed SSE response"); });
  bus.subscribe((event) => seen.push(event));
  assert.doesNotThrow(() => bus.publish("group.turn.spawned", { turnId: "one" }));
  assert.doesNotThrow(() => bus.publish("turn.indeterminate", { turnId: "two" }));
  assert.equal(failures, 1, "the failed subscriber should be detached");
  assert.deepEqual(seen.map((event) => event.seq), [1, 2]);
  assert.deepEqual(bus.since(0), seen, "SSE replay remains complete for healthy clients");
});

for (const [name, input] of [
  ["plain UTF-8", "a".repeat(256 * 1024)],
  ["multibyte", "😀".repeat(64 * 1024)],
  ["JSON escaping", "\"\\".repeat(128 * 1024)],
  ["six-byte JSON control escaping", "x" + "\u0000".repeat(256 * 1024 - 1)],
] as const) {
  test(`maximum group acceptance persists and reads back ${name} with 32 spawn identities`, async (t) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-group-size-review-"));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new GroupStore();
    const members = Array.from({ length: 32 }, (_, index) => `employee-${String(index).padStart(2, "0")}-${"a".repeat(52)}`);
    const group = await store.create({ workspace, sessionId: crypto.randomUUID(), members, now: originalTime });
    const message = { messageId: crypto.randomUUID(), input, mentions: members, mode: "parallel" as const,
      engine: "claude-local" as const, spawns: members.map((positionId) => ({ positionId, turnId: crypto.randomUUID() })), createdAt: originalTime };
    const saved = await store.appendMessage(workspace, group.conversationRef, message);
    assert.deepEqual(await store.readMessages(workspace, group.conversationRef), [saved]);
    assert.equal(Buffer.byteLength(saved.input), 256 * 1024);
    assert.deepEqual(saved.spawns, message.spawns);
  });
}

test("overlapping interrupted-spawn recovery creates once and retains the acceptance timestamp", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } })).status, 200);
  const created = await api(server.baseUrl, "/groups", { method: "POST", token: server.token, body: { memberPositionIds: ["repo-owner", "release-engineer"] } });
  const group = created.body as GroupConversation;
  const turnId = crypto.randomUUID();
  await server.ctx.groupStore.appendMessage(workspace, group.conversationRef, {
    messageId: crypto.randomUUID(), input: "Accepted before restart", mentions: ["repo-owner"],
    mode: "relay", engine: "qoder", spawns: [{ positionId: "repo-owner", turnId }], createdAt: originalTime,
  });
  const begin = server.ctx.turnStore.begin.bind(server.ctx.turnStore);
  let begins = 0;
  server.ctx.turnStore.begin = async (input) => {
    begins += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return begin(input);
  };
  const responses = await Promise.all(Array.from({ length: 4 }, () => api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { token: server.token })));
  assert.equal(begins, 1, "concurrent timeline polls must share one recovery operation");
  for (const response of responses) {
    assert.equal(response.status, 200);
    const turns = (response.body as GroupTimeline).items.flatMap((item) => item.kind === "member" ? [item.turn] : []);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.turnId, turnId);
    assert.equal(turns[0]?.createdAt, originalTime, "the recovered step belongs at its original acceptance time");
    assert.equal(turns[0]?.error?.code, "group_dispatch_interrupted");
  }
});

test("session HTTP completion write failure returns 500 and releases context policy and rotation", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  let failedWrites = 0;
  server.ctx.turnStore = new TurnStore({ atomicWriteOperations: {
    ...nodeAtomicTurnWriteOperations,
    async rename(source, target) {
      const record = JSON.parse(await fs.readFile(source, "utf8")) as { status?: string };
      if (record.status === "completed") {
        failedWrites += 1;
        throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
      }
      await nodeAtomicTurnWriteOperations.rename(source, target);
    },
  } });
  assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } })).status, 200);
  const created = await api(server.baseUrl, "/sessions", { method: "POST", token: server.token, body: { positionId: "repo-owner" } });
  assert.equal(created.status, 201);
  const sessionId = (created.body as { sessionId: string }).sessionId;
  const result = await api(server.baseUrl, `/sessions/${sessionId}/turns`, { method: "POST", token: server.token, body: { input: "Save the result", engine: "qoder" } });
  assert.equal(result.status, 500, "a failed durable write must not report task success");
  assert.equal(failedWrites, 1);
  const updated = await api(server.baseUrl, `/sessions/${sessionId}/context`, { method: "PATCH", token: server.token, body: { enabled: false } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const rotated = await api(server.baseUrl, `/sessions/${sessionId}/rotate`, { method: "POST", token: server.token, body: {} });
  assert.equal(rotated.status, 201, JSON.stringify(rotated.body));
  assert.equal(server.ctx.turnStore.hasActiveSessionTurns(workspace, sessionId), false);
});

test("rejected async event subscribers are detached without an unhandled rejection", async () => {
  const bus = new EventBus();
  let failures = 0;
  const received: number[] = [];
  bus.subscribe(async () => { failures += 1; throw new Error("async subscriber failure"); });
  bus.subscribe((event) => received.push(event.seq));
  bus.publish("group.turn.spawned", {});
  await new Promise((resolve) => setImmediate(resolve));
  bus.publish("turn.indeterminate", {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [1, 2]);
  assert.equal(failures, 1);
});

test("a broken SSE subscriber cannot stop parallel group dispatch or terminal readback", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } })).status, 200);
  const created = await api(server.baseUrl, "/groups", { method: "POST", token: server.token, body: { memberPositionIds: ["repo-owner", "release-engineer"] } });
  const group = created.body as GroupConversation;
  const events: SseEventEnvelope[] = [];
  server.ctx.bus.subscribe((event) => { if (event.type === "group.turn.spawned") throw new Error("closed SSE response"); });
  server.ctx.bus.subscribe((event) => events.push(event));
  const accepted = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { method: "POST", token: server.token, body: { input: "Both employees finish", engine: "qoder", mentions: group.members } });
  assert.equal(accepted.status, 202);
  const deadline = Date.now() + 5000;
  while (events.filter((event) => event.type === "turn.completed").length < 2) {
    assert.ok(Date.now() < deadline, "both independent tasks should finish despite a broken subscriber");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const response = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { token: server.token });
  assert.equal(response.status, 200);
  assert.equal((response.body as GroupTimeline).items.filter((item) => item.kind === "member" && item.turn.status === "completed").length, 2);
  assert.equal(events.filter((event) => event.type === "group.turn.spawned").length, 2);
});

test("group HTTP accepts a 32-member escaped 256 KiB request and rejects bodies above the existing 1 MiB cap before acceptance", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  const organizationPath = path.join(workspace, "organization.v1alpha1.json");
  const organization = JSON.parse(await fs.readFile(organizationPath, "utf8"));
  const members = ["repo-owner", ...Array.from({ length: 31 }, (_, index) => `employee-${String(index).padStart(2, "0")}-${"a".repeat(52)}`)];
  organization.roles = members.map((id, index) => ({ ...organization.roles[0], id, reportTo: index === 0 ? null : "repo-owner" }));
  await fs.writeFile(organizationPath, JSON.stringify(organization));
  assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } })).status, 200);
  const created = await api(server.baseUrl, "/groups", { method: "POST", token: server.token, body: { memberPositionIds: members } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const group = created.body as GroupConversation;
  const input = "\"\\".repeat(128 * 1024);
  const accepted = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { method: "POST", token: server.token, body: { input, engine: "qoder", mentions: members, mode: "parallel" } });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  const messageId = (accepted.body as { messageId: string }).messageId;
  const deadline = Date.now() + 30000;
  while (server.ctx.groupStore.hasActiveDispatch(workspace, group.conversationRef, messageId)) {
    assert.ok(Date.now() < deadline, "accepted group dispatch should finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const messages = await server.ctx.groupStore.readMessages(workspace, group.conversationRef);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.input, input);
  assert.equal(messages[0]?.spawns?.length, 32);
  const tooLarge = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { method: "POST", token: server.token, body: { input: "x" + "\u0000".repeat(256 * 1024 - 1), engine: "qoder", mentions: members, mode: "parallel" } });
  assert.equal(tooLarge.status, 400);
  assert.equal((tooLarge.body as { code: string }).code, "body_invalid");
  assert.equal((await server.ctx.groupStore.readMessages(workspace, group.conversationRef)).length, 1, "rejected request must not create acceptance records");
});

test("failed spawn recovery releases its lock so a later timeline poll can persist the accepted identity", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } })).status, 200);
  const created = await api(server.baseUrl, "/groups", { method: "POST", token: server.token, body: { memberPositionIds: ["repo-owner", "release-engineer"] } });
  const group = created.body as GroupConversation;
  const turnId = crypto.randomUUID();
  await server.ctx.groupStore.appendMessage(workspace, group.conversationRef, { messageId: crypto.randomUUID(), input: "Retry persistence only", mentions: ["repo-owner"], mode: "relay", engine: "qoder", spawns: [{ positionId: "repo-owner", turnId }], createdAt: originalTime });
  const begin = server.ctx.turnStore.begin.bind(server.ctx.turnStore);
  let begins = 0;
  server.ctx.turnStore.begin = async (input) => {
    begins += 1;
    if (begins === 1) throw new Error("synthetic persistence interruption");
    return begin(input);
  };
  const first = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { token: server.token });
  assert.equal(first.status, 200);
  assert.equal((first.body as GroupTimeline).items.filter((item) => item.kind === "member").length, 0, "a failed write must not invent a persisted turn");
  const second = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { token: server.token });
  assert.equal(second.status, 200);
  const turns = (second.body as GroupTimeline).items.flatMap((item) => item.kind === "member" ? [item.turn] : []);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.turnId, turnId);
  assert.equal(turns[0]?.createdAt, originalTime);
  assert.equal(turns[0]?.error?.code, "group_dispatch_interrupted");
  assert.equal(begins, 2);
});

test("timeline keeps healthy group members readable when another accepted turn is corrupt", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } })).status, 200);
  const created = await api(server.baseUrl, "/groups", { method: "POST", token: server.token, body: { memberPositionIds: ["repo-owner", "release-engineer"] } });
  const group = created.body as GroupConversation;
  const accepted = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { method: "POST", token: server.token, body: { input: "Independent results", engine: "qoder", mentions: group.members } });
  assert.equal(accepted.status, 202);
  const body = accepted.body as { messageId: string; spawns: Array<{ positionId: string; turnId: string }> };
  const deadline = Date.now() + 5000;
  while (server.ctx.groupStore.hasActiveDispatch(workspace, group.conversationRef, body.messageId)) {
    assert.ok(Date.now() < deadline, "group dispatch should finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const corrupt = body.spawns.find((spawn) => spawn.positionId === "release-engineer")!;
  const corruptFile = path.join(workspace, ".digital-employee/workbench/conversations/release-engineer/turns", `${corrupt.turnId}.json`);
  await fs.writeFile(corruptFile, "{broken");
  const response = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { token: server.token });
  assert.equal(response.status, 200);
  const turns = (response.body as GroupTimeline).items.flatMap((item) => item.kind === "member" ? [item.turn] : []);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.positionId, "repo-owner");
  assert.equal(turns[0]?.status, "completed");
  assert.equal(await fs.readFile(corruptFile, "utf8"), "{broken", "a corrupt source must not be overwritten with a fabricated terminal");
});

test("single-turn reads isolate sibling corruption and retain identity validation and restart recovery", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-single-record-review-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const store = new TurnStore();
  const turnId = crypto.randomUUID();
  const running = await store.begin({ workspace, positionId: "repo-owner", turnId, engine: "qoder", message: "Retain this task", envelopeDigest: digest, now: originalTime });
  const turnsDir = path.join(workspace, ".digital-employee/workbench/conversations/repo-owner/turns");
  await fs.writeFile(path.join(turnsDir, "broken.json"), "{broken");
  assert.deepEqual(await store.readPositionTurn(workspace, "repo-owner", turnId, originalTime), running);
  assert.equal(await store.readPositionTurn(workspace, "repo-owner", "missing", originalTime), null);
  await fs.copyFile(path.join(turnsDir, `${turnId}.json`), path.join(turnsDir, "wrong-identity.json"));
  await assert.rejects(store.readPositionTurn(workspace, "repo-owner", "wrong-identity", originalTime), /invalid record/);
  const restarted = new TurnStore();
  const recovered = await restarted.readPositionTurn(workspace, "repo-owner", turnId, "2026-09-02T00:00:00Z");
  assert.equal(recovered?.status, "indeterminate");
  assert.equal(recovered?.createdAt, originalTime);
  assert.equal(recovered?.error?.code, "turn_interrupted");
  assert.deepEqual(await restarted.readPositionTurn(workspace, "repo-owner", turnId, "2026-09-03T00:00:00Z"), recovered);
});

test("group messages sort by RFC 3339 instant with nanoseconds and reject invalid persisted dates", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-group-time-review-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const store = new GroupStore();
  const group = await store.create({ workspace, sessionId: crypto.randomUUID(), members: ["repo-owner", "release-engineer"], now: originalTime });
  const entries = [
    { messageId: "second", createdAt: "2026-09-01T00:00:00.000000002Z" },
    { messageId: "B-same", createdAt: "2026-09-01T08:00:00.000000001+08:00" },
    { messageId: "a-same", createdAt: "2026-09-01T00:00:00.000000001Z" },
    { messageId: "first", createdAt: "2026-09-01T00:00:00Z" },
  ];
  for (const entry of entries) await store.appendMessage(workspace, group.conversationRef, { ...entry, input: "timeline", mentions: ["repo-owner"] });
  assert.deepEqual((await store.readMessages(workspace, group.conversationRef)).map((message) => message.messageId), ["first", "B-same", "a-same", "second"]);
  await assert.rejects(store.appendMessage(workspace, group.conversationRef, { messageId: "invalid", input: "timeline", mentions: ["repo-owner"], createdAt: "yesterday" }), /message is invalid/);
  const file = path.join(workspace, ".digital-employee/workbench/groups", group.conversationRef, "messages/first.json");
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  record.createdAt = "2026-02-30T00:00:00Z";
  await fs.writeFile(file, JSON.stringify(record));
  await assert.rejects(store.readMessages(workspace, group.conversationRef), /invalid record/);
});

test("acceptance visible before append resolves stays owned and cannot be recovered as interrupted", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let pending: Promise<unknown> | undefined;
  t.after(async () => { release(); await pending; await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } })).status, 200);
  const created = await api(server.baseUrl, "/groups", { method: "POST", token: server.token, body: { memberPositionIds: ["repo-owner", "release-engineer"] } });
  const group = created.body as GroupConversation;
  let announceVisible!: () => void;
  const visible = new Promise<void>((resolve) => { announceVisible = resolve; });
  const append = server.ctx.groupStore.appendMessage.bind(server.ctx.groupStore);
  server.ctx.groupStore.appendMessage = async (...args) => {
    const message = await append(...args);
    announceVisible();
    await gate;
    return message;
  };
  pending = api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { method: "POST", token: server.token, body: { input: "Accepted once", engine: "qoder", mentions: ["repo-owner"] } });
  await visible;
  const during = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { token: server.token });
  assert.equal(during.status, 200);
  assert.equal((during.body as GroupTimeline).items.filter((item) => item.kind === "user").length, 1);
  assert.equal((during.body as GroupTimeline).items.filter((item) => item.kind === "member").length, 0, "a visible acceptance is still owned while its original append is pending");
  release();
  const accepted = await pending as { status: number; body: { messageId: string; spawns: Array<{ turnId: string }> } };
  assert.equal(accepted.status, 202);
  const deadline = Date.now() + 5000;
  while (server.ctx.groupStore.hasActiveDispatch(workspace, group.conversationRef, accepted.body.messageId)) {
    assert.ok(Date.now() < deadline, "original dispatch should finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const after = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { token: server.token });
  assert.equal(after.status, 200);
  const turns = (after.body as GroupTimeline).items.flatMap((item) => item.kind === "member" ? [item.turn] : []);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.turnId, accepted.body.spawns[0]?.turnId);
  assert.equal(turns[0]?.status, "completed");
  assert.equal(server.ctx.bus.since(0).filter((event) => event.type === "group.turn.spawned").length, 1);
});

test("context message references retain no original inputs and preserve legacy identities and full validation", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-group-reference-review-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const store = new GroupStore();
  const group = await store.create({ workspace, sessionId: crypto.randomUUID(), members: ["repo-owner", "release-engineer"], now: originalTime });
  for (let index = 0; index < 16; index += 1) {
    await store.appendMessage(workspace, group.conversationRef, {
      messageId: `message-${String(index).padStart(2, "0")}`,
      input: "x".repeat(256 * 1024), mentions: ["repo-owner"], createdAt: originalTime,
      ...(index === 0 ? {} : { engine: "qoder" as const, mode: "parallel" as const, spawns: [{ turnId: crypto.randomUUID(), positionId: "repo-owner" }] }),
    });
  }
  const full = await store.readMessages(workspace, group.conversationRef);
  assert.equal(full.length, 16);
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > 4 * 1024 * 1024);
  store.readMessages = async () => { throw new Error("context lookup must not materialize the full message list before projecting"); };
  const references = await store.readContextMessages(workspace, group.conversationRef);
  assert.deepEqual(references, full.map((message) => ({
    messageId: message.messageId, mentions: message.mentions, createdAt: message.createdAt,
    ...(message.spawns === undefined ? {} : { spawns: message.spawns }),
  })));
  assert.ok(references.every((message) => !Object.hasOwn(message, "input")));
  assert.ok(Buffer.byteLength(JSON.stringify(references)) < 8 * 1024, "retained context references must stay small independently of the original input size");
  assert.equal(references[0]?.spawns, undefined, "legacy mention-only messages must retain their fallback identity");
  const file = path.join(workspace, ".digital-employee/workbench/groups", group.conversationRef, "messages/message-01.json");
  const invalid = JSON.parse(await fs.readFile(file, "utf8"));
  invalid.input = "x".repeat(256 * 1024 + 1);
  await fs.writeFile(file, JSON.stringify(invalid));
  await assert.rejects(store.readContextMessages(workspace, group.conversationRef), /invalid record/, "unused input is still validated before projection");
  invalid.input = "valid input";
  invalid.messageId = "m".repeat(257);
  await fs.writeFile(file, JSON.stringify(invalid));
  await assert.rejects(store.readContextMessages(workspace, group.conversationRef), /invalid record/, "retained identity metadata must also remain bounded");
});

test("group dispatch reads lightweight context references without loading full message inputs", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } })).status, 200);
  const created = await api(server.baseUrl, "/groups", { method: "POST", token: server.token, body: { memberPositionIds: ["repo-owner", "release-engineer"] } });
  const group = created.body as GroupConversation;
  server.ctx.groupStore.readMessages = async () => { throw new Error("dispatch must not retain full acceptance inputs"); };
  const accepted = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { method: "POST", token: server.token, body: { input: "Use identity references", engine: "qoder", mentions: ["repo-owner"] } });
  assert.equal(accepted.status, 202);
  const messageId = (accepted.body as { messageId: string }).messageId;
  const deadline = Date.now() + 5000;
  while (server.ctx.groupStore.hasActiveDispatch(workspace, group.conversationRef, messageId)) {
    assert.ok(Date.now() < deadline, "the accepted task must finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const history = await server.ctx.turnStore.history(workspace, "repo-owner", new Date().toISOString());
  assert.equal(history.turns.length, 1);
  assert.equal(history.turns[0]?.status, "completed");
});

test("accepted group recovery survives clock rollback and repeated timeline reads", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } })).status, 200);
  const created = await api(server.baseUrl, "/groups", { method: "POST", token: server.token, body: { memberPositionIds: ["repo-owner", "release-engineer"] } });
  const group = created.body as GroupConversation;
  const createdAt = new Date(Date.now() + 60000).toISOString();
  const turnId = crypto.randomUUID();
  await server.ctx.groupStore.appendMessage(workspace, group.conversationRef, { messageId: crypto.randomUUID(), input: "Accepted before clock rollback", mentions: ["repo-owner"], mode: "relay", engine: "qoder", spawns: [{ positionId: "repo-owner", turnId }], createdAt });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { token: server.token });
    assert.equal(response.status, 200);
    const turns = (response.body as GroupTimeline).items.flatMap((item) => item.kind === "member" ? [item.turn] : []);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.turnId, turnId);
    assert.equal(turns[0]?.createdAt, createdAt);
    assert.equal(turns[0]?.status, "indeterminate");
    assert.ok(isTurnRecord(turns[0]), "recovered turns must remain valid even when the current clock precedes acceptance");
    assert.ok(compareRfc3339Instants(turns[0]!.updatedAt, createdAt) >= 0);
  }
});

test("single-turn restart recovery preserves timestamp ordering after clock rollback", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-clock-review-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const store = new TurnStore();
  const turnId = crypto.randomUUID();
  const createdAt = "2026-09-09T08:00:00.000000002+08:00";
  await store.begin({ workspace, positionId: "repo-owner", turnId, engine: "qoder", message: "Interrupted task", envelopeDigest: digest, now: createdAt });
  const restarted = new TurnStore();
  const recovered = await restarted.readPositionTurn(workspace, "repo-owner", turnId, "2026-09-09T00:00:00.000000001Z");
  assert.ok(isTurnRecord(recovered));
  assert.equal(recovered?.createdAt, createdAt);
  assert.ok(compareRfc3339Instants(recovered!.updatedAt, createdAt) >= 0);
  assert.deepEqual(await restarted.readPositionTurn(workspace, "repo-owner", turnId, "2026-09-08T23:59:59Z"), recovered);
});

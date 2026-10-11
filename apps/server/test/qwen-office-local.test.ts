import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { probeQwenOfficeLocal, qwenOfficeLocalBridgeConfigured, requestQwenOfficeLocal } from "../src/qwen-office-local.js";
import { DigitalEmployeeCliDriver } from "../src/engine/driver-cli.js";
import { copyExampleWorkspace } from "./helpers.js";

type Request = { id: string; operation: string; payload: Record<string, unknown>; token?: string };
type Progress = (event: { status: "running" | "waiting_for_input" }) => void;
const officeBridge = createRequire(import.meta.url)(fileURLToPath(new URL("../../../desktop/src/qwen-office-bridge.cjs", import.meta.url)));
const officeEnv = (endpoint: string, token: string) => ({ ROLEWEAVE_QWEN_OFFICE_BRIDGE: endpoint, ROLEWEAVE_QWEN_OFFICE_BRIDGE_TOKEN: token });
const reply = (request: Request, socket: net.Socket, result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);

async function rawBridge(t: test.TestContext, respond: (request: Request, socket: net.Socket) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rw-qwen-office-test-"));
  await fs.chmod(root, 0o700);
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\roleweave-qwen-office-${randomUUID()}` : path.join(root, "bridge.sock");
  const token = "a".repeat(64);
  const sockets = new Set<net.Socket>();
  const requests: Request[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0), responded = false;
    socket.on("data", (chunk) => {
      if (responded) return;
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      responded = true;
      const request = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      requests.push(request); respond(request, socket);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  if (process.platform !== "win32") await fs.chmod(endpoint, 0o600);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, endpoint, env: officeEnv(endpoint, token), requests, sockets };
}

async function ownedBridge(t: test.TestContext, invoke: (request: Request, signal: AbortSignal, progress: Progress) => unknown) {
  const channel = officeBridge.createPrivateBridge(invoke);
  await channel.ready;
  t.after(() => channel.close());
  return officeEnv(channel.endpoint, channel.token);
}

test("Office local needs its own private channel and never substitutes service credentials", async (t) => {
  const foreign = { OPENAI_API_KEY: "synthetic-openai", CODEBUDDY_API_KEY: "synthetic-workbuddy", ROLEWEAVE_WORKBUDDY_BRIDGE: "/other/socket", ROLEWEAVE_WORKBUDDY_BRIDGE_TOKEN: "b".repeat(64) };
  assert.equal(qwenOfficeLocalBridgeConfigured(foreign), false);
  assert.deepEqual(await probeQwenOfficeLocal(foreign), { configured: false, code: "qwen_office.client_unavailable" });
  await assert.rejects(requestQwenOfficeLocal(foreign, "complete", { input: "hello" }), { code: "qwen_office.client_unavailable" });
  const f = await rawBridge(t, (request, socket) => reply(request, socket, { configured: true, code: "qwen_office.ready", version: "1.0.0", account: "private-account" }));
  assert.equal(qwenOfficeLocalBridgeConfigured({ ...f.env, ROLEWEAVE_QWEN_OFFICE_BRIDGE_TOKEN: "short" }), false);
  assert.deepEqual(await probeQwenOfficeLocal(f.env), { configured: true, code: "qwen_office.ready", version: "1.0.0" });
});

test("a Unix Office channel rejects public modes and symlink endpoints", { skip: process.platform === "win32" }, async (t) => {
  const f = await rawBridge(t, () => {});
  assert.equal(qwenOfficeLocalBridgeConfigured(f.env), true);
  await fs.chmod(f.endpoint, 0o666);
  assert.equal(qwenOfficeLocalBridgeConfigured(f.env), false);
  await fs.chmod(f.endpoint, 0o600);
  await fs.chmod(f.root, 0o755);
  assert.equal(qwenOfficeLocalBridgeConfigured(f.env), false);
  await fs.chmod(f.root, 0o700);
  const alias = path.join(f.root, "rw-qwen-office-alias");
  await fs.symlink(f.root, alias, "dir");
  assert.equal(qwenOfficeLocalBridgeConfigured({ ...f.env, ROLEWEAVE_QWEN_OFFICE_BRIDGE: path.join(alias, "bridge.sock") }), false);
  await fs.unlink(alias);
  await fs.rename(f.endpoint, path.join(f.root, "actual.sock"));
  await fs.symlink(path.join(f.root, "actual.sock"), f.endpoint);
  assert.equal(qwenOfficeLocalBridgeConfigured(f.env), false);
});

for (const reflection of ["text", "base64", "model"] as const) test(`Office ${reflection} cannot reflect the private relay capability into public output`, async (t) => {
  const f = await rawBridge(t, (request, socket) => {
    const ticket = request.token!;
    reply(request, socket, reflection === "model" ? { text: "Task complete", model: ticket }
      : { text: reflection === "base64" ? Buffer.from(ticket).toString("base64") : `Bearer ${ticket}` });
  });
  await assert.rejects(requestQwenOfficeLocal(f.env, "complete", { input: "hello" }), { code: "qwen_office.credential_reflection" });
});

test("the real Office bridge carries public progress and a final native result without credentials", async (t) => {
  const observed: Request[] = [];
  const env = await ownedBridge(t, (request, _signal, progress) => {
    observed.push(request); progress({ status: "running" }); progress({ status: "waiting_for_input" });
    return { text: "任务已完成", model: "qwen-office-default", usage: { inputTokens: 2, outputTokens: 3 }, account: "must-not-forward" };
  });
  const progress: string[] = [];
  assert.deepEqual(await requestQwenOfficeLocal(env, "complete", { input: "检查资料" }, { onProgress: event => progress.push(event.status) }), {
    text: "任务已完成", model: "qwen-office-default", usage: { inputTokens: 2, outputTokens: 3 },
  });
  assert.deepEqual(progress, ["running", "waiting_for_input"]);
  assert.deepEqual(observed[0]?.payload, { input: "检查资料" });
  assert.equal(observed[0]?.token, undefined, "the transport ticket is consumed by the private broker");
});

test("UTF-8 may split inside a character across progress and final frames", async (t) => {
  const f = await rawBridge(t, (request, socket) => {
    const bytes = Buffer.from(`${JSON.stringify({ id: request.id, event: { status: "running" } })}\n${JSON.stringify({ id: request.id, result: { text: "员工已完成资料整理" } })}\n`);
    const split = bytes.indexOf(Buffer.from("员")) + 1;
    socket.write(bytes.subarray(0, split));
    setImmediate(() => socket.end(bytes.subarray(split)));
  });
  let progress = 0;
  assert.deepEqual(await requestQwenOfficeLocal(f.env, "complete", {}, { onProgress: () => progress++ }), { text: "员工已完成资料整理" });
  assert.equal(progress, 1);
});

for (const invalid of ["wrong-id", "foreign-error", "raw-error", "private-progress", "malformed-utf8", "extra-final"]) {
  test(`Office rejects ${invalid} without exposing provider diagnostics`, async (t) => {
    const f = await rawBridge(t, (request, socket) => {
      if (invalid === "wrong-id") socket.end(`${JSON.stringify({ id: randomUUID(), result: { text: "ok" } })}\n`);
      if (invalid === "foreign-error") socket.end(`${JSON.stringify({ id: request.id, error: "workbuddy.client_unavailable" })}\n`);
      if (invalid === "raw-error") socket.end(`${JSON.stringify({ id: request.id, error: "private-provider-token" })}\n`);
      if (invalid === "private-progress") socket.end(`${JSON.stringify({ id: request.id, event: { status: "running", input: "private-prompt" } })}\n`);
      if (invalid === "malformed-utf8") socket.end(Buffer.concat([Buffer.from('{"id":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
      if (invalid === "extra-final") socket.end(`${JSON.stringify({ id: request.id, result: { text: "ok" } })}\nprivate-provider-token`);
    });
    await assert.rejects(requestQwenOfficeLocal(f.env, "complete"), (error: any) => error.code === "qwen_office.protocol_invalid" && !/private|workbuddy/.test(error.message));
  });
}

test("stable Office errors keep their namespace and unknown usage is omitted", async (t) => {
  const failing = await rawBridge(t, (request, socket) => socket.end(`${JSON.stringify({ id: request.id, error: "qwen_office.confirmation_required" })}\n`));
  await assert.rejects(requestQwenOfficeLocal(failing.env, "complete"), { code: "qwen_office.confirmation_required" });
  const success = await rawBridge(t, (request, socket) => reply(request, socket, { text: "ok", usage: { credits: 77, providerAccount: "private" } }));
  assert.deepEqual(await requestQwenOfficeLocal(success.env, "complete"), { text: "ok" });
  const invalid = await rawBridge(t, (request, socket) => reply(request, socket, { text: "ok", usage: { inputTokens: -1 } }));
  await assert.rejects(requestQwenOfficeLocal(invalid.env, "complete"), { code: "qwen_office.protocol_invalid" });
});

test("progress alone is not a terminal result and progress is bounded", async (t) => {
  const incomplete = await rawBridge(t, (request, socket) => socket.end(`${JSON.stringify({ id: request.id, event: { status: "running" } })}\n`));
  await assert.rejects(requestQwenOfficeLocal(incomplete.env, "complete"), { code: "qwen_office.protocol_invalid" });
  const excessive = await rawBridge(t, (request, socket) => socket.end(Array.from({ length: 65 }, () => `${JSON.stringify({ id: request.id, event: { status: "running" } })}\n`).join("")));
  let events = 0;
  await assert.rejects(requestQwenOfficeLocal(excessive.env, "complete", {}, { onProgress: () => events++ }), { code: "qwen_office.protocol_invalid" });
  assert.equal(events, 64);
  await assert.rejects(requestQwenOfficeLocal(incomplete.env, "probe"), { code: "qwen_office.protocol_invalid" });
});

test("input and aggregate output limits cannot be bypassed by valid prefixes", async (t) => {
  const input = await rawBridge(t, () => {});
  await assert.rejects(requestQwenOfficeLocal(input.env, "complete", { input: "x".repeat(1024 * 1024) }), { code: "qwen_office.input_limit" });
  assert.equal(input.requests.length, 0);
  const output = await rawBridge(t, (request, socket) => socket.end(`${JSON.stringify({ id: request.id, event: { status: "running" } })}\n${"x".repeat(1024 * 1024)}`));
  await assert.rejects(requestQwenOfficeLocal(output.env, "complete"), { code: "qwen_office.output_limit" });
  const text = await rawBridge(t, (request, socket) => reply(request, socket, { text: "x".repeat(640 * 1024 + 1) }));
  await assert.rejects(requestQwenOfficeLocal(text.env, "complete"), { code: "qwen_office.protocol_invalid" });
});

test("caller cancellation and deadline close the owned socket", { timeout: 5000 }, async (t) => {
  const f = await rawBridge(t, () => {});
  await assert.rejects(requestQwenOfficeLocal(f.env, "complete", {}, { timeoutMs: 20 }), { code: "qwen_office.deadline_exceeded" });
  const controller = new AbortController();
  const request = requestQwenOfficeLocal(f.env, "complete", {}, { signal: controller.signal });
  for (let attempt = 0; attempt < 1000 && f.requests.length < 2; attempt++) await delay(1);
  assert.equal(f.requests.length, 2);
  controller.abort();
  await assert.rejects(request, { code: "qwen_office.cancelled" });
  for (let attempt = 0; attempt < 100 && f.sockets.size; attempt++) await delay(2);
  assert.equal(f.sockets.size, 0);
});

async function adapterTurn(workspace: string, env: NodeJS.ProcessEnv, input = "整理当前资料") {
  const adapter = fileURLToPath(new URL("../../bin/qoder-engine.mjs", import.meta.url));
  const child = spawn(process.execPath, [adapter, "turn", "run", workspace, "--position", "repo-owner", "--stdin"], {
    env: { PATH: process.env.PATH, DIGITAL_EMPLOYEE_ENGINE_MODEL: "qwen-office-local", ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  child.stdin.end(JSON.stringify({ input }));
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => clearTimeout(timer));
  assert.equal(exit, 0, stderr);
  return { stdout, events: stdout.trim().split("\n").map(line => JSON.parse(line)) };
}

test("the bundled Office adapter uses fresh sessions and only static public activity", { timeout: 10_000 }, async (t) => {
  const workspace = await copyExampleWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const calls: Request[] = [];
  const env = await ownedBridge(t, (request, _signal, progress) => {
    calls.push(request); progress({ status: "running" }); progress({ status: "waiting_for_input" });
    return { text: "Office fixture connected", usage: { nativeCredits: 1 } };
  });
  for (let turn = 0; turn < 2; turn++) {
    const { stdout, events } = await adapterTurn(workspace, { ...env, OPENAI_API_KEY: "foreign-service-key", DIGITAL_EMPLOYEE_QODER_COMMAND: "must-not-run" });
    assert.deepEqual(events.map(event => event.type), ["run.started", "trace.activity", "trace.activity", "trace.activity", "model.delta", "run.completed"]);
    assert.equal(events.at(-1).output, "Office fixture connected");
    assert.equal(new Set(events.map(event => event.runId)).size, 1);
    const activity = events.filter(event => event.type === "trace.activity");
    assert.deepEqual(activity.map(event => event.title), ["千问办公正在执行任务", "请在千问办公确认审批或补充信息", "千问办公任务已完成"]);
    assert.ok(activity.every(event => !Object.hasOwn(event, "input") && !Object.hasOwn(event, "output") && !Object.hasOwn(event, "path")));
    assert.ok(!stdout.includes("foreign-service-key"));
  }
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]!.payload.sessionKey, calls[1]!.payload.sessionKey);
  for (const call of calls) {
    assert.match(String(call.payload.sessionKey), /^[a-f0-9]{64}$/);
    assert.match(String(call.payload.input), /RoleWeave employee: repo-owner/);
    assert.match(String(call.payload.input), /整理当前资料/);
    assert.equal(call.operation, "complete");
    assert.equal(call.payload.model, undefined);
  }
});

test("an unavailable Office client or pinned foreign model fails without borrowing another engine", { timeout: 10_000 }, async (t) => {
  const workspace = await copyExampleWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const marker = path.join(workspace, "qoder-was-started");
  const fallback = path.join(workspace, "qoder.mjs");
  await fs.writeFile(fallback, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'unexpected');`);
  const absent = await adapterTurn(workspace, { OPENAI_API_KEY: "foreign-service-key", CODEBUDDY_API_KEY: "foreign-workbuddy-key", DIGITAL_EMPLOYEE_QODER_COMMAND: `${process.execPath} ${fallback}` });
  assert.deepEqual(absent.events.map(event => event.type), ["run.started", "run.failed"]);
  assert.equal(absent.events.at(-1).error.code, "qwen_office.client_unavailable");
  assert.doesNotMatch(absent.stdout, /foreign-service-key|foreign-workbuddy-key/);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  let calls = 0;
  const env = await ownedBridge(t, () => { calls++; return { text: "should not run" }; });
  const pinned = await adapterTurn(workspace, { ...env, ROLEWEAVE_TURN_MODEL: "foreign-model" });
  assert.equal(pinned.events.at(-1).error.code, "qwen_office.model_unavailable");
  assert.equal(calls, 0);
});

test("a disconnected Office task emits one failed terminal after public progress", { timeout: 10_000 }, async (t) => {
  const workspace = await copyExampleWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const f = await rawBridge(t, (request, socket) => socket.end(`${JSON.stringify({ id: request.id, event: { status: "running" } })}\n`));
  const { events } = await adapterTurn(workspace, f.env);
  assert.deepEqual(events.map(event => event.type), ["run.started", "trace.activity", "run.failed"]);
  assert.equal(events.at(-1).error.code, "qwen_office.protocol_invalid");
  assert.equal(new Set(events.map(event => event.runId)).size, 1);
});

test("Office dispatch is bundled only and its turn environment receives no foreign credential", { timeout: 10_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "office-driver-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "driver.mjs"), marker = path.join(root, "spawned");
  const injected = {
    ROLEWEAVE_QWEN_OFFICE_BRIDGE: "owned-endpoint", ROLEWEAVE_QWEN_OFFICE_BRIDGE_TOKEN: "a".repeat(64),
    OPENAI_API_KEY: "foreign-openai", CODEBUDDY_API_KEY: "foreign-workbuddy", ANTHROPIC_AUTH_TOKEN: "foreign-claude",
    ROLEWEAVE_WORKBUDDY_BRIDGE: "foreign-channel", ROLEWEAVE_WORKBUDDY_BRIDGE_TOKEN: "b".repeat(64), ORG_WORKBENCH_TOKEN: "control-plane-token",
  };
  const saved = Object.fromEntries(Object.keys(injected).map(key => [key, process.env[key]]));
  await fs.writeFile(entry, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');
for await(const chunk of process.stdin){}
if(process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL!=='qwen-office-local')process.exit(8);
if(process.env.ROLEWEAVE_QWEN_OFFICE_BRIDGE!=='owned-endpoint'||process.env.ROLEWEAVE_QWEN_OFFICE_BRIDGE_TOKEN!==${JSON.stringify(injected.ROLEWEAVE_QWEN_OFFICE_BRIDGE_TOKEN)})process.exit(9);
if(${JSON.stringify(Object.keys(injected).filter(key => !key.startsWith("ROLEWEAVE_QWEN_OFFICE_")))}.some(key=>process.env[key]!==undefined))process.exit(7);
const base={runId:'office-run',timestamp:'2026-10-11T00:00:00.000Z'};
console.log(JSON.stringify({...base,type:'run.started'}));console.log(JSON.stringify({...base,type:'run.completed',output:'ok',terminalReason:'goal_met'}));`);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)}`;
  const request = { workspace: root, positionId: "repo-owner", engine: "qwen-office-local" as const, envelope: {
    schemaVersion: "turn-envelope.v1" as const, workspaceRef: root, positionId: "repo-owner", turnId: "office-test", input: "hello", envelopeDigest: `sha256:${"a".repeat(64)}`,
  } };
  try {
    Object.assign(process.env, injected);
    const external = await new DigitalEmployeeCliDriver(command, 5000, false).turnRun(request);
    assert.equal(external.status, "indeterminate");
    assert.equal(external.code, "turn_engine_unavailable");
    await assert.rejects(fs.access(marker), { code: "ENOENT" });
    const bundled = await new DigitalEmployeeCliDriver(command, 5000, true).turnRun(request);
    assert.equal(bundled.status, "trusted", bundled.diagnostic);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

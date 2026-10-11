import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requestWorkbuddyLocal, workbuddyLocalBridgeConfigured, probeWorkbuddyLocal } from "../src/workbuddy-local.js";
import { employeeModelConfig } from "../src/model-selection.js";
import { hostHealth } from "../src/routes/health.js";

async function bridge(t: test.TestContext, reply: (request: any, socket: net.Socket) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rw-workbuddy-"));
  await fs.chmod(root, 0o700);
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\roleweave-workbuddy-${randomUUID()}` : path.join(root, "bridge.sock");
  const token = "b".repeat(64);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => { buffer += chunk.toString(); if (!buffer.includes("\n")) return; reply(JSON.parse(buffer.trim()), socket); });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  if (process.platform !== "win32") await fs.chmod(endpoint, 0o600);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  return { ROLEWEAVE_WORKBUDDY_BRIDGE: endpoint, ROLEWEAVE_WORKBUDDY_BRIDGE_TOKEN: token };
}
const response = (request: any, socket: net.Socket, result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);

test("local login needs an owned channel, never service credentials", async () => {
  const env = { CODEBUDDY_API_KEY: "service-key", CODEBUDDY_AUTH_TOKEN: "personal-token", CODEBUDDY_BASE_URL: "https://elsewhere.example" };
  assert.equal(workbuddyLocalBridgeConfigured(env), false);
  assert.deepEqual(await probeWorkbuddyLocal(env), { configured: false, code: "workbuddy.client_unavailable" });
  await assert.rejects(requestWorkbuddyLocal(env, "complete", { input: "hello" }), { code: "workbuddy.client_unavailable" });
});

test("local response is bounded and validates model, usage and exact request identity", async (t) => {
  const env = await bridge(t, (request, socket) => {
    assert.equal(request.token, "b".repeat(64));
    response(request, socket, { model: "auto", text: "连接正常", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, authorization: "must-not-forward" });
  });
  assert.deepEqual(await requestWorkbuddyLocal(env, "complete", { input: "hello" }), { model: "auto", text: "连接正常", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });
  await assert.rejects(requestWorkbuddyLocal(env, "complete", { input: "hello", model: "other" }), { code: "workbuddy.protocol_invalid" });
});

test("unknown response identity and provider errors never enter diagnostics", async (t) => {
  const env = await bridge(t, (_request, socket) => socket.end(`${JSON.stringify({ id: randomUUID(), error: "provider-token-secret" })}\n`));
  await assert.rejects(requestWorkbuddyLocal(env, "probe"), (error: any) => error.code === "workbuddy.protocol_invalid" && !error.message.includes("secret"));
});

test("caller cancellation and deadlines close the owned socket", async (t) => {
  const env = await bridge(t, () => {});
  await assert.rejects(requestWorkbuddyLocal(env, "catalog", {}, { timeoutMs: 20 }), { code: "workbuddy.deadline_exceeded" });
  const controller = new AbortController();
  const pending = requestWorkbuddyLocal(env, "complete", { input: "hello" }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: "workbuddy.cancelled" });
});

test("WorkBuddy local keeps the client's automatic model; API never reads Codex cache", async (t) => {
  let modelRequests = 0;
  const env = await bridge(t, (request, socket) => { modelRequests += 1; response(request, socket, { models: [], defaultModel: "auto" }); });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foreign-codex-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "models_cache.json"), JSON.stringify({ models: [{ slug: "foreign-model", display_name: "Wrong account", visibility: "list" }] }));
  const local = await employeeModelConfig("workbuddy-local", undefined, true, { ...env, CODEX_HOME: root, CODEBUDDY_API_KEY: "foreign-service", CODEBUDDY_MODEL: "foreign-model" });
  assert.equal(local.editable, false); assert.equal(local.source, "default");
  assert.deepEqual(local.options.map((model) => model.id), ["provider-default"]);
  assert.equal(local.options[0]?.resolvedModel, "auto");
  const cards = await Promise.all(Array.from({ length: 9 }, () => employeeModelConfig("workbuddy-local", undefined, true, env, "cached")));
  assert.equal(modelRequests, 0);
  assert.ok(cards.every((card) => card.connection?.status === "configured"));
  const service = await employeeModelConfig("workbuddy", undefined, true, { CODEX_HOME: root, CODEBUDDY_API_KEY: "service-key", CODEBUDDY_MODEL: "service-model" });
  assert.deepEqual(service.options.map((model) => model.id), ["provider-default", "service-model"]);
});

test("health gates client mode on local transport and bundled ownership", () => {
  const input = { engineAvailable: true, bundledElectronEngine: true, env: {}, workbuddyLocal: { configured: true, code: "workbuddy.ready" } };
  assert.equal(hostHealth(input)["workbuddy-local"].ready, true);
  assert.equal(hostHealth(input)["workbuddy-local"].modelPinnable, false);
  assert.equal(hostHealth({ ...input, bundledElectronEngine: false })["workbuddy-local"].ready, false);
  assert.equal(hostHealth({ ...input, workbuddyLocal: { configured: false, code: "workbuddy.client_unavailable" } })["workbuddy-local"].ready, false);
});

test("bundled adapter emits one terminal from a client response, without running any CLI", async (t) => {
  const env = await bridge(t, (request, socket) => { assert.equal(request.operation, "complete"); response(request, socket, { model: "auto", text: "connected", usage: { inputTokens: 2, outputTokens: 1 } }); });
  const adapter = fileURLToPath(new URL("../../bin/qoder-engine.mjs", import.meta.url));
  const child = spawn(process.execPath, [adapter, "turn", "run", os.tmpdir(), "--position", "local", "--stdin"], { env: { PATH: process.env.PATH, ...env, DIGITAL_EMPLOYEE_ENGINE_MODEL: "workbuddy-local", CODEBUDDY_API_KEY: "foreign-service", DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND: "must-not-run" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin.end(JSON.stringify({ input: "hello" }));
  const exit = await new Promise<number | null>((resolve) => child.once("close", resolve));
  assert.equal(exit, 0, stderr);
  const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === "run.completed").length, 1);
  assert.equal(events.at(-1).output, "connected");
  assert.ok(!stdout.includes("foreign-service"));
});

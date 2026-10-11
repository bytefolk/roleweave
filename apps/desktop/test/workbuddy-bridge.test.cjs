const assert = require("node:assert/strict");
const test = require("node:test");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createWorkbuddyClient } = require("../src/workbuddy-client.cjs");
const {
  createPrivateBridge, attachWslBridge, REQUEST_PREFIX, RESPONSE_PREFIX,
  MAX_FRAME_BYTES, MAX_IN_FLIGHT,
} = require("../src/workbuddy-bridge.cjs");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const requestFrame = (request) => `${REQUEST_PREFIX}${JSON.stringify(request)}\n`;
const request = (operation = "complete", payload = {}) => ({ id: randomUUID(), operation, payload });
const cancelled = () => Object.assign(new Error("private synthetic identity detail"), { code: "workbuddy.cancelled" });

function wslFixture(t, invoke) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough() });
  const responses = [];
  let responseBuffer = "";
  child.stdin.on("data", (chunk) => {
    responseBuffer += chunk.toString("utf8");
    let newline;
    while ((newline = responseBuffer.indexOf("\n")) >= 0) {
      const line = responseBuffer.slice(0, newline);
      responseBuffer = responseBuffer.slice(newline + 1);
      assert.ok(line.startsWith(RESPONSE_PREFIX));
      responses.push(JSON.parse(line.slice(RESPONSE_PREFIX.length)));
    }
  });
  const bridge = attachWslBridge(child, invoke);
  t.after(() => { bridge.close(); child.stdout.destroy(); child.stdin.destroy(); });
  return { child, bridge, responses };
}

async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("bridge did not settle within the fixture deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function privateSocket(t, bridge) {
  await bridge.ready;
  const socket = net.createConnection(bridge.endpoint);
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return socket;
}

function socketResponse(socket) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error("private bridge response timed out")), 1000);
    socket.on("data", (chunk) => { bytes = Buffer.concat([bytes, chunk]); });
    socket.once("end", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(bytes.toString("utf8"))); } catch (error) { reject(error); }
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

test("the owned private channel reassembles a split Unicode request and returns one response", async (t) => {
  const calls = [];
  const bridge = createPrivateBridge(async (value) => { calls.push(value); return { text: value.payload.input }; });
  t.after(bridge.close);
  const socket = await privateSocket(t, bridge);
  const value = request("complete", { input: "审查这段代码" });
  const bytes = Buffer.from(`${JSON.stringify({ ...value, token: bridge.token })}\n`);
  const split = bytes.indexOf(Buffer.from("审")) + 1;
  const response = socketResponse(socket);
  socket.write(bytes.subarray(0, split));
  await tick();
  socket.write(bytes.subarray(split));
  assert.deepEqual(await response, { id: value.id, result: { text: "审查这段代码" } });
  assert.deepEqual(calls, [value]);
  assert.equal(JSON.stringify(calls).includes(bridge.token), false);
});

test("a bad channel token or arbitrary operation never reaches the WorkBuddy client", async (t) => {
  let calls = 0;
  const bridge = createPrivateBridge(() => { calls += 1; return {}; });
  t.after(bridge.close);
  for (const value of [
    { ...request("probe"), token: "0".repeat(64) },
    { ...request("http.fetch", { path: "/private" }), token: bridge.token },
  ]) {
    const socket = await privateSocket(t, bridge);
    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.write(`${JSON.stringify(value)}\n`);
    await closed;
  }
  assert.equal(calls, 0);
});

test("disconnecting the private caller aborts its upstream task", async (t) => {
  let signal;
  const bridge = createPrivateBridge((_value, upstreamSignal) => {
    signal = upstreamSignal;
    return new Promise((_resolve, reject) => upstreamSignal.addEventListener("abort", () => reject(cancelled()), { once: true }));
  });
  t.after(bridge.close);
  const socket = await privateSocket(t, bridge);
  socket.write(`${JSON.stringify({ ...request(), token: bridge.token })}\n`);
  await until(() => signal !== undefined);
  socket.destroy();
  await until(() => signal.aborted);
});

test("the desktop client probe survives the private channel and server validation as a stable unavailable status", async (t) => {
  const { requestWorkbuddyLocal } = await import("../../server/src/workbuddy-local.js");
  const invoke = createWorkbuddyClient({ platform: "darwin" });
  const bridge = createPrivateBridge((value, signal) => invoke(value, { signal }));
  t.after(bridge.close);
  await bridge.ready;
  const result = await requestWorkbuddyLocal({ ROLEWEAVE_WORKBUDDY_BRIDGE: bridge.endpoint, ROLEWEAVE_WORKBUDDY_BRIDGE_TOKEN: bridge.token }, "probe");
  assert.deepEqual(result, { configured: false, code: "workbuddy.platform_unavailable" });
});

test("WSL messages retain Unicode across stdout byte fragments", async (t) => {
  const calls = [];
  const { child, responses } = wslFixture(t, async (value) => { calls.push(value); return { text: value.payload.input }; });
  const value = request("complete", { input: "审查这段代码" });
  const bytes = Buffer.from(requestFrame(value));
  const split = bytes.indexOf(Buffer.from("审")) + 1;
  child.stdout.write(bytes.subarray(0, split));
  await tick();
  child.stdout.write(bytes.subarray(split));
  await until(() => responses.length === 1);
  assert.deepEqual(calls, [value]);
  assert.deepEqual(responses, [{ id: value.id, result: { text: value.payload.input } }]);
});

test("multiple complete WSL frames obey the per-frame bound when stdout coalesces them", async (t) => {
  const calls = [];
  const { child, responses } = wslFixture(t, async (value) => { calls.push(value.id); return { accepted: true }; });
  const values = [request("complete", { input: "a".repeat(600_000) }), request("complete", { input: "b".repeat(600_000) })];
  const frames = values.map(requestFrame);
  assert.ok(frames.every((frame) => Buffer.byteLength(frame) < MAX_FRAME_BYTES));
  assert.ok(Buffer.byteLength(frames.join("")) > MAX_FRAME_BYTES);
  child.stdout.write(frames.join(""));
  await until(() => responses.length === 2);
  assert.deepEqual(calls, values.map((value) => value.id));
});

test("WSL cancellation and owner exit abort pending work without exposing diagnostic credentials", async (t) => {
  const signals = new Map();
  const { child, responses } = wslFixture(t, (value, signal) => {
    signals.set(value.id, signal);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(cancelled()), { once: true }));
  });
  const first = request(), second = request();
  child.stdout.write(requestFrame(first) + requestFrame(second));
  await until(() => signals.size === 2);
  child.stdout.write(requestFrame({ id: first.id, cancel: true }));
  await until(() => responses.length === 1);
  assert.deepEqual(responses, [{ id: first.id, error: "workbuddy.cancelled" }]);
  assert.equal(signals.get(first.id).aborted, true);
  child.emit("exit", 0);
  assert.equal(signals.get(second.id).aborted, true);
  await tick();
  assert.equal(responses.length, 1);
  assert.equal(JSON.stringify(responses).includes("private synthetic identity"), false);
});

test("WSL stdout EOF aborts pending work even while the supervisor process has not exited", async (t) => {
  let signal;
  const { child } = wslFixture(t, (_value, upstreamSignal) => {
    signal = upstreamSignal;
    return new Promise((_resolve, reject) => upstreamSignal.addEventListener("abort", () => reject(cancelled()), { once: true }));
  });
  child.stdout.write(requestFrame(request()));
  await until(() => signal !== undefined);
  child.stdout.end();
  await until(() => signal.aborted);
});

test("an oversized WSL result returns a stable output-limit error instead of hanging", async (t) => {
  const { child, responses } = wslFixture(t, async () => ({ text: "x".repeat(MAX_FRAME_BYTES) }));
  const value = request();
  child.stdout.write(requestFrame(value));
  await until(() => responses.length === 1);
  assert.deepEqual(responses, [{ id: value.id, error: "workbuddy.output_limit" }]);
});

test("WSL enforces concurrency without starting the rejected task", async (t) => {
  const calls = [];
  const { child, responses } = wslFixture(t, (value, signal) => {
    calls.push(value.id);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(cancelled()), { once: true }));
  });
  const values = Array.from({ length: MAX_IN_FLIGHT + 1 }, () => request());
  child.stdout.write(values.map(requestFrame).join(""));
  await until(() => responses.length === 1);
  assert.deepEqual(calls, values.slice(0, MAX_IN_FLIGHT).map((value) => value.id));
  assert.deepEqual(responses, [{ id: values.at(-1).id, error: "workbuddy.busy" }]);
});

test("private caller cancellation frees a full channel slot even when the upstream callback ignores abort", async (t) => {
  const calls = [];
  const bridge = createPrivateBridge((value, signal) => {
    calls.push({ id: value.id, signal });
    return value.operation === "probe" ? { configured: true, code: "workbuddy.ready" } : new Promise(() => {});
  });
  t.after(bridge.close);
  const sockets = [];
  for (let index = 0; index < MAX_IN_FLIGHT; index += 1) {
    const socket = await privateSocket(t, bridge);
    sockets.push(socket);
    socket.write(`${JSON.stringify({ ...request(), token: bridge.token })}\n`);
  }
  await until(() => calls.length === MAX_IN_FLIGHT);
  sockets[0].destroy();
  await until(() => calls[0].signal.aborted);
  await tick();
  const replacement = await privateSocket(t, bridge);
  const value = request("probe");
  const response = socketResponse(replacement);
  replacement.write(`${JSON.stringify({ ...value, token: bridge.token })}\n`);
  assert.deepEqual(await response, { id: value.id, result: { configured: true, code: "workbuddy.ready" } });
  assert.equal(calls.length, MAX_IN_FLIGHT + 1);
  assert.equal(calls.slice(1, MAX_IN_FLIGHT).every((call) => !call.signal.aborted), true);
});

test("WSL cancellation frees a full channel slot even when the upstream callback never settles", async (t) => {
  const calls = [];
  const { child, responses } = wslFixture(t, (value, signal) => {
    calls.push({ id: value.id, signal });
    return value.operation === "probe" ? { configured: true, code: "workbuddy.ready" } : new Promise(() => {});
  });
  const values = Array.from({ length: MAX_IN_FLIGHT }, () => request());
  child.stdout.write(values.map(requestFrame).join(""));
  await until(() => calls.length === MAX_IN_FLIGHT);
  child.stdout.write(requestFrame({ id: values[0].id, cancel: true }));
  await until(() => responses.length === 1);
  assert.deepEqual(responses[0], { id: values[0].id, error: "workbuddy.cancelled" });
  await tick();
  const replacement = request("probe");
  child.stdout.write(requestFrame(replacement));
  await until(() => responses.length === 2);
  assert.deepEqual(responses[1], { id: replacement.id, result: { configured: true, code: "workbuddy.ready" } });
  assert.equal(calls.length, MAX_IN_FLIGHT + 1);
  assert.equal(calls.slice(1, MAX_IN_FLIGHT).every((call) => !call.signal.aborted), true);
});

test("the WSL supervisor accepts coalesced bounded responses and rejects an oversized unterminated frame", async (t) => {
  const processStub = Object.assign(new EventEmitter(), {
    env: {}, execPath: "/usr/bin/node", pid: 123,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { throw new Error("bounded response must not stop the server"); },
  });
  let stderr = "", invoke;
  processStub.stderr.on("data", (chunk) => { stderr += chunk; });
  const server = Object.assign(new EventEmitter(), { pid: 456 });
  const moduleStub = { exports: {} };
  const requireStub = (name) => {
    if (name === "node:fs") return { readFileSync: () => { throw new Error("no fixture process descendants"); } };
    if (name === "node:path") return path;
    if (name === "node:child_process") return { spawn: () => server };
    if (name === "./workbuddy-bridge.cjs") return {
      ...require("../src/workbuddy-bridge.cjs"),
      createPrivateBridge: (handler) => {
        invoke = handler;
        return { endpoint: "/tmp/rw-workbuddy-fixture/bridge.sock", token: "f".repeat(64), ready: Promise.resolve(), close: () => {} };
      },
    };
    throw new Error(`unexpected fixture import: ${name}`);
  };
  requireStub.main = moduleStub;
  const timer = () => ({ unref: () => {} });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/wsl-bootstrap.cjs"), "utf8"), {
    require: requireStub, module: moduleStub, process: processStub, Buffer,
    setTimeout: timer, clearTimeout: () => {}, setInterval: timer, clearInterval: () => {},
  });
  t.after(() => processStub.stdin.end());
  processStub.stdin.write(`${JSON.stringify({ version: 1, serverEntry: "/server.js", engineCommand: null, environment: { ROLEWEAVE_WORKBUDDY_BRIDGE_ENABLED: "1" } })}\n`);
  await until(() => invoke !== undefined);
  const values = [request(), request()];
  const results = [{ text: "a".repeat(600_000) }, { text: "b".repeat(600_000) }];
  const promises = values.map((value) => invoke(value, new AbortController().signal));
  const settled = Promise.allSettled(promises);
  const frames = values.map((value, index) => `${RESPONSE_PREFIX}${JSON.stringify({ id: value.id, result: results[index] })}\n`);
  assert.ok(frames.every((frame) => Buffer.byteLength(frame) < MAX_FRAME_BYTES));
  processStub.stdin.write(frames.join(""));
  const receipts = await settled;
  assert.deepEqual(receipts.map((receipt) => receipt.status), ["fulfilled", "fulfilled"]);
  for (let index = 0; index < receipts.length; index += 1) {
    assert.ok(receipts[index].value.text === results[index].text, "the supervisor retains each complete response text");
  }
  assert.equal(stderr, "");
  processStub.stdin.write("x".repeat(MAX_FRAME_BYTES + 1));
  assert.match(stderr, /bridge response is too large/);
});

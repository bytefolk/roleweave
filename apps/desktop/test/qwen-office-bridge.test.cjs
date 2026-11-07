const assert = require("node:assert/strict");
const test = require("node:test");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");
const { performance } = require("node:perf_hooks");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const office = require("../src/qwen-office-bridge.cjs");
const workbuddy = require("../src/workbuddy-bridge.cjs");
const { MAX_FRAME_BYTES, MAX_IN_FLIGHT, createBridgeChannel } = workbuddy;

// Synthetic local channels only. No Office client, provider, account directory,
// authentication ticket, child process, or Windows/WSL installation is read.
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = (operation = "complete", payload = {}) => ({ id: randomUUID(), operation, payload });
const wslFrame = (channel, value) => `${channel.REQUEST_PREFIX}${JSON.stringify(value)}\n`;
const responseFrame = (channel, value) => `${channel.RESPONSE_PREFIX}${JSON.stringify(value)}\n`;

async function until(predicate) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "synthetic bridge did not settle");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function socketFor(t, bridge) {
  await bridge.ready;
  const socket = net.createConnection(bridge.endpoint);
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return socket;
}

function socketFrames(socket) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("synthetic response deadline")); }, 5000);
    socket.on("data", chunk => { bytes = Buffer.concat([bytes, chunk]); });
    socket.once("end", () => {
      clearTimeout(timer);
      try { resolve(bytes.toString("utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))); }
      catch (error) { reject(error); }
    });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
    socket.once("close", () => { clearTimeout(timer); });
  });
}

function wslFixture(t, channel, invoke) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough() });
  const responses = [];
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  child.stdin.on("data", chunk => {
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      assert.ok(line.startsWith(channel.RESPONSE_PREFIX));
      responses.push(JSON.parse(line.slice(channel.RESPONSE_PREFIX.length)));
    }
  });
  const bridge = channel.attachWslBridge(child, invoke);
  t.after(() => { bridge.close(); child.stdout.destroy(); child.stdin.destroy(); });
  return { child, bridge, responses };
}

test("Office factory retains its own prefixes, timeout and validation boundaries", () => {
  assert.equal(office.REQUEST_PREFIX, "roleweave-qwen-office-request ");
  assert.equal(office.RESPONSE_PREFIX, "roleweave-qwen-office-response ");
  assert.equal(office.REQUEST_TIMEOUT_MS, 180_000);
  assert.notEqual(office.REQUEST_PREFIX, workbuddy.REQUEST_PREFIX);
  for (const options of [{ name: "../provider" }, { errorPrefix: "qwen-office" }, { timeoutMs: 180_001 }, { timeoutMs: 0 }]) {
    assert.throws(() => createBridgeChannel(options), /Invalid private bridge configuration/);
  }
});

test("Office socket preserves fragmented Unicode and streams progress before one final receipt without exposing its ticket", async t => {
  const calls = [];
  const bridge = office.createPrivateBridge(async (value, _signal, onProgress) => {
    calls.push(value); onProgress({ status: "running" }); onProgress({ status: "waiting_for_input" });
    return { text: value.payload.input };
  });
  t.after(bridge.close);
  const socket = await socketFor(t, bridge);
  const value = request("complete", { input: "审查办公资料🙂" });
  const bytes = Buffer.from(`${JSON.stringify({ ...value, token: bridge.token })}\n`);
  const split = bytes.indexOf(Buffer.from("审")) + 1;
  const response = socketFrames(socket);
  socket.write(bytes.subarray(0, split)); await tick(); socket.write(bytes.subarray(split));
  assert.deepEqual(await response, [
    { id: value.id, event: { status: "running" } }, { id: value.id, event: { status: "waiting_for_input" } },
    { id: value.id, result: { text: value.payload.input } },
  ]);
  assert.deepEqual(calls, [value]);
  assert.equal(JSON.stringify(calls).includes(bridge.token), false);
});

test("provider tickets and arbitrary operations cannot cross into an Office private call", async t => {
  let calls = 0;
  const bridge = office.createPrivateBridge(() => { calls++; return {}; });
  const other = workbuddy.createPrivateBridge(() => ({}));
  t.after(bridge.close); t.after(other.close);
  await other.ready;
  assert.notEqual(bridge.token, other.token);
  for (const value of [
    { ...request(), token: other.token }, { ...request(), token: "SYNTHETIC_PROVIDER_AUTH_TICKET" },
    { ...request("desktop.permission.respond"), token: bridge.token },
    { ...request(), token: bridge.token, providerTicket: "SYNTHETIC_PROVIDER_AUTH_TICKET" },
  ]) {
    const socket = await socketFor(t, bridge);
    const closed = new Promise(resolve => socket.once("close", resolve));
    socket.resume(); socket.write(`${JSON.stringify(value)}\n`); await closed;
  }
  assert.equal(calls, 0);
});

test("Office normalizes foreign-provider errors without returning credentials or private messages", async t => {
  const bridge = office.createPrivateBridge(value => {
    throw Object.assign(new Error("SYNTHETIC_PROVIDER_AUTH_TICKET"), { code: value.payload.code });
  });
  t.after(bridge.close);
  for (const [code, expected] of [["workbuddy.cancelled", "qwen_office.client_unavailable"], ["qwen_office.cancelled", "qwen_office.cancelled"], ["qwen_office.BAD_TOKEN", "qwen_office.client_unavailable"]]) {
    const socket = await socketFor(t, bridge), value = request("complete", { code });
    const response = socketFrames(socket);
    socket.write(`${JSON.stringify({ ...value, token: bridge.token })}\n`);
    assert.deepEqual(await response, [{ id: value.id, error: expected }]);
  }
});

test("Office socket EOF frees one saturated slot even when the callback ignores abort, without cancelling siblings", async t => {
  const calls = [];
  const bridge = office.createPrivateBridge((value, signal) => {
    calls.push({ value, signal });
    return value.operation === "probe" ? { configured: true, code: "qwen_office.ready" } : new Promise(() => {});
  });
  t.after(bridge.close);
  const sockets = [];
  for (let index = 0; index < MAX_IN_FLIGHT; index++) {
    const socket = await socketFor(t, bridge); sockets.push(socket);
    socket.write(`${JSON.stringify({ ...request(), token: bridge.token })}\n`);
  }
  await until(() => calls.length === MAX_IN_FLIGHT);
  sockets[0].end();
  await until(() => calls[0].signal.aborted); await tick();
  const replacement = await socketFor(t, bridge), value = request("probe");
  const response = socketFrames(replacement);
  replacement.write(`${JSON.stringify({ ...value, token: bridge.token })}\n`);
  assert.deepEqual(await response, [{ id: value.id, result: { configured: true, code: "qwen_office.ready" } }]);
  assert.equal(calls.length, MAX_IN_FLIGHT + 1);
  assert.equal(calls.slice(1, MAX_IN_FLIGHT).every(call => !call.signal.aborted), true);
  bridge.close(); bridge.close();
  assert.equal(calls.slice(0, MAX_IN_FLIGHT).every(call => call.signal.aborted), true);
});

test("Office private responses allow 64 public progress events and reject oversized requests/results", async t => {
  let calls = 0;
  const bridge = office.createPrivateBridge((value, _signal, onProgress) => {
    calls++;
    if (value.payload.large) return { text: "x".repeat(MAX_FRAME_BYTES) };
    for (let index = 0; index < 64; index++) onProgress({ status: "running" });
    return { text: "done" };
  });
  t.after(bridge.close);
  const socket = await socketFor(t, bridge), value = request();
  const response = socketFrames(socket);
  socket.write(`${JSON.stringify({ ...value, token: bridge.token })}\n`);
  const frames = await response;
  assert.equal(frames.length, 65);
  assert.deepEqual(frames.at(-1), { id: value.id, result: { text: "done" } });
  const large = await socketFor(t, bridge), oversizedResult = request("complete", { large: true });
  const limited = socketFrames(large);
  large.write(`${JSON.stringify({ ...oversizedResult, token: bridge.token })}\n`);
  assert.deepEqual(await limited, [{ id: oversizedResult.id, error: "qwen_office.output_limit" }]);
  const oversizedRequest = await socketFor(t, bridge);
  const closed = new Promise(resolve => oversizedRequest.once("close", resolve));
  oversizedRequest.resume(); oversizedRequest.write("x".repeat(MAX_FRAME_BYTES + 1)); await closed;
  assert.equal(calls, 2);
});

test("Office's 65th private progress event aborts an uncooperative callback and closes its caller", async t => {
  let signal;
  const bridge = office.createPrivateBridge((_value, current, onProgress) => {
    signal = current;
    for (let index = 0; index < 65; index++) onProgress({ status: "waiting_for_input" });
    return new Promise(() => {});
  });
  t.after(bridge.close);
  const socket = await socketFor(t, bridge);
  const closed = new Promise(resolve => socket.once("close", resolve));
  socket.resume(); socket.write(`${JSON.stringify({ ...request(), token: bridge.token })}\n`);
  await closed;
  assert.equal(signal.aborted, true);
});

test("Office WSL reconstructs Unicode, isolates prefixes, and only publishes bounded public task status", async t => {
  const calls = [];
  const { child, responses } = wslFixture(t, office, async (value, _signal, onProgress) => {
    calls.push(value);
    onProgress({ status: "running", providerTicket: "SYNTHETIC_PROVIDER_AUTH_TICKET" });
    onProgress({ status: "private_tool_payload" });
    onProgress({ status: "running" }); onProgress({ status: "waiting_for_input" });
    return { text: value.payload.input };
  });
  const value = request("complete", { input: "跨系统办公🙂" });
  child.stdout.write(wslFrame(workbuddy, request()));
  const bytes = Buffer.from(wslFrame(office, value)), split = bytes.indexOf(Buffer.from("跨")) + 2;
  child.stdout.write(bytes.subarray(0, split)); await tick(); child.stdout.write(bytes.subarray(split));
  await until(() => responses.length === 3);
  assert.deepEqual(calls, [value]);
  assert.deepEqual(responses, [
    { id: value.id, event: { status: "running" } }, { id: value.id, event: { status: "waiting_for_input" } },
    { id: value.id, result: { text: value.payload.input } },
  ]);
  assert.equal(JSON.stringify(responses).includes("SYNTHETIC_PROVIDER"), false);
});

test("Office WSL cancellation recovers a full channel when callbacks ignore abort and lease closure suppresses late output", async t => {
  const calls = [];
  const { child, bridge, responses } = wslFixture(t, office, (value, signal, onProgress) => {
    calls.push({ value, signal, onProgress });
    return value.operation === "probe" ? { configured: true, code: "qwen_office.ready" } : new Promise(() => {});
  });
  const values = Array.from({ length: MAX_IN_FLIGHT }, () => request());
  child.stdout.write(values.map(value => wslFrame(office, value)).join(""));
  await until(() => calls.length === MAX_IN_FLIGHT);
  child.stdout.write(wslFrame(office, { id: values[0].id, cancel: true }));
  await until(() => responses.length === 1); await tick();
  assert.deepEqual(responses[0], { id: values[0].id, error: "qwen_office.cancelled" });
  const probe = request("probe"); child.stdout.write(wslFrame(office, probe));
  await until(() => responses.length === 2);
  assert.deepEqual(responses[1], { id: probe.id, result: { configured: true, code: "qwen_office.ready" } });
  assert.equal(calls.slice(1, MAX_IN_FLIGHT).every(call => !call.signal.aborted), true);
  child.stdout.end(); await until(() => calls.slice(0, MAX_IN_FLIGHT).every(call => call.signal.aborted));
  for (const call of calls) call.onProgress({ status: "running" });
  bridge.close(); await tick();
  assert.equal(responses.length, 2);
});

test("Office WSL enforces its 64-progress and one-megabyte bounds with Office-only errors", async t => {
  let oversizedSignal;
  const { child, responses } = wslFixture(t, office, (value, signal, onProgress) => {
    if (value.payload.large) return { text: "x".repeat(MAX_FRAME_BYTES) };
    if (value.payload.overProgress) {
      oversizedSignal = signal;
      for (let index = 0; index < 65; index++) onProgress({ status: "running" });
      return new Promise(() => {});
    }
    throw Object.assign(new Error("SYNTHETIC_PROVIDER_AUTH_TICKET"), { code: "workbuddy.cancelled" });
  });
  const large = request("complete", { large: true }); child.stdout.write(wslFrame(office, large));
  await until(() => responses.length === 1);
  assert.deepEqual(responses[0], { id: large.id, error: "qwen_office.output_limit" });
  const foreignError = request(); child.stdout.write(wslFrame(office, foreignError));
  await until(() => responses.length === 2);
  assert.deepEqual(responses[1], { id: foreignError.id, error: "qwen_office.client_unavailable" });
  const overflow = request("complete", { overProgress: true }); child.stdout.write(wslFrame(office, overflow));
  await until(() => responses.length === 67);
  assert.equal(oversizedSignal.aborted, true);
  assert.equal(responses.filter(value => value.id === overflow.id && value.event).length, 64);
  assert.deepEqual(responses.at(-1), { id: overflow.id, error: "qwen_office.cancelled" });
});

async function supervisorFixture(t) {
  const invokes = new Map(), leases = new Map(), output = [], errors = [];
  const server = Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() });
  const processStub = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: { write: value => output.push(value) }, stderr: { write: value => errors.push(value) },
    env: {}, execPath: "/usr/bin/node", pid: 999, kill: () => {}, exit: () => {},
  });
  const moduleStub = { exports: {} };
  const channelStub = (name, channel) => ({ ...channel, createPrivateBridge: invoke => {
    invokes.set(name, invoke);
    const lease = { endpoint: `/tmp/rw-${name}-fixture/bridge.sock`, token: name === "workbuddy" ? "f".repeat(64) : "e".repeat(64),
      ready: Promise.resolve(), closed: false, close() { this.closed = true; } };
    leases.set(name, lease); return lease;
  } });
  const requireStub = name => {
    if (name === "node:fs") return { readFileSync: () => { throw new Error("synthetic process tree only"); } };
    if (name === "node:path") return path;
    if (name === "node:child_process") return { spawn: () => server };
    if (name === "./workbuddy-bridge.cjs") return channelStub("workbuddy", workbuddy);
    if (name === "./qwen-office-bridge.cjs") return channelStub("qwen-office", office);
    throw new Error(`unexpected fixture module ${name}`);
  };
  requireStub.main = moduleStub;
  const timer = () => ({ unref() {} });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/wsl-bootstrap.cjs"), "utf8"), {
    require: requireStub, module: moduleStub, process: processStub, Buffer,
    setTimeout: timer, clearTimeout() {}, setInterval: timer, clearInterval() {},
  });
  t.after(() => { processStub.stdin.end(); server.stdout.destroy(); server.stderr.destroy(); });
  processStub.stdin.write(`${JSON.stringify({ version: 1, serverEntry: "/server.js", engineCommand: null, environment: {
    ROLEWEAVE_WORKBUDDY_BRIDGE_ENABLED: "1", ROLEWEAVE_QWEN_OFFICE_BRIDGE_ENABLED: "1",
  } })}\n`);
  await until(() => invokes.size === 2); await tick();
  return { processStub, invokes, leases, output, errors };
}

test("WSL supervisor keeps same-UUID Office/WorkBuddy requests distinct and does not settle Office on progress", async t => {
  const { processStub, invokes, leases, output, errors } = await supervisorFixture(t);
  const value = request(), officeProgress = [];
  let officeSettled = false;
  const officeResult = invokes.get("qwen-office")(value, new AbortController().signal, event => officeProgress.push({ ...event }));
  officeResult.then(() => { officeSettled = true; });
  const workbuddyResult = invokes.get("workbuddy")(value, new AbortController().signal);
  const settled = Promise.allSettled([officeResult, workbuddyResult]);
  assert.notEqual(leases.get("qwen-office").token, leases.get("workbuddy").token);
  assert.equal(output.filter(line => line.startsWith(office.REQUEST_PREFIX)).length, 1);
  assert.equal(output.filter(line => line.startsWith(workbuddy.REQUEST_PREFIX)).length, 1);
  processStub.stdin.write(responseFrame(office, { id: value.id, event: { status: "waiting_for_input" } }));
  await tick();
  assert.equal(officeSettled, false);
  assert.deepEqual(officeProgress, [{ status: "waiting_for_input" }]);
  processStub.stdin.write(responseFrame(workbuddy, { id: value.id, result: { text: "b".repeat(600_000) } })
    + responseFrame(office, { id: value.id, result: { text: "a".repeat(600_000) } }));
  const receipts = await settled;
  assert.deepEqual(receipts.map(receipt => receipt.status), ["fulfilled", "fulfilled"]);
  assert.equal(receipts[0].value.text, "a".repeat(600_000));
  assert.equal(receipts[1].value.text, "b".repeat(600_000));
  assert.equal(errors.join(""), "");
});

test("WSL supervisor rejects cross-provider error namespaces and closes both owned leases without exposing the error", async t => {
  const { processStub, invokes, leases, errors } = await supervisorFixture(t);
  const value = request();
  const pending = Promise.allSettled([
    invokes.get("qwen-office")(value, new AbortController().signal),
    invokes.get("workbuddy")(value, new AbortController().signal),
  ]);
  processStub.stdin.write(responseFrame(office, { id: value.id, error: "workbuddy.SYNTHETIC_PROVIDER_AUTH_TICKET" }));
  const receipts = await pending;
  assert.deepEqual(receipts.map(receipt => receipt.status), ["rejected", "rejected"]);
  assert.equal(receipts[0].reason.code, "qwen_office.bridge_closed");
  assert.equal(receipts[1].reason.code, "workbuddy.bridge_closed");
  assert.equal([...leases.values()].every(lease => lease.closed), true);
  assert.match(errors.join(""), /bridge response is invalid/);
  assert.doesNotMatch(errors.join(""), /SYNTHETIC_PROVIDER_AUTH_TICKET/);
});

test("WSL lease EOF cancels each provider with its own error while caller cancellation affects only its namespace", async t => {
  const { processStub, invokes, leases, output } = await supervisorFixture(t);
  const value = request(), cancelled = new AbortController();
  const officeResult = invokes.get("qwen-office")(value, cancelled.signal);
  const workbuddyResult = invokes.get("workbuddy")(value, new AbortController().signal);
  const pending = Promise.allSettled([officeResult, workbuddyResult]);
  cancelled.abort(); await tick();
  const cancellations = output.filter(line => line.includes('"cancel":true'));
  assert.equal(cancellations.length, 1);
  assert.ok(cancellations[0].startsWith(office.REQUEST_PREFIX));
  processStub.stdin.end();
  const receipts = await pending;
  assert.equal(receipts[0].reason.code, "qwen_office.cancelled");
  assert.equal(receipts[1].reason.code, "workbuddy.bridge_closed");
  assert.equal([...leases.values()].every(lease => lease.closed), true);
});

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { constants: fsConstants } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { createWorkbuddyClient } = require("../src/workbuddy-client.cjs");

// These fixtures never open a file, pipe, or network socket. The independent
// server authenticates the client's transcript before exposing the HTTP pipe.
const ENDPOINT = "\\\\.\\pipe\\wbipc-0123456789abcdef";
const TICKET = "synthetic_fixture_ticket_not_a_user_credential_123456";
const CONFIG_DIR = path.resolve(__dirname, "__memory_only_workbuddy_fixture__");
const MAX_BODY = 640 * 1024;

function serverProof(label, clientNonce, serverNonce) {
  const fields = [label, "1", ENDPOINT, clientNonce, serverNonce];
  const transcript = [];
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8"), length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    transcript.push(length, bytes);
  }
  return crypto.createHmac("sha256", TICKET).update(Buffer.concat(transcript)).digest("base64url");
}

function memoryFilesystem(options = {}) {
  const bytes = options.raw ?? Buffer.from(JSON.stringify(options.descriptor ?? { endpoint: ENDPOINT, ticket: TICKET }));
  const directory = path.join(CONFIG_DIR, "wbipc");
  const metadata = (ino, size) => ({ ino, dev: 5n, size, mtimeNs: 10n, ctimeNs: 11n });
  const state = { reads: 0, readCalls: 0, bytesRead: 0, readRequests: [], calls: [], opened: 0, closed: 0, bytes,
    fd: metadata(23n, BigInt(bytes.length)), named: metadata(23n, BigInt(bytes.length)),
    directories: { [CONFIG_DIR]: metadata(101n, 0n), [directory]: metadata(102n, 0n) },
    realpaths: { [CONFIG_DIR]: CONFIG_DIR, [directory]: directory } };
  options.initialize?.(state);
  const fileStat = value => ({ ...value, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => !!options.symlinkFile });
  const directoryStat = value => ({ ...value, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => !!options.symlinkDirectory });
  return { state, api: {
    lstatSync(filename, statOptions) {
      assert.deepEqual(statOptions, { bigint: true });
      state.calls.push({ operation: "lstat", filename });
      state.reads++;
      return filename.endsWith("endpoint.json") ? fileStat(state.named) : directoryStat(state.directories[filename]);
    },
    realpathSync(filename) {
      state.calls.push({ operation: "realpath", filename });
      return state.realpaths[filename];
    },
    openSync(filename, flags) {
      state.calls.push({ operation: "open", filename, flags });
      if (options.missing) throw Object.assign(new Error("synthetic missing descriptor"), { code: "ENOENT" });
      state.opened++;
      return 17;
    },
    fstatSync(handle, statOptions) {
      assert.equal(handle, 17); assert.deepEqual(statOptions, { bigint: true });
      state.calls.push({ operation: "fstat" });
      return fileStat(state.fd);
    },
    readSync(handle, buffer, offset, length, position) {
      assert.equal(handle, 17);
      assert.equal(Buffer.isBuffer(buffer), true);
      assert.ok(Number.isInteger(position) && position >= 0);
      state.calls.push({ operation: "read", position, length });
      state.reads++; state.readCalls++;
      state.readRequests.push(length);
      options.onRead?.(state);
      const count = Math.min(length, options.readChunkSize ?? length, Math.max(0, state.bytes.length - position));
      state.bytes.copy(buffer, offset, position, position + count);
      state.bytesRead += count;
      return count;
    },
    closeSync(handle) {
      assert.equal(handle, 17);
      state.calls.push({ operation: "close" });
      state.closed++;
    },
  } };
}

const serialDelta = overrides => ({ role: null, content: "", function_call: null, refusal: "", tool_calls: [], extra_fields: null, ...overrides });
const dataEvent = value => `data: ${JSON.stringify(value)}\n\n`;
const choiceEvent = (delta, finish = "", extra = {}) => dataEvent({ id: "synthetic-completion", model: "auto", choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
const DONE = "data: [DONE]\n\n";
const STOP = choiceEvent(serialDelta({ refusal: null }), "stop");
const successSse = () => choiceEvent(serialDelta({ reasoning_content: "SYNTHETIC_REASONING_SECRET" }))
  + choiceEvent(serialDelta({ content: "connection " }))
  + choiceEvent(serialDelta({ content: "ok", refusal: null })) + STOP
  + dataEvent({ usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } }) + DONE;
const httpResponse = body => ({ status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8", "x-fixture-private": "SYNTHETIC_HEADER_SECRET" },
  body_b64: Buffer.from(body).toString("base64") });

function brokerFixture(options = {}) {
  const filesystem = memoryFilesystem(options.fs);
  const state = { connected: 0, sockets: [], frames: [], fetches: [], clientProofVerified: false };
  const connect = endpoint => {
    assert.equal(endpoint, ENDPOINT);
    state.connected++;
    const socket = new EventEmitter();
    socket.destroyed = false;
    state.sockets.push(socket);
    let clientNonce;
    const serverNonce = "synthetic_server_nonce_01234567890123456789";
    const deliver = value => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
      queueMicrotask(() => {
        if (socket.destroyed) return;
        if (options.fragment) {
          for (let offset = 0; offset < bytes.length && !socket.destroyed; offset += 13) socket.emit("data", bytes.subarray(offset, offset + 13));
        } else socket.emit("data", bytes);
      });
    };
    socket.destroy = () => { if (!socket.destroyed) { socket.destroyed = true; socket.emit("close"); } };
    socket.write = bytes => {
      const frame = JSON.parse(bytes.toString("utf8"));
      state.frames.push(frame);
      if (frame.type === "session_hello") {
        assert.equal(frame.protocol_min, 1); assert.equal(frame.protocol_max, 1);
        assert.match(frame.client_nonce, /^[A-Za-z0-9_-]{32}$/);
        assert.equal(frame.ticket_id, crypto.createHash("sha256").update(TICKET).digest("hex").slice(0, 16));
        clientNonce = frame.client_nonce;
        if (options.oversizedFrame) deliver(Buffer.alloc(1024 * 1024 + 1, 120));
        else deliver({ type: "session_challenge", protocol: 1, server_nonce: serverNonce,
          server_proof: options.badProof ? "incorrect_fixture_proof" : serverProof("wbipc-s", clientNonce, serverNonce) });
      } else if (frame.type === "session_prove") {
        assert.equal(frame.client_proof, serverProof("wbipc-c", clientNonce, serverNonce));
        state.clientProofVerified = true;
        deliver({ type: "session_hello_ack", protocol: 1, pipes: ["wb.request"] });
      } else if (frame.method === "broker/GetPipe") {
        assert.equal(state.clientProofVerified, true);
        assert.deepEqual(frame.params, { pipe: "wb.request" });
        deliver({ jsonrpc: "2.0", id: frame.id, result: { channel: "c:wb.request", methods: ["http.fetch"] } });
      } else {
        assert.equal(frame.method, "c:wb.request/http.fetch");
        assert.equal(frame.mode, "call");
        assert.equal(state.clientProofVerified, true);
        state.fetches.push(frame.params);
        options.onFetch?.(frame.params);
        if (!options.holdFetch) deliver({ jsonrpc: "2.0", id: frame.id,
          result: options.response ?? httpResponse(options.sse ?? successSse()) });
      }
      return true;
    };
    queueMicrotask(() => { if (!socket.destroyed) socket.emit("connect"); });
    return socket;
  };
  return { state, filesystem, client: createWorkbuddyClient({ platform: "win32", configDir: CONFIG_DIR,
    fileSystem: filesystem.api, connect, timeoutMs: options.timeoutMs ?? 500 }) };
}

const complete = input => ({ id: "fixture-turn", operation: "complete", payload: { model: "auto", input } });
const errorCode = suffix => error => {
  assert.equal(error.code, `workbuddy.${suffix}`);
  assert.equal(error.message, error.code);
  assert.equal(JSON.stringify(error).includes(TICKET), false);
  return true;
};

test("probe authenticates both peers and reports no invented version or catalog", async () => {
  const fixture = brokerFixture({ fragment: true });
  assert.deepEqual(await fixture.client({ operation: "probe" }), { configured: true, code: "workbuddy.ready" });
  assert.equal(fixture.state.clientProofVerified, true);
  assert.deepEqual(fixture.state.fetches, []);
  assert.equal(fixture.state.sockets[0].destroyed, true);
  const missing = brokerFixture({ fs: { missing: true } });
  assert.deepEqual(await missing.client({ operation: "probe" }), { configured: false, code: "workbuddy.client_unavailable" });
  assert.equal(missing.state.connected, 0);
});

test("catalog keeps auto separate from an unavailable account catalog and performs no HTTP request", async () => {
  const fixture = brokerFixture();
  assert.deepEqual(await fixture.client({ operation: "catalog", payload: {} }), { models: [], defaultModel: "auto" });
  assert.deepEqual(fixture.state.fetches, []);
  assert.equal(fixture.state.sockets[0].destroyed, true);
});

test("completion sends only the fixed text request and returns text plus usage", async () => {
  const fixture = brokerFixture({ fragment: true });
  const result = await fixture.client(complete("你好\nReply connection ok."));
  assert.deepEqual(result, { model: "auto", text: "connection ok", usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } });
  assert.equal(fixture.state.fetches.length, 1);
  const request = fixture.state.fetches[0];
  assert.deepEqual(Object.keys(request).sort(), ["body_b64", "headers", "method", "path"]);
  assert.equal(request.method, "POST"); assert.equal(request.path, "/v2/chat/completions");
  assert.deepEqual(request.headers, { "content-type": "application/json", accept: "text/event-stream" });
  assert.deepEqual(JSON.parse(Buffer.from(request.body_b64, "base64")), {
    model: "auto", messages: [{ role: "user", content: "你好\nReply connection ok." }], tools: [], tool_choice: "none",
    stream: true, stream_options: { include_usage: true }, max_tokens: 4096,
  });
  assert.equal(/SYNTHETIC_|ticket|headers/.test(JSON.stringify(result)), false);
  assert.equal(fixture.state.sockets[0].destroyed, true);
});

test("trusted probe token cap stays outside caller payload", async () => {
  const fixture = brokerFixture();
  await fixture.client(complete("connection probe"), { maxOutputTokens: 512 });
  assert.equal(JSON.parse(Buffer.from(fixture.state.fetches[0].body_b64, "base64")).max_tokens, 512);
});

test("strictly empty legacy function placeholders are accepted", async t => {
  for (const [name, functionCall] of [["empty object", {}], ["empty names and arguments", { name: "", arguments: "" }]]) {
    await t.test(name, async () => {
      const fixture = brokerFixture({ sse: choiceEvent(serialDelta({ content: "connection ok", function_call: functionCall })) + STOP + DONE });
      assert.deepEqual(await fixture.client(complete("synthetic fixture")), { model: "auto", text: "connection ok" });
    });
  }
});

test("nontext and incomplete SSE responses fail closed", async t => {
  const cases = [
    ["tool calls", serialDelta({ content: "OK", tool_calls: [{ type: "function", function: { name: "Bash", arguments: "echo forbidden" } }] }), "tools_denied"],
    ["legacy function", serialDelta({ content: "OK", function_call: { name: "Bash", arguments: "echo forbidden" } }), "tools_denied"],
    ["function arguments", serialDelta({ content: "OK", function_call: { name: "", arguments: "echo forbidden" } }), "tools_denied"],
    ["unknown function property", serialDelta({ content: "OK", function_call: { unknown: "" } }), "tools_denied"],
    ["refusal", serialDelta({ content: "OK", refusal: "I cannot answer" }), "refused"],
    ["unknown tool delta", serialDelta({ content: "OK", tool_call: { name: "Bash" } }), "response_invalid"],
    ["audio", serialDelta({ content: "OK", audio: { data: "hidden" } }), "response_invalid"],
    ["content blocks", serialDelta({ content: [{ type: "text", text: "OK" }] }), "response_invalid"],
  ];
  for (const [name, delta, code] of cases) await t.test(name, async () => {
    const fixture = brokerFixture({ sse: choiceEvent(delta) + STOP + DONE });
    await assert.rejects(fixture.client(complete("synthetic fixture")), errorCode(code));
    assert.equal(fixture.state.sockets[0].destroyed, true);
  });
  for (const [name, sse, code] of [
    ["upstream error", dataEvent({ error: { message: TICKET } }) + DONE, "response_invalid"],
    ["length", choiceEvent(serialDelta({ content: "partial" }), "length") + DONE, "output_truncated"],
    ["missing DONE", choiceEvent(serialDelta({ content: "OK" })) + STOP, "empty_output"],
    ["reasoning only", choiceEvent(serialDelta({ reasoning_content: "hidden reasoning" })) + STOP + DONE, "empty_output"],
  ]) await t.test(name, async () => {
    const fixture = brokerFixture({ sse });
    await assert.rejects(fixture.client(complete("synthetic fixture")), errorCode(code));
  });
});

test("caller model, route, tools, and token-cap injection are rejected before connecting", async t => {
  for (const [name, request, code] of [
    ["different model", { operation: "complete", payload: { model: "unverified", input: "test" } }, "model_unavailable"],
    ["route", { operation: "complete", payload: { input: "test", path: "/v3/config" } }, "request_invalid"],
    ["tools", { operation: "complete", payload: { input: "test", tools: ["Bash"] } }, "request_invalid"],
    ["token cap", { operation: "complete", payload: { input: "test", max_tokens: 99999 } }, "request_invalid"],
    ["oversized input", complete("x".repeat(256 * 1024 + 1)), "request_invalid"],
  ]) await t.test(name, async () => {
    const fixture = brokerFixture();
    await assert.rejects(fixture.client(request), errorCode(code));
    assert.equal(fixture.state.connected, 0); assert.equal(fixture.filesystem.state.reads, 0);
  });
});

test("invalid server proof never exposes a model request", async () => {
  const fixture = brokerFixture({ badProof: true });
  await assert.rejects(fixture.client(complete("synthetic fixture")), errorCode("handshake_failed"));
  assert.deepEqual(fixture.state.fetches, []);
  assert.equal(fixture.state.frames.some(frame => frame.type === "session_prove"), false);
  assert.equal(fixture.state.sockets[0].destroyed, true);
});

test("abort and deadline reject the pending request and destroy only the owned socket", async t => {
  await t.test("abort", async () => {
    const controller = new AbortController();
    const fixture = brokerFixture({ holdFetch: true, onFetch: () => queueMicrotask(() => controller.abort()) });
    await assert.rejects(fixture.client(complete("synthetic fixture"), { signal: controller.signal }), errorCode("cancelled"));
    assert.equal(fixture.state.sockets.length, 1); assert.equal(fixture.state.sockets[0].destroyed, true);
  });
  await t.test("deadline", async () => {
    const fixture = brokerFixture({ holdFetch: true, timeoutMs: 20 });
    await assert.rejects(fixture.client(complete("synthetic fixture")), errorCode("deadline"));
    assert.equal(fixture.state.sockets.length, 1); assert.equal(fixture.state.sockets[0].destroyed, true);
  });
});

test("account-change pipe revocation rejects held fetch and ignores late success", async () => {
  const fixture = brokerFixture({ holdFetch: true, onFetch: () => queueMicrotask(() => {
    fixture.state.sockets[0].emit("data", Buffer.from(`${JSON.stringify({
      type: "pipe_revoked", pipe: "wb.request", reason: "account_changed",
    })}\n`));
  }) });
  let outcome;
  const pending = fixture.client(complete("synthetic fixture")).then(
    value => { outcome = { status: "resolved", value }; return value; },
    error => { outcome = { status: "rejected", code: error.code }; throw error; },
  );
  await assert.rejects(pending, errorCode("session_revoked"));
  assert.equal(fixture.state.sockets[0].destroyed, true);
  const fetchFrame = fixture.state.frames.find(frame => frame.method === "c:wb.request/http.fetch");
  fixture.state.sockets[0].emit("data", Buffer.from(`${JSON.stringify({
    jsonrpc: "2.0", id: fetchFrame.id, result: httpResponse(successSse()),
  })}\n`));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(outcome, { status: "rejected", code: "workbuddy.session_revoked" });
  assert.equal(fixture.state.fetches.length, 1);
  assert.equal(fixture.state.sockets[0].destroyed, true);
});

test("descriptor is opened first and stable short FD reads authenticate successfully", async () => {
  const fixture = brokerFixture({ fs: { readChunkSize: 7 }, fragment: true });
  assert.deepEqual(await fixture.client({ operation: "probe" }), { configured: true, code: "workbuddy.ready" });
  const filesystem = fixture.filesystem.state;
  assert.equal(filesystem.calls[0].operation, "open");
  assert.equal(filesystem.calls[0].filename, path.join(CONFIG_DIR, "wbipc", "endpoint.json"));
  const flags = filesystem.calls[0].flags;
  assert.equal(flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR), 0);
  if (fsConstants.O_NOFOLLOW) assert.equal(flags & fsConstants.O_NOFOLLOW, fsConstants.O_NOFOLLOW);
  if (process.platform !== "win32" && fsConstants.O_NONBLOCK) assert.equal(flags & fsConstants.O_NONBLOCK, fsConstants.O_NONBLOCK);
  assert.ok(filesystem.readCalls > 1);
  assert.equal(filesystem.bytesRead, filesystem.bytes.length);
  assert.ok(filesystem.readRequests.every(length => length <= 8193));
  assert.equal(filesystem.opened, 1); assert.equal(filesystem.closed, 1);
});

test("FD and named-file identity mismatch is rejected without reading data", async () => {
  const fixture = brokerFixture({ fs: { initialize: state => { state.named.ino = 24n; } } });
  await assert.rejects(fixture.client(complete("synthetic fixture")), errorCode("endpoint_invalid"));
  assert.equal(fixture.filesystem.state.calls[0].operation, "open");
  assert.equal(fixture.filesystem.state.bytesRead, 0);
  assert.equal(fixture.state.connected, 0);
  assert.equal(fixture.filesystem.state.opened, 1); assert.equal(fixture.filesystem.state.closed, 1);
});

test("a descriptor growing during reads cannot consume more than 8193 bytes", async () => {
  const fixture = brokerFixture({ fs: { onRead: state => {
    if (state.readCalls !== 1) return;
    state.bytes = Buffer.alloc(32 * 1024, 120);
    state.fd.size = state.named.size = BigInt(state.bytes.length);
    state.fd.ctimeNs++; state.named.ctimeNs++;
  } } });
  await assert.rejects(fixture.client(complete("synthetic fixture")), errorCode("endpoint_invalid"));
  assert.ok(fixture.filesystem.state.bytesRead > 0);
  assert.ok(fixture.filesystem.state.bytesRead <= 8193);
  assert.ok(fixture.filesystem.state.readRequests.every(length => length <= 8193));
  assert.equal(fixture.state.connected, 0);
  assert.equal(fixture.filesystem.state.opened, 1); assert.equal(fixture.filesystem.state.closed, 1);
});

test("file and parent-directory changes during FD reads prevent connection", async t => {
  const directory = path.join(CONFIG_DIR, "wbipc");
  const races = [
    ["same inode with changed size", state => { state.fd.size++; state.named.size++; }],
    ["same inode with changed mtime", state => { state.fd.mtimeNs++; state.named.mtimeNs++; }],
    ["same inode with changed ctime", state => { state.fd.ctimeNs++; state.named.ctimeNs++; }],
    ["named path replaced", state => { state.named.ino = 24n; }],
    ["config directory replaced", state => { state.directories[CONFIG_DIR].ino = 201n; }],
    ["wbipc directory replaced", state => { state.directories[directory].ino = 202n; }],
    ["parent swapped and restored", state => {
      const previous = state.directories[CONFIG_DIR];
      state.directories[CONFIG_DIR] = { ...previous, ino: 201n };
      // Restoring the original inode and contents still advances its ctime.
      state.directories[CONFIG_DIR] = { ...previous, ctimeNs: previous.ctimeNs + 1n };
    }],
    ["parent realpath changed", state => { state.realpaths[CONFIG_DIR] = path.join(CONFIG_DIR, "replacement"); }],
    ["wbipc realpath changed", state => { state.realpaths[directory] = path.join(CONFIG_DIR, "replacement-wbipc"); }],
  ];
  for (const [name, mutate] of races) await t.test(name, async () => {
    const fixture = brokerFixture({ fs: { readChunkSize: 7, onRead: state => { if (state.readCalls === 1) mutate(state); } } });
    await assert.rejects(fixture.client(complete("synthetic fixture")), errorCode("endpoint_invalid"));
    assert.equal(fixture.state.connected, 0);
    assert.equal(fixture.filesystem.state.opened, 1); assert.equal(fixture.filesystem.state.closed, 1);
  });
});

test("descriptor and response bounds are enforced without leaking source data", async t => {
  for (const [name, fsOptions] of [
    ["malformed JSON", { raw: Buffer.from("{invalid") }],
    ["foreign endpoint", { descriptor: { endpoint: "http://localhost:9999", ticket: TICKET } }],
    ["file symlink", { symlinkFile: true }], ["directory symlink", { symlinkDirectory: true }],
    ["descriptor limit", { raw: Buffer.alloc(8193, 120) }],
  ]) await t.test(name, async () => {
    const fixture = brokerFixture({ fs: fsOptions });
    await assert.rejects(fixture.client(complete("synthetic fixture")), errorCode("endpoint_invalid"));
    assert.equal(fixture.state.connected, 0);
    assert.equal(fixture.filesystem.state.opened, fixture.filesystem.state.closed);
  });
  for (const [name, options, code] of [
    ["frame limit", { oversizedFrame: true }, "response_too_large"],
    ["invalid base64", { response: { ...httpResponse(""), body_b64: "not?base64" } }, "response_invalid"],
    ["decoded body limit", { response: httpResponse(Buffer.alloc(MAX_BODY + 1, 120)) }, "response_too_large"],
    ["invalid UTF-8", { response: httpResponse(Buffer.from([255])) }, "response_invalid"],
  ]) await t.test(name, async () => {
    const fixture = brokerFixture(options);
    await assert.rejects(fixture.client(complete("synthetic fixture")), errorCode(code));
    assert.equal(fixture.state.sockets[0].destroyed, true);
  });
});

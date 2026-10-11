const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 640 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const DEADLINE_MS = 50_000;
const AUTO_MODEL = "auto";
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const fail = suffix => {
  const error = new Error(`workbuddy.${suffix}`);
  error.code = error.message;
  return error;
};

function validateRequest(request) {
  if (!exact(request, ["id", "operation", "payload"]) || !["probe", "catalog", "complete"].includes(request.operation)
      || (request.id !== undefined && (typeof request.id !== "string" || request.id.length > 128 || /[\x00-\x1f]/.test(request.id)))) throw fail("request_invalid");
  if (request.operation !== "complete") {
    if (request.payload !== undefined && !exact(request.payload, [])) throw fail("request_invalid");
    return;
  }
  const payload = request.payload;
  if (!exact(payload, ["model", "input"]) || typeof payload.input !== "string" || !payload.input.trim()
      || Buffer.byteLength(payload.input, "utf8") > MAX_INPUT_BYTES || payload.input.includes("\0")) throw fail("request_invalid");
  if (payload.model !== undefined && payload.model !== AUTO_MODEL) throw fail("model_unavailable");
}

function readDescriptor(configDir, fileSystem) {
  const directory = path.join(configDir, "wbipc");
  const file = path.join(directory, "endpoint.json");
  let handle;
  try {
    for (const dir of [configDir, directory]) {
      const stat = fileSystem.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("endpoint_invalid");
    }
    const named = fileSystem.lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink() || named.size > 8192) throw fail("endpoint_invalid");
    handle = fileSystem.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fileSystem.fstatSync(handle);
    if (!before.isFile() || before.size > 8192 || before.ino !== named.ino || before.dev !== named.dev) throw fail("endpoint_invalid");
    const raw = fileSystem.readFileSync(handle);
    const after = fileSystem.fstatSync(handle), latest = fileSystem.lstatSync(file);
    if (raw.length > 8192 || raw.length !== after.size || before.mtimeMs !== after.mtimeMs || before.size !== after.size
        || latest.isSymbolicLink() || latest.ino !== before.ino || latest.dev !== before.dev || latest.mtimeMs !== after.mtimeMs) throw fail("endpoint_invalid");
    const descriptor = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (!exact(descriptor, ["endpoint", "ticket"]) || typeof descriptor.endpoint !== "string"
        || !/^\\\\\.\\pipe\\wbipc-[a-f0-9]{16}$/i.test(descriptor.endpoint)
        || typeof descriptor.ticket !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(descriptor.ticket)) throw fail("endpoint_invalid");
    return descriptor;
  } catch (error) {
    if (error?.code === "workbuddy.endpoint_invalid") throw error;
    throw fail(error?.code === "ENOENT" ? "client_unavailable" : "endpoint_invalid");
  } finally {
    if (handle !== undefined) { try { fileSystem.closeSync(handle); } catch {} }
  }
}

function proof(ticket, side, endpoint, clientNonce, serverNonce) {
  const parts = [];
  for (const item of [side === "server" ? "wbipc-s" : "wbipc-c", "1", endpoint, clientNonce, serverNonce]) {
    const value = Buffer.from(item, "utf8"), size = Buffer.alloc(4);
    size.writeUInt32BE(value.length); parts.push(size, value);
  }
  return crypto.createHmac("sha256", Buffer.from(ticket, "utf8")).update(Buffer.concat(parts)).digest("base64url");
}

function connectBroker(descriptor, { signal, timeoutMs, connect }) {
  if (signal?.aborted) return Promise.reject(fail("cancelled"));
  return new Promise((resolve, reject) => {
    let socket, buffer = Buffer.alloc(0), state = "challenge", settled = false, closed = false, nextId = 1;
    const pending = new Map(), clientNonce = crypto.randomBytes(24).toString("base64url");
    const close = error => {
      if (closed) return; closed = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (!settled) { settled = true; reject(error ?? fail("connection_failed")); }
      for (const request of pending.values()) request.reject(error ?? fail("connection_failed"));
      pending.clear(); buffer = Buffer.alloc(0); socket?.destroy();
    };
    const abort = () => close(fail("cancelled"));
    const timer = setTimeout(() => close(fail("deadline")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    const send = frame => {
      const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
      if (bytes.length > MAX_FRAME_BYTES) throw fail("request_invalid");
      socket.write(bytes);
    };
    const rpc = (method, params, mode) => new Promise((yes, no) => {
      if (closed) return no(fail("connection_failed"));
      const id = nextId++; pending.set(id, { resolve: yes, reject: no });
      try { send({ jsonrpc: "2.0", id, method, params, ...(mode ? { mode } : {}) }); }
      catch (error) { close(error?.code?.startsWith("workbuddy.") ? error : fail("connection_failed")); }
    });
    const receive = frame => {
      if (!record(frame)) throw fail("response_invalid");
      if (frame.type === "session_hello_error") throw fail("handshake_failed");
      if (frame.type === "pipe_revoked") throw fail("session_revoked");
      if (state === "challenge") {
        if (frame.type !== "session_challenge" || frame.protocol !== 1 || typeof frame.server_nonce !== "string"
            || !/^[A-Za-z0-9_-]{16,128}$/.test(frame.server_nonce) || typeof frame.server_proof !== "string") throw fail("handshake_failed");
        const expected = Buffer.from(proof(descriptor.ticket, "server", descriptor.endpoint, clientNonce, frame.server_nonce));
        const actual = Buffer.from(frame.server_proof);
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw fail("handshake_failed");
        state = "ack";
        send({ type: "session_prove", client_proof: proof(descriptor.ticket, "client", descriptor.endpoint, clientNonce, frame.server_nonce) });
        return;
      }
      if (state === "ack") {
        if (frame.type !== "session_hello_ack" || frame.protocol !== 1 || !Array.isArray(frame.pipes)
            || !frame.pipes.includes("wb.request")) throw fail("client_signed_out");
        state = "ready";
        rpc("broker/GetPipe", { pipe: "wb.request" }).then(result => {
          if (!record(result) || result.channel !== "c:wb.request" || !Array.isArray(result.methods) || !result.methods.includes("http.fetch")) throw fail("response_invalid");
          if (closed) return;
          settled = true;
          resolve({ close, fetch: params => rpc("c:wb.request/http.fetch", params, "call") });
        }).catch(error => close(error));
        return;
      }
      if (frame.jsonrpc !== "2.0" || !Number.isSafeInteger(frame.id) || !pending.has(frame.id)) throw fail("response_invalid");
      const request = pending.get(frame.id); pending.delete(frame.id);
      if (frame.error) request.reject(fail(frame.error.code === "not_connected" ? "client_signed_out" : "rpc_failed"));
      else if (!Object.hasOwn(frame, "result")) request.reject(fail("response_invalid"));
      else request.resolve(frame.result);
    };
    try { socket = connect(descriptor.endpoint); }
    catch { close(fail("connection_failed")); return; }
    socket.on("error", () => close(fail("connection_failed")));
    socket.on("close", () => close(fail("connection_failed")));
    socket.on("data", chunk => {
      if (closed) return;
      if (!Buffer.isBuffer(chunk)) { close(fail("response_invalid")); return; }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) { close(fail("response_too_large")); return; }
      let newline;
      while (!closed && (newline = buffer.indexOf(10)) >= 0) {
        const frame = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
        try { receive(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame))); }
        catch (error) { close(error?.code?.startsWith("workbuddy.") ? error : fail("response_invalid")); }
      }
    });
    socket.once("connect", () => {
      try { send({ type: "session_hello", protocol_min: 1, protocol_max: 1, client_nonce: clientNonce,
        ticket_id: crypto.createHash("sha256").update(descriptor.ticket, "utf8").digest("hex").slice(0, 16), client: { kind: "roleweave", version: "1" } }); }
      catch { close(fail("connection_failed")); }
    });
  });
}

function decodeResponse(response) {
  if (!record(response) || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw fail("response_invalid");
  if (response.status !== 200) throw fail(response.status === 401 ? "authentication_expired" : response.status === 403 ? "access_denied"
    : response.status === 429 ? "rate_limited" : "upstream_failed");
  if (!record(response.headers) || typeof response.body_b64 !== "string" || response.body_b64.length > Math.ceil(MAX_RESPONSE_BYTES / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.body_b64)) throw fail("response_invalid");
  const body = Buffer.from(response.body_b64, "base64");
  if (body.length > MAX_RESPONSE_BYTES) throw fail("response_too_large");
  const contentType = Object.entries(response.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1];
  if (typeof contentType !== "string" || !/^text\/event-stream(?:\s*;|$)/i.test(contentType)) throw fail("response_invalid");
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { throw fail("response_invalid"); }
  let text = "", done = false, stopped = false, usage;
  const hasCall = value => value !== undefined && value !== null && (!Array.isArray(value) || value.length !== 0);
  const hasFunctionCall = value => value !== undefined && value !== null
    && !(exact(value, ["name", "arguments"]) && Object.values(value).every(item => item === "" || item === null));
  for (const block of source.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/), data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    if (done) throw fail("response_invalid");
    if (data.trim() === "[DONE]") { done = true; continue; }
    let event;
    try { event = JSON.parse(data); } catch { throw fail("response_invalid"); }
    if (!record(event) || event.error || event.tool_calls || event.function_call
        || (event.choices === undefined ? !record(event.usage) : !Array.isArray(event.choices) || event.choices.length > 1)
        || lines.some(line => /^event:\s*error\s*$/.test(line))) throw fail("response_invalid");
    if (event.usage !== undefined && event.usage !== null) {
      const values = [event.usage.prompt_tokens, event.usage.completion_tokens, event.usage.total_tokens];
      if (!record(event.usage) || !values.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000)) throw fail("response_invalid");
      usage = { inputTokens: values[0], outputTokens: values[1], totalTokens: values[2] };
    }
    for (const choice of event.choices ?? []) {
      if (!record(choice) || choice.index !== undefined && choice.index !== null && choice.index !== 0 || !record(choice.delta)) throw fail("response_invalid");
      const delta = choice.delta;
      if (!exact(delta, ["role", "content", "tool_calls", "function_call", "audio", "refusal", "reasoning", "reasoning_content", "extra_fields"])) throw fail("response_invalid");
      if ([delta.refusal, choice.message?.refusal].some(value => value !== undefined && value !== null && value !== "")) throw fail("refused");
      if (hasCall(delta.tool_calls) || hasFunctionCall(delta.function_call)
          || hasCall(choice.message?.tool_calls) || hasFunctionCall(choice.message?.function_call)
          || ["tool_calls", "function_call"].includes(choice.finish_reason)) throw fail("tools_denied");
      if (delta.audio !== undefined && delta.audio !== null || choice.message?.audio !== undefined && choice.message.audio !== null
          || delta.role !== undefined && delta.role !== null && delta.role !== "assistant" || choice.message !== undefined && choice.message !== null
          || delta.extra_fields !== undefined && delta.extra_fields !== null && !record(delta.extra_fields)
          || [delta.reasoning, delta.reasoning_content].some(value => value !== undefined && value !== null && typeof value !== "string")) throw fail("response_invalid");
      if (choice.finish_reason === "length") throw fail("output_truncated");
      if (choice.finish_reason !== undefined && choice.finish_reason !== null && choice.finish_reason !== "" && choice.finish_reason !== "stop") throw fail("response_invalid");
      if (stopped && delta.content) throw fail("response_invalid");
      if (delta.content !== undefined && delta.content !== null) {
        if (typeof delta.content !== "string") throw fail("response_invalid");
        text += delta.content;
      }
      if (choice.finish_reason === "stop") stopped = true;
    }
  }
  if (!done || !stopped || !text.trim()) throw fail("empty_output");
  return { model: AUTO_MODEL, text, ...(usage ? { usage } : {}) };
}

/** Uses the already signed-in desktop's WBIPC broker. Provider credentials
 * stay inside WorkBuddy; the local ticket never leaves this private client.
 * The broker buffers SSE, so this client deliberately exposes no token stream. */
function createWorkbuddyClient({ platform = process.platform, configDir, fileSystem = fs,
  connect = endpoint => net.createConnection({ path: endpoint }), timeoutMs = DEADLINE_MS } = {}) {
  return async function requestWorkbuddyClient(request, { signal, maxOutputTokens = 4096 } = {}) {
    validateRequest(request);
    let broker;
    try {
      if (platform !== "win32") throw fail("platform_unavailable");
      if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096
          || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEADLINE_MS) throw fail("request_invalid");
      const directory = configDir ?? (process.env.WORKBUDDY_CONFIG_DIR?.trim() || path.join(os.homedir(), ".workbuddy"));
      if (!path.isAbsolute(directory)) throw fail("endpoint_invalid");
      const descriptor = readDescriptor(directory, fileSystem);
      broker = await connectBroker(descriptor, { signal, timeoutMs, connect });
      if (request.operation === "probe") return { configured: true, code: "workbuddy.ready" };
      // This is the installed client's verified default, not a fetched account
      // catalogue. /v3/config requires a User-Agent unavailable to this broker.
      if (request.operation === "catalog") return { models: [], defaultModel: AUTO_MODEL };
      const body = { model: AUTO_MODEL, messages: [{ role: "user", content: request.payload.input }], tools: [], tool_choice: "none",
        stream: true, stream_options: { include_usage: true }, max_tokens: maxOutputTokens };
      const response = await broker.fetch({ method: "POST", path: "/v2/chat/completions", headers: { "content-type": "application/json", accept: "text/event-stream" },
        body_b64: Buffer.from(JSON.stringify(body), "utf8").toString("base64") });
      return decodeResponse(response);
    } catch (error) {
      const safe = error?.code?.startsWith("workbuddy.") ? error : fail("connection_failed");
      if (request.operation === "probe") return { configured: false, code: safe.code };
      throw safe;
    } finally { broker?.close(); }
  };
}

module.exports = { requestWorkbuddyClient: createWorkbuddyClient(), createWorkbuddyClient };

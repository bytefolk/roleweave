const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");

// This private, desktop-owned channel carries model requests, never provider
// credentials. It exposes three operations, not an arbitrary HTTP proxy.
const REQUEST_PREFIX = "roleweave-workbuddy-request ";
const RESPONSE_PREFIX = "roleweave-workbuddy-response ";
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 8;
const REQUEST_TIMEOUT_MS = 60_000;
const OPERATIONS = new Set(["probe", "catalog", "complete"]);
const validId = (value) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function validRequest(value) {
  return record(value) && Object.keys(value).sort().join(",") === "id,operation,payload,token"
    && validId(value.id) && OPERATIONS.has(value.operation) && record(value.payload)
    && typeof value.token === "string" && /^[a-f0-9]{64}$/.test(value.token);
}
function safeError(error) {
  return typeof error?.code === "string" && /^workbuddy\.[a-z_]{1,64}$/.test(error.code)
    ? error.code : "workbuddy.client_unavailable";
}
function invokeOwned(invoke, request, signal) {
  let abort;
  const cancelled = new Promise((_resolve, reject) => {
    abort = () => reject(Object.assign(new Error("WorkBuddy request cancelled"), { code: "workbuddy.cancelled" }));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw Object.assign(new Error("WorkBuddy request cancelled"), { code: "workbuddy.cancelled" }); return invoke(request, signal); }), cancelled])
    .finally(() => signal.removeEventListener("abort", abort));
}

// Each socket accepts one bounded request. EOF/cancellation immediately drops
// its upstream work; stopping the owning desktop/supervisor drops every call.
function createPrivateBridge(invoke, { platform = process.platform, root = os.tmpdir() } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  const directory = platform === "win32" ? null : fs.mkdtempSync(path.join(root, "rw-workbuddy-"));
  if (directory) fs.chmodSync(directory, 0o700);
  const endpoint = platform === "win32" ? `\\\\.\\pipe\\roleweave-workbuddy-${crypto.randomUUID()}` : path.join(directory, "bridge.sock");
  const calls = new Map();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0), started = false, controller;
    const timer = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
    const send = (value) => {
      if (socket.destroyed) return;
      const frame = JSON.stringify(value);
      socket.end(`${Buffer.byteLength(frame) + 1 > MAX_FRAME_BYTES ? JSON.stringify({ id: value.id, error: "workbuddy.output_limit" }) : frame}\n`);
    };
    socket.on("data", (chunk) => {
      if (started || buffer.length + chunk.length > MAX_FRAME_BYTES) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      started = true;
      let request;
      try { request = JSON.parse(buffer.subarray(0, newline).toString("utf8")); } catch { socket.destroy(); return; }
      buffer = buffer.subarray(newline + 1);
      if (buffer.length || !validRequest(request) || request.token !== token || calls.size >= MAX_IN_FLIGHT || calls.has(request.id)) { socket.destroy(); return; }
      controller = new AbortController();
      calls.set(request.id, controller);
      invokeOwned(invoke, { id: request.id, operation: request.operation, payload: request.payload }, controller.signal)
        .then((result) => send({ id: request.id, result }), (error) => send({ id: request.id, error: safeError(error) }))
        .finally(() => calls.delete(request.id));
    });
    socket.on("error", () => {});
    socket.on("close", () => { clearTimeout(timer); controller?.abort(); sockets.delete(socket); });
  });
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => { if (directory) fs.chmodSync(endpoint, 0o600); resolve(); });
  });
  // Keep a handler after startup as well; this channel may fail without killing
  // the rest of the workbench. Health will report that WorkBuddy is unavailable.
  server.on("error", () => {});
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const controller of calls.values()) controller.abort();
    for (const socket of sockets) socket.destroy();
    server.close();
    if (directory) { try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* private owned directory */ } }
  };
  return { endpoint, token, ready, close };
}

// Windows owns the original stdin/stdout pipes of its WSL supervisor. No
// listener is opened on the LAN and no Windows process is spawned from Linux.
function attachWslBridge(child, invoke) {
  let buffer = "", closed = false;
  const decoder = new StringDecoder("utf8");
  const active = new Map();
  const respond = (value) => {
    if (closed || child.stdin.destroyed || child.stdin.writableEnded) return;
    let frame = `${RESPONSE_PREFIX}${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) frame = `${RESPONSE_PREFIX}${JSON.stringify({ id: value.id, error: "workbuddy.output_limit" })}\n`;
    child.stdin.write(frame);
  };
  const onData = (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) continue;
      if (!line.startsWith(REQUEST_PREFIX)) continue;
      let request;
      try { request = JSON.parse(line.slice(REQUEST_PREFIX.length)); } catch { continue; }
      if (!record(request) || !validId(request.id)) continue;
      if (request.cancel === true && Object.keys(request).sort().join(",") === "cancel,id") {
        active.get(request.id)?.controller.abort(); continue;
      }
      if (Object.keys(request).sort().join(",") !== "id,operation,payload" || !OPERATIONS.has(request.operation) || !record(request.payload) || active.has(request.id)) continue;
      if (active.size >= MAX_IN_FLIGHT) { respond({ id: request.id, error: "workbuddy.busy" }); continue; }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      active.set(request.id, { controller, timer });
      invokeOwned(invoke, request, controller.signal)
        .then((result) => respond({ id: request.id, result }), (error) => respond({ id: request.id, error: safeError(error) }))
        .finally(() => { clearTimeout(timer); active.delete(request.id); });
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) close();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    child.stdout.removeListener("data", onData);
    for (const { controller, timer } of active.values()) { clearTimeout(timer); controller.abort(); }
    active.clear(); buffer = "";
  };
  child.stdout.on("data", onData);
  child.stdout.once("end", close);
  child.stdout.once("close", close);
  child.once("exit", close);
  child.once("error", close);
  return { close };
}

module.exports = { REQUEST_PREFIX, RESPONSE_PREFIX, MAX_FRAME_BYTES, REQUEST_TIMEOUT_MS, MAX_IN_FLIGHT, validId, createPrivateBridge, attachWslBridge };

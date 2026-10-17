const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const PROTOCOL = "qwenwork.desktop.v1";
const REQUEST_SCHEMA = "qwenwork.desktop-request.v1";
const RESPONSE_SCHEMA = "qwenwork.response.v1";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_DESCRIPTOR_BYTES = 4096;
const DEADLINE_MS = 180_000;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const string = (value, max = 256) => typeof value === "string" && value.length > 0
  && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const sessionId = value => string(value, 128) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
const taskId = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const fail = suffix => Object.assign(new Error(`qwen_office.${suffix}`), { code: `qwen_office.${suffix}` });
const sameSnapshot = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function readBoundedFile(filename, parents, maximum, fileSystem) {
  let fd;
  const directory = name => {
    const stat = fileSystem.lstatSync(name, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("endpoint_invalid");
    return { name, stat, realPath: fileSystem.realpathSync(name) };
  };
  const regular = stat => stat.isFile() && !stat.isSymbolicLink() && typeof stat.size === "bigint"
    && stat.size >= 0n && stat.size <= BigInt(maximum);
  try {
    // The opened FD owns the identity; a pathname check never precedes open.
    fd = fileSystem.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
      | (process.platform === "win32" ? 0 : (fs.constants.O_NONBLOCK ?? 0)));
    const before = fileSystem.fstatSync(fd, { bigint: true });
    if (!regular(before)) throw fail("endpoint_invalid");
    const directories = parents.map(directory);
    const named = fileSystem.lstatSync(filename, { bigint: true });
    if (!regular(named) || !sameSnapshot(before, named)) throw fail("endpoint_invalid");
    const buffer = Buffer.alloc(maximum + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fileSystem.readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length - bytes) throw fail("endpoint_invalid");
      if (!count) break;
      bytes += count;
    }
    const after = fileSystem.fstatSync(fd, { bigint: true }), latest = fileSystem.lstatSync(filename, { bigint: true });
    if (bytes > maximum || BigInt(bytes) !== before.size || !regular(after) || !regular(latest)
        || !sameSnapshot(before, after) || !sameSnapshot(before, latest)) throw fail("endpoint_invalid");
    for (const parent of directories) {
      const current = directory(parent.name);
      if (!sameSnapshot(parent.stat, current.stat) || parent.realPath !== current.realPath) throw fail("endpoint_invalid");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
  } catch (error) {
    if (error?.code?.startsWith("qwen_office.")) throw error;
    throw fail(error?.code === "ENOENT" ? "control_disabled" : "endpoint_invalid");
  } finally { if (fd !== undefined) { try { fileSystem.closeSync(fd); } catch {} } }
}

function readEndpoint(userDataDir, fileSystem) {
  const directory = path.join(userDataDir, "cli-control");
  try {
    const endpoint = JSON.parse(readBoundedFile(path.join(directory, "endpoint.json"),
      [userDataDir, directory], MAX_DESCRIPTOR_BYTES, fileSystem));
    if (!exact(endpoint, ["protocol", "port", "instance_id"]) || endpoint.protocol !== PROTOCOL
        || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535
        || typeof endpoint.instance_id !== "string" || !/^[a-f0-9]{32}$/.test(endpoint.instance_id)) throw fail("endpoint_invalid");
    const instanceDirectory = path.join(directory, endpoint.instance_id);
    const ticket = readBoundedFile(path.join(instanceDirectory, "token"),
      [userDataDir, directory, instanceDirectory], 256, fileSystem).trim();
    if (!/^[a-f0-9]{64}$/.test(ticket)) throw fail("endpoint_invalid");
    // No discovered URL can change the host, scheme, route, or redirect policy.
    return { port: endpoint.port, instance: endpoint.instance_id, ticket,
      fingerprint: crypto.createHash("sha256").update(JSON.stringify([endpoint.port, endpoint.instance_id, ticket])).digest("hex") };
  } catch (error) {
    throw error?.code?.startsWith("qwen_office.") ? error : fail("endpoint_invalid");
  }
}

function validateRequest(request) {
  if (!exact(request, ["id", "operation", "payload"]) || !["probe", "catalog", "complete"].includes(request.operation)
      || request.id !== undefined && !string(request.id, 128)) throw fail("request_invalid");
  if (request.operation !== "complete") {
    if (request.payload !== undefined && !exact(request.payload, [])) throw fail("request_invalid");
    return;
  }
  const p = request.payload;
  if (!exact(p, ["input", "sessionKey", "employeeLabel", "model"]) || typeof p.input !== "string" || !p.input.trim()
      || p.input.includes("\0") || p.input.length > 64000 || Buffer.byteLength(p.input, "utf8") > MAX_INPUT_BYTES
      || typeof p.sessionKey !== "string" || !/^[a-f0-9]{64}$/.test(p.sessionKey)
      || p.employeeLabel !== undefined && !string(p.employeeLabel, 80)
      || p.model !== undefined && !string(p.model)) throw fail("request_invalid");
}

async function boundedJson(response) {
  if (!response || !Number.isInteger(response.status) || !response.headers || !response.body?.getReader) throw fail("response_invalid");
  const contentType = response.headers.get("content-type");
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) throw fail("response_invalid");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw fail("response_too_large");
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw fail("response_invalid");
      bytes += item.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw fail("response_too_large");
      chunks.push(Buffer.from(item.value));
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch (error) { throw error?.code?.startsWith("qwen_office.") ? error : fail("response_invalid"); }
  finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

const REMOTE_ERRORS = Object.freeze({
  DESKTOP_AUTH_REQUIRED: "client_signed_out", DESKTOP_IDENTITY_CHANGED: "account_changed",
  DESKTOP_CONTROL_FORBIDDEN: "authentication_expired", REQUEST_ABORTED: "cancelled",
  DESKTOP_CONTROL_TIMEOUT: "request_deadline", DESKTOP_CONTROL_BUSY: "client_busy",
  SESSION_BUSY: "session_busy", SESSION_NOT_FOUND: "session_unavailable", TASK_NOT_FOUND: "task_lost",
  TASK_NOT_RUNNING: "task_not_running", MODE_NOT_AVAILABLE: "mode_unavailable",
  MODEL_NOT_AVAILABLE: "model_unavailable", EVENT_CURSOR_EXPIRED: "event_gap",
});

function parseStatus(data) {
  if (!exact(data, ["protocol", "app", "authenticated", "user", "backend", "features"]) || data.protocol !== PROTOCOL
      || data.backend !== "desktop" || !exact(data.app, ["name", "version", "packaged"])
      || !string(data.app.name, 128) || !string(data.app.version, 128) || typeof data.app.packaged !== "boolean"
      || typeof data.authenticated !== "boolean" || !record(data.features)
      || !Object.values(data.features).every(value => typeof value === "boolean")) throw fail("response_invalid");
  if (!data.authenticated) {
    if (data.user !== null) throw fail("response_invalid");
    throw fail("client_signed_out");
  }
  if (!exact(data.user, ["user_id", "display_name", "username"]) || !string(data.user.user_id)
      || data.features.task_execution !== true || data.features.task_events !== true
      || data.features.session_history !== true) throw fail("client_incompatible");
  return { identity: crypto.createHash("sha256").update(data.user.user_id).digest("hex"), version: data.app.version };
}

function parseModels(data) {
  if (!exact(data, ["backend", "models"]) || data.backend !== "desktop" || !Array.isArray(data.models) || data.models.length > 512) throw fail("response_invalid");
  const ids = new Set(), models = [];
  for (const model of data.models) {
    if (!exact(model, ["key", "display_name", "enabled", "source"]) || !string(model.key)
        || typeof model.enabled !== "boolean" || !["catalog", "custom"].includes(model.source)
        || model.display_name !== undefined && !string(model.display_name) || ids.has(model.key)) throw fail("response_invalid");
    ids.add(model.key);
    if (model.enabled) models.push({ id: model.key, ...(model.display_name ? { name: model.display_name } : {}) });
  }
  return models;
}

function parseModel(data, scope, id) {
  if (!exact(data, ["backend", "scope", "session_id", "model", "inherited", "applies", "runtime_execution_verified"])
      || data.backend !== "desktop" || data.scope !== scope || typeof data.inherited !== "boolean"
      || data.model !== null && !string(data.model) || scope === "session" && data.session_id !== id
      || scope === "default" && data.session_id !== null) throw fail("response_invalid");
  return data.model ?? undefined;
}

function parseSession(data) {
  if (!exact(data, ["backend", "session_id", "chat_id", "title", "model", "workspace", "output_directory"])
      || data.backend !== "desktop" || !sessionId(data.session_id) || !sessionId(data.chat_id) || typeof data.title !== "string" || data.title.length > 512
      || data.model !== null && !string(data.model) || !string(data.workspace, 4096)
      || data.output_directory !== null && data.output_directory !== undefined && !string(data.output_directory, 4096)) throw fail("response_invalid");
  return { id: data.session_id, model: data.model ?? undefined };
}

function publicResult(value, ticket) {
  const inspect = item => {
    if (typeof item === "string") {
      // Guard every projected string, including model IDs/names and version,
      // rather than assuming that only answer text can reflect a credential.
      // Direct Bearer headers contain the same ticket. Decode common standard
      // or URL-safe base64 blobs once; do not expose or retain decoded content.
      if (item.toLowerCase().includes(ticket)) throw fail("credential_reflection");
      for (const match of item.matchAll(/[A-Za-z0-9+/_-]{80,}={0,2}/g)) {
        if (Buffer.from(match[0], "base64").toString("utf8").toLowerCase().includes(ticket)) throw fail("credential_reflection");
      }
    } else if (Array.isArray(item)) item.forEach(inspect);
    else if (record(item)) Object.values(item).forEach(inspect);
  };
  inspect(value);
  return value;
}

function parseTask(data, owned, events = false) {
  const keys = ["backend", "task_id", "session_id", "turn_id", "status", "terminal", "created_at", "last_sequence", "actions",
    "answer", "answer_is_final", "answer_may_be_truncated", "error", "reported_error", "retention", "cancelled",
    ...(events ? ["events", "next_cursor", "has_more"] : [])];
  if (!exact(data, keys) || data.backend !== "desktop" || data.task_id !== owned.taskId || data.session_id !== owned.sessionId
      || !taskId(data.task_id) || !sessionId(data.session_id) || !["starting", "running", "waiting_for_input", "completed", "failed", "cancelled", "unknown"].includes(data.status)
      || typeof data.terminal !== "boolean" || data.terminal !== !["starting", "running", "waiting_for_input"].includes(data.status)
      || !string(data.created_at, 128) || !Number.isSafeInteger(data.last_sequence) || data.last_sequence < owned.cursor
      || !Array.isArray(data.actions) || data.actions.length > 3 || data.retention !== "desktop_instance_bounded"
      || data.turn_id !== undefined && !string(data.turn_id)
      || data.answer !== undefined && (typeof data.answer !== "string" || Buffer.byteLength(data.answer, "utf8") > MAX_OUTPUT_BYTES)
      || data.answer_is_final !== undefined && typeof data.answer_is_final !== "boolean"
      || data.answer_may_be_truncated !== undefined && typeof data.answer_may_be_truncated !== "boolean"
      || data.error !== undefined && (typeof data.error !== "string" || data.error.length > 16384)
      || data.reported_error !== undefined && (!exact(data.reported_error, ["message", "code", "retryable"])
        || typeof data.reported_error.message !== "string" || data.reported_error.message.length > 16384
        || data.reported_error.code !== undefined && !string(data.reported_error.code)
        || data.reported_error.retryable !== undefined && typeof data.reported_error.retryable !== "boolean")
      || data.cancelled !== undefined && typeof data.cancelled !== "boolean") throw fail("response_invalid");
  if (data.turn_id !== undefined) {
    if (owned.turnId !== undefined && owned.turnId !== data.turn_id) throw fail("task_changed");
    owned.turnId = data.turn_id;
  }
  const kinds = [];
  for (const action of data.actions) {
    if (!exact(action, ["action_id", "kind", "tool_name", "input", "decisions", "questions", "tool_call_count", "threshold", "recent_tools"])
        || !string(action.action_id, 512) || !["permission", "question", "budget"].includes(action.kind)
        || !Array.isArray(action.decisions) || !action.decisions.length || action.decisions.length > 2
        || !action.decisions.every(decision => ({ permission: ["approve", "deny"], question: ["answer", "deny"], budget: ["continue", "abort"] })[action.kind].includes(decision))) throw fail("response_invalid");
    if (!kinds.includes(action.kind)) kinds.push(action.kind);
  }
  if (data.status === "waiting_for_input" && !kinds.length || data.terminal && kinds.length) throw fail("response_invalid");
  if (events) {
    if (!Array.isArray(data.events) || data.events.length > 1 || !Number.isSafeInteger(data.next_cursor)
        || data.next_cursor < owned.cursor || data.next_cursor > data.last_sequence || typeof data.has_more !== "boolean") throw fail("response_invalid");
    let cursor = owned.cursor;
    for (const item of data.events) {
      if (!exact(item, ["sequence", "event"]) || !Number.isSafeInteger(item.sequence) || item.sequence <= cursor
          || item.sequence > data.last_sequence || !record(item.event) || !string(item.event.type, 128)) throw fail("response_invalid");
      cursor = item.sequence;
    }
    if (cursor !== data.next_cursor || data.has_more !== (cursor < data.last_sequence)) throw fail("response_invalid");
    owned.cursor = cursor;
  }
  return { status: data.status, terminal: data.terminal, actionKinds: kinds, lastSequence: data.last_sequence, text: data.answer,
    final: data.answer_is_final === true, truncated: data.answer_may_be_truncated === true };
}

function delay(ms, signal) {
  if (signal.aborted) return Promise.reject(fail("cancelled"));
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(fail("cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** The client owns only newly created Office sessions/tasks. Native tool and
 * approval policy stays in Office. No provider credential or raw account data
 * is returned; no permission.set, action.respond, or arbitrary route exists. */
function createQwenOfficeClient({ platform = process.platform, userDataDir, fileSystem = fs,
  fetchImpl = globalThis.fetch, timeoutMs = DEADLINE_MS, httpTimeoutMs = 10_000, pollIntervalMs = 750 } = {}) {
  const runs = new Map();
  const activeRequests = new Map();
  let closed = false, closing;
  let activeIdentity;
  const reset = identity => {
    if (activeIdentity !== undefined && activeIdentity !== identity) {
      for (const run of runs.values()) run.controller?.abort();
      runs.clear();
    }
    activeIdentity = identity;
  };
  const client = async function requestQwenOfficeClient(request, { signal, onProgress } = {}) {
    if (closed) throw fail("client_closed");
    validateRequest(request);
    if (![timeoutMs, httpTimeoutMs, pollIntervalMs].every(Number.isInteger) || timeoutMs < 1 || timeoutMs > DEADLINE_MS
        || httpTimeoutMs < 1 || httpTimeoutMs > 10_000 || pollIntervalMs < 1 || pollIntervalMs > 10_000) throw fail("request_invalid");
    const controller = new AbortController();
    let settle;
    const settlement = new Promise(resolve => { settle = resolve; });
    activeRequests.set(controller, settlement);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    let deadline = false, connection, ownerIdentity, owned, completed = false, registered = false, heartbeat;
    const timer = setTimeout(() => { deadline = true; controller.abort(); }, timeoutMs);
    const directory = userDataDir ?? path.join(os.homedir(), "AppData", "Roaming", "QwenWorkCN");
    const currentEndpoint = () => {
      if (!path.isAbsolute(directory)) throw fail("endpoint_invalid");
      const current = readEndpoint(directory, fileSystem);
      if (connection && connection.fingerprint !== current.fingerprint) throw fail("instance_changed");
      return current;
    };
    const project = value => {
      if (controller.signal.aborted) throw fail("cancelled");
      return publicResult(value, connection.ticket);
    };
    const rpc = async (method, params, requestSignal = controller.signal) => {
      if (requestSignal.aborted) throw fail("cancelled");
      currentEndpoint();
      const timeout = AbortSignal.timeout(httpTimeoutMs), combined = AbortSignal.any([requestSignal, timeout]);
      let response;
      try {
        response = await fetchImpl(`http://127.0.0.1:${connection.port}/v1/control`, { method: "POST", redirect: "error",
          headers: { "content-type": "application/json", authorization: `Bearer ${connection.ticket}` },
          body: JSON.stringify({ schema_version: REQUEST_SCHEMA, method, params }), signal: combined });
        if (combined.aborted) throw fail("cancelled");
        const envelope = await boundedJson(response);
        if (combined.aborted) throw fail("cancelled");
        currentEndpoint();
        if (response.headers.get("x-qwenwork-instance") !== connection.instance
            || !exact(envelope, ["schema_version", "ok", "data", "error"]) || envelope.schema_version !== RESPONSE_SCHEMA
            || typeof envelope.ok !== "boolean") throw fail("response_invalid");
        if (!envelope.ok) {
          if (envelope.data !== null || !exact(envelope.error, ["code", "message", "retryable"])
              || !string(envelope.error.code, 128) || typeof envelope.error.retryable !== "boolean") throw fail("response_invalid");
          throw fail(REMOTE_ERRORS[envelope.error.code] ?? "client_failed");
        }
        if (response.status !== 200 || envelope.error !== null || !record(envelope.data)) throw fail("response_invalid");
        return envelope.data;
      } catch (error) {
        if (requestSignal.aborted) throw fail("cancelled");
        if (timeout.aborted) throw fail("request_deadline");
        throw error?.code?.startsWith("qwen_office.") ? error : fail("connection_failed");
      } finally { try { await response?.body?.cancel(); } catch {} }
    };
    const assertAccount = async (requestSignal = controller.signal) => {
      const status = parseStatus(await rpc("desktop.status", {}, requestSignal));
      const identity = `${connection.fingerprint}:${status.identity}`;
      if (ownerIdentity !== undefined && ownerIdentity !== identity) { reset(identity); throw fail("account_changed"); }
      reset(identity);
      ownerIdentity = identity;
      return status;
    };
    try {
      if (platform !== "win32") throw fail("platform_unavailable");
      if (controller.signal.aborted) throw fail("cancelled");
      connection = currentEndpoint();
      const status = await assertAccount();
      if (request.operation === "probe") return project({ configured: true, code: "qwen_office.ready", version: status.version });
      if (request.operation === "catalog") {
        const models = parseModels(await rpc("model.list", {}));
        const model = parseModel(await rpc("model.get", { scope: "default" }), "default");
        await assertAccount();
        return project({ models, ...(model ? { defaultModel: model } : {}) });
      }
      const payload = request.payload, inputHash = crypto.createHash("sha256").update(JSON.stringify([payload.input, payload.model])).digest("hex");
      const previous = runs.get(payload.sessionKey);
      if (previous) {
        if (previous.inputHash !== inputHash) throw fail("session_key_reused");
        throw fail(previous.controller ? "session_busy" : "session_key_reused");
      }
      if (runs.size >= 128) {
        const oldest = [...runs].find(([, value]) => !value.controller);
        if (!oldest) throw fail("client_busy");
        runs.delete(oldest[0]);
      }
      const run = { inputHash, controller };
      runs.set(payload.sessionKey, run); registered = true;
      const session = parseSession(await rpc("session.create", { title: `RoleWeave · ${payload.employeeLabel ?? "Assistant"}`, workspace_mode: "general" }));
      await assertAccount();
      let model = session.model;
      if (payload.model !== undefined) {
        const models = parseModels(await rpc("model.list", {}));
        if (!models.some(item => item.id === payload.model)) throw fail("model_unavailable");
        model = parseModel(await rpc("model.set", { scope: "session", session_id: session.id, model: payload.model }), "session", session.id);
        await assertAccount();
      } else if (!model) model = parseModel(await rpc("model.get", { scope: "session", session_id: session.id }), "session", session.id);
      // Recheck after every model branch immediately before sending context.
      // This closes observable switches; Office still owns the native request
      // transaction and its account-bound task IDs.
      await assertAccount();
      // Set ownership before submission: even a lost submit response can only
      // trigger cleanup of this freshly generated request ID, never a user turn.
      owned = { sessionId: session.id, taskId: crypto.randomUUID(), cursor: 0 };
      let task = parseTask(await rpc("task.submit", { session_id: session.id, prompt: payload.input, request_id: owned.taskId }), owned);
      let progress = { status: "running" }, previousProgress;
      const report = () => { if (!controller.signal.aborted) { try { onProgress?.(progress); } catch {} } };
      heartbeat = setInterval(report, 5000);
      for (;;) {
        await assertAccount();
        if (task.terminal) {
          if (task.status !== "completed") throw fail(task.status === "cancelled" ? "task_cancelled" : task.status === "unknown" ? "task_lost" : "task_failed");
          const result = parseTask(await rpc("task.result", { task_id: owned.taskId }), owned);
          await assertAccount();
          if (result.status !== "completed" || !result.final || !result.text?.trim()) throw fail("empty_output");
          if (result.truncated) throw fail("output_truncated");
          const output = project({ text: result.text, ...(model ? { model } : {}) });
          completed = true;
          run.controller = undefined;
          return output;
        }
        progress = { status: task.status === "waiting_for_input" ? "waiting_for_input" : "running",
          ...(task.actionKinds.length ? { actionKinds: task.actionKinds } : {}) };
        if (JSON.stringify(progress) !== previousProgress) { report(); previousProgress = JSON.stringify(progress); }
        try { parseTask(await rpc("task.events", { task_id: owned.taskId, after: owned.cursor, limit: 1 }), owned, true); }
        catch (error) {
          if (error?.code !== "qwen_office.event_gap") throw error;
          // Office evicts old events. Reconcile its current state rather than
          // treating an incomplete event history as a completed task.
          owned.cursor = Math.max(owned.cursor, task.lastSequence);
        }
        await delay(pollIntervalMs, controller.signal);
        task = parseTask(await rpc("task.get", { task_id: owned.taskId }), owned);
      }
    } catch (error) {
      const safe = deadline ? fail("deadline") : signal?.aborted ? fail("cancelled")
        : error?.code?.startsWith("qwen_office.") ? error : fail("connection_failed");
      if (request.operation === "probe") return { configured: false, code: safe.code };
      throw safe;
    } finally {
      clearTimeout(timer); clearInterval(heartbeat); signal?.removeEventListener("abort", abort);
      if (owned && !completed) {
        // Cancellation uses a fresh bounded request, with both instance and
        // account rechecked. A changed account/instance must never be targeted.
        const cleanup = AbortSignal.timeout(Math.min(httpTimeoutMs, 5000));
        try {
          const status = parseStatus(await rpc("desktop.status", {}, cleanup));
          if (`${connection.fingerprint}:${status.identity}` === ownerIdentity) {
            const task = parseTask(await rpc("task.get", { task_id: owned.taskId }, cleanup), owned);
            if (!task.terminal) {
              const latest = parseStatus(await rpc("desktop.status", {}, cleanup));
              if (`${connection.fingerprint}:${latest.identity}` === ownerIdentity) {
                parseTask(await rpc("task.cancel", { task_id: owned.taskId }, cleanup), owned);
              }
            }
          }
        } catch {}
      }
      if (registered) {
        const run = runs.get(request.payload.sessionKey);
        if (run?.controller === controller) run.controller = undefined;
      }
      activeRequests.delete(controller);
      settle();
    }
  };
  client.hasPending = () => activeRequests.size > 0;
  client.close = () => {
    if (closing) return closing;
    closed = true;
    for (const controller of activeRequests.keys()) controller.abort();
    closing = (async () => {
      let timer;
      await Promise.race([
        Promise.allSettled([...activeRequests.values()]),
        new Promise(resolve => { timer = setTimeout(resolve, 5500); }),
      ]);
      clearTimeout(timer);
    })();
    return closing;
  };
  return client;
}

const requestQwenOfficeClient = createQwenOfficeClient();
module.exports = { requestQwenOfficeClient, createQwenOfficeClient,
  closeQwenOfficeClient: () => requestQwenOfficeClient.close(),
  hasPendingQwenOfficeTasks: () => requestQwenOfficeClient.hasPending() };

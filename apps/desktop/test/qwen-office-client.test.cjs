const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { createQwenOfficeClient } = require("../src/qwen-office-client.cjs");

// Entirely in-memory Office/file fixtures: no installed client, user directory,
// token vault, process, socket, or provider is contacted by these tests.
const USER_DATA = path.resolve(__dirname, "__memory_only_office_fixture__");
const INSTANCE = "0123456789abcdef0123456789abcdef";
const TICKET = "a".repeat(64);
const KEY = "b".repeat(64);
const OTHER_TASK = "01234567-89ab-cdef-0123-456789abcdef";

function memoryFiles(options = {}) {
  const control = path.join(USER_DATA, "cli-control"), instance = path.join(control, INSTANCE);
  const descriptor = path.join(control, "endpoint.json"), token = path.join(instance, "token");
  const metadata = (ino, size) => ({ dev: 3n, ino, size, mtimeNs: 10n, ctimeNs: 11n });
  const files = new Map([[descriptor, { bytes: Buffer.from(JSON.stringify({ protocol: "qwenwork.desktop.v1", port: 31337, instance_id: INSTANCE })), ino: 20n }],
    [token, { bytes: Buffer.from(TICKET), ino: 21n }]]);
  const dirs = new Map([USER_DATA, control, instance].map((name, index) => [name, metadata(BigInt(100 + index), 0n)]));
  const handles = new Map(), calls = [];
  let nextFd = 10;
  const fileStat = file => ({ ...metadata(file.ino, BigInt(file.bytes.length)), ...file.changed,
    isFile: () => !options.nonRegular, isDirectory: () => false, isSymbolicLink: () => !!options.fileSymlink });
  return { files, dirs, calls, descriptor, token, api: {
    openSync(name, flags) {
      calls.push({ op: "open", name, flags });
      if (options.missing) throw Object.assign(new Error("synthetic missing"), { code: "ENOENT" });
      const file = files.get(name);
      assert.ok(file, "only the synthetic control descriptor/ticket may be opened");
      const fd = nextFd++; handles.set(fd, file); return fd;
    },
    fstatSync(fd, opts) { assert.deepEqual(opts, { bigint: true }); calls.push({ op: "fstat" }); return fileStat(handles.get(fd)); },
    lstatSync(name, opts) {
      assert.deepEqual(opts, { bigint: true }); calls.push({ op: "lstat", name });
      const file = files.get(name);
      if (file) {
        const stat = fileStat(file);
        return options.nameReplaced ? { ...stat, ino: stat.ino + 1n } : stat;
      }
      assert.ok(dirs.has(name), "only the exact synthetic parent directories may be checked");
      return { ...dirs.get(name), isFile: () => false, isDirectory: () => true, isSymbolicLink: () => !!options.directorySymlink };
    },
    realpathSync(name) { assert.ok(dirs.has(name)); return options.realpathChanged ? `${name}-other` : name; },
    readSync(fd, buffer, offset, length, position) {
      const file = handles.get(fd); calls.push({ op: "read", position, length });
      options.onRead?.(file, files, dirs);
      const count = Math.min(length, options.chunkSize ?? length, Math.max(0, file.bytes.length - position));
      file.bytes.copy(buffer, offset, position, position + count); return count;
    },
    closeSync(fd) { calls.push({ op: "close" }); assert.ok(handles.delete(fd)); },
  } };
}

function officeFixture(options = {}) {
  const filesystem = memoryFiles(options.files);
  const state = { calls: [], progress: [], tasks: new Map(), sessions: [], statusCalls: 0, getCalls: 0, account: "synthetic-user-A" };
  const status = () => ({ protocol: "qwenwork.desktop.v1", backend: "desktop", app: { name: "QwenWorkCN", version: "1.3.0", packaged: true },
    authenticated: options.signedOut ? false : true, user: options.signedOut ? null : { user_id: state.account,
      display_name: "SYNTHETIC_ACCOUNT_SECRET", username: "SYNTHETIC_ACCOUNT_SECRET" },
    features: { model_selection: true, permission_selection: true, task_execution: true, session_history: true,
      task_events: true, single_action_response: true, artifact_download: true } });
  const taskView = task => ({ backend: "desktop", task_id: task.id, session_id: task.session, turn_id: task.turn,
    status: task.status, terminal: !["starting", "running", "waiting_for_input"].includes(task.status), created_at: "2026-10-12T00:00:00.000Z",
    last_sequence: task.sequence, actions: task.status === "waiting_for_input" ? [{ action_id: "synthetic-permission", kind: "permission",
      tool_name: "SYNTHETIC_PRIVATE_TOOL", input: { private: "SYNTHETIC_TOOL_INPUT_SECRET" }, decisions: ["approve", "deny"] }] : [],
    ...(task.status === "completed" ? { answer: options.text ?? "Office connection ok.", answer_is_final: true,
      answer_may_be_truncated: false } : {}), retention: "desktop_instance_bounded" });
  const reply = (data, error) => new Response(JSON.stringify({ schema_version: "qwenwork.response.v1", ok: !error,
    data: error ? null : data, error: error ? { code: error, message: "SYNTHETIC_PROVIDER_TOKEN_SECRET", retryable: false } : null }), {
    status: error ? 400 : 200, headers: { "content-type": "application/json; charset=utf-8", "x-qwenwork-instance": INSTANCE },
  });
  const fetchImpl = async (url, init) => {
    assert.equal(url, "http://127.0.0.1:31337/v1/control");
    assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
    assert.deepEqual(Object.keys(init.headers).sort(), ["authorization", "content-type"]);
    assert.equal(init.headers.authorization, `Bearer ${TICKET}`);
    if (init.signal.aborted) throw new DOMException("synthetic aborted", "AbortError");
    const request = JSON.parse(init.body);
    assert.equal(request.schema_version, "qwenwork.desktop-request.v1");
    assert.deepEqual(Object.keys(request).sort(), ["method", "params", "schema_version"]);
    state.calls.push(request);
    options.beforeRequest?.(request, state, filesystem);
    if (options.respond) {
      const custom = await options.respond(request, state, { reply, taskView, status, signal: init.signal });
      if (custom !== undefined) return custom;
    }
    let data;
    switch (request.method) {
      case "desktop.status": state.statusCalls++; data = status(); break;
      case "model.list": data = { backend: "desktop", models: [
        { key: "qwen-office-default", display_name: "Office default", enabled: true, source: "catalog" },
        { key: "disabled-model", display_name: "Disabled", enabled: false, source: "catalog" },
      ] }; break;
      case "model.get": data = { backend: "desktop", scope: request.params.scope, session_id: request.params.session_id ?? null,
        model: "qwen-office-default", inherited: request.params.scope === "session" }; break;
      case "model.set": assert.equal(request.params.scope, "session"); data = { backend: "desktop", scope: "session", session_id: request.params.session_id,
        model: request.params.model, inherited: false, applies: "next_model_policy", runtime_execution_verified: false }; break;
      case "session.create": {
        assert.deepEqual(Object.keys(request.params).sort(), ["title", "workspace_mode"]);
        assert.equal(request.params.workspace_mode, "general");
        const id = `roleweave-session-${state.sessions.length + 1}`; state.sessions.push(id);
        data = { backend: "desktop", session_id: id, chat_id: `chat-${state.sessions.length}`, title: request.params.title,
          model: null, workspace: "C:/synthetic-office-workspace", output_directory: null }; break;
      }
      case "task.submit": {
        assert.ok(state.sessions.includes(request.params.session_id));
        assert.notEqual(request.params.request_id, OTHER_TASK);
        assert.deepEqual(Object.keys(request.params).sort(), ["prompt", "request_id", "session_id"]);
        const task = { id: request.params.request_id, session: request.params.session_id, turn: "own-turn-1",
          status: options.initialStatus ?? "running", sequence: 1 };
        state.tasks.set(task.id, task); data = taskView(task);
        if (options.lostSubmitResponse) throw new Error("SYNTHETIC_TRANSPORT_SECRET");
        break;
      }
      case "task.get": {
        const task = state.tasks.get(request.params.task_id);
        assert.ok(task, "client must only retrieve its exact submitted task");
        state.getCalls++;
        if (!options.neverComplete) { task.status = "completed"; task.sequence = Math.max(task.sequence, 2); }
        data = taskView(task); break;
      }
      case "task.result": data = taskView(state.tasks.get(request.params.task_id)); break;
      case "task.events": {
        assert.equal(request.params.limit, 1);
        const task = state.tasks.get(request.params.task_id);
        assert.ok(task);
        const sequence = Math.min(request.params.after + 1, task.sequence);
        data = { ...taskView(task), events: sequence > request.params.after ? [{ sequence, event: { type: "assistant.delta",
          delta: "SYNTHETIC_EVENT_CONTENT_SECRET", private: "SYNTHETIC_EVENT_CONTENT_SECRET" } }] : [],
        next_cursor: sequence, has_more: sequence < task.sequence }; break;
      }
      case "task.cancel": {
        const task = state.tasks.get(request.params.task_id);
        assert.ok(task, "cancellation cannot target a user or another integration task");
        task.status = "cancelled"; task.sequence++;
        data = { ...taskView(task), cancelled: true }; break;
      }
      default: throw new Error(`Unexpected Office method: ${request.method}`);
    }
    return reply(data);
  };
  const client = createQwenOfficeClient({ platform: "win32", userDataDir: USER_DATA, fileSystem: filesystem.api,
    fetchImpl, pollIntervalMs: 1, timeoutMs: options.timeoutMs ?? 1000, httpTimeoutMs: options.httpTimeoutMs ?? 1000 });
  const complete = (extra = {}, requestOptions = {}) => client({ operation: "complete", payload: {
    input: "Reply only Office connection ok.", sessionKey: KEY, employeeLabel: "Office assistant", ...extra } }, requestOptions);
  return { client, complete, state, filesystem, reply, taskView };
}

test("probe returns only non-sensitive native readiness metadata", async () => {
  const fixture = officeFixture();
  const result = await fixture.client({ operation: "probe" });
  assert.deepEqual(result, { configured: true, code: "qwen_office.ready", version: "1.3.0" });
  assert.deepEqual(fixture.state.calls.map(call => call.method), ["desktop.status"]);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-user|ACCOUNT_SECRET|Bearer|token/i);
});

test("catalog uses the actual Office model selection and filters disabled models", async () => {
  const fixture = officeFixture();
  assert.deepEqual(await fixture.client({ operation: "catalog" }), {
    models: [{ id: "qwen-office-default", name: "Office default" }], defaultModel: "qwen-office-default",
  });
  assert.deepEqual(fixture.state.calls.find(call => call.method === "model.get").params, { scope: "default" });
  assert.ok(!fixture.state.calls.some(call => call.method === "model.set"));
});

test("a native turn creates a dedicated session, reconciles the precise result, and invents no usage", async () => {
  const fixture = officeFixture();
  const result = await fixture.complete({}, { onProgress: progress => fixture.state.progress.push(progress) });
  assert.deepEqual(result, { text: "Office connection ok.", model: "qwen-office-default" });
  const submit = fixture.state.calls.find(call => call.method === "task.submit");
  const resultCall = fixture.state.calls.find(call => call.method === "task.result");
  assert.equal(resultCall.params.task_id, submit.params.request_id);
  assert.equal(submit.params.session_id, fixture.state.sessions[0]);
  assert.deepEqual(fixture.state.progress, [{ status: "running" }]);
  assert.ok(!fixture.state.calls.some(call => /permission\.set|action\.respond|session\.list|session\.history|artifact\./.test(call.method)));
  assert.doesNotMatch(JSON.stringify([result, fixture.state.progress]), /SYNTHETIC_|token|Bearer|workspace/i);
});

for (const [name, reflected] of [
  ["raw ticket", TICKET],
  ["Bearer header", `Authorization: Bearer ${TICKET}`],
  ["base64 ticket", Buffer.from(TICKET).toString("base64")],
  ["unpadded base64 ticket", Buffer.from(TICKET).toString("base64").replace(/=+$/, "")],
  ["base64 Bearer header", Buffer.from(`Authorization: Bearer ${TICKET}`).toString("base64")],
  ["URL-safe base64 JSON", Buffer.from(JSON.stringify({ authorization: `Bearer ${TICKET}` })).toString("base64url")],
]) test(`the actual native answer cannot reflect the known IPC ${name}`, async () => {
  const fixture = officeFixture({ text: `Native response: ${reflected}` });
  await assert.rejects(fixture.complete(), error => error.code === "qwen_office.credential_reflection"
    && error.message === error.code && !error.message.includes(TICKET));
  assert.equal(fixture.state.calls.filter(call => call.method === "task.submit").length, 1);
  assert.equal(fixture.state.calls.filter(call => call.method === "task.result").length, 1);
  assert.ok(!fixture.state.calls.some(call => call.method === "task.cancel"), "a completed native task does not need cancellation");
});

for (const [name, field, value] of [
  ["catalog ID", "key", TICKET],
  ["catalog display name", "display_name", `Bearer ${TICKET}`],
  ["encoded catalog display name", "display_name", Buffer.from(TICKET).toString("base64url")],
]) test(`the public ${name} cannot carry the native IPC credential`, async () => {
  const fixture = officeFixture({ respond(request, state, helpers) {
    if (request.method === "model.list") return helpers.reply({ backend: "desktop", models: [{
      key: "qwen-office-default", display_name: "Office default", enabled: true, source: "catalog", [field]: value,
    }] });
  } });
  await assert.rejects(fixture.client({ operation: "catalog" }), error => error.code === "qwen_office.credential_reflection"
    && error.message === error.code && !error.message.includes(TICKET));
  assert.equal(fixture.state.sessions.length, 0);
});

for (const operation of ["catalog", "complete"]) test(`the ${operation} model projection cannot return an encoded native IPC ticket`, async () => {
  const fixture = officeFixture({ respond(request, state, helpers) {
    if (request.method === "model.get") return helpers.reply({ backend: "desktop", scope: request.params.scope,
      session_id: request.params.session_id ?? null, model: Buffer.from(`Bearer ${TICKET}`).toString("base64"),
      inherited: request.params.scope === "session" });
  } });
  const result = operation === "complete" ? fixture.complete() : fixture.client({ operation });
  await assert.rejects(result, error => error.code === "qwen_office.credential_reflection" && error.message === error.code);
});

test("probe rejects a reflected credential in otherwise valid public version metadata", async () => {
  const fixture = officeFixture({ respond(request, state, helpers) {
    if (request.method === "desktop.status") {
      const data = helpers.status(); data.app.version = Buffer.from(TICKET).toString("base64");
      return helpers.reply(data);
    }
  } });
  assert.deepEqual(await fixture.client({ operation: "probe" }), { configured: false, code: "qwen_office.credential_reflection" });
});

test("ordinary long native text and unrelated encoded content remain available", async () => {
  const text = `A normal Office response. ${"z".repeat(300)} ${Buffer.from("public sample text").toString("base64")}`;
  const fixture = officeFixture({ text });
  assert.deepEqual(await fixture.complete(), { text, model: "qwen-office-default" });
});

test("separate RoleWeave turns always create different Office sessions; a reused run key cannot submit again", async () => {
  const fixture = officeFixture();
  await fixture.complete();
  await assert.rejects(fixture.complete(), { code: "qwen_office.session_key_reused" });
  await fixture.complete({ sessionKey: "c".repeat(64) });
  assert.equal(fixture.state.sessions.length, 2);
  assert.notEqual(fixture.state.sessions[0], fixture.state.sessions[1]);
  assert.equal(fixture.state.calls.filter(call => call.method === "task.submit").length, 2);
});

test("Office permission remains pending until the user confirms in Office; no action is automatically answered", async () => {
  const fixture = officeFixture({ initialStatus: "waiting_for_input" });
  const result = await fixture.complete({}, { onProgress: progress => fixture.state.progress.push(progress) });
  assert.equal(result.text, "Office connection ok.");
  assert.deepEqual(fixture.state.progress[0], { status: "waiting_for_input", actionKinds: ["permission"] });
  assert.ok(!fixture.state.calls.some(call => call.method === "action.respond"));
  assert.doesNotMatch(JSON.stringify(fixture.state.progress), /PRIVATE_TOOL|TOOL_INPUT_SECRET|permission.*approve|ACCOUNT_SECRET/);
});

test("abort cancels only the freshly submitted owned task, preserving an unrelated user turn", async () => {
  const controller = new AbortController(), fixture = officeFixture({ neverComplete: true });
  const result = fixture.complete({}, { signal: controller.signal, onProgress: () => controller.abort() });
  await assert.rejects(result, { code: "qwen_office.cancelled" });
  const submitted = fixture.state.calls.find(call => call.method === "task.submit").params.request_id;
  assert.deepEqual(fixture.state.calls.filter(call => call.method === "task.cancel").map(call => call.params), [{ task_id: submitted }]);
  assert.notEqual(submitted, OTHER_TASK);
});

test("deadline cancels the owned task and returns a stable redacted error", async () => {
  const fixture = officeFixture({ timeoutMs: 20, neverComplete: true });
  await assert.rejects(fixture.complete(), error => error.code === "qwen_office.deadline" && error.message === error.code);
  assert.equal(fixture.state.calls.filter(call => call.method === "task.cancel").length, 1);
});

test("a lost submit response is reconciled and cancelled by the original request ID without resubmitting", async () => {
  const fixture = officeFixture({ lostSubmitResponse: true, neverComplete: true });
  await assert.rejects(fixture.complete(), { code: "qwen_office.connection_failed" });
  const submits = fixture.state.calls.filter(call => call.method === "task.submit");
  assert.equal(submits.length, 1);
  assert.deepEqual(fixture.state.calls.find(call => call.method === "task.cancel").params, { task_id: submits[0].params.request_id });
});

test("account changes discard the old ownership and never cancel a task as the new account", async () => {
  const fixture = officeFixture({ neverComplete: true, beforeRequest(request, state) {
    if (request.method === "desktop.status" && state.tasks.size) state.account = "synthetic-user-B";
  } });
  await assert.rejects(fixture.complete(), { code: "qwen_office.account_changed" });
  assert.ok(!fixture.state.calls.some(call => call.method === "task.cancel"));
});

test("an account change during implicit model lookup stops before task submission or context transfer", async () => {
  const fixture = officeFixture({ beforeRequest(request, state) {
    if (request.method === "model.get" && request.params.scope === "session") state.account = "synthetic-user-B";
  } });
  await assert.rejects(fixture.complete(), { code: "qwen_office.account_changed" });
  assert.equal(fixture.state.sessions.length, 1);
  assert.ok(fixture.state.calls.some(call => call.method === "model.get"));
  assert.ok(!fixture.state.calls.some(call => call.method === "task.submit" || call.method === "task.cancel"));
  assert.equal(fixture.state.tasks.size, 0);
});

test("an account change during cancellation reconciliation prevents cancellation under the new account", async () => {
  const controller = new AbortController();
  const fixture = officeFixture({ neverComplete: true, beforeRequest(request, state) {
    if (request.method === "task.get") state.account = "synthetic-user-B";
  } });
  await assert.rejects(fixture.complete({}, { signal: controller.signal, onProgress: () => controller.abort() }), {
    code: "qwen_office.cancelled",
  });
  assert.ok(fixture.state.calls.some(call => call.method === "task.get"));
  assert.equal(fixture.state.calls.at(-1).method, "desktop.status");
  assert.ok(!fixture.state.calls.some(call => call.method === "task.cancel"));
});

test("endpoint/ticket revocation stops polling and never forwards the old ticket to a replacement endpoint", async () => {
  const fixture = officeFixture({ neverComplete: true, beforeRequest(request, state, files) {
    if (request.method === "task.submit") files.files.get(files.token).bytes = Buffer.from("d".repeat(64));
  } });
  await assert.rejects(fixture.complete(), { code: "qwen_office.instance_changed" });
  assert.ok(!fixture.state.calls.some(call => call.method === "task.cancel"));
});

test("task/session mismatch cannot become output or target an unrelated task for cancellation", async () => {
  const fixture = officeFixture({ neverComplete: true, respond(request, state, helpers) {
    if (request.method === "task.submit") {
      const task = { id: request.params.request_id, session: request.params.session_id, turn: "own-turn-1", status: "running", sequence: 1 };
      state.tasks.set(task.id, task);
      return helpers.reply({ ...helpers.taskView(task), task_id: OTHER_TASK });
    }
  } });
  await assert.rejects(fixture.complete(), { code: "qwen_office.response_invalid" });
  assert.ok(fixture.state.calls.filter(call => call.method === "task.cancel").every(call => call.params.task_id !== OTHER_TASK));
});

test("a changed native turn is rejected and cannot be cancelled as the original turn", async () => {
  const fixture = officeFixture({ neverComplete: true, beforeRequest(request, state) {
    if (request.method === "task.get") state.tasks.get(request.params.task_id).turn = "new-user-turn";
  } });
  await assert.rejects(fixture.complete(), { code: "qwen_office.task_changed" });
  assert.ok(!fixture.state.calls.some(call => call.method === "task.cancel"));
});

test("bounded event eviction is reconciled by task state, without exposing raw event content", async () => {
  const fixture = officeFixture({ respond(request, state, helpers) {
    if (request.method === "task.events") return helpers.reply(null, "EVENT_CURSOR_EXPIRED");
  } });
  assert.equal((await fixture.complete()).text, "Office connection ok.");
});

for (const [name, patch, expected] of [
  ["truncated result", { answer_may_be_truncated: true }, "output_truncated"],
  ["non-final result", { answer_is_final: false }, "empty_output"],
  ["empty result", { answer: " " }, "empty_output"],
  ["unrecognized result fields", { providerToken: "SYNTHETIC_PROVIDER_TOKEN_SECRET" }, "response_invalid"],
  ["oversized result", { answer: "x".repeat(256 * 1024 + 1) }, "response_invalid"],
]) test(`${name} cannot be reported as successful output`, async () => {
  const fixture = officeFixture({ respond(request, state, helpers) {
    if (request.method === "task.result") return helpers.reply({ ...helpers.taskView(state.tasks.get(request.params.task_id)), ...patch });
  } });
  await assert.rejects(fixture.complete(), error => error.code === `qwen_office.${expected}` && !error.message.includes("SYNTHETIC_"));
});

test("Office raw failures and transport errors never leak through the client", async () => {
  const fixture = officeFixture({ respond(request, state, helpers) {
    if (request.method === "session.create") return helpers.reply(null, "UNEXPECTED_PRIVATE_FAILURE");
  } });
  await assert.rejects(fixture.complete(), error => error.code === "qwen_office.client_failed" && error.message === error.code);
});

test("only session-scoped model selection is available; unknown models cannot start a task", async () => {
  const fixture = officeFixture();
  await fixture.complete({ model: "qwen-office-default" });
  assert.equal(fixture.state.calls.find(call => call.method === "model.set").params.scope, "session");
  const unknown = officeFixture();
  await assert.rejects(unknown.complete({ model: "not-in-catalog" }), { code: "qwen_office.model_unavailable" });
  assert.ok(!unknown.state.calls.some(call => call.method === "task.submit" || call.method === "model.set"));
});

for (const [name, options] of [
  ["missing endpoint", { missing: true }], ["file symlink", { fileSymlink: true }],
  ["directory symlink", { directorySymlink: true }], ["non-regular file", { nonRegular: true }],
  ["name substituted after open", { nameReplaced: true }],
  ["file grows during read", { onRead(file) { file.bytes = Buffer.concat([file.bytes, Buffer.from("x")]); } }],
  ["directory changes during read", { onRead(file, files, dirs) { const dir = dirs.get(USER_DATA); dir.ctimeNs++; } }],
]) test(`FD-first discovery rejects ${name} before any HTTP call`, async () => {
  const fixture = officeFixture({ files: options });
  const result = await fixture.client({ operation: "probe" });
  assert.equal(result.configured, false);
  assert.equal(result.code, name === "missing endpoint" ? "qwen_office.control_disabled" : "qwen_office.endpoint_invalid");
  assert.equal(fixture.state.calls.length, 0);
  assert.equal(fixture.filesystem.calls.filter(call => call.op === "open").length,
    fixture.filesystem.calls.filter(call => call.op === "close").length + (name === "missing endpoint" ? 1 : 0));
});

test("discovery starts with open/fstat and reads bounded fragmented bytes", async () => {
  const fixture = officeFixture({ files: { chunkSize: 7 } });
  assert.equal((await fixture.client({ operation: "probe" })).configured, true);
  assert.deepEqual(fixture.filesystem.calls.slice(0, 2).map(call => call.op), ["open", "fstat"]);
  assert.ok(fixture.filesystem.calls.filter(call => call.op === "read").every(call => call.length <= 4097));
  if (fs.constants.O_NOFOLLOW) assert.ok(fixture.filesystem.calls[0].flags & fs.constants.O_NOFOLLOW);
});

test("malformed endpoint cannot choose a remote origin, path, or token location", async () => {
  const fixture = officeFixture();
  fixture.filesystem.files.get(fixture.filesystem.descriptor).bytes = Buffer.from(JSON.stringify({
    protocol: "qwenwork.desktop.v1", port: 31337, instance_id: INSTANCE, url: "https://synthetic.invalid", tokenPath: "../other",
  }));
  assert.deepEqual(await fixture.client({ operation: "probe" }), { configured: false, code: "qwen_office.endpoint_invalid" });
  assert.equal(fixture.state.calls.length, 0);
});

test("response instance mismatch is rejected without accepting a stale server", async () => {
  const fixture = officeFixture({ respond(request, state, helpers) {
    const response = helpers.reply(helpers.status()); response.headers.set("x-qwenwork-instance", "e".repeat(32)); return response;
  } });
  assert.deepEqual(await fixture.client({ operation: "probe" }), { configured: false, code: "qwen_office.response_invalid" });
});

test("signed-out clients never create sessions and report honest readiness", async () => {
  const fixture = officeFixture({ signedOut: true });
  assert.deepEqual(await fixture.client({ operation: "probe" }), { configured: false, code: "qwen_office.client_signed_out" });
  assert.equal(fixture.state.sessions.length, 0);
});

test("unsupported platform and arbitrary methods/payload keys cannot contact Office", async () => {
  assert.deepEqual(await createQwenOfficeClient({ platform: "linux" })({ operation: "probe" }), {
    configured: false, code: "qwen_office.platform_unavailable",
  });
  const fixture = officeFixture();
  for (const request of [{ operation: "permission.set", payload: { mode: "full_access" } },
    { operation: "complete", payload: { input: "hello", sessionKey: KEY, taskId: OTHER_TASK } },
    { operation: "complete", payload: { input: "hello", sessionKey: "../escape" } },
    { operation: "catalog", payload: { token: TICKET } }]) {
    await assert.rejects(fixture.client(request), { code: "qwen_office.request_invalid" });
  }
  assert.equal(fixture.state.calls.length, 0);
});

test("already aborted calls neither read the local ticket nor contact Office", async () => {
  const controller = new AbortController(); controller.abort();
  const fixture = officeFixture();
  await assert.rejects(fixture.complete({}, { signal: controller.signal }), { code: "qwen_office.cancelled" });
  assert.equal(fixture.filesystem.calls.length, 0);
  assert.equal(fixture.state.calls.length, 0);
});

for (const [name, bytes, contentType, expected] of [
  ["invalid UTF-8", Buffer.from([0xff, 0xfe]), "application/json", "response_invalid"],
  ["non-JSON response", Buffer.from("SYNTHETIC_HTTP_ERROR_SECRET"), "text/plain", "response_invalid"],
  ["oversized body without a length header", Buffer.alloc(1024 * 1024 + 1, 32), "application/json", "response_too_large"],
]) test(`transport rejects ${name} without echoing response data`, async () => {
  const fixture = officeFixture({ respond() {
    return new Response(bytes, { headers: { "content-type": contentType, "x-qwenwork-instance": INSTANCE } });
  } });
  assert.deepEqual(await fixture.client({ operation: "probe" }), { configured: false, code: `qwen_office.${expected}` });
});

test("each HTTP request has its own shorter deadline even when the overall turn is still live", async () => {
  const fixture = officeFixture({ httpTimeoutMs: 15, respond(request, state, { signal }) {
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("SYNTHETIC_PRIVATE_TIMEOUT", "AbortError")), { once: true }));
  } });
  assert.deepEqual(await fixture.client({ operation: "probe" }), { configured: false, code: "qwen_office.request_deadline" });
  assert.equal(fixture.state.calls.length, 1);
});

test("a cursor that does not match its event cannot fabricate progress or successful output", async () => {
  const fixture = officeFixture({ neverComplete: true, respond(request, state, helpers) {
    if (request.method !== "task.events") return;
    const task = state.tasks.get(request.params.task_id);
    return helpers.reply({ ...helpers.taskView(task), events: [{ sequence: 1, event: { type: "assistant.delta" } }],
      next_cursor: 0, has_more: true });
  } });
  await assert.rejects(fixture.complete(), { code: "qwen_office.response_invalid" });
  assert.equal(fixture.state.calls.filter(call => call.method === "task.cancel").length, 1);
});

test("client capabilities must support native task observation before readiness is reported", async () => {
  const fixture = officeFixture({ respond(request, state, helpers) {
    const data = helpers.status(); data.features.task_events = false; return helpers.reply(data);
  } });
  assert.deepEqual(await fixture.client({ operation: "probe" }), { configured: false, code: "qwen_office.client_incompatible" });
});

test("a catalogue collected across an account switch cannot be returned as the current account's catalogue", async () => {
  const fixture = officeFixture({ beforeRequest(request, state) {
    if (request.method === "model.get") state.account = "synthetic-user-B";
  } });
  await assert.rejects(fixture.client({ operation: "catalog" }), { code: "qwen_office.account_changed" });
});

test("closing the broker waits for its precise native-task cancellation before the app can quit", async () => {
  let signalReady, cancelEntered, releaseCancellation;
  const ready = new Promise(resolve => { signalReady = resolve; });
  const cancelling = new Promise(resolve => { cancelEntered = resolve; });
  const release = new Promise(resolve => { releaseCancellation = resolve; });
  const fixture = officeFixture({ neverComplete: true, respond(request, state, helpers) {
    if (request.method !== "task.cancel") return;
    cancelEntered();
    return release.then(() => {
      const task = state.tasks.get(request.params.task_id);
      task.status = "cancelled"; task.sequence++;
      return helpers.reply({ ...helpers.taskView(task), cancelled: true });
    });
  } });
  const task = fixture.complete({}, { onProgress: signalReady }).catch(error => error);
  await ready;
  assert.equal(fixture.client.hasPending(), true);
  let closed = false;
  const closing = fixture.client.close().then(() => { closed = true; });
  await cancelling;
  assert.equal(closed, false, "Electron must retain the client while cancellation awaits its reply");
  await assert.rejects(fixture.client({ operation: "probe" }), { code: "qwen_office.client_closed" });
  releaseCancellation();
  await closing;
  assert.equal((await task).code, "qwen_office.cancelled");
  assert.equal(fixture.client.hasPending(), false);
  assert.equal(fixture.state.calls.filter(call => call.method === "task.cancel").length, 1);
  assert.ok(!fixture.state.calls.some(call => call.method === "action.respond"));
});

test("close is idempotent and refuses new work before reading account files", async () => {
  const fixture = officeFixture();
  const first = fixture.client.close();
  assert.equal(fixture.client.close(), first);
  await first;
  await assert.rejects(fixture.complete(), { code: "qwen_office.client_closed" });
  assert.equal(fixture.filesystem.calls.length, 0);
  assert.equal(fixture.state.calls.length, 0);
});

test("closing rejects a late fetch result without rereading the endpoint or reporting ready", async () => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const fixture = officeFixture({ respond(request, state, helpers) {
    entered();
    return response.then(() => helpers.reply(helpers.status()));
  } });
  const pending = fixture.client({ operation: "probe" });
  await ready;
  const closing = fixture.client.close();
  const readsAtClose = fixture.filesystem.calls.length;
  release();
  assert.deepEqual(await pending, { configured: false, code: "qwen_office.cancelled" });
  await closing;
  assert.equal(fixture.filesystem.calls.length, readsAtClose);
  assert.equal(fixture.state.calls.length, 1);
  assert.equal(fixture.client.hasPending(), false);
});

test("an uncooperative callback cannot prevent bounded application shutdown", async () => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const fixture = officeFixture({ respond() { entered(); return new Promise(() => {}); } });
  void fixture.client({ operation: "probe" });
  await ready;
  const started = performance.now();
  await fixture.client.close();
  assert.ok(performance.now() - started < 7000);
  await assert.rejects(fixture.client({ operation: "probe" }), { code: "qwen_office.client_closed" });
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConnectionStore, createServiceConnections, registerServiceIpc, normalizeConnection,
  safeServiceUrl, serviceWindowOptions, isSafeServiceNavigation, serviceLaunchUrl } = require("../src/service-connections.cjs");

const doc = { kind: "doc", apiUrl: "https://docs.example", token: "test-secret" };
const secure = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "test-keychain",
  encryptString: (value) => Buffer.from([...Buffer.from(value)].map((n) => n ^ 93)),
  decryptString: (value) => Buffer.from([...value].map((n) => n ^ 93)).toString(),
};
function tempStore(t, safeStorage = secure) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roleweave-services-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: createConnectionStore({ userDataPath: directory, safeStorage }) };
}
function managerFixture(initial = {}) {
  let disk = structuredClone(initial);
  const calls = [];
  let fail = false;
  const manager = createServiceConnections({
    store: { read: () => structuredClone(disk), write: (value) => { disk = structuredClone(value); } },
    apiRequest: async (url, request) => {
      calls.push({ url, request });
      if (fail) return { status: 503, body: { code: "unavailable" } };
      return { status: 200, body: { configured: true, connections: [] } };
    },
  });
  return { manager, calls, disk: () => disk, fail: (value) => { fail = value; } };
}

test("connection URLs support loopback and HTTPS base paths and reject unsafe schemes and credentials", () => {
  for (const value of ["https://example.com/doc/", "http://127.2.3.4:3100/", "http://[::1]:8080/", "http://localhost:3100/"]) {
    assert.equal(safeServiceUrl(value), value.replace(/\/+$/, ""));
  }
  for (const value of ["http://example.com", "file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com/?token=secret", "https://example.com/#token"]) {
    assert.throws(() => safeServiceUrl(value));
  }
  assert.throws(() => normalizeConnection({ ...doc, kind: "../../any" }));
  assert.throws(() => normalizeConnection({ ...doc, token: "a\nb" }));
  assert.throws(() => normalizeConnection({ ...doc, workspaceId: "not-a-uuid" }));
  assert.throws(() => normalizeConnection({ ...doc, arbitraryUrl: "https://evil.example" }));
});

test("only encrypted PATs are written; empty token and disconnected overrides survive restart", (t) => {
  const { store, directory } = tempStore(t);
  store.write({ doc, mem: null });
  const serialized = fs.readFileSync(path.join(directory, "service-connections.json"), "utf8");
  assert.ok(!serialized.includes("test-secret"));
  assert.ok(!serialized.includes('"token"'));
  assert.deepEqual(store.read(), { doc, mem: null });
  store.write({ doc: { ...doc, token: "" } });
  assert.equal(store.read().doc.token, "");
});

test("OS encryption unavailable or basic_text cannot persist a PAT or mutate existing data", (t) => {
  for (const backend of ["disabled", "basic_text"]) {
    const { store, directory } = tempStore(t, { ...secure,
      isEncryptionAvailable: () => backend !== "disabled", getSelectedStorageBackend: () => backend });
    assert.throws(() => store.write({ doc }), /service_storage_unavailable/);
    assert.equal(fs.existsSync(path.join(directory, "service-connections.json")), false);
    store.write({ doc: { ...doc, token: "" } });
    assert.equal(store.read().doc.token, "");
  }
});

test("startup restores saved credentials and a disconnected environment override", async () => {
  const fixture = managerFixture({ doc, mem: null });
  await fixture.manager.initialize();
  assert.deepEqual(fixture.calls, [
    { url: "/services/configure", request: { method: "PUT", body: doc } },
    { url: "/services/disconnect", request: { method: "POST", body: { kind: "mem" } } },
  ]);
});

test("failed restore is reported, then retried instead of silently exposing default connections", async () => {
  const fixture = managerFixture({ doc });
  fixture.fail(true); await fixture.manager.initialize();
  assert.equal((await fixture.manager.list()).body.code, "service_restore_unavailable");
  fixture.fail(false);
  assert.equal((await fixture.manager.list()).status, 200);
  assert.equal(fixture.calls.filter((entry) => entry.url === "/services/configure").length, 3);
});

test("recovery waits for an in-flight failed edit to roll back before reading its durable connection", async () => {
  let disk = { doc: { ...doc } };
  let runtime = { ...doc };
  let configureCalls = 0;
  let finishEdit;
  const manager = createServiceConnections({
    store: { read: () => structuredClone(disk), write: (value) => { disk = structuredClone(value); } },
    apiRequest: async (pathname, request) => {
      if (pathname === "/services/configure") {
        configureCalls++;
        if (configureCalls === 1) return { status: 503 };
        if (configureCalls === 2) return new Promise((resolve) => { finishEdit = resolve; });
        runtime = structuredClone(request.body);
        return { status: 200, body: { configured: true } };
      }
      return { status: 200, body: { connections: [{ ...runtime }] } };
    },
  });
  await manager.initialize();
  const save = manager.configure({ kind: "doc", apiUrl: "https://replacement.example", token: "replacement-token" });
  await Promise.resolve();
  assert.equal(disk.doc.apiUrl, "https://replacement.example", "the candidate is staged while configure is pending");
  const listing = manager.list();
  await Promise.resolve();
  assert.equal(configureCalls, 2, "recovery must not apply the staged candidate while its save is unresolved");
  finishEdit({ status: 503, body: { code: "unavailable" } });
  assert.equal((await save).status, 503);
  assert.deepEqual((await listing).body.connections, [doc]);
  assert.deepEqual(disk, { doc });
  assert.deepEqual(runtime, doc);
  assert.equal(configureCalls, 3, "recovery applies the rolled-back durable connection once");
});

test("same URL retains PAT, changing URL drops it, clearing and disconnecting are durable", async () => {
  const fixture = managerFixture({ doc });
  await fixture.manager.initialize();
  await fixture.manager.configure({ kind: "doc", apiUrl: doc.apiUrl, webUrl: "https://docs.example/work" });
  assert.equal(fixture.disk().doc.token, doc.token);
  await fixture.manager.configure({ kind: "doc", apiUrl: "https://other.example" });
  assert.equal(fixture.disk().doc.token, "");
  await fixture.manager.configure({ kind: "doc", apiUrl: "https://other.example", token: "new-token" });
  await fixture.manager.configure({ kind: "doc", apiUrl: "https://other.example", token: "" });
  assert.equal(fixture.disk().doc.token, "");
  await fixture.manager.disconnect("doc");
  assert.equal(fixture.disk().doc, null);
});

test("failed server configure rolls back persistence; storage refusal never configures runtime", async () => {
  const fixture = managerFixture({ doc });
  await fixture.manager.initialize(); fixture.fail(true);
  assert.equal((await fixture.manager.configure({ kind: "doc", apiUrl: "https://new.example" })).status, 503);
  assert.deepEqual(fixture.disk(), { doc });
  let called = false;
  const manager = createServiceConnections({ store: { read: () => ({}), write: () => { throw new Error("disk unavailable"); } },
    apiRequest: async () => { called = true; } });
  assert.equal((await manager.configure(doc)).body.code, "service_storage_unavailable");
  assert.equal(called, false);
});

test("service IPC rejects untrusted frames and invalid kinds without calling any service", async () => {
  const handlers = new Map(); let called = false;
  registerServiceIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, isTrusted: (event) => event.trusted,
    manager: { configure: () => { called = true; } }, BrowserWindow: null, shell: null });
  for (const handler of handlers.values()) assert.equal((await handler({ trusted: false }, "doc")).status, 403);
  assert.equal((await handlers.get("owb:services:probe")({ trusted: true }, "../admin")).status, 400);
  assert.equal(called, false);
});

test("Doc opens its workspace route under the API base unless a distinct web route is configured", () => {
  assert.equal(serviceLaunchUrl({ kind: "doc", apiUrl: "https://docs.example/" }), "https://docs.example/work");
  assert.equal(serviceLaunchUrl({ kind: "doc", apiUrl: "https://gateway.example/doc", webUrl: "https://gateway.example/doc/" }), "https://gateway.example/doc/work");
  assert.equal(serviceLaunchUrl({ kind: "doc", apiUrl: "https://docs.example", webUrl: "https://docs.example/zh-cn/work" }), "https://docs.example/zh-cn/work");
  assert.equal(serviceLaunchUrl({ kind: "doc", apiUrl: "https://docs.example", webUrl: "https://docs.example/work" }), "https://docs.example/work");
  assert.equal(serviceLaunchUrl({ kind: "mem", apiUrl: "http://localhost:8080" }), "http://localhost:8080");
  assert.equal(serviceLaunchUrl({ kind: "mem", apiUrl: "http://localhost:8787", webUrl: "http://localhost:3000" }), "http://localhost:3000");
});

test("native service windows have no Node/preload, isolated sessions, and safe navigation", async () => {
  const options = serviceWindowOptions("doc", "https://docs.example");
  assert.equal(options.webPreferences.preload, undefined);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.sandbox, true);
  assert.notEqual(options.webPreferences.partition, serviceWindowOptions("mem", "https://docs.example").webPreferences.partition);
  assert.notEqual(options.webPreferences.partition, serviceWindowOptions("doc", "https://other.example").webPreferences.partition);
  assert.equal(isSafeServiceNavigation("https://login.example/callback?code=abc"), true);
  assert.equal(isSafeServiceNavigation("file:///private"), false);
  assert.equal(isSafeServiceNavigation("http://remote.example"), false);
  const handlers = new Map(); const opened = []; const external = [];
  let popupHandler;
  class FakeWindow {
    constructor(configuration) { this.options = configuration; this.webContents = {
      on: () => {}, setWindowOpenHandler: (handler) => { popupHandler = handler; },
      session: { setPermissionRequestHandler: () => {} },
    }; }
    on() {} async loadURL(url) { opened.push(url); }
  }
  registerServiceIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, isTrusted: () => true,
    manager: { list: async () => ({ status: 200, body: { connections: [{ kind: "doc", configured: true, apiUrl: "https://docs.example", webUrl: "https://docs.example/work" }] } }) },
    BrowserWindow: FakeWindow, shell: { openExternal: async (url) => external.push(url) } });
  assert.equal((await handlers.get("owb:services:open")({}, "doc")).status, 200);
  assert.deepEqual(opened, ["https://docs.example/work"]);
  assert.deepEqual(popupHandler({ url: "javascript:alert(1)" }), { action: "deny" });
  assert.equal(external.length, 0);
  assert.deepEqual(popupHandler({ url: "https://docs.example/help" }), { action: "deny" });
  assert.deepEqual(external, ["https://docs.example/help"]);
});

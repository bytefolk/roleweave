const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { PassThrough } = require("node:stream");
const { createCipheriv, createDecipheriv, randomBytes, createHash } = require("node:crypto");
const test = require("node:test");
const vm = require("node:vm");
const { createCredentialStore, registerSettingsIpc, KEYS, validValue, forwardCredentialSafeStderr } = require("../src/credential-settings.cjs");
const { createControlPlaneChild, engineRuntimeEnvironment, wslLaunchSpec } = require("../src/control-plane-launch.cjs");
const { parseConfiguration, serverEnvironment } = require("../src/wsl-bootstrap.cjs");

const TOKEN = "test-secret-token-only-220-abcd";
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-credentials-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = randomBytes(32);
  let decrypts = 0;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test-keychain",
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      decrypts += 1;
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
  const store = () => createCredentialStore({ userDataPath: root, safeStorage });
  return { root, safeStorage, store, file: path.join(root, "host-credentials.json"), decrypts: () => decrypts };
}

test("ciphertext survives a new store; get returns only status and last four; clear removes it", (t) => {
  const h = setup(t);
  const logs = [];
  for (const name of ["log", "warn", "error"]) t.mock.method(console, name, (...args) => logs.push(args));
  assert.equal(h.store().get().credentials.every((entry) => !entry.configured && entry.last4 === null), true);
  assert.deepEqual(h.store().set("QODER_PERSONAL_ACCESS_TOKEN", TOKEN), { ok: true });
  const disk = fs.readFileSync(h.file, "utf8");
  assert.equal(disk.includes(TOKEN), false);
  assert.equal(disk.includes("abcd"), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
  const snapshot = h.store().get();
  assert.deepEqual(snapshot.credentials[0], { key: "QODER_PERSONAL_ACCESS_TOKEN", configured: true, last4: "abcd" });
  assert.equal(JSON.stringify(snapshot).includes(TOKEN), false);
  assert.deepEqual(h.store().clear("QODER_PERSONAL_ACCESS_TOKEN"), { ok: true });
  assert.equal(h.store().get().credentials[0].configured, false);
  assert.equal(h.store().environment({}).QODER_PERSONAL_ACCESS_TOKEN, undefined);
  assert.deepEqual(logs, []);
  assert.deepEqual(fs.readdirSync(h.root), ["host-credentials.json"]);
});

test("no stored credentials leaves spawn env unchanged without touching safeStorage", (t) => {
  const h = setup(t);
  h.safeStorage.isEncryptionAvailable = () => { throw new Error("should not be used"); };
  const source = Object.freeze({ PATH: "/operator/bin", ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI: "pinned-cli", ANTHROPIC_API_KEY: "operator" });
  assert.deepEqual(h.store().environment(source), source);
  assert.equal(fs.existsSync(h.file), false);
  assert.equal(h.decrypts(), 0);
});

test("saved keys are injected into a real control-plane child only, without argv or parent mutations", async (t) => {
  const h = setup(t);
  assert.equal(h.store().set("QODER_PERSONAL_ACCESS_TOKEN", TOKEN).ok, true);
  const fixture = path.join(h.root, "child.cjs");
  fs.writeFileSync(fixture, `const { createHash } = require('node:crypto'); process.stdout.write(JSON.stringify({ digest: createHash('sha256').update(process.env.QODER_PERSONAL_ACCESS_TOKEN).digest('hex'), engine: process.env.ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI, runAsNode: process.env.ELECTRON_RUN_AS_NODE, argv: process.argv }));`);
  const source = Object.freeze({ PATH: process.env.PATH, ...engineRuntimeEnvironment({}, "bundled-adapter") });
  const parent = process.env.QODER_PERSONAL_ACCESS_TOKEN;
  const child = createControlPlaneChild({ serverEntry: fixture, env: h.store().environment(source) });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  const result = JSON.parse(output);
  assert.equal(result.digest, createHash("sha256").update(TOKEN).digest("hex"));
  assert.equal(result.engine, "bundled-adapter");
  assert.equal(result.runAsNode, "1");
  assert.equal(JSON.stringify(result.argv).includes(TOKEN), false);
  assert.equal((output + errors).includes(TOKEN), false);
  assert.equal(source.QODER_PERSONAL_ACCESS_TOKEN, undefined);
  assert.equal(process.env.QODER_PERSONAL_ACCESS_TOKEN, parent);
});

test("environment connections and explicit empty values win as a unit; CLI pins remain unchanged", (t) => {
  const h = setup(t);
  h.store().set("ANTHROPIC_API_KEY", TOKEN);
  h.store().set("ANTHROPIC_BASE_URL", "https://saved.example/v1");
  h.store().set("OPENAI_API_KEY", TOKEN);
  const source = Object.freeze({ ANTHROPIC_API_KEY: "operator-token", OPENAI_API_KEY: "", ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI: "/pinned/cli" });
  assert.deepEqual(h.store().environment(source), source);
  assert.equal(h.store().environment({ ANTHROPIC_BASE_URL: "https://operator.example" }).ANTHROPIC_API_KEY, undefined);
  assert.equal(h.store().environment({}).ANTHROPIC_API_KEY, TOKEN);
  assert.equal(h.store().environment({}).ANTHROPIC_BASE_URL, "https://saved.example/v1");
  assert.equal(h.store().set("ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI", TOKEN).ok, false);
});

test("WSL transports stored credentials over stdin, preserving connection isolation and no secret argv", (t) => {
  const h = setup(t);
  h.store().set("OPENAI_API_KEY", TOKEN);
  h.store().set("GEMINI_API_KEY", `${TOKEN}-gemini`);
  const env = h.store().environment({ ROLEWEAVE_WSL_DISTRO: "Ubuntu-22.04" });
  const spec = wslLaunchSpec({ serverEntry: "C:\\app\\server.js", bootstrapEntry: "C:\\app\\wsl-bootstrap.cjs", env });
  assert.equal(spec.args.join(" ").includes(TOKEN), false);
  const actual = serverEnvironment(parseConfiguration(spec.input), {
    HOME: "/home/test",
    OPENAI_BASE_URL: "https://other-provider.example",
    GOOGLE_GEMINI_BASE_URL: "https://other-gemini.example",
  }, "/usr/bin/node");
  assert.equal(actual.OPENAI_API_KEY, TOKEN);
  assert.equal(actual.OPENAI_BASE_URL, undefined);
  assert.equal(actual.GEMINI_API_KEY, `${TOKEN}-gemini`);
  assert.equal(actual.GOOGLE_GEMINI_BASE_URL, undefined);
});

test("Windows environment matching is case-insensitive and does not add a duplicate key", (t) => {
  const h = setup(t);
  h.store().set("OPENAI_API_KEY", TOKEN);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  const source = { OpenAI_Api_Key: "operator-key" };
  assert.deepEqual(h.store().environment(source), source);
});

test("oversized encryption output fails before replacing a readable store", (t) => {
  const h = setup(t);
  h.store().set("OPENAI_API_KEY", TOKEN);
  const before = fs.readFileSync(h.file, "utf8");
  h.safeStorage.encryptString = () => Buffer.alloc(128 * 1024);
  assert.deepEqual(h.store().set("ANTHROPIC_API_KEY", TOKEN), { ok: false, code: "storage_unavailable" });
  assert.equal(fs.readFileSync(h.file, "utf8"), before);
  assert.equal(h.store().get().ok, true);
});

test("unavailable/basic_text storage, crypto failures and corrupt files produce only fixed errors", (t) => {
  const h = setup(t);
  for (const backend of ["basic_text", "unavailable"]) {
    h.safeStorage.getSelectedStorageBackend = () => backend;
    h.safeStorage.isEncryptionAvailable = () => backend !== "unavailable";
    assert.equal(h.store().get().storageAvailable, false);
    assert.deepEqual(h.store().set("OPENAI_API_KEY", TOKEN), { ok: false, code: "storage_unavailable" });
    assert.equal(fs.existsSync(h.file), false);
  }
  h.safeStorage.isEncryptionAvailable = () => true;
  h.safeStorage.getSelectedStorageBackend = () => "test-keychain";
  h.store().set("OPENAI_API_KEY", TOKEN);
  const before = fs.readFileSync(h.file, "utf8");
  h.safeStorage.decryptString = () => { throw new Error(TOKEN); };
  assert.deepEqual(h.store().get(), { ok: false, code: "storage_unavailable" });
  assert.throws(() => h.store().environment({}), { message: "Credential storage unavailable" });
  assert.equal(h.store().set("ANTHROPIC_API_KEY", TOKEN).ok, false);
  assert.equal(fs.readFileSync(h.file, "utf8"), before);
  fs.writeFileSync(h.file, `{broken-${TOKEN}`);
  assert.deepEqual(h.store().get(), { ok: false, code: "storage_unavailable" });
  assert.equal(h.store().clear("OPENAI_API_KEY").ok, false);
  assert.equal(fs.readFileSync(h.file, "utf8"), `{broken-${TOKEN}`);
});

test("fixed field/value validation never echoes input and never persists invalid requests", (t) => {
  const h = setup(t);
  for (const value of ["", "abcd", "with space", "newline\nsecret", "nul\0secret", "x".repeat(8193), null, {}]) {
    assert.deepEqual(h.store().set("OPENAI_API_KEY", value), { ok: false, code: "invalid_value" });
  }
  for (const value of ["invalid", "http://remote.example", "https://user:secret@example.com", "https://example.com?key=secret", "https://example.com/#secret"]) {
    assert.equal(validValue("OPENAI_BASE_URL", value), false);
  }
  for (const value of ["https://provider.example/v1", "http://127.0.0.1:8080/v1", "http://[::1]:8080", "http://localhost:8080"]) {
    assert.equal(validValue("OPENAI_BASE_URL", value), true);
  }
  assert.equal(h.store().clear("__proto__").ok, false);
  assert.equal(fs.existsSync(h.file), false);
});

test("trusted, enumerated IPC and preload expose write-only values and redacted reads", async (t) => {
  const h = setup(t);
  const handlers = new Map();
  registerSettingsIpc({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, getStore: h.store, isTrusted: (event) => event.trusted });
  assert.deepEqual([...handlers.keys()], ["owb:settings:get", "owb:settings:set", "owb:settings:clear"]);
  for (const handler of handlers.values()) assert.deepEqual(handler({ trusted: false }, TOKEN), { ok: false, code: "untrusted_sender" });
  assert.deepEqual(handlers.get("owb:settings:get")({ trusted: true }, TOKEN), { ok: false, code: "invalid_value" });
  assert.equal(handlers.get("owb:settings:set")({ trusted: true }, "OPENAI_API_KEY", TOKEN).ok, true);
  const snapshot = handlers.get("owb:settings:get")({ trusted: true });
  assert.equal(JSON.stringify(snapshot).includes(TOKEN), false);
  assert.equal(snapshot.credentials.length, KEYS.length);
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/preload.js"), "utf8"), {
    require: (id) => {
      assert.equal(id, "electron");
      return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
        ipcRenderer: { invoke: async (channel, ...args) => handlers.get(channel)({ trusted: true }, ...args) } };
    },
  });
  assert.deepEqual(Object.keys(bridge.settings), ["get", "set", "clear"]);
  assert.equal((await bridge.settings.set("ANTHROPIC_API_KEY", TOKEN)).ok, true);
  assert.equal(JSON.stringify(await bridge.settings.get()).includes(TOKEN), false);
  assert.equal((await bridge.settings.clear("ANTHROPIC_API_KEY")).ok, true);
});

test("stderr redaction spans every chunk boundary, redacts truncated prefixes, and preserves uncredentialed output", async () => {
  for (let split = 1; split < TOKEN.length; split += 1) {
    const stream = new PassThrough();
    let log = "";
    forwardCredentialSafeStderr(stream, { OPENAI_API_KEY: TOKEN }, (text) => { log += text; });
    stream.write(`error: ${TOKEN.slice(0, split)}`);
    stream.end(`${TOKEN.slice(split)}\n`);
    await once(stream, "end");
    assert.equal(log, "error: [REDACTED]\n");
  }
  const stream = new PassThrough();
  let log = "";
  forwardCredentialSafeStderr(stream, { OPENAI_API_KEY: TOKEN }, (text) => { log += text; });
  stream.end(`error: ${TOKEN.slice(0, 10)}`);
  await once(stream, "end");
  assert.equal(log, "error: [REDACTED]");
  const empty = new PassThrough();
  let original = "";
  forwardCredentialSafeStderr(empty, {}, (text) => { original += text; });
  empty.end("unchanged stderr\n");
  await once(empty, "end");
  assert.equal(original, "unchanged stderr\n");
});

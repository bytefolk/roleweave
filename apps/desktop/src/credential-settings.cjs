const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");

// A fixed allowlist: settings can never alter CLI pins, loaders or boot tokens.
const HOST_FIELDS = Object.freeze({
  qoder: ["QODER_PERSONAL_ACCESS_TOKEN"],
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
});
const KEYS = Object.freeze(Object.values(HOST_FIELDS).flat());
const MAX_FILE_BYTES = 128 * 1024;
const failure = (code) => ({ ok: false, code });

function validValue(key, value) {
  if (!KEYS.includes(key) || typeof value !== "string" || value.length > 8192 ||
      /[\s\x00-\x1f\x7f]/u.test(value)) return false;
  if (!key.endsWith("_BASE_URL")) return value.length >= 5;
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    const local = ["localhost", "[::1]"].includes(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    return !!url.hostname && (url.protocol === "https:" || (url.protocol === "http:" && local)) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** No plaintext cache or fallback. Even URLs are encrypted. Reads that fail
 * never silently replace the file with an empty store. All errors are bounded. */
function createCredentialStore({ userDataPath, safeStorage }) {
  const file = path.join(userDataPath, "host-credentials.json");
  function available() {
    try {
      return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
    } catch { return false; }
  }
  function read() {
    let raw;
    let handle;
    try {
      // Size-check and read the same descriptor so a concurrently replaced
      // path cannot bypass the bound between stat and read (TOCTOU).
      handle = fs.openSync(file, "r");
      if (fs.fstatSync(handle).size > MAX_FILE_BYTES) throw new Error();
      raw = fs.readFileSync(handle, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new Error("Credential storage unavailable");
    } finally {
      if (handle !== undefined) try { fs.closeSync(handle); } catch { /* fd already closed */ }
    }
    try {
      const payload = JSON.parse(raw);
      if (payload?.version !== 1 || Object.keys(payload).sort().join(",") !== "credentials,version" ||
          !payload.credentials || typeof payload.credentials !== "object" || Array.isArray(payload.credentials)) throw new Error();
      for (const [key, value] of Object.entries(payload.credentials)) {
        if (!KEYS.includes(key) || typeof value !== "string" || !value.length ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error();
      }
      return payload.credentials;
    } catch { throw new Error("Credential storage unavailable"); }
  }
  function decrypt(key, ciphertext) {
    try {
      if (!available()) throw new Error();
      const value = safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
      if (!validValue(key, value)) throw new Error();
      return value;
    } catch { throw new Error("Credential storage unavailable"); }
  }
  function write(credentials) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const payload = JSON.stringify({ version: 1, credentials });
      if (Buffer.byteLength(payload) > MAX_FILE_BYTES) throw new Error();
      fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, payload, { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, file);
    } catch { throw new Error("Credential storage unavailable"); }
    finally {
      try { fs.unlinkSync(temp); } catch { /* Only ciphertext can remain. */ }
    }
  }
  function get() {
    try {
      const entries = read();
      const credentials = KEYS.map((key) => ({
        key, configured: Object.hasOwn(entries, key),
        last4: Object.hasOwn(entries, key) ? decrypt(key, entries[key]).slice(-4) : null,
      }));
      return { ok: true, storageAvailable: available(), credentials };
    } catch { return failure("storage_unavailable"); }
  }
  function set(key, value) {
    if (!validValue(key, value)) return failure("invalid_value");
    try {
      if (!available()) throw new Error();
      const entries = read();
      // Verify existing ciphertext before preserving it during an edit.
      for (const [entryKey, ciphertext] of Object.entries(entries)) decrypt(entryKey, ciphertext);
      entries[key] = safeStorage.encryptString(value).toString("base64");
      write(entries);
      return { ok: true };
    } catch { return failure("storage_unavailable"); }
  }
  function clear(key) {
    if (!KEYS.includes(key)) return failure("invalid_value");
    try {
      const entries = read();
      if (Object.hasOwn(entries, key)) { delete entries[key]; write(entries); }
      return { ok: true };
    } catch { return failure("storage_unavailable"); }
  }
  function environment(source) {
    const entries = read();
    const result = { ...source };
    for (const [host, keys] of Object.entries(HOST_FIELDS)) {
      // Treat a provider connection as a unit: never send an inherited API key
      // to a saved endpoint, or a saved key to an inherited endpoint. Explicit
      // empty env values count as operator choices too. WSL keeps its existing
      // Windows connection / Linux connection isolation in wsl-bootstrap.cjs.
      const connectionKeys = host === "claude" ? [...keys, "ANTHROPIC_CUSTOM_HEADERS"] : keys;
      if (connectionKeys.some((key) => Object.keys(source).some((entry) =>
        (process.platform === "win32" ? entry.toUpperCase() === key : entry === key) && source[entry] !== undefined))) continue;
      for (const key of keys) {
        if (Object.hasOwn(entries, key)) result[key] = decrypt(key, entries[key]);
      }
    }
    return result;
  }
  return { get, set, clear, environment };
}

function registerSettingsIpc({ ipcMain, getStore, isTrusted }) {
  for (const operation of ["get", "set", "clear"]) {
    ipcMain.handle(`owb:settings:${operation}`, (event, ...args) => {
      try {
        if (!isTrusted(event)) return failure("untrusted_sender");
        if (args.length !== ({ get: 0, set: 2, clear: 1 })[operation]) return failure("invalid_value");
        return getStore()[operation](...args);
      } catch { return failure("storage_unavailable"); }
    });
  }
}

/** Hold only a possible secret prefix across chunks, so a split credential
 * cannot escape to the console. With no credentials, preserve the old stream. */
function forwardCredentialSafeStderr(stream, env, write) {
  const secrets = [...new Set(KEYS.map((key) => env[key]).filter((value) => typeof value === "string" && value.length > 0))]
    .sort((a, b) => b.length - a.length);
  if (!secrets.length) { stream.on("data", write); return; }
  const decoder = new StringDecoder("utf8");
  let pending = "";
  function consume(text, final = false) {
    pending += text;
    let output = "";
    let offset = 0;
    while (offset < pending.length) {
      const tail = pending.slice(offset);
      const match = secrets.find((secret) => tail.startsWith(secret));
      if (match) { output += "[REDACTED]"; offset += match.length; }
      else if (secrets.some((secret) => secret.startsWith(tail))) {
        if (final) { output += "[REDACTED]"; offset = pending.length; }
        break;
      } else { output += pending[offset]; offset += 1; }
    }
    pending = pending.slice(offset);
    if (output) write(output);
  }
  stream.on("data", (chunk) => consume(Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk)));
  stream.on("end", () => consume(decoder.end(), true));
}

module.exports = { HOST_FIELDS, KEYS, validValue, createCredentialStore, registerSettingsIpc, forwardCredentialSafeStderr };

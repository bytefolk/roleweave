const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_FILE_BYTES = 128 * 1024;
const MAX_SESSIONS = 50;
const MAX_URL_LENGTH = 2048;
const MAX_IDENTITY_LENGTH = 320;
const MAX_TOKEN_LENGTH = 8192;

function failure(code) { return { ok: false, code }; }

function isValidUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return !!url.hostname && (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username && !url.password && !url.hash;
  } catch { return false; }
}

function isValidProvider(value) {
  return value === "local" || value === "remote";
}

function isValidIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH &&
    !/[\x00-\x1f\x7f]/u.test(value);
}

function isValidToken(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH &&
    !/[\s\x00-\x1f\x7f]/u.test(value);
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.hash) return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch { return null; }
}

function createDeploymentSessionStore({ userDataPath, safeStorage }) {
  const file = path.join(userDataPath, "deployment-sessions.json");

  function available() {
    try {
      return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
    } catch { return false; }
  }

  function read() {
    let handle;
    try {
      handle = fs.openSync(file, "r");
      if (fs.fstatSync(handle).size > MAX_FILE_BYTES) throw new Error();
      const raw = fs.readFileSync(handle, "utf8");
      const payload = JSON.parse(raw);
      if (!payload || payload.version !== 1 || !Array.isArray(payload.sessions)) throw new Error();
      return payload.sessions;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("Deployment session storage unavailable");
    } finally {
      if (handle !== undefined) try { fs.closeSync(handle); } catch { /* fd already closed */ }
    }
  }

  function write(sessions) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const payload = JSON.stringify({ version: 1, sessions });
      if (Buffer.byteLength(payload) > MAX_FILE_BYTES) throw new Error();
      fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, payload, { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, file);
    } catch { throw new Error("Deployment session storage unavailable"); }
    finally {
      try { fs.unlinkSync(temp); } catch { /* Only ciphertext can remain. */ }
    }
  }

  function encryptToken(token) {
    if (!available()) throw new Error();
    return safeStorage.encryptString(token).toString("base64");
  }

  function decryptToken(ciphertext) {
    if (!available()) throw new Error();
    return safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
  }

  function save(session) {
    if (!session || typeof session !== "object") return failure("invalid_session");
    const { deploymentUrl, provider, accountIdentity, token, expiresAt } = session;
    const normalized = normalizeUrl(deploymentUrl);
    if (!normalized) return failure("invalid_url");
    if (!isValidProvider(provider)) return failure("invalid_provider");
    if (!isValidIdentity(accountIdentity)) return failure("invalid_identity");
    if (!isValidToken(token)) return failure("invalid_token");
    if (expiresAt !== null && (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))) return failure("invalid_expiry");
    try {
      if (!available()) return failure("storage_unavailable");
      const sessions = read();
      const encrypted = encryptToken(token);
      const createdAt = new Date().toISOString();
      const existing = sessions.findIndex((s) => s.deploymentUrl === normalized);
      const entry = { deploymentUrl: normalized, provider, accountIdentity, token: encrypted, expiresAt: expiresAt ?? null, createdAt };
      if (existing >= 0) sessions[existing] = entry;
      else sessions.push(entry);
      if (sessions.length > MAX_SESSIONS) return failure("too_many_sessions");
      write(sessions);
      return { ok: true };
    } catch { return failure("storage_unavailable"); }
  }

  function remove(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return failure("invalid_url");
    try {
      const sessions = read();
      const filtered = sessions.filter((s) => s.deploymentUrl !== normalized);
      if (filtered.length !== sessions.length) write(filtered);
      return { ok: true };
    } catch { return failure("storage_unavailable"); }
  }

  function list() {
    try {
      const sessions = read();
      return {
        ok: true,
        sessions: sessions.map((s) => ({
          deploymentUrl: s.deploymentUrl,
          provider: s.provider,
          accountIdentity: s.accountIdentity,
          expiresAt: s.expiresAt,
          createdAt: s.createdAt,
        })),
      };
    } catch { return failure("storage_unavailable"); }
  }

  function getToken(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return failure("invalid_url");
    try {
      const sessions = read();
      const session = sessions.find((s) => s.deploymentUrl === normalized);
      if (!session) return failure("not_found");
      const token = decryptToken(session.token);
      return { ok: true, token };
    } catch { return failure("storage_unavailable"); }
  }

  function clear() {
    try {
      write([]);
      return { ok: true };
    } catch { return failure("storage_unavailable"); }
  }

  return { save, remove, list, getToken, clear };
}

function registerDeploymentSessionIpc({ ipcMain, getStore, isTrusted }) {
  ipcMain.handle("owb:deploy-session:save", (event, session) => {
    try {
      if (!isTrusted(event)) return failure("untrusted_sender");
      return getStore().save(session);
    } catch { return failure("storage_unavailable"); }
  });
  ipcMain.handle("owb:deploy-session:remove", (event, url) => {
    try {
      if (!isTrusted(event)) return failure("untrusted_sender");
      return getStore().remove(url);
    } catch { return failure("storage_unavailable"); }
  });
  ipcMain.handle("owb:deploy-session:list", (event) => {
    try {
      if (!isTrusted(event)) return failure("untrusted_sender");
      return getStore().list();
    } catch { return failure("storage_unavailable"); }
  });
  ipcMain.handle("owb:deploy-session:clear", (event) => {
    try {
      if (!isTrusted(event)) return failure("untrusted_sender");
      return getStore().clear();
    } catch { return failure("storage_unavailable"); }
  });
}

module.exports = { createDeploymentSessionStore, registerDeploymentSessionIpc };

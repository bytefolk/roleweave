// Independent doc/mem services. Credentials live only in the main process and
// the authenticated local control plane; remote application windows get no IPC.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const KINDS = ["doc", "mem"];
const RELEASE_URLS = { doc: "https://github.com/bytefolk/doc", mem: "https://github.com/bytefolk/mem/releases" };
const failure = (status, code) => ({ status, body: { code, message: code, retryable: false } });
const validKind = (kind) => KINDS.includes(kind);

function safeServiceUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("service_url_invalid");
  const url = new URL(value);
  const local = ["localhost", "[::1]"].includes(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      url.username || url.password || url.search || url.hash) throw new Error("service_url_invalid");
  return url.href.replace(/\/+$/u, "");
}

function normalizeConnection(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !validKind(input.kind) ||
      Object.keys(input).some((key) => !["kind", "apiUrl", "webUrl", "token", "workspaceId"].includes(key))) {
    throw new Error("service_request_invalid");
  }
  const value = { kind: input.kind, apiUrl: safeServiceUrl(input.apiUrl) };
  if (input.webUrl !== undefined && input.webUrl !== "") value.webUrl = safeServiceUrl(input.webUrl);
  if (input.token !== undefined) {
    if (typeof input.token !== "string" || input.token.length > 8192 || /[\x00-\x20\x7f]/.test(input.token)) throw new Error("service_request_invalid");
    value.token = input.token;
  }
  if (input.workspaceId !== undefined && input.workspaceId !== "") {
    if (typeof input.workspaceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.workspaceId)) throw new Error("service_request_invalid");
    value.workspaceId = input.workspaceId;
  }
  return value;
}

function encryptionAvailable(safeStorage) {
  return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
}

/** Atomic, private file. A saved token can never fall back to plaintext, even
 * when Electron's Linux basic_text backend claims encryption is available. */
function createConnectionStore({ userDataPath, safeStorage }) {
  const file = path.join(userDataPath, "service-connections.json");
  function read() {
    if (!fs.existsSync(file)) return {};
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    if (payload.version !== 1 || !payload.connections || typeof payload.connections !== "object") throw new Error("service_storage_unavailable");
    const connections = {};
    for (const kind of KINDS) {
      const entry = payload.connections[kind];
      if (entry === null) { connections[kind] = null; continue; }
      if (!entry) continue;
      const { encryptedToken, token, ...fields } = entry;
      if (token !== undefined) throw new Error("service_storage_unavailable");
      if (encryptedToken && !encryptionAvailable(safeStorage)) throw new Error("service_storage_unavailable");
      connections[kind] = normalizeConnection({ ...fields, kind,
        ...(encryptedToken !== undefined ? { token: encryptedToken ? safeStorage.decryptString(Buffer.from(encryptedToken, "base64")) : "" } : {}) });
    }
    return connections;
  }
  function write(connections) {
    const entries = {};
    for (const kind of KINDS) {
      const entry = connections[kind];
      if (entry === null) { entries[kind] = null; continue; }
      if (!entry) continue;
      const { token, ...fields } = normalizeConnection(entry);
      if (token && !encryptionAvailable(safeStorage)) throw new Error("service_storage_unavailable");
      entries[kind] = { ...fields, ...(token !== undefined ? { encryptedToken: token ? safeStorage.encryptString(token).toString("base64") : "" } : {}) };
    }
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, connections: entries }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  return { read, write };
}

function createServiceConnections({ store, apiRequest }) {
  let saved = {};
  let storageError = false;
  let restoreError = false;
  // Recovery reads the durable file and writes runtime configuration too. Keep
  // it in the same queue as edits, so it cannot observe a staged connection
  // whose live configure request has not yet succeeded or rolled back.
  let pending = Promise.resolve();
  const serial = (action) => {
    const result = pending.then(action, action);
    pending = result.catch(() => {});
    return result;
  };
  async function initialize() {
    try { saved = store.read(); storageError = false; } catch { storageError = true; return; }
    restoreError = false;
    for (const kind of KINDS) {
      try {
        const response = saved[kind] === null
          ? await apiRequest("/services/disconnect", { method: "POST", body: { kind } })
          : saved[kind] ? await apiRequest("/services/configure", { method: "PUT", body: saved[kind] }) : null;
        if (response && (response.status < 200 || response.status >= 300)) restoreError = true;
      } catch { restoreError = true; }
    }
  }
  async function update(input, disconnect) {
    if (storageError) return failure(503, "service_storage_unavailable");
    let next;
    try { next = disconnect ? { kind: input.kind } : normalizeConnection(input); }
    catch { return failure(400, "service_request_invalid"); }
    if (!validKind(next.kind)) return failure(400, "service_request_invalid");
    if (!disconnect && next.token === undefined && saved[next.kind]?.apiUrl === next.apiUrl && saved[next.kind]?.token !== undefined) {
      next.token = saved[next.kind].token;
    }
    if (!disconnect && next.token === undefined && Object.hasOwn(saved, next.kind) && saved[next.kind]?.apiUrl !== next.apiUrl) {
      next.token = "";
    }
    const previous = saved;
    const candidate = { ...saved };
    if (disconnect) candidate[next.kind] = null;
    else candidate[next.kind] = next;
    // Persist before changing the live service. Failure cannot leave a token
    // working for this session while silently disappearing on restart.
    try { store.write(candidate); } catch { return failure(503, "service_storage_unavailable"); }
    let response;
    try {
      response = await apiRequest(disconnect ? "/services/disconnect" : "/services/configure", {
        method: disconnect ? "POST" : "PUT", body: next,
      });
    } catch { response = failure(503, "service_unavailable"); }
    if (response.status >= 200 && response.status < 300) saved = candidate;
    else {
      try { store.write(previous); } catch { storageError = true; return failure(503, "service_storage_unavailable"); }
    }
    return response;
  }
  return {
    initialize: () => serial(initialize),
    list: () => serial(async () => {
      if (storageError || restoreError) await initialize();
      if (storageError) return failure(503, "service_storage_unavailable");
      if (restoreError) return failure(503, "service_restore_unavailable");
      return apiRequest("/services");
    }),
    configure: (input) => serial(() => update(input, false)),
    disconnect: (kind) => serial(() => update({ kind }, true)),
    probe: (kind) => apiRequest(`/services/probe?kind=${kind}`),
    release: (kind) => apiRequest(`/services/release?kind=${kind}`),
  };
}

function serviceWindowOptions(kind, origin) {
  return {
    title: kind === "doc" ? "Doc · RoleWeave" : "Mem · RoleWeave",
    width: 1280, height: 900, minWidth: 720, minHeight: 520, autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      partition: `persist:roleweave-${kind}-${createHash("sha256").update(origin).digest("hex").slice(0, 16)}`,
      // Deliberately no preload: service pages must not inherit window.owb.
    },
  };
}

function isSafeServiceNavigation(value) {
  try {
    const url = new URL(value);
    // OAuth callbacks and document routes need query parameters and fragments.
    return !url.username && !url.password && (url.protocol === "https:" ||
      (url.protocol === "http:" && (["localhost", "[::1]"].includes(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname))));
  } catch { return false; }
}

function serviceLaunchUrl(connection) {
  const apiUrl = safeServiceUrl(connection.apiUrl);
  const webUrl = safeServiceUrl(connection.webUrl || apiUrl);
  // Doc's origin is its public landing page. Its /work route performs locale
  // selection; preserve any reverse-proxy base path and any explicit web route.
  return connection.kind === "doc" && webUrl === apiUrl ? `${apiUrl}/work` : webUrl;
}

function registerServiceIpc({ ipcMain, isTrusted, manager, BrowserWindow, shell }) {
  const windows = new Map();
  const register = (name, handler, needsKind = false) => ipcMain.handle(`owb:services:${name}`, async (event, request) => {
    if (!isTrusted(event)) return failure(403, "service_sender_untrusted");
    if (needsKind && !validKind(request)) return failure(400, "service_request_invalid");
    try { return await handler(request); }
    catch { return failure(503, "service_unavailable"); }
  });
  register("list", () => manager.list());
  register("configure", (request) => manager.configure(request));
  register("disconnect", (kind) => manager.disconnect(kind), true);
  register("probe", (kind) => manager.probe(kind), true);
  register("release", (kind) => manager.release(kind), true);
  register("open-release", async (kind) => {
    await shell.openExternal(RELEASE_URLS[kind]);
    return { status: 200, body: { opened: true } };
  }, true);
  register("open", async (kind) => {
    const response = await manager.list();
    if (response.status !== 200) return response;
    const connection = response.body.connections.find((entry) => entry.kind === kind && entry.configured);
    if (!connection) return failure(409, "service_unconfigured");
    const url = serviceLaunchUrl(connection);
    const key = `${kind}:${url}`;
    const existing = windows.get(key);
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return { status: 200, body: { opened: true } }; }
    const window = new BrowserWindow(serviceWindowOptions(kind, new URL(url).origin));
    windows.set(key, window);
    window.on("closed", () => windows.delete(key));
    window.webContents.on("will-navigate", (event, target) => { if (!isSafeServiceNavigation(target)) event.preventDefault(); });
    window.webContents.on("will-redirect", (event, target) => { if (!isSafeServiceNavigation(target)) event.preventDefault(); });
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      if (isSafeServiceNavigation(target)) void shell.openExternal(target).catch(() => {});
      return { action: "deny" };
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    try { await window.loadURL(url); }
    catch { windows.delete(key); window.close(); throw new Error("service_unavailable"); }
    return { status: 200, body: { opened: true } };
  }, true);
}

module.exports = { createConnectionStore, createServiceConnections, registerServiceIpc, normalizeConnection,
  safeServiceUrl, serviceWindowOptions, isSafeServiceNavigation, serviceLaunchUrl };

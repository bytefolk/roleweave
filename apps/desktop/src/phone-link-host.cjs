const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MAX_SUMMARY = 2000;

function loadWebSocket() {
  if (typeof WebSocket === "function") return WebSocket;
  const wsPath = path.join(__dirname, "..", "..", "..", "deploy", "node_modules", "ws");
  return require(wsPath).WebSocket;
}

function bind(socket, event, handler) {
  const wrapped = (...args) => {
    if (event === "message") {
      const raw = args[0] && args[0].data !== undefined ? args[0].data : args[0];
      handler({ data: raw });
      return;
    }
    handler(args[0]);
  };
  if (typeof socket.addEventListener === "function") socket.addEventListener(event, wrapped);
  else socket.on(event, wrapped);
}

function truncate(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  return text.length <= MAX_SUMMARY ? text : `${text.slice(0, MAX_SUMMARY - 1)}…`;
}

function summarizeTurn(record) {
  if (!record || typeof record !== "object") return "已完成";
  if (typeof record.output === "string") return truncate(record.output);
  if (record.output && typeof record.output === "object") {
    for (const key of ["text", "answer", "message", "content"]) {
      if (typeof record.output[key] === "string") return truncate(record.output[key]);
    }
  }
  const deltas = Array.isArray(record.events)
    ? record.events
        .filter((event) => event && event.type === "model.delta")
        .map((event) => event.text || event.delta || "")
        .join("")
    : "";
  if (deltas) return truncate(deltas);
  if (record.error && typeof record.error.message === "string") return truncate(record.error.message);
  return "已完成";
}

function firstReadyEngine(health) {
  const hosts = health && typeof health === "object" ? health.hosts : null;
  if (!hosts || typeof hosts !== "object") return null;
  const preferred = ["qoder", "claude-local", "claude-code", "codex-local", "codex", "workbuddy"];
  for (const id of preferred) {
    if (hosts[id] && hosts[id].ready === true) return id;
  }
  for (const [id, host] of Object.entries(hosts)) {
    if (host && host.ready === true) return id;
  }
  return null;
}

function firstPositionId(tree, preferred) {
  if (typeof preferred === "string" && preferred.trim()) return preferred.trim();
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return null;
    for (const node of nodes) {
      if (node && typeof node.id === "string") return node.id;
      const nested = walk(node && node.children);
      if (nested) return nested;
    }
    return null;
  };
  return walk(tree && tree.tree);
}

async function defaultLoadSnapshot(dir) {
  const url = pathToFileURL(path.join(__dirname, "..", "..", "..", "deploy", "mobile-surface.mjs")).href;
  const mod = await import(url);
  return mod.liveOrgSnapshot(mod.loadWorkspaceSnapshot(dir), dir);
}

async function collectLiveOrgSnapshot(apiRequest, loadSnapshot = defaultLoadSnapshot) {
  const workspace = await apiRequest("/workspace");
  if (workspace.status !== 200 || !workspace.body || workspace.body.open !== true) {
    return { open: false, source: "closed", name: "", description: "", owner: null, roles: [] };
  }
  const dir = workspace.body.path;
  if (typeof dir !== "string" || dir.length === 0) {
    return { open: false, source: "closed", name: "", description: "", owner: null, roles: [] };
  }
  try {
    const snapshot = await loadSnapshot(dir);
    const live = snapshot && snapshot.source === "live"
      ? snapshot
      : { ...snapshot, open: true, source: "live" };
    if (JSON.stringify(live).includes(dir)) {
      return { open: false, source: "closed", name: "", description: "", owner: null, roles: [] };
    }
    return live;
  } catch {
    return { open: false, source: "closed", name: "", description: "", owner: null, roles: [] };
  }
}

async function dispatchPhoneCommand(apiRequest, text, preferredPositionId) {
  const workspace = await apiRequest("/workspace");
  if (workspace.status !== 200 || !workspace.body || workspace.body.open !== true) {
    return { state: "failed", summary: "电脑上还没有打开工作区" };
  }
  const org = await apiRequest("/org/tree");
  const positionId = firstPositionId(org.body, preferredPositionId);
  if (!positionId) return { state: "failed", summary: "组织里没有可派发的员工" };
  const health = await apiRequest("/health", { withAuth: false });
  const engine = firstReadyEngine(health.body);
  if (!engine) return { state: "failed", summary: "本机 Agent 还没就绪" };
  const sessions = await apiRequest(`/sessions?positionId=${encodeURIComponent(positionId)}`);
  let sessionId = sessions.body && sessions.body.activeSessionId;
  if (!sessionId) {
    const created = await apiRequest("/sessions", { method: "POST", body: { positionId } });
    if (created.status !== 201 && created.status !== 200) {
      return { state: "failed", summary: created.body && created.body.message ? created.body.message : "无法创建会话" };
    }
    sessionId = created.body.sessionId;
  }
  const turn = await apiRequest(`/sessions/${sessionId}/turns`, {
    method: "POST",
    body: { input: text, engine },
  });
  if (turn.status === 409) return { state: "busy", summary: "该员工正在处理别的任务" };
  if (turn.status === 400 && turn.body && /approval/i.test(String(turn.body.message ?? ""))) {
    return { state: "needs_approval", summary: "请在电脑上确认这次操作" };
  }
  if (turn.status !== 200 && turn.status !== 201 && turn.status !== 202) {
    return { state: "failed", summary: turn.body && turn.body.message ? String(turn.body.message) : "回合没有启动" };
  }
  if (turn.body && turn.body.status === "failed") {
    return { state: "failed", summary: summarizeTurn(turn.body) };
  }
  return { state: "completed", summary: summarizeTurn(turn.body) };
}

function startPhoneLinkHost({
  port,
  hostToken,
  apiRequest,
  preferredPositionId,
  onPairCode,
  WebSocketImpl = loadWebSocket(),
} = {}) {
  if (!port || typeof hostToken !== "string" || !/^[a-f0-9]{64}$/.test(hostToken)) {
    return { stop() {} };
  }
  let socket = null;
  let stopped = false;
  let retryTimer = null;
  let orgTimer = null;

  const publishOrg = async () => {
    if (stopped || !socket) return;
    try {
      const snapshot = await collectLiveOrgSnapshot(apiRequest);
      if (stopped || !socket) return;
      socket.send(JSON.stringify({ v: 1, type: "org.snapshot", snapshot }));
    } catch {
      // A missed org refresh must not drop the command channel.
    }
  };

  const connect = () => {
    if (stopped) return;
    socket = new WebSocketImpl(`ws://127.0.0.1:${port}/phone-link/host`);
    bind(socket, "open", () => {
      socket.send(JSON.stringify({ v: 1, type: "host.hello", token: hostToken }));
    });
    bind(socket, "message", async (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "host.accepted") {
        socket.send(JSON.stringify({ v: 1, type: "pair.start" }));
        void publishOrg();
        if (orgTimer) clearInterval(orgTimer);
        orgTimer = setInterval(() => { void publishOrg(); }, 5000);
        return;
      }
      if (message.type === "pair.ready" && typeof onPairCode === "function") {
        onPairCode(message.code, message.expiresAt);
        return;
      }
      if (message.type !== "command.submit") return;
      socket.send(JSON.stringify({
        v: 1, type: "command.status", commandId: message.commandId,
        deviceId: message.deviceId, state: "running",
      }));
      let result;
      try {
        result = await dispatchPhoneCommand(
          apiRequest,
          message.text,
          message.positionId || preferredPositionId,
        );
      } catch (error) {
        result = { state: "failed", summary: error instanceof Error ? error.message : "dispatch failed" };
      }
      if (stopped || !socket) return;
      socket.send(JSON.stringify({
        v: 1, type: "command.status", commandId: message.commandId,
        deviceId: message.deviceId, state: result.state, summary: result.summary,
      }));
    });
    bind(socket, "close", () => {
      if (orgTimer) {
        clearInterval(orgTimer);
        orgTimer = null;
      }
      if (stopped) return;
      retryTimer = setTimeout(connect, 2000);
    });
    bind(socket, "error", () => {});
  };

  connect();
  return {
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (orgTimer) clearInterval(orgTimer);
      if (socket) socket.close();
    },
  };
}

function newCommandId() {
  return randomUUID();
}

module.exports = {
  dispatchPhoneCommand,
  collectLiveOrgSnapshot,
  summarizeTurn,
  firstReadyEngine,
  firstPositionId,
  startPhoneLinkHost,
  newCommandId,
};

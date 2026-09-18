const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const pairForm = document.getElementById("pair-form");
const claimForm = document.getElementById("claim-form");
const hostStatus = document.getElementById("host-status");
const commandForm = document.getElementById("command-form");
const storageKey = "roleweave-phone-link-v1";

let socket = null;
let deviceToken = localStorage.getItem(storageKey);

function setStatus(text) {
  statusEl.textContent = text;
}

function showSummary(text) {
  if (!text) {
    summaryEl.hidden = true;
    summaryEl.textContent = "";
    return;
  }
  summaryEl.hidden = false;
  summaryEl.textContent = text;
}

function connectedUi() {
  pairForm.hidden = true;
  claimForm.hidden = true;
  commandForm.hidden = false;
}

function disconnectedUi() {
  pairForm.hidden = false;
  claimForm.hidden = false;
  commandForm.hidden = true;
}

function connect() {
  if (!deviceToken) return;
  socket?.close();
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/phone-link/phone`;
  socket = new WebSocket(url);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ v: 1, type: "phone.hello", deviceToken }));
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.type === "phone.accepted") {
      connectedUi();
      setStatus("已连上电脑，可以发指令。");
      return;
    }
    if (message.type === "command.status") {
      const labels = {
        accepted: "电脑已接到",
        running: "员工正在处理",
        completed: "完成",
        failed: "失败",
        busy: "该员工正在忙",
        needs_approval: "请在电脑上确认",
      };
      setStatus(labels[message.state] ?? message.state);
      if (message.summary) showSummary(message.summary);
      return;
    }
    if (message.type === "error") {
      if (message.code === "unauthorized" || message.code === "revoked") {
        localStorage.removeItem(storageKey);
        deviceToken = null;
        disconnectedUi();
      }
      setStatus(message.message ?? "出错了");
    }
  });
  socket.addEventListener("close", () => {
    if (deviceToken) setStatus("连接断开，正在重试…");
  });
}

async function acceptGrant(body) {
  if (!body?.deviceToken) return false;
  deviceToken = body.deviceToken;
  localStorage.setItem(storageKey, deviceToken);
  connect();
  return true;
}

async function refreshHostStatus() {
  if (!hostStatus) return;
  try {
    const response = await fetch("/phone-link/v1/status", { headers: { accept: "application/json" } });
    const body = await response.json();
    hostStatus.textContent = body.hostOnline ? "电脑在线，可以连接。" : "电脑还没连上。先打开 RoleWeave 桌面。";
  } catch {
    hostStatus.textContent = "暂时读不到电脑状态。";
  }
}

claimForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("正在连接电脑…");
  const response = await fetch("/phone-link/v1/claim", { method: "POST" });
  const body = await response.json();
  if (!response.ok || !(await acceptGrant(body))) {
    setStatus(body.message ?? "连接失败");
  }
});

pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = document.getElementById("code").value.trim();
  setStatus("正在配对…");
  const response = await fetch("/phone-link/v1/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const body = await response.json();
  if (!response.ok || !(await acceptGrant(body))) {
    setStatus(body.message ?? "配对失败");
  }
});

commandForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = document.getElementById("text").value.trim();
  if (!text || !socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("还没连上电脑");
    return;
  }
  showSummary("");
  const commandId = crypto.randomUUID();
  socket.send(JSON.stringify({ v: 1, type: "command.submit", commandId, text }));
  setStatus("已发出，等电脑受理…");
});

if (deviceToken) connect();
void refreshHostStatus();
setInterval(() => { void refreshHostStatus(); }, 4000);

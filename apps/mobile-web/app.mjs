const workspaceName = document.getElementById("workspace-name");
const orgLead = document.getElementById("org-lead");
const roleList = document.getElementById("role-list");
const roleDetail = document.getElementById("role-detail");
const pairForm = document.getElementById("pair-form");
const commandForm = document.getElementById("command-form");
const commandStatus = document.getElementById("command-status");
const commandSummary = document.getElementById("command-summary");
const storageKey = "roleweave-phone-link-v1";

let socket = null;
let deviceToken = localStorage.getItem(storageKey);
let selectedRoleId = null;

function setCommandStatus(text) {
  commandStatus.textContent = text;
}

function showSummary(text) {
  if (!text) {
    commandSummary.hidden = true;
    commandSummary.textContent = "";
    return;
  }
  commandSummary.hidden = false;
  commandSummary.textContent = text;
}

function formatBudget(role) {
  const tokens = role.budget?.perTask?.tokens;
  return typeof tokens === "number" ? `每任务 ${tokens.toLocaleString("zh-CN")} tokens` : "预算未声明";
}

function renderDetail(role, names) {
  const reports = role.reportTo ? `汇报给 ${names.get(role.reportTo) ?? role.reportTo}` : "组织负责人";
  roleDetail.hidden = false;
  roleDetail.innerHTML = `
    <h2>${escapeHtml(role.name)}</h2>
    <p>${escapeHtml(role.description)}</p>
    <div class="meta">
      <span class="chip">${escapeHtml(reports)}</span>
      <span class="chip">${escapeHtml(formatBudget(role))}</span>
    </div>
    <pre>${escapeHtml(role.skillExcerpt || "这份岗位还没有说明书摘录。")}</pre>
    <button type="button" id="talk" data-tab-jump="command">去发指令</button>
  `;
  document.getElementById("talk")?.addEventListener("click", () => selectTab("command"));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderRoles(snapshot) {
  workspaceName.textContent = snapshot.name;
  orgLead.textContent = snapshot.description || "当前是示例组织的只读预览。选一个岗位，看说明书和预算。";
  const names = new Map(snapshot.roles.map((role) => [role.id, role.name]));
  roleList.replaceChildren();
  for (const role of snapshot.roles) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "role";
    button.innerHTML = `<strong>${escapeHtml(role.name)}</strong><span>${escapeHtml(role.description)}</span>`;
    button.addEventListener("click", () => {
      selectedRoleId = role.id;
      renderDetail(role, names);
      roleDetail.scrollIntoView({ block: "nearest" });
    });
    item.append(button);
    roleList.append(item);
  }
  const initial = snapshot.roles.find((role) => role.id === selectedRoleId) ?? snapshot.roles[0];
  if (initial) renderDetail(initial, names);
}

async function loadWorkspace() {
  try {
    const response = await fetch("/api/mobile/workspace", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("workspace unavailable");
    renderRoles(await response.json());
  } catch {
    orgLead.textContent = "组织预览暂时读不到。桌面工作台仍可用。";
    orgLead.classList.add("error");
  }
}

function selectTab(id) {
  for (const panel of document.querySelectorAll(".panel")) {
    const active = panel.dataset.panel === id;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  }
  for (const tab of document.querySelectorAll(".tab")) {
    const active = tab.dataset.tab === id;
    tab.classList.toggle("is-active", active);
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
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
      pairForm.hidden = true;
      commandForm.hidden = false;
      setCommandStatus("已连上电脑，可以发指令。");
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
      setCommandStatus(labels[message.state] ?? message.state);
      if (message.summary) showSummary(message.summary);
      return;
    }
    if (message.type === "error") {
      if (message.code === "unauthorized" || message.code === "revoked") {
        localStorage.removeItem(storageKey);
        deviceToken = null;
        pairForm.hidden = false;
        commandForm.hidden = true;
      }
      setCommandStatus(message.message ?? "出错了");
    }
  });
  socket.addEventListener("close", () => {
    if (deviceToken) setCommandStatus("连接断开，正在重试…");
  });
}

pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = document.getElementById("code").value.trim();
  setCommandStatus("正在配对…");
  const response = await fetch("/phone-link/v1/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const body = await response.json();
  if (!response.ok || !body.deviceToken) {
    setCommandStatus(body.message ?? "配对失败");
    return;
  }
  deviceToken = body.deviceToken;
  localStorage.setItem(storageKey, deviceToken);
  connect();
});

commandForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = document.getElementById("text").value.trim();
  if (!text || !socket || socket.readyState !== WebSocket.OPEN) {
    setCommandStatus("还没连上电脑");
    return;
  }
  showSummary("");
  const commandId = crypto.randomUUID();
  socket.send(JSON.stringify({ v: 1, type: "command.submit", commandId, text }));
  setCommandStatus("已发出，等电脑受理…");
});

document.querySelector(".tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (tab) selectTab(tab.dataset.tab);
});

if (deviceToken) connect();
void loadWorkspace();

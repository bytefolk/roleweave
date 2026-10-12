const COLORS = { idle: [114, 160, 118], running: [80, 140, 230], approval: [232, 180, 74], offline: [111, 116, 126], starting: [111, 116, 126] };

function trayStatus(connection, counts, chinese) {
  const zh = chinese;
  if (connection === "starting") return { state: "starting", label: zh ? "正在启动" : "Starting" };
  if (connection !== "ready" || !counts) return { state: "offline", label: zh ? "连接中断" : "Disconnected" };
  if (counts.pendingApprovals > 0) return { state: "approval", label: zh ? `${counts.pendingApprovals} 项待审批` : `${counts.pendingApprovals} awaiting approval` };
  if (counts.runningTurns > 0) return { state: "running", label: zh ? `${counts.runningTurns} 项任务执行中` : `${counts.runningTurns} tasks running` };
  return { state: "idle", label: zh ? "空闲" : "Idle" };
}

function validCounts(body) {
  return body && [body.runningTurns, body.pendingApprovals].every(value => Number.isSafeInteger(value) && value >= 0);
}

// Windows nativeImage bitmap bytes are BGRA. Keep the existing brand mark,
// adding one small static status dot instead of animating the OS tray.
function statusIcon({ nativeImage, iconPath, state, platform }) {
  const base = nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32 });
  if (base.isEmpty() || platform !== "win32") return base;
  const pixels = Buffer.from(base.toBitmap());
  const [red, green, blue] = COLORS[state] ?? COLORS.offline;
  for (let y = 20; y < 32; y++) for (let x = 20; x < 32; x++) {
    const distance = Math.hypot(x - 25.5, y - 25.5);
    if (distance > 5.5) continue;
    const offset = (y * 32 + x) * 4;
    const border = distance > 4;
    pixels[offset] = border ? 40 : blue;
    pixels[offset + 1] = border ? 40 : green;
    pixels[offset + 2] = border ? 40 : red;
    pixels[offset + 3] = 255;
  }
  return nativeImage.createFromBitmap(pixels, { width: 32, height: 32 });
}

function createStatusTray({ Tray, Menu, nativeImage, iconPath, platform, locale, requestStatus, onOpen, onQuit }) {
  const chinese = /^zh/i.test(locale);
  let connection = "starting";
  let counts = null;
  let disposed = false;
  let inFlight = false;
  let revision = 0;
  let rendered = "";
  let eventTimer = null;
  const tray = new Tray(statusIcon({ nativeImage, iconPath, platform, state: "starting" }));
  function render() {
    if (disposed) return;
    const status = trayStatus(connection, counts, chinese);
    const key = JSON.stringify([status, counts]);
    if (rendered === key) return;
    rendered = key;
    tray.setImage(statusIcon({ nativeImage, iconPath, platform, state: status.state }));
    tray.setToolTip(`RoleWeave · ${status.label}`);
    const known = connection === "ready" && counts;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `RoleWeave · ${status.label}`, enabled: false },
      ...(known ? [{ label: chinese ? `执行中 ${counts.runningTurns} · 待审批 ${counts.pendingApprovals}` : `Running ${counts.runningTurns} · Approvals ${counts.pendingApprovals}`, enabled: false }] : []),
      { type: "separator" },
      { label: chinese ? "打开 RoleWeave" : "Open RoleWeave", click: onOpen },
      { type: "separator" },
      { label: chinese ? "退出" : "Quit", click: onQuit },
    ]));
  }
  async function refresh() {
    if (disposed || inFlight || connection !== "ready") return;
    inFlight = true;
    const requestedRevision = revision;
    try {
      const response = await requestStatus();
      if (disposed || revision !== requestedRevision) return;
      counts = response.status === 200 && validCounts(response.body) ? response.body : null;
    } catch {
      if (!disposed && revision === requestedRevision) counts = null;
    } finally {
      inFlight = false;
      render();
    }
  }
  tray.on("click", onOpen);
  render();
  const timer = setInterval(() => void refresh(), 5000);
  timer.unref?.();
  return {
    setConnection(value) {
      if (connection !== value) { connection = value; counts = null; revision++; }
      render();
      void refresh();
    },
    onEvent(event) {
      // Public progress/terminal events only trigger a fresh authoritative
      // snapshot. Reconnects, failed spawns and workspace changes cannot leave
      // phantom work behind as they can with increment/decrement counters.
      if (!/^(turn\.(progress|started|completed|failed|indeterminate|approval\.)|approvals\.changed|org\.updated)/.test(event?.type ?? "")) return;
      if (disposed || eventTimer !== null) return;
      eventTimer = setTimeout(() => { eventTimer = null; void refresh(); }, 200);
      eventTimer.unref?.();
    },
    refresh,
    dispose() {
      disposed = true;
      revision++;
      clearInterval(timer);
      if (eventTimer !== null) clearTimeout(eventTimer);
      tray.destroy();
    },
  };
}

module.exports = { createStatusTray, trayStatus, validCounts, statusIcon };

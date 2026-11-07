const assert = require("node:assert/strict");
const test = require("node:test");
const { createStatusTray, trayStatus, validCounts } = require("../src/status-tray.cjs");

function fixture(requestStatus = async () => ({ status: 200, body: { runningTurns: 0, pendingApprovals: 0 } })) {
  const state = { destroyed: false, menu: [], tooltip: "", opens: 0, quits: 0, handlers: {} };
  const image = { resize() { return this; }, isEmpty: () => false };
  class Tray {
    setImage() {}
    setToolTip(text) { state.tooltip = text; }
    setContextMenu(menu) { state.menu = menu; }
    on(event, fn) { state.handlers[event] = fn; }
    destroy() { state.destroyed = true; }
  }
  const controller = createStatusTray({ Tray, Menu: { buildFromTemplate: value => value },
    nativeImage: { createFromPath: () => image }, iconPath: "brand.png", platform: "darwin", locale: "zh-CN",
    requestStatus, onOpen: () => state.opens++, onQuit: () => state.quits++ });
  return { state, controller };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("approval priority, task counts, and unknown status remain truthful", () => {
  assert.equal(trayStatus("ready", { runningTurns: 2, pendingApprovals: 1 }, true).label, "1 项待审批");
  assert.equal(trayStatus("ready", { runningTurns: 2, pendingApprovals: 0 }, true).label, "2 项任务执行中");
  assert.equal(trayStatus("ready", { runningTurns: 0, pendingApprovals: 0 }, true).label, "空闲");
  assert.equal(trayStatus("ready", null, true).state, "offline");
  assert.equal(trayStatus("offline", { runningTurns: 9, pendingApprovals: 0 }, false).label, "Disconnected");
  for (const bad of [{}, { runningTurns: -1, pendingApprovals: 0 }, { runningTurns: 1, pendingApprovals: NaN }]) assert.ok(!validCounts(bad));
});

test("native click/menu open the window, explicit quit is preserved, disposal removes the icon", async () => {
  const { controller, state } = fixture();
  try {
    assert.equal(state.tooltip, "RoleWeave · 正在启动");
    controller.setConnection("ready"); await flush();
    assert.equal(state.tooltip, "RoleWeave · 空闲");
    state.handlers.click();
    state.menu.find(item => item.label === "打开 RoleWeave").click();
    state.menu.find(item => item.label === "退出").click();
    assert.equal(state.opens, 2);
    assert.equal(state.quits, 1);
  } finally { controller.dispose(); }
  assert.equal(state.destroyed, true);
});

test("late snapshots cannot resurrect busy status after disconnect", async () => {
  let finish;
  const { controller, state } = fixture(() => new Promise(resolve => { finish = resolve; }));
  controller.setConnection("ready");
  controller.setConnection("offline");
  finish({ status: 200, body: { runningTurns: 3, pendingApprovals: 1 } });
  await flush();
  assert.equal(state.tooltip, "RoleWeave · 连接中断");
  controller.dispose();
  await controller.refresh();
  assert.equal(state.destroyed, true);
});

test("snapshots reconcile completion and reconnect without stale event counters", async () => {
  let body = { runningTurns: 2, pendingApprovals: 0 };
  const { controller, state } = fixture(async () => ({ status: 200, body }));
  try {
    controller.setConnection("ready"); await flush();
    assert.equal(state.tooltip, "RoleWeave · 2 项任务执行中");
    body = { runningTurns: 1, pendingApprovals: 1 };
    await controller.refresh();
    assert.equal(state.tooltip, "RoleWeave · 1 项待审批");
    body = { runningTurns: 0, pendingApprovals: 0 };
    controller.setConnection("offline");
    controller.setConnection("ready"); await flush();
    assert.equal(state.tooltip, "RoleWeave · 空闲");
  } finally { controller.dispose(); }
});

test("request failure shows unknown instead of retaining a busy badge", async () => {
  let reject = false;
  const { controller, state } = fixture(async () => {
    if (reject) throw new Error("timeout");
    return { status: 200, body: { runningTurns: 1, pendingApprovals: 0 } };
  });
  try {
    controller.setConnection("ready"); await flush();
    reject = true;
    await controller.refresh();
    assert.equal(state.tooltip, "RoleWeave · 连接中断");
    assert.equal(state.menu.some(item => /执行中 1/.test(item.label ?? "")), false);
  } finally { controller.dispose(); }
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { windowChromeInfo, windowChromeOptions, validateWindowChromeColors, setWindowChromeColors } = require("../src/window-chrome.cjs");

test("Windows owns native overlay controls; macOS/Linux retain their frameless renderer chrome", () => {
  for (const dark of [false, true]) {
    const options = windowChromeOptions("win32", dark);
    assert.equal(options.frame, true);
    assert.equal(options.titleBarStyle, "hidden");
    assert.equal(options.titleBarOverlay.height, 40);
    assert.notEqual(options.titleBarOverlay.color, options.titleBarOverlay.symbolColor);
  }
  for (const platform of ["darwin", "linux", "freebsd"]) {
    assert.deepEqual(windowChromeOptions(platform), { frame: false });
    assert.equal(windowChromeInfo(platform).nativeControls, false);
  }
});

test("production sandbox preload reports the Windows shell even when its backend runs in WSL", async () => {
  let bridge;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/preload.js"), "utf8"), {
    process: { platform: "win32", env: { ROLEWEAVE_CONTROL_PLANE_MODE: "wsl", ROLEWEAVE_WSL_DISTRO: "Ubuntu-22.04" } },
    require: (name) => {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "owb"); bridge = value; } },
        ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } },
      };
    },
  });
  assert.equal(bridge.windowChrome.platform, "win32");
  assert.equal(bridge.windowChrome.nativeControls, true);
  await bridge.setWindowChromeColors({ color: "#102030", symbolColor: "#f0f1f2" });
  assert.equal(calls[0][0], "owb:window:chrome-colors");
  assert.equal(calls[0][1].color, "#102030");
});

function fixture() {
  const frame = { url: "file:///roleweave/renderer/index.html" };
  const overlays = [];
  return {
    overlays,
    event: { senderFrame: frame }, trustedRendererUrl: frame.url,
    platform: "win32", nativeControls: true,
    browserWindow: { webContents: { mainFrame: frame }, isDestroyed: () => false, setTitleBarOverlay: value => overlays.push(value) },
    request: { color: "#102030", symbolColor: "#f0f1f2ff" },
  };
}

test("only the owned main frame may update overlay colors, retaining the fixed title bar height", () => {
  const f = fixture();
  assert.deepEqual(setWindowChromeColors(f), { ok: true });
  assert.deepEqual(f.overlays, [{ color: "#102030", symbolColor: "#f0f1f2ff", height: 40 }]);
  for (const overrides of [
    { event: { senderFrame: { url: f.trustedRendererUrl } } },
    { event: {} }, { browserWindow: null }, { trustedRendererUrl: "https://other.test/" },
    { platform: "darwin" }, { platform: "linux" }, { nativeControls: false },
    { browserWindow: { ...f.browserWindow, isDestroyed: () => true } },
  ]) assert.deepEqual(setWindowChromeColors({ ...f, ...overrides }), { ok: false });
  assert.equal(f.overlays.length, 1);
});

test("overlay requests cannot change geometry/visibility or pass arbitrary CSS into Electron", () => {
  for (const request of [null, [], "#102030", {}, { color: "#102030" },
    { color: "red", symbolColor: "#ffffff" }, { color: "#abc", symbolColor: "#ffffff" },
    { color: "#102030", symbolColor: "var(--ui-color)" }, { color: "#102030", symbolColor: "#ffffff", height: 100 },
    { color: "#102030", symbolColor: "#ffffff", visible: false }]) {
    assert.equal(validateWindowChromeColors(request), null);
    const f = fixture();
    assert.deepEqual(setWindowChromeColors({ ...f, request }), { ok: false });
    assert.deepEqual(f.overlays, []);
  }
  assert.deepEqual(validateWindowChromeColors({ color: "#aAbBcC00", symbolColor: "#123456" }), { color: "#aAbBcC00", symbolColor: "#123456" });
});

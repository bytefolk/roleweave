// Explicit real-Windows acceptance: node --test apps/desktop/test/window-chrome-windows.cjs
// Use ROLEWEAVE_WINDOWS_ELECTRON to select a Windows Electron executable when
// this checkout's node_modules was installed in WSL. This file is deliberately
// outside the *.test.cjs gate: it opens only its own short-lived fixture window,
// with no control plane, Agent, credentials, or user workspace.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

test("real Windows overlay exposes a safe area and tracks native maximize/restore even with a WSL backend preference", {
  skip: process.platform !== "win32" ? "requires a real Windows Electron host" : false,
  timeout: 45000,
}, async (t) => {
  const electron = process.env.ROLEWEAVE_WINDOWS_ELECTRON || require("electron");
  assert.equal(typeof electron, "string", "run this acceptance with Node and a Windows Electron executable");
  assert.ok(fs.existsSync(electron), `Windows Electron runtime is missing: ${electron}`);
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(tempRoot, "roleweave-window-chrome-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise(resolve => { child.once("close", resolve); setTimeout(resolve, 1000); });
    }
    assert.equal(path.dirname(path.resolve(fixture)), tempRoot);
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const name of ["window-chrome.cjs", "window-ipc.cjs", "preload.js"]) {
    fs.copyFileSync(path.join(__dirname, "../src", name), path.join(fixture, name));
  }
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "roleweave-window-chrome-acceptance", main: "main.cjs" }));
  fs.writeFileSync(path.join(fixture, "index.html"), `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{margin:0}#safe-area{position:absolute;left:env(titlebar-area-x,0px);top:env(titlebar-area-y,0px);width:env(titlebar-area-width,100%);height:env(titlebar-area-height,40px);app-region:drag;background:#f7f8fb}</style>
</head><body><div id="safe-area">RoleWeave isolated window chrome acceptance</div></body></html>`);
  fs.writeFileSync(path.join(fixture, "main.cjs"), `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { app, BrowserWindow, ipcMain } = require('electron');
const { windowChromeInfo, windowChromeOptions, validateWindowChromeColors, setWindowChromeColors } = require('./window-chrome.cjs');
fs.mkdirSync(path.join(__dirname, 'user-data'), { recursive: true });
app.setPath('userData', path.join(__dirname, 'user-data'));
app.disableHardwareAcceleration();
const reportPath = path.join(__dirname, 'report.json');
let win;
const diagnostics = { stage: 'startup', htmlPath: null, requestedRendererUrl: null, loadedRendererUrl: null, mainFrameUrl: null, trustedRendererUrl: null, lastChromeIpc: null };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) {
  const deadline = Date.now() + 6000;
  do { const value = await read(); if (value) return value; await delay(30); } while (Date.now() < deadline);
  throw new Error('native window did not reach the requested state');
}
const measure = () => win.webContents.executeJavaScript("(() => { const overlay = navigator.windowControlsOverlay; const rect = overlay?.getTitlebarAreaRect(); const safe = document.getElementById('safe-area').getBoundingClientRect(); return { visible: overlay?.visible === true, chrome: window.owb.windowChrome, width: innerWidth, rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null, safe: { x: safe.x, y: safe.y, width: safe.width, height: safe.height } }; })()");
function verifySafeArea(measurement) {
  assert.equal(measurement.visible, true);
  assert.equal(measurement.chrome.platform, 'win32');
  assert.equal(measurement.chrome.nativeControls, true);
  assert.ok(measurement.rect && measurement.rect.width > 0 && measurement.rect.width < measurement.width);
  for (const field of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(measurement.safe[field] - measurement.rect[field]) <= 1, field + ' must match the native safe area');
  assert.ok(Math.abs(measurement.rect.height - 40) <= 1);
}
app.whenReady().then(async () => {
  const html = fs.realpathSync.native(path.join(__dirname, 'index.html'));
  let trustedRendererUrl = null;
  diagnostics.htmlPath = html;
  diagnostics.requestedRendererUrl = pathToFileURL(html).toString();
  diagnostics.stage = 'create-window';
  win = new BrowserWindow({ width: 800, height: 700, show: false, focusable: false,
    title: 'RoleWeave isolated native chrome acceptance', ...windowChromeOptions(process.platform),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const nativeSetOverlay = win.setTitleBarOverlay.bind(win);
  win.setTitleBarOverlay = options => {
    if (diagnostics.lastChromeIpc) diagnostics.lastChromeIpc.nativeCallAttempted = true;
    try { return nativeSetOverlay(options); }
    catch (error) {
      if (diagnostics.lastChromeIpc) diagnostics.lastChromeIpc.nativeCallError = error.stack || String(error);
      throw error;
    }
  };
  ipcMain.handle('owb:window:chrome-colors', (event, request) => {
    diagnostics.lastChromeIpc = {
      senderUrl: event.senderFrame?.url ?? null, trustedRendererUrl,
      sameMainFrame: event.senderFrame === win.webContents.mainFrame,
      urlMatches: event.senderFrame?.url === trustedRendererUrl,
      platform: process.platform, nativeControls: windowChromeInfo(process.platform).nativeControls,
      colorsValid: validateWindowChromeColors(request) !== null, nativeCallAttempted: false, nativeCallError: null,
    };
    const result = setWindowChromeColors({ event, request, browserWindow: win, trustedRendererUrl,
      platform: process.platform, nativeControls: windowChromeInfo(process.platform).nativeControls });
    diagnostics.lastChromeIpc.result = result;
    return result;
  });
  diagnostics.stage = 'load-fixture';
  await win.loadFile(html);
  // Chromium may expand Windows 8.3 temp names or normalize URL spelling.
  // Verify the loaded file identity before pinning its exact actual URL; never
  // relax the production sender/frame equality guard to accommodate aliases.
  const loadedRendererUrl = win.webContents.getURL();
  diagnostics.loadedRendererUrl = loadedRendererUrl;
  diagnostics.mainFrameUrl = win.webContents.mainFrame.url;
  const loaded = new URL(loadedRendererUrl);
  assert.equal(loaded.protocol, 'file:');
  assert.equal(loaded.search, '');
  assert.equal(loaded.hash, '');
  assert.equal(fs.realpathSync.native(fileURLToPath(loaded)).toLowerCase(), html.toLowerCase(), 'loaded URL must resolve to the private fixture HTML');
  assert.equal(diagnostics.mainFrameUrl, loadedRendererUrl, 'main frame and webContents URL must agree');
  trustedRendererUrl = loadedRendererUrl;
  diagnostics.trustedRendererUrl = trustedRendererUrl;
  diagnostics.stage = 'initial-overlay';
  win.showInactive();
  const initial = await until(async () => { const value = await measure(); return value.visible ? value : null; });
  verifySafeArea(initial);
  assert.equal(win.isMaximized(), false);
  diagnostics.stage = 'color-update';
  const themed = await win.webContents.executeJavaScript("window.owb.setWindowChromeColors({color:'#202127',symbolColor:'#f7f8fb'})");
  assert.equal(themed.ok, true);
  diagnostics.stage = 'reject-geometry-update';
  const rejected = await win.webContents.executeJavaScript("window.owb.setWindowChromeColors({color:'#202127',symbolColor:'#f7f8fb',height:200})");
  assert.equal(rejected.ok, false);
  diagnostics.stage = 'maximize';
  win.maximize();
  await until(() => win.isMaximized());
  await delay(120);
  const maximized = await measure();
  verifySafeArea(maximized);
  const maximizedState = win.isMaximized();
  assert.equal(maximizedState, true);
  diagnostics.stage = 'restore';
  win.unmaximize();
  await until(() => !win.isMaximized());
  await delay(120);
  const restored = await measure();
  verifySafeArea(restored);
  const restoredState = win.isMaximized();
  assert.equal(restoredState, false);
  diagnostics.stage = 'complete';
  fs.writeFileSync(reportPath, JSON.stringify({ ok: true, diagnostics, platform: process.platform, backendPreference: process.env.ROLEWEAVE_CONTROL_PLANE_MODE,
    initial, maximized: { ...maximized, isMaximized: maximizedState }, restored: { ...restored, isMaximized: restoredState }, themed, rejected }));
  win.destroy();
  app.exit(0);
}).catch(error => {
  fs.writeFileSync(reportPath, JSON.stringify({ ok: false, diagnostics, error: error.stack || String(error) }));
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(1);
});
`);
  let diagnostics = "";
  const result = await new Promise((resolve, reject) => {
    child = spawn(electron, [fixture], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ROLEWEAVE_CONTROL_PLANE_MODE: "wsl" },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Windows Electron acceptance timed out: ${diagnostics}`)); }, 35000);
    child.stdout.on("data", chunk => { if (diagnostics.length < 24000) diagnostics += String(chunk); });
    child.stderr.on("data", chunk => { if (diagnostics.length < 24000) diagnostics += String(chunk); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve(code); });
  });
  const reportPath = path.join(fixture, "report.json");
  assert.ok(fs.existsSync(reportPath), diagnostics);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (result !== 0 || report.ok !== true) t.diagnostic(JSON.stringify(report));
  assert.equal(result, 0, report.error || diagnostics);
  assert.equal(report.ok, true, report.error);
  assert.equal(report.platform, "win32");
  assert.equal(report.backendPreference, "wsl");
  assert.equal(report.maximized.isMaximized, true);
  assert.equal(report.restored.isMaximized, false);
  t.diagnostic(JSON.stringify(report));
});

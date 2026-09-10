// RoleWeave Electron shell (main process).
//
// Security baseline (frozen, docs/api-contract-v0.md §安全基线):
//   - contextIsolation: true, nodeIntegration: false, sandbox: true
//   - preload exposes a whitelisted, enumerated IPC bridge only
//   - the boot token never enters the renderer: IPC -> main -> HTTP proxy
//   - strict CSP in renderer/index.html; no third-party CDN; no remote code
//
// Shell-service split (ADR-0001): main spawns apps/server as a child process
// with ELECTRON_RUN_AS_NODE; the same server also runs standalone.

const { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } = require("electron");
// Keep the development window and the packaged bundle aligned on the public
// product name. The old IPC/package identifiers below remain compatibility
// contracts, but users should only see RoleWeave.
app.setName("RoleWeave");
const { spawn } = require("node:child_process");
const {
  createControlPlaneChild,
  engineRuntimeEnvironment,
  serverPathForWorkspace,
} = require("./control-plane-launch.cjs");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { rendererEntryPath } = require("./runtime-paths.cjs");
const { recoverMacGuiPath } = require("./macos-login-path.cjs");
const {
  reservePackagedSmokeRequests,
  runPackagedBehaviorSmoke,
} = require("./packaged-behavior-smoke.cjs");
const {
  awaitHarnessRelease,
  packagedSmokeLoadOptions,
  runPackagedSmoke,
  startPackagedSmokeLifecycle,
  LAYOUT_MEASURE_SCRIPT,
} = require("./packaged-smoke.cjs");
const { defaultMacAppPath, startUpdaterService } = require("./updater.cjs");
const {
  RELEASE_PAGE_URL,
  boundedUpdateResult,
  boundedUpdateState,
  confirmedByUser,
  updateStatusPayload,
} = require("./update-ipc.cjs");
const {
  DEFAULT_READY_TIMEOUT_MS,
  isControlPlaneAlive,
  startControlPlaneProcess,
  stopControlPlaneProcess,
} = require("./control-plane-lifecycle.cjs");
const { isAllowedNavigationTarget, isTrustedWindowSender } = require("./window-ipc.cjs");
const { validateRestoreRequest, validateOrgApply } = require("./org-ipc.cjs");
const {
  validateAssetsCreateRequest,
  validateAssetsListRequest,
  validateAssetsReadRequest,
} = require("./assets-ipc.cjs");
const {
  validateDocsCreateRequest,
  validateDocsListRequest,
  validateDocsReadRequest,
  validateDocsResolveRequest,
} = require("./docs-ipc.cjs");
const {
  validateDriveListRequest,
  validateDriveDetailRequest,
  validateDriveUploadRequest,
} = require("./drive-ipc.cjs");
const { validateHireRequest } = require("./hire-ipc.cjs");
const { turnHistoryPath, validateCancelRequest, validateCreateTurnRequest } = require("./turn-ipc.cjs");
const {
  sessionListPath,
  sessionPath,
  validateSessionCreateRequest,
  validateSessionContextRequest,
  validateSessionId,
  validateSessionTurnRequest,
} = require("./session-ipc.cjs");
const {
  groupPath,
  validateConversationRef,
  validateGroupAddMemberRequest,
  validateGroupCreateRequest,
  validateGroupTurnRequest,
} = require("./group-ipc.cjs");
const {
  writeLastWorkspacePath,
} = require("./last-workspace.cjs");
const { validateWorkspaceCreateRequest } = require("./workspace-ipc.cjs");
const { openDefaultWorkspace } = require("./auto-open-workspace.cjs");

const SERVER_ENTRY = path.join(__dirname, "..", "..", "server", "dist", "src", "index.js");
const ROLEWEAVE_DEV_ICON = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "branding",
  "roleweave",
  "platform-icons",
  "roleweave.png",
);
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let controlPlane = null; // { child, port, token, state }
let controlPlaneState = "stopped";
let controlPlaneStopPromise = null;
let updaterService = null;
let controlPlaneError = null;
let mainWindow = null;
/** file:// URL of the packaged renderer entry loaded into mainWindow — the
 * one and only URL a trusted window IPC call may be sent from (#77 review). */
let trustedRendererUrl = null;
let eventStreamRequest = null;
let currentSseStatus = "connecting";
let pendingFallbackNotice = null;
let updateCheckTimer = null;

function pinnedEngineCommandDefault() {
  const nodePath = process.execPath;
  const enginePath = path.join(
    __dirname,
    "..",
    "..",
    "server",
    "bin",
    "qoder-engine.mjs",
  );
  // Wrap both paths in double quotes so the server's quote-aware splitCommand
  // recovers them as two argv tokens even when the install path contains
  // spaces (Windows `C:\Program Files\...`, macOS OneDrive folders, etc).
  return `"${nodePath}" "${enginePath}"`;
}

function startControlPlane() {
  controlPlaneState = "starting";
  controlPlaneError = null;
  return startControlPlaneProcess({
    readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
    createChild: () => {
      const child = createControlPlaneChild({
        serverEntry: SERVER_ENTRY,
        env: {
          ...process.env,
          // Directly runnable: default the pinned engine to the bundled qoder
          // adapter unless the operator pins a real digital-employee CLI.
          ...engineRuntimeEnvironment(
            process.env,
            pinnedEngineCommandDefault(),
          ),
        },
      });
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));
      return child;
    },
  }).then((handle) => {
    controlPlaneState = "ready";
    return handle;
  }).catch((error) => {
    controlPlaneState = "failed";
    controlPlaneError = error;
    throw error;
  });
}

function stopControlPlane() {
  if (controlPlaneStopPromise) return controlPlaneStopPromise;
  if (!controlPlane) {
    controlPlaneState = "stopped";
    return Promise.resolve({ state: "stopped", forced: false, exitCode: null, signalCode: null });
  }
  const handle = controlPlane;
  controlPlaneState = "stopping";
  controlPlaneStopPromise = stopControlPlaneProcess(handle).then((result) => {
    if (controlPlane === handle) controlPlane = null;
    controlPlaneState = "stopped";
    return result;
  }).catch((error) => {
    controlPlaneState = "failed";
    controlPlaneError = error;
    throw error;
  }).finally(() => {
    controlPlaneStopPromise = null;
  });
  return controlPlaneStopPromise;
}

function apiRequest(pathname, { method = "GET", withAuth = true, body = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!controlPlane) {
      reject(new Error("control plane is not running"));
      return;
    }
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: controlPlane.port,
        path: pathname,
        method,
        headers: {
          ...(withAuth ? { authorization: `Bearer ${controlPlane.token}` } : {}),
          ...(payload !== null
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += String(chunk);
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = raw.length > 0 ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function startEventStream() {
  if (!controlPlane || eventStreamRequest) return;
  broadcastSseStatus("connecting");
  const req = http.request(
    {
      host: "127.0.0.1",
      port: controlPlane.port,
      path: "/events",
      method: "GET",
      headers: {
        authorization: `Bearer ${controlPlane.token}`,
        accept: "text/event-stream",
      },
    },
    (res) => {
      broadcastSseStatus("connected");
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += String(chunk);
        let sep = buffer.indexOf("\n\n");
        while (sep >= 0) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf("\n\n");
          const dataLine = raw
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (dataLine && mainWindow && !mainWindow.isDestroyed()) {
            try {
              mainWindow.webContents.send("owb:event", JSON.parse(dataLine.slice(6)));
            } catch {
              // Non-JSON frame; ignore.
            }
          }
        }
      });
      res.on("end", () => {
        eventStreamRequest = null;
        broadcastSseStatus("connecting");
        setTimeout(startEventStream, 2000);
      });
    },
  );
  req.on("error", () => {
    eventStreamRequest = null;
    broadcastSseStatus("connecting");
    setTimeout(startEventStream, 2000);
  });
  req.end();
  eventStreamRequest = req;
}

function broadcastSseStatus(state) {
  currentSseStatus = state;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("owb:sse-status", state);
  }
}

// Whitelisted IPC bridge — enumerated, typed, no generic channel.
ipcMain.handle("owb:status", async () => {
  if (!controlPlane) {
    return {
      running: false,
      state: controlPlaneState,
      error: controlPlaneError ? String(controlPlaneError.message ?? controlPlaneError) : null,
      nextSteps: [
        "确认已安装 Node >= 22 并已构建（npm run build）",
        "手动启动控制面排障：npm run dev:server，然后重新打开应用",
        "若引擎不可用，设置 ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI 指向钉版 digital-employee CLI",
      ],
    };
  }
  if (controlPlaneState === "stopping") {
    return { running: false, state: "stopping", port: controlPlane.port, health: null };
  }
  if (!isControlPlaneAlive(controlPlane.child)) {
    controlPlaneState = "failed";
    return {
      running: false,
      state: controlPlaneState,
      port: controlPlane.port,
      health: null,
      error: "control plane process is not alive",
    };
  }
  try {
    const health = await apiRequest("/health", { withAuth: false });
    controlPlaneState = health.status === 200 && health.body?.status === "ok" && health.body?.api === "v0"
      ? "ready"
      : "degraded";
    return { running: true, state: controlPlaneState, port: controlPlane.port, health: health.body };
  } catch (err) {
    controlPlaneState = "degraded";
    return { running: true, state: controlPlaneState, port: controlPlane.port, health: null, error: String(err.message ?? err) };
  }
});

ipcMain.handle("owb:control-plane:stop", async () => {
  const result = await stopControlPlane();
  return { ok: true, ...result };
});

ipcMain.handle("owb:workspace:open", async () => {
  const options = {
    title: "打开 RoleWeave 工作区",
    properties: ["openDirectory"],
  };
  const picked = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
  const dir = picked.filePaths[0];
  const res = await apiRequest("/workspace/open", {
    method: "POST",
    body: { path: serverPathForWorkspace(dir, process.env) },
  });
  if (res.status === 200) {
    try {
      // Persisted untranslated on purpose: the boot-time reopen checks
      // fs.existsSync(<path>/workspace.json) from the Windows side, so a
      // /mnt/c/... value would never resolve there.
      writeLastWorkspacePath(app.getPath("userData"), dir);
    } catch {
      // Persistence is best-effort; the open itself succeeded.
    }
  }
  return res;
});

ipcMain.handle("owb:workspace:create", async (_event, request) => {
  const validated = validateWorkspaceCreateRequest(request);
  if (!validated.ok) return validated.response;
  const options = {
    title: "选择项目保存位置",
    properties: ["openDirectory", "createDirectory"],
  };
  const picked = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
  const res = await apiRequest("/workspace/create", {
    method: "POST",
    body: { ...validated.request, parentPath: picked.filePaths[0] },
  });
  if (res.status === 201 && res.body?.path) {
    try {
      writeLastWorkspacePath(app.getPath("userData"), res.body.path);
    } catch {
      // Persistence is best-effort; project creation itself succeeded.
    }
  }
  return res;
});

ipcMain.handle("owb:workspace:get", async () => apiRequest("/workspace"));

ipcMain.handle("owb:org:tree", async () => apiRequest("/org/tree"));

ipcMain.handle("owb:org:apply", async (_event, manifest) => {
  const validated = validateOrgApply(manifest);
  if (!validated.ok) return validated.response;
  return apiRequest("/org/apply", { method: "POST", body: validated.request });
});

ipcMain.handle("owb:org:backups", async () => apiRequest("/org/backups"));

ipcMain.handle("owb:org:restore", async (_event, backupId) => {
  const validated = validateRestoreRequest(backupId);
  if (!validated.ok) return validated.response;
  return apiRequest("/org/restore", { method: "POST", body: validated.request });
});

ipcMain.handle("owb:org:undo", async () => apiRequest("/org/undo", { method: "POST", body: {} }));

ipcMain.handle("owb:hire:create", async (_event, request) => {
  const validated = validateHireRequest(request);
  if (!validated.ok) return validated.response;
  return apiRequest("/hire", { method: "POST", body: validated.request });
});

ipcMain.handle("owb:reports:get", async () => apiRequest("/reports"));

ipcMain.handle("owb:position:get", async (_event, positionId) => {
  if (typeof positionId !== "string" || positionId.length === 0) {
    return { status: 400, body: { code: "manifest_invalid", message: "positionId required" } };
  }
  return apiRequest(`/positions/${encodeURIComponent(positionId)}`);
});

// Read-only document file routing (#35 S2): whitelisted, enumerated, no generic channel.
ipcMain.handle("owb:position:docs:list", async (_event, positionId) => {
  const validated = validateDocsListRequest(positionId);
  if (!validated.ok) return validated.response;
  return apiRequest(validated.pathname);
});

ipcMain.handle("owb:position:docs:read", async (_event, positionId, filePath) => {
  const validated = validateDocsReadRequest(positionId, filePath);
  if (!validated.ok) return validated.response;
  return apiRequest(validated.pathname);
});

// Minimal doc creation + doc-ref resolution (#35 S4): whitelisted, enumerated.
ipcMain.handle("owb:position:docs:create", async (_event, request) => {
  const validated = validateDocsCreateRequest(request);
  if (!validated.ok) return validated.response;
  return apiRequest("/docs/create", { method: "POST", body: validated.request });
});

ipcMain.handle("owb:docs:resolve", async (_event, request) => {
  const validated = validateDocsResolveRequest(request);
  if (!validated.ok) return validated.response;
  return apiRequest("/docs/resolve", { method: "POST", body: validated.request });
});

// External doc-plane bridge (#35 R2 MVP): read-only proxy in front of
// bytefolk/doc. The renderer never touches the upstream directly — the
// shell owns the origin, the PAT and the CORS boundary.
ipcMain.handle("owb:doc-plane:list", async (_event, query) => {
  const safeQuery = typeof query === "string" ? query : "";
  if (safeQuery.length > 200) {
    return {
      status: 400,
      body: {
        code: "doc_plane_request_invalid",
        message: "query must be at most 200 characters",
        retryable: false,
      },
    };
  }
  const suffix = safeQuery.length > 0 ? `?q=${encodeURIComponent(safeQuery)}` : "";
  return apiRequest(`/doc-plane/list${suffix}`);
});

ipcMain.handle("owb:doc-plane:detail", async (_event, id) => {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    return {
      status: 400,
      body: {
        code: "doc_plane_request_invalid",
        message: "id must be a non-empty string of at most 128 characters",
        retryable: false,
      },
    };
  }
  return apiRequest(`/doc-plane/detail?id=${encodeURIComponent(id)}`);
});

// Asset-layer foundation (#36 S1): whitelisted, enumerated.
ipcMain.handle("owb:assets:list", async () => {
  const validated = validateAssetsListRequest();
  if (!validated.ok) return validated.response;
  return apiRequest(validated.pathname);
});

ipcMain.handle("owb:assets:read", async (_event, assetId) => {
  const validated = validateAssetsReadRequest(assetId);
  if (!validated.ok) return validated.response;
  return apiRequest(validated.pathname);
});

ipcMain.handle("owb:assets:create", async (_event, request) => {
  const validated = validateAssetsCreateRequest(request);
  if (!validated.ok) return validated.response;
  return apiRequest("/assets/create", { method: "POST", body: validated.request });
});

ipcMain.handle("owb:turn:create", async (_event, request) => {
  const validated = validateCreateTurnRequest(request);
  if (!validated.ok) return validated.response;
  return apiRequest("/turns", { method: "POST", body: validated.request });
});

ipcMain.handle("owb:turn:history", async (_event, positionId) => {
  const pathname = turnHistoryPath(positionId);
  if (pathname === null) {
    return { status: 400, body: { code: "turn_position_invalid", message: "positionId is invalid", retryable: false } };
  }
  return apiRequest(pathname);
});

ipcMain.handle("owb:turn:cancel", async (_event, request) => {
  const validated = validateCancelRequest(request);
  if (!validated.ok) return validated.response;
  return apiRequest("/turns/cancel", { method: "POST", body: validated.request });
});

ipcMain.handle("owb:session:create", async (_event, request) => {
  const validated = validateSessionCreateRequest(request);
  if (!validated.ok) return validated.response;
  return apiRequest("/sessions", { method: "POST", body: validated.request });
});

ipcMain.handle("owb:session:list", async (_event, positionId) => {
  const pathname = sessionListPath(positionId);
  if (pathname === null) {
    return { status: 400, body: { code: "session_request_invalid", message: "positionId is invalid", retryable: false } };
  }
  return apiRequest(pathname);
});

ipcMain.handle("owb:session:get", async (_event, sessionId) => {
  const pathname = sessionPath(sessionId);
  if (pathname === null) {
    return { status: 400, body: { code: "session_request_invalid", message: "sessionId is invalid", retryable: false } };
  }
  return apiRequest(pathname);
});

ipcMain.handle("owb:session:context", async (_event, request) => {
  const validated = validateSessionContextRequest(request);
  if (!validated.ok) return validated.response;
  return apiRequest(`/sessions/${validated.sessionId}/context`, { method: "PATCH", body: validated.request });
});

ipcMain.handle("owb:session:rotate", async (_event, sessionId) => {
  const pathname = sessionPath(sessionId, "/rotate");
  if (pathname === null) {
    return { status: 400, body: { code: "session_request_invalid", message: "sessionId is invalid", retryable: false } };
  }
  return apiRequest(pathname, { method: "POST", body: {} });
});

ipcMain.handle("owb:session:turn:create", async (_event, request) => {
  const validated = validateSessionTurnRequest(request);
  if (!validated.ok) return validated.response;
  return apiRequest(`/sessions/${validated.sessionId}/turns`, { method: "POST", body: validated.request });
});

ipcMain.handle("owb:session:turn:history", async (_event, sessionId) => {
  if (!validateSessionId(sessionId)) {
    return { status: 400, body: { code: "session_request_invalid", message: "sessionId is invalid", retryable: false } };
  }
  return apiRequest(`/sessions/${sessionId}/turns`);
});

// Additive #52: S2 group-chat surface (DS-34-001 rev-1 §1.2).
ipcMain.handle("owb:group:create", async (_event, request) => {
  const validated = validateGroupCreateRequest(request);
  if (!validated.ok) return validated.response;
  return apiRequest("/groups", { method: "POST", body: validated.request });
});

ipcMain.handle("owb:group:list", async () => apiRequest("/groups"));

ipcMain.handle("owb:group:get", async (_event, conversationRef) => {
  const pathname = groupPath(conversationRef);
  if (pathname === null) {
    return { status: 400, body: { code: "group_request_invalid", message: "conversationRef is invalid", retryable: false } };
  }
  return apiRequest(pathname);
});

ipcMain.handle("owb:group:member:add", async (_event, request) => {
  const validated = validateGroupAddMemberRequest(request);
  if (!validated.ok) return validated.response;
  return apiRequest(groupPath(validated.conversationRef, "/members"), { method: "POST", body: validated.request });
});

ipcMain.handle("owb:group:turn:create", async (_event, request) => {
  const validated = validateGroupTurnRequest(request);
  if (!validated.ok) return validated.response;
  return apiRequest(groupPath(validated.conversationRef, "/turns"), { method: "POST", body: validated.request });
});

ipcMain.handle("owb:group:timeline", async (_event, conversationRef) => {
  if (!validateConversationRef(conversationRef)) {
    return { status: 400, body: { code: "group_request_invalid", message: "conversationRef is invalid", retryable: false } };
  }
  return apiRequest(`/groups/${encodeURIComponent(conversationRef)}/turns`);
});

// Drive plane (bytefolk/mem proxy): whitelisted list/detail reads and a
// stubbed upload seam. The desktop shell owns the OS file picker so an
// absolute path never crosses the renderer boundary unvalidated.
ipcMain.handle("owb:drive:list", async (_event, query) => {
  const validated = validateDriveListRequest(query);
  if (!validated.ok) return validated.response;
  return apiRequest(validated.pathname);
});

ipcMain.handle("owb:drive:detail", async (_event, id) => {
  const validated = validateDriveDetailRequest(id);
  if (!validated.ok) return validated.response;
  return apiRequest(validated.pathname);
});

ipcMain.handle("owb:drive:upload", async (_event, filePath) => {
  const validated = validateDriveUploadRequest(filePath);
  if (!validated.ok) return validated.response;
  // TODO(mem-upload): once mem's multipart PUT to /v1/files is contract-frozen,
  // read validated.request.filePath here and stream it upstream. Until then
  // the server route also returns a stub payload, keeping the seam honest.
  return apiRequest("/drive/upload", { method: "POST", body: validated.request });
});

ipcMain.handle("owb:drive:pick-and-upload", async () => {
  const options = {
    title: "选择要上传到 mem 的文件",
    properties: ["openFile"],
  };
  const picked = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
  const validated = validateDriveUploadRequest(picked.filePaths[0]);
  if (!validated.ok) return validated.response;
  return apiRequest("/drive/upload", { method: "POST", body: validated.request });
});

ipcMain.handle("owb:sse-status:get", async () => currentSseStatus);

// #73: the renderer draws its own 40px title bar (设计稿 .wintitle), so the
// native frame is dropped — otherwise the shell stacks two title bars and the
// OS decoration looks crude next to the app chrome. The window stays resizable
// (WM edge drag) and the bar carries -webkit-app-region: drag for moving.
function createWindow() {
  const entryPath = rendererEntryPath(__dirname);
  // This request remains null in source-tree development and for every normal
  // packaged launch. Only the external clean-staging harness owns all three
  // controls and a create-exclusive report inode.
  // Family conflict detection is deliberately side-effect-free and precedes
  // every O_EXCL reservation, including partial/mixed-case Windows controls.
  const smokeRequests = reservePackagedSmokeRequests(process.env, {
    isPackaged: app.isPackaged,
  });
  if (smokeRequests.conflict) {
    process.stderr.write("static and behavior packaged smoke modes are mutually exclusive\n");
    app.exit(1);
    return;
  }
  const { smokeRequest, behaviorSmokeRequest } = smokeRequests;
  const layoutReportPath =
    smokeRequest === null && behaviorSmokeRequest === null
      ? (process.env.ORG_WORKBENCH_LAYOUT_REPORT ?? null)
      : null;
  const smokeLoad = smokeRequest === null ? null : packagedSmokeLoadOptions(entryPath, smokeRequest);
  trustedRendererUrl = smokeLoad?.trustedRendererUrl ?? pathToFileURL(entryPath).toString();
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    // #77 review item 5: was 980 — the 680px CSS breakpoint (sidebar hidden,
    // single-column stack) could never actually be reached by dragging the
    // real window; only DevTools viewport emulation could prove it. Lowered
    // so the narrow layout it drives is reachable in production, not just
    // in a simulated viewport.
    minWidth: 640,
    minHeight: 680,
    title: "RoleWeave",
    frame: false,
    resizable: true,
    icon: fs.existsSync(ROLEWEAVE_DEV_ICON) ? ROLEWEAVE_DEV_ICON : undefined,
    // Native window paint color before any CSS loads (avoids a white flash);
    // main process has no access to CSS custom properties, so this literal
    // must be kept in sync with --ui-canvas in antd-skin.css by hand — not
    // an AC-002 "no raw hex in components" violation (there is no component
    // here, just Electron's own pre-paint).
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#14151b" : "#f7f8fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  // Lane A staging harness: static, opt-in, packaged-only, and confined to the
  // caller's freshly created OS-temp root. Source-tree dev behavior is not
  // reachable through this seam.
  if (smokeRequest !== null) {
    startPackagedSmokeLifecycle({
      browserWindow: mainWindow,
      reportRequest: smokeRequest,
      failureReport: () => ({
        schemaVersion: "org-workbench-packaged-smoke.v1",
        appPid: process.pid,
        serverPid: Number.isInteger(controlPlane?.child?.pid)
          ? controlPlane.child.pid
          : null,
        resourcesPath: process.resourcesPath,
      }),
      onUnexpected: (error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
        app.exit(1);
      },
      load: () => mainWindow.loadFile(entryPath, smokeLoad.loadOptions),
      run: (lifecycle) => runPackagedSmoke({
        reportRequest: smokeRequest,
        webContents: mainWindow.webContents,
        appPid: process.pid,
        serverPid: controlPlane?.child?.pid,
        serverPort: controlPlane?.port,
        resourcesPath: process.resourcesPath,
        onReportWritten: () => lifecycle.markReportWritten(),
        // Stay up while the harness still holds its lease, so the external native
        // oracle can finish snapshotting descendants. Its cost is milliseconds on
        // macOS and seconds on Windows, so a fixed delay here races on one platform
        // or wastes time on the other; the harness releases when it is actually done.
        close: () => {
          void awaitHarnessRelease(smokeRequest.report).then(() => {
            lifecycle.beginIntentionalClose();
            mainWindow?.close();
          });
        },
      }),
    });
  } else if (behaviorSmokeRequest !== null) {
    // #111 behavior qualification remains a separate, explicitly requested
    // path. Unlike the Lane A static smoke it may exercise the local Qoder/MCP
    // fixture and a business turn, so the two reports and commands never mix.
    startPackagedSmokeLifecycle({
      browserWindow: mainWindow,
      reportRequest: behaviorSmokeRequest,
      failureReport: () => ({
        schemaVersion: "org-workbench-packaged-behavior-smoke.v1",
        serverPid: Number.isInteger(controlPlane?.child?.pid)
          ? controlPlane.child.pid
          : null,
        resourcesPath: process.resourcesPath,
      }),
      onUnexpected: (error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
        app.exit(1);
      },
      load: () => mainWindow.loadFile(entryPath),
      run: (lifecycle) => runPackagedBehaviorSmoke({
        reportRequest: behaviorSmokeRequest,
        webContents: mainWindow.webContents,
        serverPid: controlPlane?.child?.pid,
        serverPort: controlPlane?.port,
        resourcesPath: process.resourcesPath,
        onReportWritten: () => lifecycle.markReportWritten(),
        // Keep the behavior-qualified tree alive long enough for the same
        // identity-bound external oracle used by static staging to snapshot it.
        quit: () => setTimeout(() => {
          lifecycle.beginIntentionalClose();
          app.quit();
        }, 2500),
      }),
    });
  } else if (layoutReportPath !== null) {
    // #127 AC-004: dedicated full-app layout smoke (both platforms). The
    // renderer renders the REAL app (no minimal smoke entry), main measures
    // the two-column org workspace once mounted, writes the report, exits.
    mainWindow.webContents.once("did-finish-load", () => {
      void mainWindow.webContents
        .executeJavaScript(LAYOUT_MEASURE_SCRIPT, true)
        .then((layout) => {
          fs.writeFileSync(
            layoutReportPath,
            JSON.stringify({
              schemaVersion: "org-workbench-layout-smoke.v1",
              ok: layout !== null,
              layout,
            }),
          );
          app.exit(0);
        })
        .catch((error) => {
          fs.writeFileSync(
            layoutReportPath,
            JSON.stringify({
              schemaVersion: "org-workbench-layout-smoke.v1",
              ok: false,
              layout: null,
              error: String(error?.message ?? error),
            }),
          );
          app.exit(1);
        });
    });
    void mainWindow.loadFile(entryPath);
  } else {
    void mainWindow.loadFile(entryPath);
  }
  if (pendingFallbackNotice !== null) {
    const noticePath = pendingFallbackNotice;
    pendingFallbackNotice = null;
    mainWindow.webContents.once("did-finish-load", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("owb:fallback-notice", noticePath);
      }
    });
  }
  // #77 review item 2: this shell never legitimately navigates away from the
  // packaged renderer or opens child windows; deny both explicitly rather
  // than relying on Electron's defaults.
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedNavigationTarget(targetUrl, trustedRendererUrl)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("closed", () => {
    mainWindow = null;
    trustedRendererUrl = null;
  });
}

// Window chrome controls for the custom title bar. Enumerated handlers only —
// no generic "call any BrowserWindow method" channel — each additionally
// gated on isTrustedWindowSender (#77 review item 2: ipcMain.handle() is not
// scoped to a window on its own). Rejection returns { ok: false } rather than
// throwing, matching this bridge's existing response shape.
ipcMain.handle("owb:window:minimize", (event) => {
  if (!isTrustedWindowSender(event, mainWindow, trustedRendererUrl)) return { ok: false };
  mainWindow?.minimize();
  return { ok: true };
});

// 注意：WSLg/Weston 下 isMaximized() 会恒返回 true（窗口实际未最大化），
// 所以不向渲染层暴露"当前是否最大化"，按钮文案保持静态、不谎报状态。
ipcMain.handle("owb:window:toggle-maximize", (event) => {
  if (!isTrustedWindowSender(event, mainWindow, trustedRendererUrl)) return { ok: false };
  if (!mainWindow) return { ok: false };
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return { ok: true };
});

ipcMain.handle("owb:window:close", (event) => {
  if (!isTrustedWindowSender(event, mainWindow, trustedRendererUrl)) return { ok: false };
  mainWindow?.close();
  return { ok: true };
});


// #134 update surface. Enumerated exactly like the window controls above and
// gated on the same trusted-sender check: the renderer may ask about, check,
// download, install, and open the changelog for an update, and nothing else.
// Every payload crossing back is projected through update-ipc.cjs.
//
// An untrusted frame gets null rather than a fabricated status: the renderer
// treats null as "unknown" and says so, which is the truth for a caller this
// shell will not answer.
ipcMain.handle("owb:update:status", (event) => {
  if (!isTrustedWindowSender(event, mainWindow, trustedRendererUrl)) return null;
  return updateStatusPayload({
    service: updaterService,
    version: app.getVersion(),
    platform: process.platform,
  });
});

ipcMain.handle("owb:update:check", async (event) => {
  if (!isTrustedWindowSender(event, mainWindow, trustedRendererUrl)) return null;
  if (updaterService === null) return boundedUpdateResult(null);
  return boundedUpdateResult(await updaterService.check());
});

// The confirmation is forwarded, never fabricated. The service refuses an
// unconfirmed download, and that guard is the reason a renderer bug cannot turn
// into an update installing itself while someone is mid-turn.
ipcMain.handle("owb:update:download", async (event, request) => {
  if (!isTrustedWindowSender(event, mainWindow, trustedRendererUrl)) return null;
  if (updaterService === null) return boundedUpdateResult(null);
  return boundedUpdateResult(
    await updaterService.download({ confirmedByUser: confirmedByUser(request) }),
  );
});

ipcMain.handle("owb:update:install", async (event, request) => {
  if (!isTrustedWindowSender(event, mainWindow, trustedRendererUrl)) return null;
  if (updaterService === null) return boundedUpdateResult(null);
  return boundedUpdateResult(
    await updaterService.install({ confirmedByUser: confirmedByUser(request) }),
  );
});

// Takes no argument on purpose. `shell.openExternal` with a renderer-supplied
// URL would be an arbitrary-navigation capability; this surface only ever needs
// the releases page, so the URL is a constant in update-ipc.cjs.
ipcMain.handle("owb:update:release-notes", async (event) => {
  if (!isTrustedWindowSender(event, mainWindow, trustedRendererUrl)) return { ok: false };
  try {
    await shell.openExternal(RELEASE_PAGE_URL);
    return { ok: true, url: RELEASE_PAGE_URL };
  } catch {
    return { ok: false, url: RELEASE_PAGE_URL };
  }
});

/**
 * Build the update service, loading the vendored updater only where the channel
 * can actually work.
 *
 * The lazy require matters: `autoUpdater` is a getter that resolves a
 * platform-specific implementation, and outside Electron -- or on a platform with
 * no channel -- evaluating it does not throw, it hangs. So it is never touched
 * except on the one platform that has a channel, and the service takes it as an
 * argument so tests drive a fake instead.
 */
function publishUpdateState(event) {
  // Guarded because this runs inside electron-updater's emitter and a packaged
  // Windows app has no attached console: an EPIPE here would escape into the
  // library rather than surfacing as a log line nobody was reading anyway.
  try {
    process.stdout.write(`org-workbench-update ${JSON.stringify(event)}\n`);
  } catch {
    // Losing a diagnostic line is not worth failing an update check over.
  }
  // #134: the settings surface renders these live. Projected through
  // update-ipc.cjs so an unrecognized state is dropped rather than reaching a
  // pane that has no copy for it, and so no service internals cross the bridge.
  const bounded = boundedUpdateState(event);
  if (bounded === null) return;
  try {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("owb:update:state", bounded);
    }
  } catch {
    // A closing window must not turn an update event into an unhandled throw
    // inside the updater's emitter.
  }
}

app.whenReady().then(async () => {
  // Finder/LaunchServices does not inherit the user's command search path.
  // Recover only a bounded login-shell PATH before the control plane (and in
  // turn Qoder/MCP children) is spawned; all other inherited env is unchanged.
  process.env.PATH = await recoverMacGuiPath();
  try {
    controlPlane = await startControlPlane();
    startEventStream();
    const autoOpenResult = await openDefaultWorkspace({
      apiRequest,
      env: process.env,
      userDataPath: app.getPath("userData"),
    });
    if (autoOpenResult.fallbackNoticePath !== null) {
      pendingFallbackNotice = autoOpenResult.fallbackNoticePath;
    }
  } catch (err) {
    controlPlaneError = err;
    controlPlaneState = "failed";
  }
  // The vendored bundle is loaded through the service so a missing or unloadable
  // one degrades to an explained refusal. This used to be a bare require on the
  // line before createWindow(), where a throw meant the app opened no window at
  // all -- an optional update check taking down the launch.
  updaterService = startUpdaterService({
    loadUpdater: () => require("./vendor/electron-updater.cjs").autoUpdater,
    onState: publishUpdateState,
    currentVersion: app.getVersion(),
    arch: process.arch,
    appPath: process.platform === "darwin" ? defaultMacAppPath() : null,
    execPath: process.execPath,
    helperPath: path.join(__dirname, "macos-update-helper.cjs"),
    parentPid: process.pid,
    quit: () => app.quit(),
  });
  if (process.platform === "darwin" && app.dock && fs.existsSync(ROLEWEAVE_DEV_ICON)) {
    app.dock.setIcon(ROLEWEAVE_DEV_ICON);
  }
  createWindow();
  // macOS's free channel checks GitHub automatically and downloads only after
  // the signed manifest has been verified. A verified download is applied on a
  // normal app exit by the detached helper, so work is not interrupted by a
  // surprise restart. Windows keeps its existing explicit UI flow.
  void updaterService.check({ automatic: true });
  updateCheckTimer = setInterval(() => {
    void updaterService?.check({ automatic: true });
  }, UPDATE_CHECK_INTERVAL_MS);
  updateCheckTimer.unref?.();
});

app.on("window-all-closed", () => {
  app.quit();
});

let quitSequenceStarted = false;

app.on("before-quit", (event) => {
  // If a verified macOS package was downloaded in the background, replace the
  // app as part of this normal quit. The service's installing guard prevents a
  // manual "Install and restart" click from spawning a second helper.
  void updaterService?.installOnQuit?.();
  if (quitSequenceStarted || !controlPlane || !isControlPlaneAlive(controlPlane.child)) return;
  event.preventDefault();
  quitSequenceStarted = true;
  void stopControlPlane().then(() => app.quit()).catch(() => {
    // Keep the window alive and leave the control-plane handle inspectable if
    // even the bounded SIGKILL/exit wait failed. A quit must not orphan it.
    quitSequenceStarted = false;
  });
});

app.on("quit", () => {
  if (updateCheckTimer !== null) clearInterval(updateCheckTimer);
  if (eventStreamRequest) eventStreamRequest.destroy();
  void stopControlPlane();
});

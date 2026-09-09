const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// #127 AC-004: renderer-side two-column layout measurement, shared by the
// static smoke report and the dedicated cross-platform layout smoke. Bounded
// wait for the module to mount; resolves null when absent so the parity job
// fails loudly instead of silently.
const LAYOUT_MEASURE_SCRIPT = String.raw`(async () => {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      document.querySelector(".owb-org-module__left") &&
      document.querySelector(".owb-org-module > .owb-turn-panel")
    ) break;
    await sleep(50);
  }
  const left = document.querySelector(".owb-org-module__left")?.getBoundingClientRect();
  const right = document.querySelector(".owb-org-module > .owb-turn-panel")?.getBoundingClientRect();
  if (!left || !right) return null;
  return {
    leftWidth: left.width,
    leftHeight: left.height,
    rightWidth: right.width,
    rightHeight: right.height,
    bottomDelta: Math.abs(left.bottom - right.bottom),
    // #190: without the viewport a height difference cannot be attributed. The
    // runners do not give the app the same window height, so comparing absolute
    // column heights across platforms measures the runner, not the layout.
    viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
  };
})()`;

const PACKAGED_SMOKE_SCRIPT = String.raw`(async () => {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (document.querySelector("#root")?.childElementCount > 0) break;
    await sleep(50);
  }
  const smokeEntry = document.querySelector("[data-org-workbench-packaged-smoke-entry='true']");
  const rendererMounted = document.querySelector("#root")?.childElementCount > 0;
  const rendererEntryObserved = location.protocol === "file:" && /\/index\.html$/.test(location.pathname);
  const preloadBridge = typeof window.owb?.status === "function";
  if (!rendererMounted || !rendererEntryObserved || !preloadBridge || smokeEntry === null) {
    throw new Error("renderer entry or preload bridge did not become ready");
  }
  const layout = await ${LAYOUT_MEASURE_SCRIPT};
  return {
    rendererMounted,
    rendererEntryObserved,
    preloadBridge,
    staticSmokeEntry: true,
    layout,
  };
})()`;

const PACKAGED_SMOKE_QUERY_KEY = "orgWorkbenchPackagedSmoke";
const NONCE_PATTERN = /^[a-f0-9]{64}$/;
const PACKAGED_SMOKE_CONTROL_PREFIX = "ORG_WORKBENCH_PACKAGED_SMOKE_";
const PACKAGED_BEHAVIOR_SMOKE_CONTROL_PREFIX =
  "ORG_WORKBENCH_PACKAGED_BEHAVIOR_SMOKE_";

function asciiUppercase(value) {
  return String(value).replace(/[a-z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) - 32));
}

function canonicalEnvironmentKey(key, nativePlatform) {
  return nativePlatform === "win32" ? asciiUppercase(key) : key;
}

function packagedSmokeControlValue(env, expectedKey, nativePlatform = process.platform) {
  if (nativePlatform !== "win32") return env[expectedKey];
  const matches = Object.entries(env).filter(([key]) =>
    canonicalEnvironmentKey(key, nativePlatform) === expectedKey);
  // A real Windows environment cannot contain two differently-cased versions
  // of one key. Treat a fabricated/ambiguous object as invalid, not as a source
  // whose enumeration order chooses the active report path.
  return matches.length === 1 ? matches[0][1] : undefined;
}

function packagedSmokeControlFamilies(env, nativePlatform = process.platform) {
  let staticMode = false;
  let behaviorMode = false;
  for (const key of Object.keys(env)) {
    const canonicalKey = canonicalEnvironmentKey(key, nativePlatform);
    if (canonicalKey.startsWith(PACKAGED_SMOKE_CONTROL_PREFIX)) staticMode = true;
    if (canonicalKey.startsWith(PACKAGED_BEHAVIOR_SMOKE_CONTROL_PREFIX)) behaviorMode = true;
  }
  return { static: staticMode, behavior: behaviorMode };
}

function isDirectChild(root, candidate) {
  return path.dirname(path.resolve(candidate)) === path.resolve(root);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function closeQuietly(fd) {
  if (!Number.isInteger(fd)) return;
  try {
    fs.closeSync(fd);
  } catch {}
}

function closeSmokeReportReservation(request) {
  if (!Number.isInteger(request?.reportFd)) return;
  const reportFd = request.reportFd;
  // Invalidate before close. BrowserWindow failure/gone/closed events may all
  // fire, and closing the same integer after OS reuse could close an unrelated
  // descriptor in Electron.
  request.reportFd = null;
  closeQuietly(reportFd);
}

/**
 * The harness holds a lease file for as long as it still needs the staged process
 * tree standing. The app closes when the lease is released rather than on a fixed
 * timer: the external oracle's cost is platform-dependent (a native process inventory
 * is milliseconds on macOS and seconds on Windows), so any constant here is a race
 * on some platform. The cap only exists so an abandoned harness cannot leak the app.
 */
const HARNESS_LEASE_SUFFIX = ".hold";
const HARNESS_LEASE_CAP_MS = 120000;
const HARNESS_LEASE_POLL_MS = 100;
/** Kept for the case where no lease was taken, matching the previous behaviour. */
const UNLEASED_CLOSE_DELAY_MS = 2500;

function harnessLeasePath(reportPath) {
  return `${reportPath}${HARNESS_LEASE_SUFFIX}`;
}

function awaitHarnessRelease(
  reportPath,
  { capMs = HARNESS_LEASE_CAP_MS, pollMs = HARNESS_LEASE_POLL_MS, unleasedDelayMs = UNLEASED_CLOSE_DELAY_MS } = {},
) {
  const lease = harnessLeasePath(reportPath);
  if (!fs.existsSync(lease)) {
    return new Promise((resolve) => setTimeout(() => resolve("unleased"), unleasedDelayMs));
  }
  return new Promise((resolve) => {
    const deadline = Date.now() + capMs;
    const tick = () => {
      if (!fs.existsSync(lease)) {
        resolve("released");
        return;
      }
      if (Date.now() >= deadline) {
        resolve("expired");
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

function assertReservedReport(request) {
  if (
    request === null ||
    typeof request !== "object" ||
    typeof request.root !== "string" ||
    typeof request.report !== "string" ||
    !Number.isInteger(request.reportFd)
  ) {
    throw new Error("invalid packaged smoke report reservation");
  }
  const rootStat = fs.lstatSync(request.root);
  const reportStat = fs.lstatSync(request.report);
  const openedStat = fs.fstatSync(request.reportFd);
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    reportStat.isSymbolicLink() ||
    !reportStat.isFile() ||
    !openedStat.isFile() ||
    !sameFileIdentity(rootStat, request.rootStat) ||
    !sameFileIdentity(reportStat, openedStat) ||
    fs.realpathSync(request.root) !== request.root ||
    fs.realpathSync(path.dirname(request.report)) !== request.root ||
    !isDirectChild(request.root, request.report)
  ) {
    throw new Error("packaged smoke report reservation changed");
  }
}

function packagedSmokeRequest(env, tempRoot = os.tmpdir(), nativePlatform = process.platform) {
  const requestedRoot = packagedSmokeControlValue(
    env,
    "ORG_WORKBENCH_PACKAGED_SMOKE_ROOT",
    nativePlatform,
  );
  const report = packagedSmokeControlValue(
    env,
    "ORG_WORKBENCH_PACKAGED_SMOKE_REPORT",
    nativePlatform,
  );
  const nonce = packagedSmokeControlValue(
    env,
    "ORG_WORKBENCH_PACKAGED_SMOKE_NONCE",
    nativePlatform,
  );
  if (
    typeof requestedRoot !== "string" ||
    typeof report !== "string" ||
    typeof nonce !== "string" ||
    !NONCE_PATTERN.test(nonce) ||
    !path.isAbsolute(requestedRoot) ||
    !path.isAbsolute(report) ||
    path.resolve(requestedRoot) !== requestedRoot ||
    path.resolve(report) !== report ||
    /[\0\r\n]/.test(requestedRoot) ||
    /[\0\r\n]/.test(report) ||
    !path.basename(requestedRoot).startsWith("owb-clean-staging-") ||
    !isDirectChild(requestedRoot, report)
  ) {
    return null;
  }
  let reportFd = null;
  let openedStat = null;
  let reservedReport = report;
  try {
    const rootStat = fs.lstatSync(requestedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const realRoot = fs.realpathSync(requestedRoot);
    const realTemp = fs.realpathSync(tempRoot);
    if (path.dirname(realRoot) !== realTemp || fs.existsSync(report)) return null;
    if (fs.realpathSync(path.dirname(report)) !== realRoot) return null;
    reservedReport = path.join(realRoot, path.basename(report));
    const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
    reportFd = fs.openSync(
      reservedReport,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollow,
      0o600,
    );
    openedStat = fs.fstatSync(reportFd);
    const request = { root: realRoot, report: reservedReport, reportFd, rootStat, nonce };
    // Recheck after the exclusive reservation. A parent rename/swap between
    // validation and open cannot redirect the later write: it is bound to fd.
    assertReservedReport(request);
    return request;
  } catch {
    closeQuietly(reportFd);
    if (openedStat !== null) {
      try {
        const pathStat = fs.lstatSync(reservedReport);
        if (sameFileIdentity(pathStat, openedStat)) fs.unlinkSync(reservedReport);
      } catch {}
    }
    return null;
  }
}

function packagedSmokeLoadOptions(entryPath, request) {
  if (!request || !NONCE_PATTERN.test(request.nonce ?? "")) {
    throw new Error("packaged smoke load requires a reserved nonce");
  }
  const entryUrl = pathToFileURL(path.resolve(entryPath));
  entryUrl.searchParams.set(PACKAGED_SMOKE_QUERY_KEY, request.nonce);
  return {
    trustedRendererUrl: entryUrl.toString(),
    loadOptions: { query: { [PACKAGED_SMOKE_QUERY_KEY]: request.nonce } },
  };
}

function createPackagedSmokeLifecycle({ reportRequest, failureReport = null, onUnexpected }) {
  let intentionalClose = false;
  let failed = false;
  let reportWritten = false;
  return {
    beginIntentionalClose() {
      intentionalClose = true;
    },
    markReportWritten() {
      reportWritten = true;
    },
    unexpected(stage, reason = stage) {
      if (intentionalClose || failed) return false;
      failed = true;
      const safeStage = safeError(stage);
      const safeReason = safeError(reason);
      let reportError = null;
      if (!reportWritten && Number.isInteger(reportRequest?.reportFd) && typeof failureReport === "function") {
        try {
          writeSmokeReport(reportRequest, {
            ...failureReport({ stage: safeStage, error: safeReason }),
            ok: false,
            nonce: reportRequest.nonce,
            stage: safeStage,
            error: safeReason,
          });
        } catch (error) {
          reportError = error;
          closeSmokeReportReservation(reportRequest);
        }
      } else {
        closeSmokeReportReservation(reportRequest);
      }
      const reportSuffix = reportError === null
        ? ""
        : `; failure report write failed: ${safeError(reportError)}`;
      onUnexpected(new Error(
        `packaged smoke lifecycle failed${reportWritten ? " after reporting" : ""}: ${safeReason}${reportSuffix}`,
      ));
      return true;
    },
    state() {
      return { failed, intentionalClose, reportWritten };
    },
  };
}

function startPackagedSmokeLifecycle({
  browserWindow,
  reportRequest,
  failureReport = null,
  load,
  run,
  onUnexpected,
}) {
  if (
    typeof browserWindow?.once !== "function" ||
    typeof browserWindow?.webContents?.once !== "function" ||
    typeof load !== "function" ||
    typeof run !== "function" ||
    typeof onUnexpected !== "function"
  ) {
    throw new Error("invalid packaged smoke lifecycle configuration");
  }
  const lifecycle = createPackagedSmokeLifecycle({
    reportRequest,
    failureReport,
    onUnexpected,
  });
  browserWindow.webContents.once("did-fail-load", (_event, code, description) => {
    lifecycle.unexpected("renderer-load", `renderer load failed (${code}): ${description}`);
  });
  browserWindow.webContents.once("render-process-gone", (_event, details) => {
    lifecycle.unexpected(
      "renderer-process",
      `renderer process gone: ${details?.reason ?? "unknown"}`,
    );
  });
  browserWindow.once("closed", () => {
    lifecycle.unexpected("window-closed", "smoke window closed before the harness requested it");
  });
  browserWindow.webContents.once("did-finish-load", () => {
    if (lifecycle.state().failed) return;
    void Promise.resolve()
      .then(() => run(lifecycle))
      .catch((error) => lifecycle.unexpected("smoke-run", error));
  });
  try {
    void Promise.resolve(load()).catch((error) => {
      lifecycle.unexpected("renderer-load-promise", error);
    });
  } catch (error) {
    lifecycle.unexpected("renderer-load-promise", error);
  }
  return lifecycle;
}

function safeError(error) {
  return String(error?.message ?? error)
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 512);
}

function writeSmokeReport(request, report) {
  try {
    assertReservedReport(request);
    fs.writeFileSync(request.reportFd, `${JSON.stringify(report)}\n`, {
      encoding: "utf8",
    });
    fs.fsyncSync(request.reportFd);
  } finally {
    closeSmokeReportReservation(request);
  }
}

async function runPackagedSmoke({
  reportRequest,
  webContents,
  appPid,
  serverPid,
  serverPort,
  resourcesPath,
  onReportWritten = () => {},
  close,
}) {
  let report;
  try {
    const renderer = await webContents.executeJavaScript(PACKAGED_SMOKE_SCRIPT, false);
    if (!Number.isInteger(serverPid) || !Number.isInteger(serverPort) || serverPort < 1) {
      throw new Error("control plane ready line was not observed");
    }
    report = {
      schemaVersion: "org-workbench-packaged-smoke.v1",
      ok: true,
      nonce: reportRequest.nonce,
      ...renderer,
      controlPlaneReady: true,
      appPid,
      serverPid,
      serverPort,
      resourcesPath,
    };
  } catch (error) {
    report = {
      schemaVersion: "org-workbench-packaged-smoke.v1",
      ok: false,
      nonce: reportRequest.nonce,
      error: safeError(error),
      appPid,
      serverPid: Number.isInteger(serverPid) ? serverPid : null,
      resourcesPath,
    };
  }
  writeSmokeReport(reportRequest, report);
  onReportWritten();
  close();
}

module.exports = {
  LAYOUT_MEASURE_SCRIPT,
  HARNESS_LEASE_SUFFIX,
  PACKAGED_SMOKE_SCRIPT,
  awaitHarnessRelease,
  harnessLeasePath,
  PACKAGED_SMOKE_QUERY_KEY,
  closeSmokeReportReservation,
  createPackagedSmokeLifecycle,
  packagedSmokeLoadOptions,
  packagedSmokeControlFamilies,
  packagedSmokeControlValue,
  packagedSmokeRequest,
  runPackagedSmoke,
  startPackagedSmokeLifecycle,
  writeSmokeReport,
};

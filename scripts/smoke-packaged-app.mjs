import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { verifyPackagedApp } from "./verify-packaged-app.mjs";

const require = createRequire(import.meta.url);
const { platformLayout } = require("../apps/desktop/packaging/runtime-layout.cjs");
const { harnessLeasePath } = require("../apps/desktop/src/packaged-smoke.cjs");
const {
  bindNativeProcessIdentities,
  descendantProcesses,
  listNativeProcesses,
  terminateNativeProcessTree,
  waitForBoundProcessIdentity,
  waitForNoResidualProcesses,
} = require("../apps/desktop/packaging/process-tree.cjs");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function inside(root, candidate) {
  const relation = path.relative(root, candidate);
  return relation.length === 0 || (
    relation !== ".." &&
    !relation.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relation)
  );
}

async function canonicalDirectory(candidate, label) {
  const resolved = path.resolve(candidate);
  const stat = await fs.lstat(resolved);
  assert.equal(stat.isSymbolicLink(), false, `${label} must not be a symlink or junction`);
  assert.equal(stat.isDirectory(), true, `${label} must be a directory`);
  const real = await fs.realpath(resolved);
  assert.equal(
    normalizedPath(real),
    normalizedPath(resolved),
    `${label} must not traverse a symlink or junction`,
  );
  return real;
}

function assertDisjointFromSource(sourceRoot, candidate, label) {
  assert.equal(
    inside(sourceRoot, candidate) || inside(candidate, sourceRoot),
    false,
    `${label} must be canonically disjoint from the source tree`,
  );
}

export async function createExternalStagingRoot({
  tempBase,
  sourceRoot = projectRoot,
  mkdtemp = fs.mkdtemp,
} = {}) {
  const resolvedTempBase = tempBase ?? await fs.realpath(os.tmpdir());
  const canonicalSource = await canonicalDirectory(sourceRoot, "source root");
  const canonicalTemp = await canonicalDirectory(resolvedTempBase, "smoke temp base");
  assertDisjointFromSource(canonicalSource, canonicalTemp, "smoke temp base");
  const stagingRoot = await mkdtemp(path.join(canonicalTemp, "owb-clean-staging-"));
  const canonicalStaging = await canonicalDirectory(stagingRoot, "smoke staging root");
  assertDisjointFromSource(canonicalSource, canonicalStaging, "smoke staging root");
  return { stagingRoot: canonicalStaging, sourceRoot: canonicalSource };
}

function createLaunchEnvironment(platform, { stagingRoot, workspace, report, nonce }) {
  const home = path.join(stagingRoot, "home");
  const emptyPath = path.join(stagingRoot, "empty-path");
  const nativeTemp = path.dirname(stagingRoot);
  const common = {
    HOME: home,
    LANG: "en_US.UTF-8",
    ORG_WORKBENCH_DEFAULT_WORKSPACE: workspace,
    ORG_WORKBENCH_PACKAGED_SMOKE_NONCE: nonce,
    ORG_WORKBENCH_PACKAGED_SMOKE_REPORT: report,
    ORG_WORKBENCH_PACKAGED_SMOKE_ROOT: stagingRoot,
    PATH: emptyPath,
  };
  if (platform === "macos") {
    return {
      ...common,
      LOGNAME: "org-workbench-smoke",
      TMPDIR: nativeTemp,
      USER: "org-workbench-smoke",
    };
  }
  return {
    ...common,
    APPDATA: path.join(home, "AppData", "Roaming"),
    COMSPEC: process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe",
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    TEMP: nativeTemp,
    TMP: nativeTemp,
    USERPROFILE: home,
  };
}

function executableScript(body) {
  return `#!/bin/sh\nset -eu\n${body}\n`;
}

async function writeExecutable(file, body) {
  await fs.writeFile(file, executableScript(body), { encoding: "utf8", mode: 0o700 });
}

export async function createBehaviorFixtures(stagingRoot) {
  const smokeBin = path.join(stagingRoot, "login-bin");
  const tempDir = path.join(stagingRoot, "tmp");
  const homeDir = path.join(stagingRoot, "home");
  await Promise.all([
    fs.mkdir(smokeBin, { recursive: true }),
    fs.mkdir(tempDir, { recursive: true }),
    fs.mkdir(homeDir, { recursive: true }),
  ]);

  const mcpBin = path.join(smokeBin, "owb-mcp-smoke");
  await writeExecutable(mcpBin, `
if [ "\${ELECTRON_RUN_AS_NODE:-}" != "" ]; then exit 45; fi
if [ "\${OWB_LOGIN_ONLY_SECRET:-}" != "" ]; then exit 46; fi
exit 0
`);
  const qoderBin = path.join(smokeBin, "qodercli");
  const qoderAlias = path.join(smokeBin, "qoder");
  const qoderPidFile = path.join(tempDir, "qoder.pid");
  const qoderScript = `
qoder_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s\\n' "$$" > "$qoder_dir/../tmp/qoder.pid"
if [ "\${ELECTRON_RUN_AS_NODE:-}" != "" ]; then
  exit 44
fi
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' 'qoder 1.1.0'
  exit 0
fi
if [ "\${OWB_LOGIN_ONLY_SECRET:-}" != "" ]; then
  exit 43
fi
if ! owb-mcp-smoke; then
  exit 42
fi
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"packaged path smoke ok"}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"packaged path smoke ok","usage":{"input_tokens":1,"output_tokens":1}}'
`;
  await writeExecutable(qoderBin, qoderScript);
  await writeExecutable(qoderAlias, qoderScript);
  const loginShell = path.join(stagingRoot, "login-shell");
  await writeExecutable(loginShell, `
OWB_LOGIN_ONLY_SECRET='must-not-cross'
export OWB_LOGIN_ONLY_SECRET
printf '%s\\n' '__ORG_WORKBENCH_LOGIN_PATH__=${smokeBin}:/usr/bin:/bin:/usr/sbin:/sbin'
`);

  return { homeDir, loginShell, qoderPidFile, tempDir };
}

export function createLayoutLaunchEnvironment(platform, { stagingRoot, workspace, report }) {
  // #127 AC-004: full-app layout smoke. Deliberately NO packaged-smoke nonce:
  // the renderer must render the REAL app (two-column org workspace), not the
  // minimal static smoke entry. Main measures the layout and writes the report.
  const base = createLaunchEnvironment(platform, {
    stagingRoot,
    workspace,
    report,
    nonce: "0".repeat(64),
  });
  const {
    ORG_WORKBENCH_PACKAGED_SMOKE_NONCE: _nonce,
    ORG_WORKBENCH_PACKAGED_SMOKE_REPORT: _report,
    ORG_WORKBENCH_PACKAGED_SMOKE_ROOT: _root,
    ...rest
  } = base;
  return { ...rest, ORG_WORKBENCH_LAYOUT_REPORT: report };
}

export function createBehaviorLaunchEnvironment({ stagingRoot, workspace, report, nonce, fixtures }) {
  return {
    HOME: fixtures.homeDir,
    LANG: "en_US.UTF-8",
    LOGNAME: "org-workbench-behavior-smoke",
    ORG_WORKBENCH_DEFAULT_WORKSPACE: workspace,
    ORG_WORKBENCH_PACKAGED_BEHAVIOR_SMOKE_NONCE: nonce,
    ORG_WORKBENCH_PACKAGED_BEHAVIOR_SMOKE_REPORT: report,
    ORG_WORKBENCH_PACKAGED_BEHAVIOR_SMOKE_ROOT: stagingRoot,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: fixtures.loginShell,
    // The packaged main process uses os.tmpdir() as the independent anchor
    // for its canonical staging-root/report reservation. Keep TMPDIR on that
    // native parent; the Qoder fixture has its own explicit tempDir path.
    TMPDIR: path.dirname(stagingRoot),
    USER: "org-workbench-behavior-smoke",
  };
}

export function launchApp(executable, cwd, env) {
  const child = spawn(executable, ["--disable-gpu"], {
    cwd,
    detached: process.platform !== "win32",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  let output = "";
  const append = (chunk) => {
    output = (output + String(chunk)).slice(-65536);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const closed = new Promise((resolve) => {
    let settled = false;
    const settle = (state) => {
      if (settled) return;
      settled = true;
      resolve({ ...state, output });
    };
    child.once("error", (error) => settle({ kind: "error", error }));
    child.once("close", (code, signal) => settle({ kind: "close", code, signal }));
  });
  return { child, closed };
}

function normalizedClosedState(value) {
  return value?.kind === "error" || value?.kind === "close"
    ? value
    : { kind: "close", ...value };
}

function closedFailure(state) {
  if (state.kind === "error") {
    return new Error(`staged app launch failed: ${state.error?.message ?? state.error}\n${state.output ?? ""}`);
  }
  return new Error(`staged app exited before reporting (${state.code ?? state.signal})\n${state.output ?? ""}`);
}

/**
 * Prove the control plane the app reported is genuinely serving.
 *
 * This replaces an earlier check that looked for the server PID as a handle-bound
 * descendant of the app in the native process table. That asked a topology question
 * to answer a liveness one, and on Windows it could only be answered inside a narrow
 * window while the app held itself open.
 *
 * The health route is exempt from bearer auth (apps/server/src/server.ts) and reports
 * the control plane's own pid, so one request establishes more than the process table
 * could: the pid is alive, it is serving this API, and it identifies as that pid --
 * which also rules out a recycled pid, since a reused pid does not answer here.
 */
export async function probeControlPlane(smoke, closed, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let closedState = null;
  Promise.resolve(closed).then(
    (state) => { closedState = normalizedClosedState(state); },
    (error) => { closedState = { kind: "error", error, output: "" }; },
  );
  let lastFailure = "the control plane was never reached";
  while (Date.now() < deadline) {
    if (closedState !== null) {
      throw new Error(`staged app exited before its control plane answered: ${lastFailure}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${smoke.serverPort}/health`, {
        signal: AbortSignal.timeout(Math.max(1000, Math.min(15000, deadline - Date.now()))),
      });
      if (!response.ok) {
        lastFailure = `health returned HTTP ${response.status}`;
      } else {
        const body = await response.json();
        if (body?.status !== "ok") {
          lastFailure = `health reported status ${JSON.stringify(body?.status)}`;
        } else if (body?.server?.pid !== smoke.serverPid) {
          // A different process answering on that port is not the control plane
          // the app reported, whatever else it may be.
          throw new Error(
            `control plane on port ${smoke.serverPort} reports pid ${body?.server?.pid}, app reported ${smoke.serverPid}`,
          );
        } else {
          return body;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("control plane on port")) throw error;
      lastFailure = String(error?.message ?? error);
    }
    await delay(intervalMs);
  }
  throw new Error(`control plane did not answer within ${timeoutMs}ms: ${lastFailure}`);
}

export async function waitForReport(reportPath, closed, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let closedState = null;
  let lastParseError = null;
  Promise.resolve(closed).then(
    (state) => { closedState = normalizedClosedState(state); },
    (error) => { closedState = { kind: "error", error, output: "" }; },
  );
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(reportPath, "utf8"));
    } catch (error) {
      // The packaged process reserves an empty report inode at startup and
      // later writes through that descriptor. Empty/partial JSON is pending.
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      if (error instanceof SyntaxError) lastParseError = error;
    }
    if (closedState !== null) {
      if (lastParseError !== null) {
        throw new Error(`staged app exited with a malformed smoke report (${lastParseError.message})`);
      }
      throw closedFailure(closedState);
    }
    await delay(25);
  }
  if (lastParseError !== null) {
    throw new Error(`staged app report remained malformed (${lastParseError.message})`);
  }
  throw new Error(`staged app did not write its smoke report within ${timeoutMs}ms`);
}

/**
 * Wait for the staged app to close, bounded, and reject a non-clean exit.
 *
 * #186: layout mode used to skip this entirely on the strength of a comment
 * saying the app "exits right after writing its report". Nothing enforced that.
 * On Windows the still-exiting Electron tree holds handles inside the staging
 * directory, so cleanup's `fs.rm` raced it and failed with EBUSY; POSIX allows
 * unlinking an open file, which is why only Windows saw it.
 */
export async function awaitStagedAppExit(closed, { timeoutMs = 15000 } = {}) {
  const exit = await waitForClose(closed, timeoutMs);
  assert.equal(
    exit.code,
    0,
    `staged app exited ${exit.code ?? exit.signal}\n${exit.output ?? ""}`,
  );
  return exit;
}

async function waitForClose(closed, timeoutMs = 15000) {
  const state = await Promise.race([
    closed,
    delay(timeoutMs).then(() => {
      throw new Error(`staged app did not close within ${timeoutMs}ms after reporting`);
    }),
  ]);
  const normalized = normalizedClosedState(state);
  if (normalized.kind === "error") throw closedFailure(normalized);
  return normalized;
}

export async function cleanupSmokeStaging({
  rootIdentity,
  spawnProvenance = null,
  stagingRoot,
  terminate = terminateNativeProcessTree,
  remove = (target) => fs.rm(target, { force: true, recursive: true }),
}) {
  const errors = [];
  if (rootIdentity !== null || spawnProvenance !== null) {
    try {
      await terminate(rootIdentity, stagingRoot, spawnProvenance ?? {});
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await remove(stagingRoot);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "staged process and directory cleanup both failed");
}

// Runs inside the window the packaged app holds open for this snapshot, so the
// whole set is bound in one shell round trip rather than one per process.
function bindVisibleProcesses(processes) {
  return bindNativeProcessIdentities(processes);
}

export async function smokePackagedApp(platform, candidate, options = {}) {
  const mode = options.mode ?? "static";
  assert.equal(["static", "behavior", "layout"].includes(mode), true, `unsupported smoke mode: ${mode}`);
  if (mode === "behavior") {
    assert.equal(platform, "macos", "#111 behavior smoke is qualified only on native macOS");
  }
  const verify = options.verify ?? verifyPackagedApp;
  const packageReport = verify(platform, candidate);
  const layout = platformLayout(platform);
  const sourceApp = path.join(projectRoot, packageReport.artifact);
  const { stagingRoot, sourceRoot } = await createExternalStagingRoot({
    tempBase: options.tempBase,
    sourceRoot: projectRoot,
  });
  let appIdentity = null;
  let spawnProvenance = null;
  let completedReport = null;
  let primaryError = null;
  // Held across the try so a failing assertion still releases the app instead of
  // leaving it parked until the lease cap expires.
  let releaseLease = async () => {};

  try {
    const stagedApp = platform === "macos"
      ? path.join(stagingRoot, "RoleWeave Staging.app")
      : path.join(stagingRoot, "RoleWeave Staging");
    assert.equal(stagedApp.includes(" "), true, "clean staging path must exercise spaces");
    await fs.cp(sourceApp, stagedApp, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const canonicalStagedApp = await canonicalDirectory(stagedApp, "copied staged app");
    assertDisjointFromSource(sourceRoot, canonicalStagedApp, "copied staged app");

    const resources = path.join(canonicalStagedApp, layout.resourcesRelative);
    const workspace = path.join(stagingRoot, "workspace");
    await fs.cp(path.join(resources, "examples", "oss-maintainer"), workspace, { recursive: true });
    for (const directory of [
      path.join(stagingRoot, "empty-path"),
      path.join(stagingRoot, "home"),
      path.join(stagingRoot, "home", "AppData", "Local"),
      path.join(stagingRoot, "home", "AppData", "Roaming"),
    ]) {
      await fs.mkdir(directory, { recursive: true });
    }

    const behaviorFixtures = mode === "behavior"
      ? await createBehaviorFixtures(stagingRoot)
      : null;
    const nonce = crypto.randomBytes(32).toString("hex");
    const reportPath = path.join(
      stagingRoot,
      mode === "static"
        ? "smoke-report.json"
        : mode === "behavior"
          ? "behavior-report.json"
          : "layout-report.json",
    );
    const launchEnvironment = mode === "layout"
      ? createLayoutLaunchEnvironment(platform, {
        stagingRoot,
        workspace,
        report: reportPath,
      })
      : mode === "static"
      ? createLaunchEnvironment(platform, {
        stagingRoot,
        workspace,
        report: reportPath,
        nonce,
      })
      : createBehaviorLaunchEnvironment({
        stagingRoot,
        workspace,
        report: reportPath,
        nonce,
        fixtures: behaviorFixtures,
      });
    for (const credential of [
      "ANTHROPIC_API_KEY",
      "QODER_PERSONAL_ACCESS_TOKEN",
      "ORG_WORKBENCH_BOOT_TOKEN",
      "ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI",
      "CSC_LINK",
      "WIN_CSC_LINK",
    ]) {
      assert.equal(credential in launchEnvironment, false, `smoke environment contains ${credential}`);
    }
    if (mode === "static") {
      assert.equal("ORG_WORKBENCH_PACKAGED_BEHAVIOR_SMOKE_REPORT" in launchEnvironment, false);
    } else {
      for (const key of [
        "ORG_WORKBENCH_PACKAGED_SMOKE_NONCE",
        "ORG_WORKBENCH_PACKAGED_SMOKE_REPORT",
        "ORG_WORKBENCH_PACKAGED_SMOKE_ROOT",
      ]) {
        assert.equal(key in launchEnvironment, false, `behavior smoke contains static control ${key}`);
      }
    }

    const executable = path.join(canonicalStagedApp, layout.executableRelative);
    const launch = options.launch ?? launchApp;
    // Taken before launch so it is already present when the app writes its report
    // and looks for it. Released once this harness is done reading the process tree.
    const lease = mode === "static" ? harnessLeasePath(reportPath) : null;
    if (lease !== null) await fs.writeFile(lease, "held\n", { flag: "wx" });
    releaseLease = async () => {
      if (lease === null) return;
      await fs.rm(lease, { force: true });
    };
    const { child, closed } = launch(executable, stagingRoot, launchEnvironment);
    assert.equal(Number.isInteger(child.pid), true, "staged app did not receive a process id");
    // Preserve the kernel-created detached group/origin before any identity
    // lookup. If a leader exits immediately after spawning a same-group child,
    // failure cleanup can still enumerate and bind that child without ever
    // signaling the now-stale raw leader PID.
    spawnProvenance = {
      originPid: child.pid,
      processGroup: process.platform === "win32" ? null : child.pid,
    };
    appIdentity = await waitForBoundProcessIdentity(child.pid);
    if (process.platform !== "win32") {
      assert.equal(appIdentity.pgid, appIdentity.pid, "staged app must own an isolated process group");
      const harness = await waitForBoundProcessIdentity(process.pid);
      assert.notEqual(appIdentity.pgid, harness.pgid, "staged app shares the harness process group");
    }

    const smoke = await waitForReport(reportPath, closed);
    assert.equal(smoke.ok, true, smoke.error ?? `packaged ${mode} smoke failed`);
    if (mode === "layout") {
      // #127 AC-004: the layout report feeds the cross-platform parity job;
      // a null layout means the two-column module never rendered. The layout
      // app exits right after writing its report, so the liveness/process-tree
      // proofs below (static/behavior only) are skipped for this mode.
      assert.notEqual(smoke.layout, null, "layout smoke did not measure the two-column org workspace");
      // #186: wait for the exit the comment above assumes, before the cleanup
      // below removes the tree the app is still holding open. Ordered before
      // `completedReport` is set on purpose: if the app does not close, the
      // failure path still has a process tree to terminate.
      await awaitStagedAppExit(closed);
      completedReport = { ...smoke };
      const layoutPublish = process.env.ORG_WORKBENCH_LAYOUT_REPORT_PUBLISH;
      if (layoutPublish) await fs.copyFile(reportPath, layoutPublish);
    } else {
    assert.equal(smoke.rendererMounted, true);
    assert.equal(smoke.preloadBridge, true);
    assert.equal(smoke.controlPlaneReady, true);
    assert.equal(Number.isInteger(smoke.serverPid), true);
    assert.equal(
      await fs.realpath(smoke.resourcesPath),
      await fs.realpath(path.dirname(resources)),
      "app reported the wrong resources path",
    );
    if (mode === "static") {
      assert.equal(smoke.schemaVersion, "org-workbench-packaged-smoke.v1");
      assert.equal(smoke.nonce, nonce, "smoke report nonce does not match the external reservation");
      assert.equal(smoke.appPid, appIdentity.pid);
      assert.equal(smoke.rendererEntryObserved, true);
      assert.equal(smoke.staticSmokeEntry, true);
      assert.equal(Number.isInteger(smoke.serverPort) && smoke.serverPort > 0, true);
    } else {
      assert.equal(smoke.schemaVersion, "org-workbench-packaged-behavior-smoke.v1");
      assert.equal(smoke.nonce, nonce, "behavior report nonce does not match the external reservation");
      for (const key of [
        "localStorageRoundTrip",
        "engineAvailable",
        "qoderReady",
        "workspaceOpen",
        "turnCompleted",
        "historyReadback",
        "sessionHistoryReadback",
      ]) {
        assert.equal(smoke[key], true, `behavior smoke did not prove ${key}`);
      }
      const qoderPid = Number.parseInt(
        (await fs.readFile(behaviorFixtures.qoderPidFile, "utf8")).trim(),
        10,
      );
      assert.equal(Number.isInteger(qoderPid) && qoderPid > 1, true, "Qoder fixture pid was not recorded");
    }

    // Liveness first, from outside the app, before anything reads the process table.
    const health = await probeControlPlane(smoke, closed);
    assert.equal(health.server.pid, smoke.serverPid, "control plane pid disagrees with the smoke report");

    const liveInventory = listNativeProcesses();
    const liveDescendants = descendantProcesses(liveInventory, appIdentity.pid);
    const liveIdentities = bindVisibleProcesses(liveDescendants);
    // The app is held open by the harness lease, so an empty descendant set here is a
    // real finding rather than a snapshot that arrived after the app closed.
    assert.notEqual(
      liveDescendants.length,
      0,
      "staged app reported no descendants while still held open",
    );
    const liveQoderDescendants = liveDescendants.filter(({ command }) => /qoder(?:-engine|cli)?|claude/i.test(command));
    assert.equal(
      liveQoderDescendants.length,
      0,
      `${mode} smoke left a Qoder/Claude/Host child alive after reporting`,
    );

    // Everything that needs the tree standing has been read; let the app close.
    await releaseLease();
    await awaitStagedAppExit(closed);
    const trackedIdentities = [appIdentity, ...liveIdentities];
    await waitForNoResidualProcesses(stagingRoot, trackedIdentities, {
      processGroup: process.platform === "win32" ? null : appIdentity.pgid,
    });

    const commonReport = {
      ok: true,
      platform,
      architecture: packageReport.architecture,
      artifact: packageReport.artifact,
      stagedOutsideSourceTree: !inside(sourceRoot, canonicalStagedApp),
      stagedPathHasSpaces: canonicalStagedApp.includes(" "),
      controlPlaneReady: true,
      trackedWorkbenchPid: true,
      trackedControlPlanePid: true,
      externalCredentialsForwarded: false,
      liveDescendants: liveDescendants.length,
      qoderDescendantsObservedAfterReport: liveQoderDescendants.length,
      knownResidualProcesses: 0,
    };
    completedReport = mode === "static"
      ? {
        schemaVersion: "org-workbench-clean-staging-smoke.v1",
        ...commonReport,
        rendererEntryObserved: true,
        staticSmokeEntry: true,
      }
      : {
        schemaVersion: "org-workbench-clean-staging-behavior-smoke.v1",
        ...commonReport,
        rendererMounted: true,
        preloadBridge: true,
        loginPathRecovered: true,
        nestedMcpResolvedViaRecoveredPath: true,
        loginShellEnvironmentImported: false,
        qoderReady: true,
        turnCompleted: true,
        historyReadback: true,
        sessionHistoryReadback: true,
      };
    }
  } catch (error) {
    primaryError = error;
  }

  // Release unconditionally: on the failure path the app is still waiting on it.
  try {
    await releaseLease();
  } catch {}

  let cleanupError = null;
  try {
    await cleanupSmokeStaging({
      rootIdentity: completedReport === null ? appIdentity : null,
      spawnProvenance: completedReport === null ? spawnProvenance : null,
      stagingRoot,
      terminate: options.terminate ?? terminateNativeProcessTree,
      remove: options.remove ?? ((target) => fs.rm(target, { force: true, recursive: true })),
    });
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError !== null && cleanupError !== null) {
    throw new AggregateError([primaryError, cleanupError], "staged smoke and cleanup both failed");
  }
  if (primaryError !== null) throw primaryError;
  if (cleanupError !== null) throw cleanupError;
  assert.notEqual(completedReport, null, "smoke completed without a report");
  assert.equal(await fs.stat(stagingRoot).then(() => false, () => true), true, "smoke staging cleanup failed");
  return { ...completedReport, stagingCleaned: true };
}

/**
 * Split `--mode <value>` out of the CLI arguments, leaving the positionals.
 *
 * Exported so the four real invocations are pinned by a test rather than only
 * by CI. The previous inline version filtered on `index !== modeIndex + 1`,
 * which with no `--mode` present means `index !== 0` — it dropped the platform,
 * and both `smoke:package:*` legs failed on `unsupported staging platform:
 * undefined` before staging anything. The guard is the whole fix: when there is
 * no flag there is nothing to remove.
 */
export function parseSmokeArgs(args) {
  const modeIndex = args.indexOf("--mode");
  if (modeIndex < 0) return { positional: [...args], mode: undefined };
  const mode = args[modeIndex + 1];
  const positional = args.filter(
    (_, index) => index !== modeIndex && index !== modeIndex + 1,
  );
  return { positional, mode };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { positional, mode } = parseSmokeArgs(process.argv.slice(2));
  const report = await smokePackagedApp(positional[0], positional[1], mode ? { mode } : {});
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

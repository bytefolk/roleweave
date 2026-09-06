/**
 * Detached macOS update helper. It is launched through the packaged Electron
 * binary with ELECTRON_RUN_AS_NODE=1, so it survives the old app exiting.
 * Every input is read from the 0600 request written by the main process; the
 * signed manifest and hash are checked again immediately before replacement.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { UPDATE_APP_NAME, UPDATE_ARCH, verifyUpdateManifest } = require("./update-trust.cjs");

const WAIT_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 120_000;

function fail(message) {
  throw new Error(message);
}

function isRegularFile(filePath) {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(directory) {
  try {
    return fs.lstatSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function assertAbsoluteAppPath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || !value.endsWith(".app")) fail(`${label} is invalid`);
  const normalized = path.normalize(value);
  if (normalized === "/" || normalized === path.dirname(normalized)) fail(`${label} is invalid`);
  let stat;
  try {
    stat = fs.lstatSync(normalized);
  } catch {
    fail(`${label} does not exist`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real app directory`);
  return normalized;
}

function assertPrivateRequest(requestPath) {
  if (typeof requestPath !== "string" || !path.isAbsolute(requestPath) || path.basename(requestPath) !== "request.json") fail("update request path is invalid");
  const stat = fs.lstatSync(requestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail("update request must be a private regular file");
}

async function waitForExit(pid, timeoutMs = WAIT_TIMEOUT_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) fail("update parent PID is invalid");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await sleep(100);
  }
  fail("the previous app process did not exit in time");
}

function runCommand(command, args, { spawnProcess = spawn, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { stdio: ["ignore", "ignore", "pipe"], shell: false });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${path.basename(command)} timed out`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-512);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} failed (${code ?? signal ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function assertNoUnsafeLinks(root, canonicalRoot = fs.realpathSync(root)) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const current = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      let resolved;
      try {
        resolved = fs.realpathSync(current);
      } catch {
        fail(`the extracted update contains a dangling link: ${entry.name}`);
      }
      const relative = path.relative(canonicalRoot, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        fail(`the extracted update contains a link outside the app bundle: ${entry.name}`);
      }
      continue;
    }
    if (entry.isDirectory()) assertNoUnsafeLinks(current, canonicalRoot);
  }
}

async function runMacUpdateHelper(
  requestPath,
  {
    spawnProcess = spawn,
    wait = waitForExit,
    tempDirectory = os.tmpdir(),
    open = true,
    verifyManifest = verifyUpdateManifest,
  } = {},
) {
  assertPrivateRequest(requestPath);
  let request;
  try {
    request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  } catch {
    fail("update request is not valid JSON");
  }
  if (request?.schemaVersion !== "org-workbench-update-request.v1") fail("unsupported update request schema");
  if (request.appName !== UPDATE_APP_NAME || request.arch !== UPDATE_ARCH) fail("update request targets an unexpected app");
  const targetAppPath = assertAbsoluteAppPath(request.targetAppPath, "target app");
  const manifestCheck = verifyManifest(request.manifest, { arch: request.arch });
  if (!manifestCheck.ok) fail(manifestCheck.reason);
  if (!isRegularFile(request.zipPath)) fail("downloaded update ZIP does not exist");
  const zipStat = fs.statSync(request.zipPath);
  if (zipStat.size !== request.manifest.size) fail("downloaded update ZIP size changed");
  if (await sha256File(request.zipPath) !== request.manifest.sha256) fail("downloaded update ZIP hash changed");

  await wait(request.parentPid);

  const extractionRoot = fs.mkdtempSync(path.join(tempDirectory, "org-workbench-update-extract-"));
  const incomingPath = path.join(path.dirname(targetAppPath), `.${UPDATE_APP_NAME}.update-${process.pid}`);
  const backupPath = path.join(path.dirname(targetAppPath), `.${UPDATE_APP_NAME}.backup-${process.pid}`);
  try {
    await runCommand("/usr/bin/ditto", ["-x", "-k", request.zipPath, extractionRoot], { spawnProcess });
    const sourceAppPath = path.join(extractionRoot, `${UPDATE_APP_NAME}.app`);
    if (!isDirectory(sourceAppPath)) fail("the update ZIP does not contain the expected app bundle");
    assertNoUnsafeLinks(sourceAppPath);
    if (fs.existsSync(incomingPath) || fs.existsSync(backupPath)) fail("an update staging path already exists");

    fs.cpSync(sourceAppPath, incomingPath, { recursive: true, force: false, errorOnExist: true });
    fs.renameSync(targetAppPath, backupPath);
    try {
      fs.renameSync(incomingPath, targetAppPath);
    } catch (error) {
      if (!fs.existsSync(targetAppPath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, targetAppPath);
      throw error;
    }
    // The old app is no longer needed. Failure to remove this private backup
    // does not invalidate the already completed replacement.
    try {
      fs.rmSync(backupPath, { recursive: true, force: true });
    } catch {
      // The next successful update can remove stale backups in this directory.
    }
    if (open) {
      const child = spawnProcess("/usr/bin/open", [targetAppPath], { detached: true, stdio: "ignore", shell: false });
      child.unref?.();
    }
  } finally {
    try {
      if (fs.existsSync(incomingPath)) fs.rmSync(incomingPath, { recursive: true, force: true });
    } catch {
      // Best effort after a failed copy.
    }
    try {
      fs.rmSync(extractionRoot, { recursive: true, force: true });
    } catch {
      // Best effort; the downloaded directory is private and bounded.
    }
    try {
      fs.rmSync(path.dirname(requestPath), { recursive: true, force: true });
    } catch {
      // Best effort after the replacement outcome is known.
    }
  }
  return { ok: true, version: request.manifest.version };
}

if (require.main === module) {
  runMacUpdateHelper(process.argv[2])
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

module.exports = {
  assertAbsoluteAppPath,
  assertNoLinks: assertNoUnsafeLinks,
  assertNoUnsafeLinks,
  runMacUpdateHelper,
  sha256File,
  waitForExit,
};

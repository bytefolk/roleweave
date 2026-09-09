const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MARKER_FILE = ".owb-notarization-ran";
const NOTARIZATION_SECRET_ENV_NAMES = Object.freeze([
  "MACOS_CERTIFICATE",
  "MACOS_CERTIFICATE_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
]);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function notarizationSettings(env = process.env) {
  const required = [
    ["APPLE_ID", env.APPLE_ID],
    ["APPLE_APP_SPECIFIC_PASSWORD", env.APPLE_APP_SPECIFIC_PASSWORD],
    ["APPLE_TEAM_ID", env.APPLE_TEAM_ID],
  ];
  const missing = required.filter(([, value]) => typeof value !== "string" || value.length === 0).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`missing macOS notarization credentials: ${missing.join(", ")}`);
  }
  return {
    appleId: env.APPLE_ID,
    password: env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: env.APPLE_TEAM_ID,
    keychain: typeof env.OWB_NOTARIZATION_KEYCHAIN === "string" && env.OWB_NOTARIZATION_KEYCHAIN.length > 0
      ? env.OWB_NOTARIZATION_KEYCHAIN
      : null,
    profileName: env.OWB_NOTARIZATION_PROFILE || "org-workbench-notarization",
    attempts: positiveInteger(env.OWB_NOTARIZATION_ATTEMPTS, DEFAULT_ATTEMPTS),
    timeoutMs: positiveInteger(env.OWB_NOTARIZATION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

function childProcessEnvironment(env = process.env) {
  const childEnv = { ...env };
  for (const name of NOTARIZATION_SECRET_ENV_NAMES) delete childEnv[name];
  return childEnv;
}

function runProcess(command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      // The notarization commands do not need the credentials in their
      // environment. Keep the Apple secrets in the hook process only; the
      // profile-backed submit below avoids putting the app-specific password
      // in a child argv as well.
      env: childProcessEnvironment(),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input !== undefined) child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function assertSuccessful(result, operation) {
  if (result?.code !== 0) throw new Error(`${operation} failed`);
}

function parseNotarytoolResult(stdout) {
  try {
    const result = JSON.parse(stdout.trim());
    return result?.status === "Accepted";
  } catch {
    return false;
  }
}

async function notarizeOnce(appPath, settings, runner = runProcess) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-notarization-"));
  const zipPath = path.join(tempDir, `${path.basename(appPath, ".app")}.zip`);
  try {
    const zipped = await runner(
      "ditto",
      ["-c", "-k", "--sequesterRsrc", "--keepParent", path.basename(appPath), zipPath],
      { cwd: path.dirname(appPath), timeoutMs: settings.timeoutMs },
    );
    assertSuccessful(zipped, "preparing the notarization archive");

    const submitArgs = ["notarytool", "submit", zipPath];
    if (settings.keychain) {
      submitArgs.push("--keychain-profile", settings.profileName, "--keychain", settings.keychain);
    } else {
      // Keep the helper independently usable for local callers/tests that do
      // not provide a temporary keychain. The release workflow always uses
      // the profile-backed branch above.
      submitArgs.push(
        "--apple-id",
        settings.appleId,
        "--password",
        settings.password,
        "--team-id",
        settings.teamId,
      );
    }
    submitArgs.push("--wait", "--output-format", "json");
    const submitted = await runner("xcrun", submitArgs, { timeoutMs: settings.timeoutMs });
    if (submitted?.code !== 0 || !parseNotarytoolResult(submitted.stdout)) {
      throw new Error("Apple did not accept the notarization request");
    }

    const stapled = await runner(
      "xcrun",
      ["stapler", "staple", "-q", appPath],
      { timeoutMs: settings.timeoutMs },
    );
    assertSuccessful(stapled, "stapling the notarization ticket");

    const validated = await runner(
      "xcrun",
      ["stapler", "validate", "-q", appPath],
      { timeoutMs: settings.timeoutMs },
    );
    assertSuccessful(validated, "validating the stapled notarization ticket");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function prepareNotarizationCredentials(settings, runner = runProcess) {
  if (!settings.keychain) return;
  const result = await runner(
    "xcrun",
    [
      "notarytool",
      "store-credentials",
      settings.profileName,
      "--apple-id",
      settings.appleId,
      "--team-id",
      settings.teamId,
      "--keychain",
      settings.keychain,
    ],
    {
      timeoutMs: settings.timeoutMs,
      // notarytool prompts for the app-specific password when --password is
      // omitted. It never appears in argv or in a workflow log.
      input: `${settings.password}\n`,
    },
  );
  assertSuccessful(result, "storing the notarization credentials");
}

async function notarizeWithRetry(appPath, settings, runner = runProcess, log = console) {
  let lastError = null;
  for (let attempt = 1; attempt <= settings.attempts; attempt += 1) {
    log.log(`macOS notarization attempt ${attempt}/${settings.attempts}`);
    try {
      await notarizeOnce(appPath, settings, runner);
      return { attempts: attempt, ticketStapled: true };
    } catch (error) {
      lastError = error;
      if (attempt < settings.attempts) log.warn(`macOS notarization attempt ${attempt} failed; retrying`);
    }
  }
  throw new Error(`macOS notarization failed after ${settings.attempts} attempts: ${lastError?.message ?? "unknown error"}`);
}

function findApp(appOutDir) {
  const app = fs.readdirSync(appOutDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (!app) throw new Error(`no macOS app bundle found in ${appOutDir}`);
  return path.join(appOutDir, app.name);
}

async function notarizeMacos(context) {
  if (context?.electronPlatformName !== "darwin" || process.env.OWB_MAC_SIGNED_BUILD !== "true") return;
  const appPath = findApp(context.appOutDir);
  const settings = notarizationSettings();
  await prepareNotarizationCredentials(settings);
  const result = await notarizeWithRetry(appPath, settings);
  fs.writeFileSync(path.join(context.appOutDir, MARKER_FILE), `${new Date().toISOString()}\n`, { mode: 0o600 });
  return result;
}

module.exports = {
  DEFAULT_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  MARKER_FILE,
  NOTARIZATION_SECRET_ENV_NAMES,
  childProcessEnvironment,
  findApp,
  notarizationSettings,
  notarizeMacos,
  notarizeOnce,
  notarizeWithRetry,
  prepareNotarizationCredentials,
  parseNotarytoolResult,
  runProcess,
};

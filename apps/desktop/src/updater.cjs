/**
 * In-app update, gated by what each platform can actually deliver and by the
 * requirement-decision on #110.
 *
 * The platforms are not symmetric. Squirrel.Mac refuses an update whose
 * signature does not match the installed app, and Gatekeeper blocks an unsigned
 * first launch, so the native macOS updater requires a Developer ID build
 * (#135). The default free macOS channel uses its own signed manifest; Windows
 * has no such native precondition.
 *
 * The Windows path below still follows the #110 R3 decision and uses
 * electron-updater's publisher verification. macOS has a separate free path
 * in macos-github-updater.cjs: its release metadata is verified by an embedded
 * Ed25519 public key before a detached helper replaces the bundle. A later
 * Developer ID rollout can switch macOS back to Squirrel.Mac explicitly.
 *
 * What unsigned costs, measured from electron-updater 6.8.9: `NsisUpdater`
 * skips signature verification entirely when `publisherName` is absent from
 * `app-update.yml`, which it is for an unsigned build -- `verifySignature`
 * returns null and the caller treats null as a pass. So the only integrity
 * guarantee on an unsigned Windows update is the SHA512 in `latest.yml` fetched
 * over HTTPS; there is no publisher pinning. The macOS path does not use that
 * metadata: it verifies `latest-mac.json` with the embedded Ed25519 key before
 * any ZIP is opened or copied. Once #136 signs Windows, `publisherName` appears
 * and NsisUpdater enforces the pinning itself.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createMacGithubUpdaterService } = require("./macos-github-updater.cjs");

/** Resolve the installed product bundle, without mistaking development Electron for it. */
function defaultMacAppPath(resourcesPath = process.resourcesPath, execPath = process.execPath) {
  if (typeof resourcesPath === "string" && resourcesPath.length > 0) {
    const appPath = path.resolve(resourcesPath, "..", "..");
    if (appPath.endsWith(".app")) return appPath;
  }
  if (typeof execPath === "string") {
    const marker = ".app/Contents/";
    const contentsIndex = execPath.indexOf(marker);
    if (contentsIndex >= 0) {
      const appPath = execPath.slice(0, contentsIndex + ".app".length);
      // A source-tree run uses Electron.app. It is not the product being
      // updated, even if that development binary happens to carry a signature.
      if (!appPath.endsWith("/Electron.app")) return appPath;
    }
  }
  return null;
}

/** Read the native macOS signature details. `codesign -dv` writes them to stderr. */
function inspectMacCodeSignature(appPath) {
  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status,
    error: result.error ?? null,
    signal: result.signal ?? null,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * macOS has no useful `publisherName` in `app-update.yml`: Squirrel.Mac uses
 * the native bundle signature. Require a Developer ID authority and team ID,
 * and explicitly reject the ad-hoc signature used by staging builds.
 */
function readMacBuildSignature({ appPath = defaultMacAppPath(), inspect = inspectMacCodeSignature } = {}) {
  const unsigned = {
    signed: false,
    reason: "this build is not signed with a Developer ID Application certificate",
  };
  if (typeof appPath !== "string" || appPath.length === 0) {
    return { signed: false, reason: "no packaged macOS app path; this is a source-tree run" };
  }

  let result;
  try {
    result = inspect(appPath);
  } catch {
    return unsigned;
  }
  if (result?.status !== 0 || result?.error != null || result?.signal != null) return unsigned;
  const output = typeof result.output === "string" ? result.output : "";
  const hasDeveloperIdAuthority = /^Authority=Developer ID Application: .+$/m.test(output);
  const hasTeamIdentifier = /^TeamIdentifier=[A-Z0-9]+$/m.test(output);
  const isAdHoc = /^Signature=adhoc$/m.test(output);
  return hasDeveloperIdAuthority && hasTeamIdentifier && !isAdHoc ? { signed: true } : unsigned;
}

/**
 * Whether this build carries a publisher identity, read from the same file
 * electron-updater reads on Windows: `app-update.yml`, which electron-builder
 * writes from the signing configuration.
 */
function readBuildSignature({
  platform = null,
  resourcesPath = process.resourcesPath,
  appPath = null,
  inspect = inspectMacCodeSignature,
} = {}) {
  if (platform === "darwin") {
    return readMacBuildSignature({
      appPath: appPath ?? defaultMacAppPath(resourcesPath),
      inspect,
    });
  }
  if (typeof resourcesPath !== "string" || resourcesPath.length === 0) {
    return { signed: false, reason: "no packaged resources path; this is a source-tree run" };
  }
  const configPath = path.join(resourcesPath, "app-update.yml");
  let contents;
  try {
    contents = fs.readFileSync(configPath, "utf8");
  } catch {
    return { signed: false, reason: "this build carries no update configuration" };
  }
  // A targeted read rather than a YAML parse. electron-builder writes the key
  // either inline or as a block list, and both are valid identities; an empty
  // key is not. `\s*` would cross the newline and read the following key's value
  // as this one's, so the two forms are distinguished explicitly.
  const unsigned = {
    signed: false,
    reason: "this build is unsigned, so a downloaded update could not be verified",
  };
  const declaration = /^publisherName:[ \t]*(.*)$/m.exec(contents);
  if (declaration === null) return unsigned;
  if (declaration[1].trim().length > 0) return { signed: true };
  const following = contents
    .slice(declaration.index + declaration[0].length)
    .split("\n")
    .find((line) => line.trim().length > 0);
  return /^[ \t]+-/.test(following ?? "") ? { signed: true } : unsigned;
}

const UNSIGNED_REFUSAL =
  "Updates are download-only once this build is signed. This build carries no publisher identity, so an update cannot be verified before it replaces the app. Download the new version from the release page instead. Tracked in #135 (macOS) and #136 (Windows).";

const UNAVAILABLE_REASONS = Object.freeze({
  darwin:
    "In-app update needs a Developer ID signed build. Squirrel.Mac refuses an update whose signature does not match the installed app. Tracked in #135.",
  linux:
    "This build has no Linux release channel. Install and update through the source tree.",
});

/**
 * Whether in-app update can work on this platform, and if not, what to tell the
 * person looking at it. A reason is always a sentence a user can act on, never a
 * bare capability flag.
 */
function updateChannelAvailability(platform = process.platform, signature = null) {
  // `requiresConfirmation` is not advice to the caller, it is a statement about
  // what this service will refuse. It exists so a UI can render the prompt
  // rather than discover the refusal.
  if (platform === "win32") return { available: true, requiresConfirmation: true };
  if (platform === "darwin" && signature?.signed === true) {
    return { available: true, requiresConfirmation: true };
  }
  const reason = UNAVAILABLE_REASONS[platform]
    ?? "In-app update is not available for this platform.";
  return { available: false, reason };
}

/** Terminal and progress states the service reports. */
const UPDATE_STATES = Object.freeze([
  "idle",
  "unavailable",
  "checking",
  "current",
  "available",
  "downloading",
  "downloaded",
  "error",
]);

function normalizedError(error) {
  if (error === null || error === undefined) return "update failed for an unstated reason";
  const message = typeof error === "string" ? error : error.message;
  return String(message ?? error).slice(0, 512);
}

/**
 * Wraps an electron-updater instance. The updater is injected rather than
 * imported so the state machine is testable without Electron, and so the
 * unavailable platforms never construct one.
 */
function createUpdaterService({
  updater,
  platform = process.platform,
  signature = null,
  onState = () => {},
  logger = null,
  unavailableReason = null,
} = {}) {
  // Read rather than defaulted, so a caller cannot forget to pass it and
  // silently get the permissive behaviour. macOS uses codesign metadata;
  // Windows uses the publisherName that NsisUpdater itself verifies.
  const build = signature ?? readBuildSignature({ platform });
  const availability = unavailableReason === null
    ? updateChannelAvailability(platform, build)
    : { available: false, reason: unavailableReason };
  let state = availability.available ? "idle" : "unavailable";

  const publish = (next, detail = {}) => {
    state = next;
    onState({ state: next, ...detail });
  };

  if (!availability.available) {
    return {
      get state() { return state; },
      availability,
      build,
      updateVerified: false,
      async check() {
        publish("unavailable", { reason: availability.reason });
        return { state: "unavailable", reason: availability.reason };
      },
      async install() {
        return { state: "unavailable", reason: availability.reason };
      },
      async download() {
        return { state: "unavailable", reason: availability.reason };
      },
    };
  }

  if (updater === null || updater === undefined) {
    throw new Error("an available update channel requires an updater instance");
  }

  // Explicit confirmation is a user gesture, not a verification. Without a
  // publisher identity neither NsisUpdater nor the person clicking can tell a
  // legitimate installer from a substituted one, so the apply paths stay closed
  // while check stays open -- knowing a new version exists is still useful.
  const refuseUnsigned = () => ({ state, reason: UNSIGNED_REFUSAL, unsigned: true });

  // Nothing is downloaded or installed without an explicit request. An update
  // that installs itself while someone is mid-turn is a data-loss risk, not a
  // convenience.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  if (logger !== null) updater.logger = logger;

  updater.on?.("update-available", (info) => publish("available", { version: info?.version ?? null }));
  updater.on?.("update-not-available", () => publish("current"));
  updater.on?.("download-progress", (progress) => publish("downloading", {
    percent: typeof progress?.percent === "number" ? Math.round(progress.percent) : null,
  }));
  updater.on?.("update-downloaded", (info) => publish("downloaded", { version: info?.version ?? null }));
  updater.on?.("error", (error) => publish("error", { reason: normalizedError(error) }));

  return {
    get state() { return state; },
    availability,
    build,
    updateVerified: build.signed === true,

    async check() {
      publish("checking");
      try {
        const result = await updater.checkForUpdates();
        // The event handlers above have already moved the state; the return
        // value is the caller's receipt, not a second source of truth.
        return { state, version: result?.updateInfo?.version ?? null };
      } catch (error) {
        publish("error", { reason: normalizedError(error) });
        return { state: "error", reason: normalizedError(error) };
      }
    },

    async download({ confirmedByUser = false } = {}) {
      if (!build.signed) return refuseUnsigned();
      // #110 R3: nothing may happen without an explicit request.
      if (confirmedByUser !== true) {
        return { state, reason: "downloading an update requires explicit confirmation" };
      }
      if (state !== "available") {
        return { state, reason: "no update is available to download" };
      }
      try {
        await updater.downloadUpdate();
        return { state };
      } catch (error) {
        publish("error", { reason: normalizedError(error) });
        return { state: "error", reason: normalizedError(error) };
      }
    },

    async install({ confirmedByUser = false } = {}) {
      if (!build.signed) return refuseUnsigned();
      // Installing restarts the app, so this is the step most likely to lose
      // someone's work if it happens without being asked for.
      if (confirmedByUser !== true) {
        return { state, reason: "installing an update requires explicit confirmation" };
      }
      if (state !== "downloaded") {
        return { state, reason: "no downloaded update is ready to install" };
      }
      updater.quitAndInstall();
      return { state: "downloaded", installing: true };
    },
  };
}

/**
 * Build the service, loading the updater only where a channel exists and never
 * letting that load fail the caller.
 *
 * The loader is passed in rather than required here so this is testable, and so
 * the failure is contained: the app's window must not depend on an optional
 * update check. A missing or unloadable vendored bundle degrades to a service
 * that explains itself, exactly as an unsupported platform does.
 */
function startUpdaterService({
  loadUpdater,
  platform = process.platform,
  signature = null,
  onState = () => {},
  currentVersion = null,
  arch = process.arch,
  appPath = null,
  execPath = process.execPath,
  helperPath = path.join(__dirname, "macos-update-helper.cjs"),
  parentPid = process.pid,
  quit = null,
} = {}) {
  const build = signature ?? readBuildSignature({ platform });
  // Native Squirrel.Mac remains an explicit future opt-in for a Developer ID
  // build. A real Developer ID signature also selects it automatically; the
  // environment flag exists for an explicit rollout/rollback switch. The
  // default unsigned build uses the free GitHub-signed channel.
  if (platform === "darwin" && process.env.OWB_NATIVE_MAC_UPDATES !== "true" && !build.signed) {
    return createMacGithubUpdaterService({
      currentVersion: currentVersion ?? "0.0.0",
      appPath: appPath ?? defaultMacAppPath(),
      arch,
      onState,
      execPath,
      helperPath,
      parentPid,
      quit,
    });
  }
  const availability = updateChannelAvailability(platform, build);
  if (!availability.available) {
    return createUpdaterService({ updater: null, platform, signature: build, onState });
  }
  let updater;
  try {
    updater = loadUpdater();
  } catch (error) {
    return createUpdaterService({
      updater: null,
      platform: "unsupported",
      signature: build,
      onState,
      unavailableReason: `the update component could not be loaded: ${normalizedError(error)}`,
    });
  }
  return createUpdaterService({ updater, platform, signature: build, onState });
}

module.exports = {
  UNSIGNED_REFUSAL,
  UPDATE_STATES,
  createUpdaterService,
  defaultMacAppPath,
  inspectMacCodeSignature,
  readMacBuildSignature,
  readBuildSignature,
  startUpdaterService,
  updateChannelAvailability,
};

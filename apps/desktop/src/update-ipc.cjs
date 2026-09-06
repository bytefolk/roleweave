// Update IPC bounding (#134).
//
// The updater service (#133, updater.cjs) speaks in rich objects: an
// electron-updater instance, a build signature, platform availability. None of
// that may cross the preload bridge. These functions project the service onto a
// closed set of primitive fields, so the renderer receives what it needs to
// render and nothing it could act on.
//
// Kept electron-free and pure so it is unit-testable without a BrowserWindow,
// mirroring window-ipc.cjs / drive-ipc.cjs.

const { UPDATE_STATES } = require("./updater.cjs");

/** The changelog target. Fixed here rather than accepted from the renderer:
 * `shell.openExternal` with a caller-supplied URL is an arbitrary-navigation
 * capability, and this surface only ever needs the one page. */
const RELEASE_PAGE_URL = "https://github.com/bytefolk/org-workbench/releases";

/** Platforms the renderer is allowed to know about, for localizing an
 * unavailability reason. Anything else collapses to "other" rather than
 * forwarding a raw `process.platform` value. */
function boundedPlatform(platform) {
  if (platform === "win32" || platform === "darwin" || platform === "linux") return platform;
  return "other";
}

function isKnownState(state) {
  return typeof state === "string" && UPDATE_STATES.includes(state);
}

function boundedReason(reason) {
  if (typeof reason !== "string" || reason.length === 0) return null;
  // The service already truncates its own error text; this bounds a reason
  // arriving from anywhere else in the same way.
  return reason.slice(0, 512);
}

function boundedVersion(version) {
  if (typeof version !== "string" || version.length === 0) return null;
  return version.slice(0, 64);
}

function boundedPercent(percent) {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/**
 * One state event from the service's `onState`, projected for the renderer.
 * An unrecognized state is dropped rather than forwarded: the pane renders a
 * fixed set of states, and a state it has no copy for would render as nothing
 * while looking like it had been handled.
 *
 * @returns {{ state: string, reason: string|null, version: string|null, percent: number|null }|null}
 */
function boundedUpdateState(event) {
  if (event === null || typeof event !== "object") return null;
  if (!isKnownState(event.state)) return null;
  return {
    state: event.state,
    reason: boundedReason(event.reason),
    version: boundedVersion(event.version),
    percent: boundedPercent(event.percent),
  };
}

/**
 * A `check` / `download` / `install` return value, projected for the renderer.
 * `unsigned` and `installing` are the two markers the service sets that are not
 * states; they are carried as booleans so the pane can localize its own copy
 * instead of printing the service's English sentence.
 */
function boundedUpdateResult(result) {
  if (result === null || typeof result !== "object") {
    return { state: "error", reason: "the update service returned nothing", version: null, percent: null, unsigned: false, installing: false };
  }
  return {
    state: isKnownState(result.state) ? result.state : "error",
    reason: boundedReason(result.reason),
    version: boundedVersion(result.version),
    percent: boundedPercent(result.percent),
    unsigned: result.unsigned === true,
    installing: result.installing === true,
  };
}

/**
 * The pane's opening snapshot: what version is running, whether this platform
 * has a channel at all, whether this build carries a publisher identity, and
 * the reason when it does not.
 *
 * `signed: false` only describes native platform signing. `updateVerified`
 * describes the independent release-signature check used by the free macOS
 * channel, so an unsigned app can still update safely through that channel.
 */
function updateStatusPayload({ service, version, platform } = {}) {
  const runningVersion = boundedVersion(version);
  if (service === null || service === undefined) {
    return {
      version: runningVersion,
      state: "unavailable",
      available: false,
      requiresConfirmation: false,
      signed: false,
      updateVerified: false,
      reason: "the update service is not running",
      platform: boundedPlatform(platform),
    };
  }
  const availability = service.availability ?? {};
  const build = service.build ?? {};
  const available = availability.available === true;
  return {
    version: runningVersion,
    state: isKnownState(service.state) ? service.state : (available ? "idle" : "unavailable"),
    available,
    requiresConfirmation: availability.requiresConfirmation === true,
    signed: build.signed === true,
    updateVerified: service.updateVerified === true,
    // On an available platform the interesting reason is the signing one; on an
    // unavailable platform it is the platform one. Never both, never neither.
    reason: boundedReason(available ? build.reason : availability.reason),
    platform: boundedPlatform(platform),
  };
}

/** A renderer request for download/install carries the confirmation explicitly.
 * Fabricating it here would make the service's guard vacuous: a renderer bug
 * that calls download() without asking would silently start a download. */
function confirmedByUser(request) {
  return request !== null && typeof request === "object" && request.confirmedByUser === true;
}

module.exports = {
  RELEASE_PAGE_URL,
  boundedPlatform,
  boundedUpdateResult,
  boundedUpdateState,
  confirmedByUser,
  updateStatusPayload,
};

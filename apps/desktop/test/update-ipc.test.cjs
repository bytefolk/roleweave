// #134 AC-005: the update bridge is bounded. These assert on the projection
// itself rather than on a running BrowserWindow, matching window-ipc.test.cjs.

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  RELEASE_PAGE_URL,
  boundedPlatform,
  boundedUpdateResult,
  boundedUpdateState,
  confirmedByUser,
  updateStatusPayload,
} = require("../src/update-ipc.cjs");

describe("update state projection", () => {
  it("carries the four fields a pane renders and drops everything else", () => {
    const bounded = boundedUpdateState({
      state: "downloading",
      percent: 41.6,
      version: "0.2.0",
      reason: null,
      // Anything the service or the library might add later must not ride along.
      updater: { quitAndInstall() {} },
      files: ["/Users/someone/Library/Caches/org-workbench-updater/pending"],
    });
    assert.deepEqual(bounded, {
      state: "downloading",
      reason: null,
      version: "0.2.0",
      percent: 42,
    });
  });

  it("drops an unrecognized state rather than forwarding it", () => {
    // A pane has no copy for a state it does not know, so forwarding one would
    // render as nothing while looking handled.
    assert.equal(boundedUpdateState({ state: "verifying" }), null);
    assert.equal(boundedUpdateState({ state: "" }), null);
    assert.equal(boundedUpdateState(null), null);
    assert.equal(boundedUpdateState("downloaded"), null);
  });

  it("clamps a percent and truncates a reason", () => {
    assert.equal(boundedUpdateState({ state: "downloading", percent: -3 }).percent, 0);
    assert.equal(boundedUpdateState({ state: "downloading", percent: 140 }).percent, 100);
    assert.equal(boundedUpdateState({ state: "downloading", percent: "40" }).percent, null);
    const long = boundedUpdateState({ state: "error", reason: "x".repeat(900) });
    assert.equal(long.reason.length, 512);
  });
});

describe("update result projection", () => {
  it("keeps the two markers that are not states", () => {
    const refusal = boundedUpdateResult({
      state: "available",
      reason: "Updates are download-only once this build is signed.",
      unsigned: true,
    });
    assert.equal(refusal.state, "available");
    assert.equal(refusal.unsigned, true);
    assert.equal(refusal.installing, false);

    const installing = boundedUpdateResult({ state: "downloaded", installing: true });
    assert.equal(installing.installing, true);
    assert.equal(installing.unsigned, false);
  });

  it("reports an error rather than inventing a state", () => {
    assert.equal(boundedUpdateResult(null).state, "error");
    assert.equal(boundedUpdateResult({ state: "sideways" }).state, "error");
    // Truthiness is not enough: only an exact true sets a marker.
    assert.equal(boundedUpdateResult({ state: "idle", unsigned: "yes" }).unsigned, false);
  });
});

describe("status payload", () => {
  const windowsUnsigned = {
    state: "idle",
    availability: { available: true, requiresConfirmation: true },
    build: { signed: false, reason: "this build is unsigned, so a downloaded update could not be verified" },
  };

  it("reports an available channel with an unsigned build, and why", () => {
    const payload = updateStatusPayload({
      service: windowsUnsigned,
      version: "0.1.0",
      platform: "win32",
    });
    assert.deepEqual(payload, {
      version: "0.1.0",
      state: "idle",
      available: true,
      requiresConfirmation: true,
      signed: false,
      updateVerified: false,
      reason: "this build is unsigned, so a downloaded update could not be verified",
      platform: "win32",
    });
  });

  it("keeps the free macOS channel open when native code signing is absent", () => {
    const payload = updateStatusPayload({
      service: {
        state: "idle",
        availability: { available: true, requiresConfirmation: false },
        build: { signed: false, reason: null },
        updateVerified: true,
      },
      version: "0.1.0",
      platform: "darwin",
    });
    assert.equal(payload.available, true);
    assert.equal(payload.signed, false);
    assert.equal(payload.updateVerified, true);
    assert.equal(payload.reason, null);
  });

  it("reports the platform reason where there is no channel", () => {
    const payload = updateStatusPayload({
      service: {
        state: "unavailable",
        availability: { available: false, reason: "In-app update needs a Developer ID signed build." },
        build: { signed: false, reason: "this build is unsigned" },
      },
      version: "0.1.0",
      platform: "darwin",
    });
    assert.equal(payload.available, false);
    assert.equal(payload.state, "unavailable");
    assert.equal(payload.updateVerified, false);
    // The platform reason wins here: the signing one is not why the pane is closed.
    assert.equal(payload.reason, "In-app update needs a Developer ID signed build.");
  });

  it("says the service is not running rather than claiming a state", () => {
    const payload = updateStatusPayload({ service: null, version: "0.1.0", platform: "win32" });
    assert.equal(payload.state, "unavailable");
    assert.equal(payload.available, false);
    assert.equal(payload.signed, false);
    assert.equal(payload.updateVerified, false);
    assert.match(payload.reason, /not running/);
  });

  it("never forwards a raw platform value", () => {
    assert.equal(boundedPlatform("freebsd"), "other");
    assert.equal(boundedPlatform(undefined), "other");
    assert.equal(boundedPlatform("darwin"), "darwin");
    assert.equal(
      updateStatusPayload({ service: windowsUnsigned, version: "0.1.0", platform: "aix" }).platform,
      "other",
    );
  });

  it("does not leak the service object through the payload", () => {
    const payload = updateStatusPayload({
      service: { ...windowsUnsigned, updater: { quitAndInstall() {} } },
      version: "0.1.0",
      platform: "win32",
    });
    assert.deepEqual(Object.keys(payload).sort(), [
      "available",
      "platform",
      "reason",
      "requiresConfirmation",
      "signed",
      "state",
      "updateVerified",
      "version",
    ]);
  });
});

describe("confirmation forwarding", () => {
  it("only an exact true counts as a confirmation", () => {
    // The service refuses an unconfirmed apply. If this fabricated or coerced
    // the flag, a renderer bug would become an update installing itself.
    assert.equal(confirmedByUser({ confirmedByUser: true }), true);
    assert.equal(confirmedByUser({ confirmedByUser: "true" }), false);
    assert.equal(confirmedByUser({ confirmedByUser: 1 }), false);
    assert.equal(confirmedByUser({}), false);
    assert.equal(confirmedByUser(null), false);
    assert.equal(confirmedByUser(undefined), false);
  });
});

describe("changelog target", () => {
  it("is a fixed https release page, not a renderer-supplied URL", () => {
    assert.equal(RELEASE_PAGE_URL, "https://github.com/bytefolk/org-workbench/releases");
    assert.match(RELEASE_PAGE_URL, /^https:\/\//);
  });
});

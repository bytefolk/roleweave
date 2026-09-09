const assert = require("node:assert/strict");
const test = require("node:test");
const {
  UPDATE_STATES,
  createUpdaterService,
  readMacBuildSignature,
  startUpdaterService,
  updateChannelAvailability,
} = require("../src/updater.cjs");

/** A stand-in for electron-updater: records what was asked of it, emits on demand. */
function fakeUpdater() {
  const listeners = new Map();
  const calls = [];
  return {
    calls,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on(event, handler) { listeners.set(event, handler); return this; },
    emit(event, payload) { listeners.get(event)?.(payload); },
    async checkForUpdates() { calls.push("checkForUpdates"); return { updateInfo: { version: "0.0.1" } }; },
    async downloadUpdate() { calls.push("downloadUpdate"); },
    quitAndInstall() { calls.push("quitAndInstall"); },
  };
}

test("Windows has an update channel; macOS and Linux say why they do not", () => {
  assert.deepEqual(updateChannelAvailability("win32"), { available: true, requiresConfirmation: true });

  const mac = updateChannelAvailability("darwin");
  assert.equal(mac.available, false);
  // The reason has to be actionable, not a bare flag: it names the requirement
  // and where the work is tracked.
  assert.match(mac.reason, /Developer ID/);
  assert.match(mac.reason, /#135/);

  const linux = updateChannelAvailability("linux");
  assert.equal(linux.available, false);
  assert.ok(linux.reason.length > 0);

  const unknown = updateChannelAvailability("aix");
  assert.equal(unknown.available, false);
  assert.ok(unknown.reason.length > 0);
});

test("macOS opens its channel only for a Developer ID signature", () => {
  const inspect = () => ({
    status: 0,
    error: null,
    signal: null,
    output: [
      "Authority=Developer ID Application: Example, Inc. (TEAM123)",
      "TeamIdentifier=TEAM123",
    ].join("\n"),
  });
  const signed = readMacBuildSignature({ appPath: "/Applications/RoleWeave.app", inspect });
  assert.deepEqual(signed, { signed: true });
  assert.deepEqual(updateChannelAvailability("darwin", signed), {
    available: true,
    requiresConfirmation: true,
  });

  const adhoc = readMacBuildSignature({
    appPath: "/Applications/RoleWeave.app",
    inspect: () => ({
      status: 0,
      error: null,
      signal: null,
      output: "Signature=adhoc\nTeamIdentifier=not set\n",
    }),
  });
  assert.equal(adhoc.signed, false);
  assert.equal(updateChannelAvailability("darwin", adhoc).available, false);
});

test("an unavailable platform never touches an updater", async () => {
  // Passing null proves the service does not construct or call one: on macOS
  // today there is no signed build for electron-updater to reason about.
  const states = [];
  const service = createUpdaterService({
    updater: null,
    platform: "darwin",
    onState: (event) => states.push(event.state),
  });

  assert.equal(service.state, "unavailable");
  const checked = await service.check();
  assert.equal(checked.state, "unavailable");
  assert.match(checked.reason, /Developer ID/);
  const installed = await service.install();
  assert.equal(installed.state, "unavailable");
  assert.deepEqual(states, ["unavailable"]);
});

test("an available platform refuses to start without an updater", () => {
  assert.throws(
    () => createUpdaterService({ updater: null, platform: "win32" }),
    /requires an updater instance/,
  );
});

test("nothing downloads or installs without being asked", () => {
  const updater = fakeUpdater();
  createUpdaterService({ updater, platform: "win32" });
  // An update that installs itself mid-turn is a data-loss risk, so both
  // automatic paths are turned off at construction.
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
});

test("the full check to install sequence reports every state in order", async () => {
  const updater = fakeUpdater();
  const states = [];
  const service = createUpdaterService({
    updater,
    platform: "win32",
    signature: { signed: true },
    onState: (event) => states.push(event),
  });

  await service.check();
  updater.emit("update-available", { version: "0.0.1" });
  assert.equal(service.state, "available");

  await service.download({ confirmedByUser: true });
  updater.emit("download-progress", { percent: 41.7 });
  assert.equal(service.state, "downloading");
  assert.equal(states.at(-1).percent, 42);

  updater.emit("update-downloaded", { version: "0.0.1" });
  assert.equal(service.state, "downloaded");

  const installed = await service.install({ confirmedByUser: true });
  assert.equal(installed.installing, true);
  assert.deepEqual(updater.calls, ["checkForUpdates", "downloadUpdate", "quitAndInstall"]);
  assert.deepEqual(states.map((event) => event.state), [
    "checking", "available", "downloading", "downloaded",
  ]);
});

test("already current is a distinct state from an error", async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService({ updater, platform: "win32", signature: { signed: true } });
  await service.check();
  updater.emit("update-not-available");
  assert.equal(service.state, "current");
});

test("a failed check surfaces the reason instead of hanging in checking", async () => {
  const updater = fakeUpdater();
  updater.checkForUpdates = async () => { throw new Error("ENOTFOUND api.github.com"); };
  const service = createUpdaterService({ updater, platform: "win32", signature: { signed: true } });

  const result = await service.check();
  assert.equal(result.state, "error");
  assert.match(result.reason, /ENOTFOUND/);
  assert.equal(service.state, "error");
});

test("an updater error event is reported even when no call is in flight", async () => {
  const updater = fakeUpdater();
  const states = [];
  const service = createUpdaterService({ updater, platform: "win32", onState: (e) => states.push(e) });
  updater.emit("error", new Error("signature mismatch"));
  assert.equal(service.state, "error");
  assert.match(states.at(-1).reason, /signature mismatch/);
});

test("download and install refuse out of order rather than acting", async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService({ updater, platform: "win32", signature: { signed: true } });

  const early = await service.download({ confirmedByUser: true });
  assert.match(early.reason, /no update is available/);
  const premature = await service.install({ confirmedByUser: true });
  assert.match(premature.reason, /no downloaded update is ready/);
  assert.deepEqual(updater.calls, []);
});

test("every state the service publishes is a declared one", async () => {
  const updater = fakeUpdater();
  const states = [];
  const service = createUpdaterService({ updater, platform: "win32", onState: (e) => states.push(e.state) });
  await service.check();
  for (const event of ["update-available", "download-progress", "update-downloaded", "update-not-available"]) {
    updater.emit(event, { percent: 1, version: "0.0.1" });
  }
  updater.emit("error", new Error("x"));
  for (const state of states) assert.ok(UPDATE_STATES.includes(state), `undeclared state: ${state}`);
});

test("neither download nor install proceeds without explicit confirmation", async () => {
  // #110 R3, verbatim: an unsigned platform "must not silently download, apply,
  // or restart into that update". The refusal lives here rather than in a UI,
  // because #134's UI does not exist yet and a later one must not be able to
  // skip the prompt by forgetting to ask.
  const updater = fakeUpdater();
  const service = createUpdaterService({ updater, platform: "win32", signature: { signed: true } });
  assert.equal(service.availability.requiresConfirmation, true);

  await service.check();
  updater.emit("update-available", { version: "0.0.1" });

  for (const call of [
    () => service.download(),
    () => service.download({}),
    () => service.download({ confirmedByUser: false }),
    // A truthy value that is not exactly true must not pass either.
    () => service.download({ confirmedByUser: "yes" }),
    () => service.download({ confirmedByUser: 1 }),
  ]) {
    const result = await call();
    assert.match(result.reason, /requires explicit confirmation/);
  }
  assert.deepEqual(updater.calls, ["checkForUpdates"], "nothing was downloaded");

  await service.download({ confirmedByUser: true });
  updater.emit("update-downloaded", { version: "0.0.1" });

  for (const call of [
    () => service.install(),
    () => service.install({ confirmedByUser: false }),
    () => service.install({ confirmedByUser: "yes" }),
  ]) {
    const result = await call();
    assert.match(result.reason, /requires explicit confirmation/);
  }
  assert.deepEqual(
    updater.calls,
    ["checkForUpdates", "downloadUpdate"],
    "quitAndInstall must not have run without confirmation",
  );

  const installed = await service.install({ confirmedByUser: true });
  assert.equal(installed.installing, true);
  assert.deepEqual(updater.calls, ["checkForUpdates", "downloadUpdate", "quitAndInstall"]);
});

test("checking needs no confirmation, because checking changes nothing", async () => {
  // The decision permits check-and-notify outright. Requiring a prompt to look
  // would make the feature useless without protecting anything.
  const updater = fakeUpdater();
  const service = createUpdaterService({ updater, platform: "win32", signature: { signed: true } });
  const result = await service.check();
  assert.notEqual(result.state, "unavailable");
  assert.deepEqual(updater.calls, ["checkForUpdates"]);
});

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { UNSIGNED_REFUSAL, readBuildSignature } = require("../src/updater.cjs");

/** A packaged resources directory, with or without the file electron-builder writes. */
function resources(t, contents = null) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "owb-update-signature-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  if (contents !== null) fs.writeFileSync(path.join(dir, "app-update.yml"), contents);
  return dir;
}

test("signedness comes from the same key NsisUpdater reads", (t) => {
  // NsisUpdater skips verification entirely when publisherName is absent, so
  // its presence is the only honest signal that an update can be verified.
  const signed = readBuildSignature({
    resourcesPath: resources(t, "provider: github\npublisherName: Example Org\n"),
  });
  assert.deepEqual(signed, { signed: true });

  const unsigned = readBuildSignature({
    resourcesPath: resources(t, "provider: github\nowner: bytefolk\n"),
  });
  assert.equal(unsigned.signed, false);
  assert.match(unsigned.reason, /unsigned/);

  // A declared-but-empty key is not an identity.
  assert.equal(
    readBuildSignature({ resourcesPath: resources(t, "publisherName:\n") }).signed,
    false,
  );

  // A block list is a valid identity; NsisUpdater accepts an array.
  assert.equal(
    readBuildSignature({ resourcesPath: resources(t, "publisherName:\n  - Example Org\n") }).signed,
    true,
  );

  // An empty key followed by another key must not read that key's value as its
  // own -- the failure a newline-crossing pattern would have introduced.
  assert.equal(
    readBuildSignature({ resourcesPath: resources(t, "publisherName:\nprovider: github\n") }).signed,
    false,
  );
  assert.equal(
    readBuildSignature({ resourcesPath: resources(t, "publisherName: [Example Org]\n") }).signed,
    true,
  );
});

test("a build with no update configuration is treated as unsigned", (t) => {
  const missing = readBuildSignature({ resourcesPath: resources(t) });
  assert.equal(missing.signed, false);
  assert.match(missing.reason, /no update configuration/);

  const sourceTree = readBuildSignature({ resourcesPath: "" });
  assert.equal(sourceTree.signed, false);
  assert.match(sourceTree.reason, /source-tree run/);
});

test("an unsigned build may check for updates but not apply one", async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService({
    updater,
    platform: "win32",
    signature: { signed: false, reason: "unsigned" },
  });

  // Knowing a new version exists is still useful, so check stays open.
  await service.check();
  updater.emit("update-available", { version: "0.2.0" });
  assert.equal(service.state, "available");

  const downloaded = await service.download({ confirmedByUser: true });
  assert.equal(downloaded.unsigned, true);
  assert.equal(downloaded.reason, UNSIGNED_REFUSAL);

  const installed = await service.install({ confirmedByUser: true });
  assert.equal(installed.unsigned, true);

  // Confirmation does not buy past the gate, and nothing was asked of the updater.
  assert.deepEqual(updater.calls, ["checkForUpdates"]);
});

test("the gate opens on its own once the build carries a publisher", async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService({
    updater,
    platform: "win32",
    signature: { signed: true },
  });

  await service.check();
  updater.emit("update-available", { version: "0.2.0" });
  await service.download({ confirmedByUser: true });
  updater.emit("update-downloaded", { version: "0.2.0" });
  const installed = await service.install({ confirmedByUser: true });

  assert.equal(installed.installing, true);
  assert.deepEqual(updater.calls, ["checkForUpdates", "downloadUpdate", "quitAndInstall"]);
  // No flag was flipped by hand: the same file that turns NsisUpdater's own
  // verification on is what opened this.
  assert.equal(service.build.signed, true);
});

test("both gates hold independently: confirmation without signing, signing without confirmation", async () => {
  const unsignedButConfirmed = createUpdaterService({
    updater: fakeUpdater(), platform: "win32", signature: { signed: false, reason: "x" },
  });
  await unsignedButConfirmed.check();
  assert.equal((await unsignedButConfirmed.download({ confirmedByUser: true })).unsigned, true);

  const signedButUnconfirmed = createUpdaterService({
    updater: fakeUpdater(), platform: "win32", signature: { signed: true },
  });
  await signedButUnconfirmed.check();
  const unconfirmed = await signedButUnconfirmed.download();
  assert.match(unconfirmed.reason, /requires explicit confirmation/);
  assert.notEqual(unconfirmed.unsigned, true);
});

test("an unloadable update component degrades instead of throwing", () => {
  // This wiring used to be a bare require on the line before createWindow(). A
  // missing or corrupt vendored bundle threw out of the whenReady handler, so
  // the app opened no window at all -- an optional update check taking down the
  // launch.
  let service;
  assert.doesNotThrow(() => {
    service = startUpdaterService({
      loadUpdater: () => { throw new Error("ENOENT vendor/electron-updater.cjs"); },
      platform: "win32",
    });
  });

  assert.equal(service.availability.available, false);
  assert.match(service.availability.reason, /could not be loaded/);
  assert.match(service.availability.reason, /ENOENT/);
  assert.equal(service.state, "unavailable");
});

test("the loader is not called on macOS when the free channel has no packaged app", () => {
  // The free macOS service does not touch the native Squirrel.Mac getter. A
  // source-tree run has no bundle to replace, so it remains unavailable.
  let called = false;
  const service = startUpdaterService({
    loadUpdater: () => { called = true; return {}; },
    platform: "darwin",
  });
  assert.equal(called, false);
  assert.equal(service.availability.available, false);
  assert.match(service.availability.reason, /source-tree/);
});

test("a loaded updater still reaches the signed gate", async () => {
  const updater = fakeUpdater();
  const service = startUpdaterService({
    loadUpdater: () => updater,
    platform: "win32",
    signature: { signed: false, reason: "unsigned" },
  });

  assert.equal(service.state, "idle");
  await service.check();
  updater.emit("update-available", { version: "0.2.0" });
  const refused = await service.download({ confirmedByUser: true });
  assert.equal(refused.unsigned, true);
});

test("a signed macOS build loads the updater and can apply with confirmation", async () => {
  const previous = process.env.OWB_NATIVE_MAC_UPDATES;
  process.env.OWB_NATIVE_MAC_UPDATES = "true";
  const updater = fakeUpdater();
  try {
    const service = startUpdaterService({
      loadUpdater: () => updater,
      platform: "darwin",
      signature: { signed: true },
    });

    assert.equal(service.availability.available, true);
    await service.check();
    updater.emit("update-available", { version: "0.2.0" });
    await service.download({ confirmedByUser: true });
    updater.emit("update-downloaded", { version: "0.2.0" });
    const installed = await service.install({ confirmedByUser: true });
    assert.equal(installed.installing, true);
    assert.deepEqual(updater.calls, ["checkForUpdates", "downloadUpdate", "quitAndInstall"]);
  } finally {
    if (previous === undefined) delete process.env.OWB_NATIVE_MAC_UPDATES;
    else process.env.OWB_NATIVE_MAC_UPDATES = previous;
  }
});

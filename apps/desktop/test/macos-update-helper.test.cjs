const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runMacUpdateHelper } = require("../src/macos-update-helper.cjs");
const trust = require("../src/update-trust.cjs");

function manifestFor(bytes) {
  return {
    schemaVersion: trust.UPDATE_MANIFEST_SCHEMA,
    repository: trust.UPDATE_REPOSITORY,
    tag: "v0.2.0",
    platform: "darwin",
    arch: "arm64",
    version: "0.2.0",
    assetName: trust.expectedAssetName("0.2.0"),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    publicKeyId: trust.UPDATE_PUBLIC_KEY_ID,
    signature: "test-signature",
  };
}

test("the helper rechecks the ZIP and atomically replaces then relaunches the app", async (t) => {
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "owb-update-helper-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const requestDirectory = path.join(fixture, "request");
  const extractionDirectory = path.join(fixture, "extract");
  const targetAppPath = path.join(fixture, "RoleWeave.app");
  const sourceAppPath = path.join(fixture, "source", "RoleWeave.app");
  const zipPath = path.join(requestDirectory, "org-workbench-0.2.0-arm64.zip");
  fs.mkdirSync(targetAppPath, { recursive: true });
  fs.writeFileSync(path.join(targetAppPath, "version.txt"), "old");
  fs.mkdirSync(sourceAppPath, { recursive: true });
  fs.writeFileSync(path.join(sourceAppPath, "version.txt"), "new");
  const bytes = Buffer.from("fake zip contents");
  fs.mkdirSync(requestDirectory);
  fs.mkdirSync(extractionDirectory);
  fs.writeFileSync(zipPath, bytes, { mode: 0o600 });
  const requestPath = path.join(requestDirectory, "request.json");
  const request = {
    schemaVersion: "org-workbench-update-request.v1",
    parentPid: 12345,
    targetAppPath,
    zipPath,
    manifest: manifestFor(bytes),
    appName: "RoleWeave",
    arch: "arm64",
  };
  fs.writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
  const commands = [];
  const spawnProcess = (command, args) => {
    commands.push({ command, args });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      if (command === "/usr/bin/ditto") fs.cpSync(sourceAppPath, path.join(args[args.length - 1], "RoleWeave.app"), { recursive: true });
      child.emit("close", 0, null);
    });
    child.unref = () => undefined;
    return child;
  };

  const result = await runMacUpdateHelper(requestPath, {
    tempDirectory: extractionDirectory,
    spawnProcess,
    wait: async () => undefined,
    verifyManifest: () => ({ ok: true }),
  });
  assert.deepEqual(result, { ok: true, version: "0.2.0" });
  assert.equal(fs.readFileSync(path.join(targetAppPath, "version.txt"), "utf8"), "new");
  assert.equal(commands.at(-1).command, "/usr/bin/open");
  assert.deepEqual(commands.at(-1).args, [targetAppPath]);
  assert.equal(fs.existsSync(requestDirectory), false, "private update staging is cleaned after replacement");
});

test("the helper rejects a request whose file is not private", async (t) => {
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "owb-update-helper-private-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const requestPath = path.join(fixture, "request.json");
  fs.writeFileSync(requestPath, "{}", { mode: 0o644 });
  await assert.rejects(() => runMacUpdateHelper(requestPath), /private regular file/);
});

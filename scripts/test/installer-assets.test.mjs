import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCanonicalOutputDirectory,
  classifyEntries,
  expectedArtifacts,
  isPermittedCompanion,
} from "../verify-installer-assets.mjs";

const META = { name: "org-workbench", version: "0.0.0" };

function fixture(t, entries) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "owb-installer-assets-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  for (const entry of entries) fs.writeFileSync(path.join(root, entry), "x");
  return root;
}

test("the expected set names the architecture, so a wrong-arch build cannot pass", () => {
  assert.deepEqual(expectedArtifacts("macos", META), [
    "org-workbench-0.0.0-arm64.dmg",
    "org-workbench-0.0.0-arm64.zip",
  ]);
  assert.deepEqual(expectedArtifacts("windows", META), ["org-workbench-0.0.0-x64.exe"]);
  assert.throws(() => expectedArtifacts("linux", META), /unsupported installer platform/);
});

test("a complete output classifies clean", () => {
  const required = expectedArtifacts("macos", META);
  const { missing, unexpected } = classifyEntries([...required], required);
  assert.deepEqual(missing, []);
  assert.deepEqual(unexpected, []);
});

test("a missing artifact is reported by name", () => {
  const required = expectedArtifacts("macos", META);
  const { missing } = classifyEntries(["org-workbench-0.0.0-arm64.dmg"], required);
  assert.deepEqual(missing, ["org-workbench-0.0.0-arm64.zip"]);
});

test("an artifact this lane does not claim is reported", () => {
  const required = expectedArtifacts("windows", META);
  // An MSI would mean the build produced a target nobody asked for.
  const { unexpected } = classifyEntries(
    ["org-workbench-0.0.0-x64.exe", "org-workbench-0.0.0-x64.msi"],
    required,
  );
  assert.deepEqual(unexpected, ["org-workbench-0.0.0-x64.msi"]);
});

test("blockmaps and update metadata are permitted companions, nothing else is", () => {
  const required = expectedArtifacts("windows", META);
  assert.equal(isPermittedCompanion("org-workbench-0.0.0-x64.exe.blockmap", required), true);
  assert.equal(isPermittedCompanion("latest.yml", required), true);
  assert.equal(isPermittedCompanion("latest-mac.yml", required), true);
  // A blockmap for something that is not a required artifact is not a companion.
  assert.equal(isPermittedCompanion("something-else.exe.blockmap", required), false);
  assert.equal(isPermittedCompanion("release-notes.md", required), false);
});

test("electron-builder's own byproducts are permitted", () => {
  // Observed on the first macOS run: the output carried builder-debug.yml, an
  // effective-config dump written on every build, and latest-mac.yml, written
  // even under --publish never. Neither is a release asset; both are permitted
  // rather than claimed.
  const required = expectedArtifacts("macos", META);
  assert.equal(isPermittedCompanion("builder-debug.yml", required), true);
  assert.equal(isPermittedCompanion("latest-mac.yml", required), true);

  const observed = [
    "builder-debug.yml",
    "latest-mac.yml",
    "org-workbench-0.0.0-arm64.dmg",
    "org-workbench-0.0.0-arm64.dmg.blockmap",
    "org-workbench-0.0.0-arm64.zip",
    "org-workbench-0.0.0-arm64.zip.blockmap",
  ];
  const { missing, unexpected } = classifyEntries(observed, required);
  assert.deepEqual(missing, []);
  assert.deepEqual(unexpected, []);

  // The Windows run carried the same byproducts under different names: the NSIS
  // target emits a single blockmap and `latest.yml` rather than `latest-mac.yml`.
  const winRequired = expectedArtifacts("windows", META);
  const winObserved = [
    "builder-debug.yml",
    "latest.yml",
    "org-workbench-0.0.0-x64.exe",
    "org-workbench-0.0.0-x64.exe.blockmap",
  ];
  const win = classifyEntries(winObserved, winRequired);
  assert.deepEqual(win.missing, []);
  assert.deepEqual(win.unexpected, []);
});

test("the signed macOS manifest is accepted only by the macOS asset lane", () => {
  const mac = expectedArtifacts("macos", META);
  assert.deepEqual(classifyEntries([...mac, "latest-mac.json"], mac).unexpected, []);
  assert.equal(isPermittedCompanion("latest-mac.json", expectedArtifacts("windows", META)), false);
  for (const name of ["latest.json", "latest-mac-extra.json", "../latest-mac.json"]) {
    assert.equal(isPermittedCompanion(name, mac), false);
  }
});

test("a wrong-architecture build fails rather than passing on a glob", () => {
  const required = expectedArtifacts("windows", META);
  const { missing, unexpected } = classifyEntries(["org-workbench-0.0.0-ia32.exe"], required);
  assert.deepEqual(missing, ["org-workbench-0.0.0-x64.exe"]);
  assert.deepEqual(unexpected, ["org-workbench-0.0.0-ia32.exe"]);
});

test("the fixture helper keeps these cases honest about real directory reads", (t) => {
  const required = expectedArtifacts("macos", META);
  const root = fixture(t, [...required, "org-workbench-0.0.0-arm64.dmg.blockmap"]);
  const entries = fs.readdirSync(root).sort();
  const { missing, unexpected } = classifyEntries(entries, required);
  assert.deepEqual(missing, []);
  assert.deepEqual(unexpected, []);
});

test("the installer verifier rejects a symlinked output root", (t) => {
  if (process.platform === "win32") {
    t.skip("creating symlinks may require elevated privileges on Windows");
    return;
  }

  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "owb-installer-root-"));
  const target = path.join(parent, "target");
  const linkedRoot = path.join(parent, "linked-dist");
  fs.mkdirSync(target);
  fs.symlinkSync(target, linkedRoot, "dir");
  t.after(() => fs.rmSync(parent, { force: true, recursive: true }));

  assert.throws(
    () => assertCanonicalOutputDirectory(linkedRoot),
    /symlink or junction/,
  );
});

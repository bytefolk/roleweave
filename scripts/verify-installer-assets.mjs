import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { UPDATE_MANIFEST_NAME, verifyUpdateManifest } = require("../apps/desktop/src/update-trust.cjs");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "release", "dist");

/**
 * The installable artifacts each platform must produce, derived from the pinned
 * `artifactName` in the builder config. Named rather than pattern-matched: a
 * glob would pass on a build that silently produced the wrong architecture.
 */
export function expectedArtifacts(platform, { name, version }) {
  if (platform === "macos") {
    return [`${name}-${version}-arm64.dmg`, `${name}-${version}-arm64.zip`];
  }
  if (platform === "windows") {
    return [`${name}-${version}-x64.exe`];
  }
  throw new Error(`unsupported installer platform: ${platform}`);
}

/**
 * Build byproducts. electron-builder writes its effective configuration here on
 * every run; it is a diagnostic dump, not a release asset, and it is emitted
 * whether or not anything is published.
 */
const BUILD_BYPRODUCTS = Object.freeze(["builder-debug.yml"]);

/**
 * Files electron-builder emits alongside a required artifact. Permitted but not
 * required: whether a target emits a blockmap depends on the target. Note that
 * `latest*.yml` is written even under `--publish never` -- observed on the first
 * macOS run, where the output carried `latest-mac.yml` with no publish provider
 * configured. It is permitted here rather than claimed; #133 is where update
 * metadata becomes something this repository asserts about.
 */
export function isPermittedCompanion(entry, required) {
  if (BUILD_BYPRODUCTS.includes(entry)) return true;
  if (entry === UPDATE_MANIFEST_NAME && required.some((name) => name.endsWith("-arm64.dmg"))) return true;
  if (/^latest.*\.yml$/.test(entry)) return true;
  return required.some((artifact) => entry === `${artifact}.blockmap`);
}

export function classifyEntries(entries, required) {
  const present = required.filter((artifact) => entries.includes(artifact));
  const missing = required.filter((artifact) => !entries.includes(artifact));
  const unexpected = entries.filter(
    (entry) => !required.includes(entry) && !isPermittedCompanion(entry, required),
  );
  return { present, missing, unexpected };
}

function readOutputEntries(root) {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`installer output contains a link: ${entry.name}`);
    }
    // electron-builder leaves its unpacked staging tree next to the installers.
    // It is an input to the installer, not a release asset, so it is not part of
    // the asset set -- but anything else that is a directory is unexplained.
    if (entry.isDirectory()) {
      if (/-unpacked$/.test(entry.name) || entry.name === "mac-arm64" || entry.name === "mac") continue;
      throw new Error(`installer output contains an unexpected directory: ${entry.name}`);
    }
    if (!entry.isFile()) throw new Error(`installer output contains a special file: ${entry.name}`);
    found.push(entry.name);
  }
  return found.sort();
}

function samePath(left, right) {
  const normalize = (value) => path.normalize(value).replace(/[\\/]$/, "");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Verify that the output root is a real, canonical directory. Following a
 * symlink here would let an external directory satisfy the asset-set check.
 */
export function assertCanonicalOutputDirectory(root) {
  const resolvedRoot = path.resolve(root);
  let rootStat;
  try {
    rootStat = fs.lstatSync(resolvedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`installer output is missing: ${resolvedRoot}`);
    }
    throw error;
  }

  assert.equal(
    rootStat.isSymbolicLink(),
    false,
    `installer output must not be a symlink or junction: ${resolvedRoot}`,
  );
  assert.equal(rootStat.isDirectory(), true, `installer output must be a directory: ${resolvedRoot}`);
  assert.equal(
    samePath(fs.realpathSync(resolvedRoot), resolvedRoot),
    true,
    `installer output must be canonical: ${resolvedRoot}`,
  );
  const finalRootStat = fs.lstatSync(resolvedRoot);
  assert.equal(
    sameFileIdentity(rootStat, finalRootStat),
    true,
    "installer output identity changed during validation",
  );
  return resolvedRoot;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Open once: metadata checks and bounded reads must refer to the same file.
// The native macOS release gate also refuses symlinks and non-regular files.
function readRegularFile(file, label, { maxSize, size }, consume) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error.code === "ELOOP") throw new Error(`${label} must be a regular file`);
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    assert.ok(stat.isFile(), `${label} must be a regular file`);
    assert.ok(stat.size > 0 && stat.size <= maxSize, `${label} has an invalid size`);
    if (size !== undefined) assert.equal(stat.size, size, `${label} size does not match the manifest`);
    const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size + 1));
    let total = 0;
    // Read at most the checked length plus one byte to detect growth, without
    // allowing a concurrently growing file to consume unbounded resources.
    while (total <= stat.size) {
      const bytes = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size + 1 - total), null);
      if (bytes === 0) break;
      total += bytes;
      consume(buffer.subarray(0, bytes));
    }
    assert.equal(total, stat.size, `${label} size changed during validation`);
  } finally {
    fs.closeSync(fd);
  }
}

/** Check the signed manifest against the same trust root shipped in the app. */
export function verifyMacosUpdateArtifact(root, version, { required = false, publicKeyPem } = {}) {
  const manifestPath = path.join(root, UPDATE_MANIFEST_NAME);
  const chunks = [];
  try {
    readRegularFile(manifestPath, "macOS update manifest", { maxSize: 64 * 1024 }, (chunk) => chunks.push(Buffer.from(chunk)));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    assert.equal(required, false, "signed macOS update manifest is required for release");
    return;
  }
  const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = verifyUpdateManifest(manifest, { publicKeyPem });
  assert.equal(result.ok, true, `invalid macOS update manifest: ${result.reason}`);
  assert.equal(manifest.version, version, "macOS update manifest version does not match the package");
  // assetName is constrained to the exact versioned ZIP by verifyUpdateManifest.
  const assetPath = path.join(root, manifest.assetName);
  const hash = crypto.createHash("sha256");
  readRegularFile(assetPath, "macOS update ZIP", { maxSize: manifest.size, size: manifest.size }, (chunk) => hash.update(chunk));
  assert.equal(hash.digest("hex"), manifest.sha256, "macOS update ZIP hash does not match the manifest");
}

export function verifyInstallerAssets(platform, root = outputRoot, { requireMacosSignature = false } = {}) {
  const expectedHost = platform === "macos" ? "darwin" : platform === "windows" ? "win32" : null;
  assert.notEqual(expectedHost, null, `unsupported installer platform: ${platform}`);
  assert.equal(
    process.platform,
    expectedHost,
    `${platform} installer verification must run on its native host`,
  );
  const canonicalRoot = assertCanonicalOutputDirectory(root);

  const metadata = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const required = expectedArtifacts(platform, metadata);
  const entries = readOutputEntries(canonicalRoot);
  const { missing, unexpected } = classifyEntries(entries, required);

  assert.deepEqual(
    missing,
    [],
    `installer output is missing required artifacts.\n  expected: ${required.join(", ")}\n  found:    ${entries.join(", ") || "(nothing)"}`,
  );
  assert.deepEqual(
    unexpected,
    [],
    `installer output carries artifacts this lane does not claim.\n  unexpected: ${unexpected.join(", ")}\n  found:      ${entries.join(", ")}`,
  );

  if (platform === "macos") {
    verifyMacosUpdateArtifact(canonicalRoot, metadata.version, { required: requireMacosSignature });
  } else {
    assert.equal(requireMacosSignature, false, "macOS signature verification requires the macOS lane");
  }

  return {
    schemaVersion: "org-workbench-installer-assets.v1",
    ok: true,
    platform,
    version: metadata.version,
    unsigned: true,
    artifacts: required.map((artifact) => {
      const file = path.join(canonicalRoot, artifact);
      return { name: artifact, bytes: fs.statSync(file).size, sha256: sha256(file) };
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const platform = process.argv[2];
  try {
    const flags = process.argv.slice(3);
    assert.ok(flags.every((flag) => flag === "--require-macos-signature"), "unknown installer verification option");
    console.log(JSON.stringify(verifyInstallerAssets(platform, outputRoot, {
      requireMacosSignature: flags.includes("--require-macos-signature"),
    })));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

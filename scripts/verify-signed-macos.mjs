import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MARKER_FILE } from "./notarize-macos.cjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "release", "dist");

/**
 * `codesign -dv` writes its details to stderr. Keep the classifier separate
 * from the command so a Linux test runner can exercise the trust decision
 * without pretending to be macOS.
 */
export function parseDeveloperIdSignature(output) {
  const text = typeof output === "string" ? output : "";
  const authority = /^Authority=Developer ID Application: .+$/m.test(text);
  const teamIdentifier = /^TeamIdentifier=[A-Z0-9]+$/m.test(text);
  const adhoc = /^Signature=adhoc$/m.test(text);
  return {
    signed: authority && teamIdentifier && !adhoc,
    authority,
    teamIdentifier,
    adhoc,
  };
}

export function shouldRunGatekeeper({ notarizationMarkerPresent } = {}) {
  return notarizationMarkerPresent === true;
}

export function notarizationMarkerPresent(root = outputRoot) {
  if (!fs.existsSync(root)) return false;
  return fs.readdirSync(root, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, MARKER_FILE)),
  );
}

function runTool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    code: result.status,
    signal: result.signal,
    error: result.error ?? null,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function assertToolSucceeded(result, operation) {
  assert.equal(result.error, null, `${operation} could not start`);
  assert.equal(result.code, 0, `${operation} failed`);
}

function findMacZip(root = outputRoot) {
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const expected = `${packageMetadata.name}-${packageMetadata.version}-arm64.zip`;
  const zipPath = path.join(root, expected);
  assert.equal(fs.existsSync(zipPath), true, `signed macOS artifact is missing: ${expected}`);
  return zipPath;
}

function findExtractedApp(root) {
  const app = fs.readdirSync(root, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  assert.ok(app, "the macOS ZIP does not contain an app bundle");
  return path.join(root, app.name);
}

export function verifySignedMacArtifact({
  zipPath = findMacZip(),
  mode = "signature",
  runner = runTool,
} = {}) {
  assert.ok(mode === "signature" || mode === "gatekeeper", `unsupported macOS verification mode: ${mode}`);
  assert.equal(process.platform, "darwin", "signed macOS verification must run on a macOS host");

  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "owb-verify-macos-"));
  try {
    const extracted = runner("/usr/bin/ditto", ["-x", "-k", zipPath, extractionRoot]);
    assertToolSucceeded(extracted, "extracting the signed macOS artifact");
    const appPath = findExtractedApp(extractionRoot);

    const signatureCheck = runner("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
    assertToolSucceeded(signatureCheck, "validating the macOS code signature");
    const details = runner("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
    assertToolSucceeded(details, "reading the macOS code signature");
    assert.equal(parseDeveloperIdSignature(details.output).signed, true, "the app is not signed by Developer ID Application");

    if (mode === "signature") {
      const stapled = runner("/usr/bin/xcrun", ["stapler", "validate", "-q", appPath]);
      assertToolSucceeded(stapled, "validating the stapled notarization ticket");
      return { ok: true, mode, notarized: true, gatekeeper: "not-run" };
    }

    const gatekeeper = runner("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
    assertToolSucceeded(gatekeeper, "running the Gatekeeper assessment");
    return { ok: true, mode, notarized: true, gatekeeper: "passed" };
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "signature";
  try {
    if (mode === "gatekeeper" && !shouldRunGatekeeper({ notarizationMarkerPresent: notarizationMarkerPresent() })) {
      console.warn("::warning::Notarization did not run; Gatekeeper assessment is skipped and no pass is reported.");
      console.log(JSON.stringify({ ok: true, mode, notarized: false, gatekeeper: "skipped-notarization-not-run" }));
    } else {
      console.log(JSON.stringify(verifySignedMacArtifact({ mode })));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

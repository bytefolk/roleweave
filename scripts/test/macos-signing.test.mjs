import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import {
  childProcessEnvironment,
  notarizationSettings,
  notarizeOnce,
  notarizeWithRetry,
  prepareNotarizationCredentials,
} from "../notarize-macos.cjs";
import {
  parseDeveloperIdSignature,
  shouldRunGatekeeper,
} from "../verify-signed-macos.mjs";

const require = createRequire(import.meta.url);
const builderConfigPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../apps/desktop/electron-builder.config.cjs");

function loadBuilderConfig(signed) {
  const previous = process.env.OWB_MAC_SIGNED_BUILD;
  if (signed) process.env.OWB_MAC_SIGNED_BUILD = "true";
  else delete process.env.OWB_MAC_SIGNED_BUILD;
  delete require.cache[builderConfigPath];
  const config = require(builderConfigPath);
  delete require.cache[builderConfigPath];
  if (previous === undefined) delete process.env.OWB_MAC_SIGNED_BUILD;
  else process.env.OWB_MAC_SIGNED_BUILD = previous;
  return config;
}

test("the builder opts into signing only in the explicit signed lane", () => {
  const staging = loadBuilderConfig(false);
  assert.equal(staging.mac.identity, null);
  assert.equal(staging.mac.forceCodeSigning, undefined);

  const signed = loadBuilderConfig(true);
  assert.equal(signed.mac.identity, undefined);
  assert.equal(signed.mac.forceCodeSigning, true);
  assert.equal(signed.mac.hardenedRuntime, true);
  assert.equal(signed.mac.afterSign, "scripts/notarize-macos.cjs");
});

test("macOS signing metadata accepts Developer ID and rejects ad-hoc signatures", () => {
  assert.equal(parseDeveloperIdSignature([
    "Authority=Developer ID Application: Example, Inc. (TEAM123)",
    "TeamIdentifier=TEAM123",
  ].join("\n")).signed, true);
  assert.equal(parseDeveloperIdSignature("Signature=adhoc\nTeamIdentifier=not set\n").signed, false);
  assert.equal(parseDeveloperIdSignature("Authority=Mac Developer: Example\nTeamIdentifier=TEAM123\n").signed, false);
});

test("notarization settings name missing credentials without exposing values", () => {
  assert.throws(
    () => notarizationSettings({ APPLE_ID: "id@example.com" }),
    /APPLE_APP_SPECIFIC_PASSWORD.*APPLE_TEAM_ID/,
  );
  const settings = notarizationSettings({
    APPLE_ID: "id@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "secret",
    APPLE_TEAM_ID: "TEAM123",
    OWB_NOTARIZATION_ATTEMPTS: "4",
    OWB_NOTARIZATION_TIMEOUT_MS: "1234",
  });
  assert.deepEqual(settings, {
    appleId: "id@example.com",
    password: "secret",
    teamId: "TEAM123",
    keychain: null,
    profileName: "org-workbench-notarization",
    attempts: 4,
    timeoutMs: 1234,
  });
});

test("notarization child processes do not inherit Apple credentials", () => {
  const env = childProcessEnvironment({
    PATH: "/usr/bin",
    APPLE_ID: "id@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "secret",
    MACOS_CERTIFICATE_PASSWORD: "p12-secret",
    SAFE_SENTINEL: "kept",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", SAFE_SENTINEL: "kept" });
});

test("profile-backed notarization stores the password through stdin", async () => {
  const calls = [];
  await prepareNotarizationCredentials({
    appleId: "id@example.com",
    password: "secret",
    teamId: "TEAM123",
    keychain: "/tmp/owb.keychain-db",
    profileName: "owb-profile",
    timeoutMs: 1000,
  }, async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: "" };
  });
  assert.deepEqual(calls[0].args, [
    "notarytool",
    "store-credentials",
    "owb-profile",
    "--apple-id",
    "id@example.com",
    "--team-id",
    "TEAM123",
    "--keychain",
    "/tmp/owb.keychain-db",
  ]);
  assert.equal(calls[0].options.input, "secret\n");
});

test("notarization submits, staples, and validates the ticket", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-notarize-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, "RoleWeave.app");
  fs.mkdirSync(appPath);
  const calls = [];
  await notarizeOnce(appPath, {
    appleId: "id@example.com",
    password: "secret",
    teamId: "TEAM123",
    timeoutMs: 1000,
  }, async (command, args) => {
    calls.push([command, args]);
    if (command === "xcrun" && args[0] === "notarytool") {
      return { code: 0, stdout: JSON.stringify({ status: "Accepted" }) };
    }
    return { code: 0, stdout: "" };
  });
  assert.deepEqual(calls.map(([command, args]) => [command, args[0]]), [
    ["ditto", "-c"],
    ["xcrun", "notarytool"],
    ["xcrun", "stapler"],
    ["xcrun", "stapler"],
  ]);
});

test("notarization retries a bounded number of times", async () => {
  let submissions = 0;
  const log = { log() {}, warn() {} };
  await assert.rejects(
    notarizeWithRetry("/tmp/RoleWeave.app", {
      appleId: "id@example.com",
      password: "secret",
      teamId: "TEAM123",
      attempts: 3,
      timeoutMs: 1000,
    }, async (command, args) => {
      if (command === "xcrun" && args[0] === "notarytool") submissions += 1;
      if (command === "ditto") return { code: 0, stdout: "" };
      return { code: 1, stdout: "{\"status\":\"Invalid\"}" };
    }, log),
    /failed after 3 attempts/,
  );
  assert.equal(submissions, 3);
});

test("Gatekeeper runs only after the notarization success marker exists", () => {
  assert.equal(shouldRunGatekeeper({ notarizationMarkerPresent: true }), true);
  assert.equal(shouldRunGatekeeper({ notarizationMarkerPresent: false }), false);
  assert.equal(shouldRunGatekeeper(), false);
});

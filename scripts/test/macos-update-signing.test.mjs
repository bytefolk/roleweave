import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { signMacosUpdate } from "../sign-macos-update.mjs";
import { verifyMacosUpdateArtifact } from "../verify-installer-assets.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const trust = require("../../apps/desktop/src/update-trust.cjs");

test("signMacosUpdate writes a manifest whose signature verifies against the matching public key", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "owb-update-signing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "release", "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const assetName = trust.expectedAssetName("0.2.0");
  const assetPath = path.join(root, "release", "dist", assetName);
  const assetContent = "test release asset".repeat(5000);
  fs.writeFileSync(assetPath, assetContent);

  const report = await signMacosUpdate({
    root,
    privateKey: pair.privateKey,
    publicKeyPem,
  });
  const manifest = JSON.parse(fs.readFileSync(report.manifestPath, "utf8"));
  assert.equal(manifest.assetName, assetName);
  assert.equal(manifest.size, Buffer.byteLength(assetContent));
  assert.deepEqual(
    trust.verifyUpdateManifest(manifest, { publicKeyPem }),
    { ok: true },
  );
  assert.equal(Object.hasOwn(manifest, "privateKey"), false);
  const output = path.dirname(report.manifestPath);
  const verify = () => verifyMacosUpdateArtifact(output, "0.2.0", { required: true, publicKeyPem });
  assert.doesNotThrow(verify, "signer output must pass the installer release gate");
  assert.throws(() => verifyMacosUpdateArtifact(output, "0.2.1", { publicKeyPem }), /version does not match/);
  assert.throws(() => verifyMacosUpdateArtifact(output, "0.2.0"), /unexpected signing key/);

  // Mutate after the descriptor metadata check, before the first read. Both
  // growth and truncation must fail rather than parsing a different length.
  const originalRead = fs.readSync;
  for (const mutate of [
    () => fs.appendFileSync(report.manifestPath, " "),
    () => fs.truncateSync(report.manifestPath, 1),
  ]) {
    let firstRead = true;
    const mock = t.mock.method(fs, "readSync", (fd, ...args) => {
      if (firstRead) {
        firstRead = false;
        mutate();
      }
      return originalRead(fd, ...args);
    });
    try {
      assert.throws(verify, /size changed during validation/);
    } finally {
      mock.mock.restore();
      fs.writeFileSync(report.manifestPath, JSON.stringify(manifest));
    }
  }

  fs.writeFileSync(report.manifestPath, JSON.stringify({ ...manifest, sha256: "0".repeat(64) }));
  assert.throws(verify, /signature does not match/);
  fs.writeFileSync(report.manifestPath, JSON.stringify(manifest));

  fs.writeFileSync(assetPath, "X".repeat(manifest.size));
  assert.throws(verify, /ZIP hash does not match/);
  fs.writeFileSync(assetPath, "short");
  assert.throws(verify, /ZIP size does not match/);
  fs.unlinkSync(assetPath);
  assert.throws(verify, { code: "ENOENT" });

  fs.writeFileSync(report.manifestPath, "not-json");
  assert.throws(verify, SyntaxError);
  fs.writeFileSync(report.manifestPath, "x".repeat(64 * 1024 + 1));
  assert.throws(verify, /invalid size/);
  fs.unlinkSync(report.manifestPath);
  assert.throws(verify, /manifest is required/);
  assert.doesNotThrow(() => verifyMacosUpdateArtifact(output, "0.2.0"), "unsigned CI remains supported");
  if (process.platform !== "win32") {
    fs.writeFileSync(assetPath, assetContent);
    fs.symlinkSync(assetPath, report.manifestPath);
    assert.throws(verify, /must be a regular file/);
    fs.unlinkSync(report.manifestPath);
    fs.writeFileSync(report.manifestPath, JSON.stringify(manifest));
    fs.unlinkSync(assetPath);
    fs.symlinkSync(report.manifestPath, assetPath);
    assert.throws(verify, /ZIP must be a regular file/);
  }
});

test("signMacosUpdate refuses a private key that does not match the app trust root", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "owb-update-signing-mismatch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "release", "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
  fs.writeFileSync(path.join(root, "release", "dist", trust.expectedAssetName("0.2.0")), "asset");
  const pair = crypto.generateKeyPairSync("ed25519");
  await assert.rejects(
    () => signMacosUpdate({ root, privateKey: pair.privateKey }),
    /does not match the public key embedded in the app/,
  );
});

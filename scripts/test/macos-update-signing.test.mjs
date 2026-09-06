import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { signMacosUpdate } from "../sign-macos-update.mjs";
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
  fs.writeFileSync(assetPath, "test release asset");

  const report = await signMacosUpdate({
    root,
    privateKey: pair.privateKey,
    publicKeyPem,
  });
  const manifest = JSON.parse(fs.readFileSync(report.manifestPath, "utf8"));
  assert.equal(manifest.assetName, assetName);
  assert.equal(manifest.size, fs.statSync(assetPath).size);
  assert.deepEqual(
    trust.verifyUpdateManifest(manifest, { publicKeyPem }),
    { ok: true },
  );
  assert.equal(Object.hasOwn(manifest, "privateKey"), false);
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

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  UPDATE_ARCH,
  UPDATE_MANIFEST_NAME,
  UPDATE_MANIFEST_SCHEMA,
  UPDATE_PLATFORM,
  UPDATE_PUBLIC_KEY_PEM,
  UPDATE_REPOSITORY,
  canonicalUpdatePayload,
  expectedAssetName,
  publicKeyId,
  verifyUpdateManifest,
} = require("../apps/desktop/src/update-trust.cjs");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "release", "dist");

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function privateKeyFromEnvironment() {
  const value = process.env.OWB_UPDATE_SIGNING_PRIVATE_KEY;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("OWB_UPDATE_SIGNING_PRIVATE_KEY is required to sign the macOS update manifest");
  }
  try {
    return crypto.createPrivateKey(value);
  } catch {
    throw new Error("OWB_UPDATE_SIGNING_PRIVATE_KEY is not a valid private key");
  }
}

export async function signMacosUpdate({
  root = projectRoot,
  version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version,
  privateKey = privateKeyFromEnvironment(),
  publicKeyPem = UPDATE_PUBLIC_KEY_PEM,
} = {}) {
  const output = path.join(root, "release", "dist");
  const assetName = expectedAssetName(version, UPDATE_ARCH);
  const assetPath = path.join(output, assetName);
  if (!fs.existsSync(assetPath)) throw new Error(`macOS update asset is missing: ${assetName}`);
  if (path.basename(assetPath) !== assetName) throw new Error("macOS update asset escaped the release directory");

  const publicKey = crypto.createPublicKey(privateKey);
  const derivedKeyId = publicKeyId(publicKey.export({ format: "pem", type: "spki" }).toString());
  if (derivedKeyId !== publicKeyId(publicKeyPem)) {
    throw new Error("the release private key does not match the public key embedded in the app");
  }

  const stat = fs.statSync(assetPath);
  const manifest = {
    schemaVersion: UPDATE_MANIFEST_SCHEMA,
    repository: UPDATE_REPOSITORY,
    tag: `v${version}`,
    platform: UPDATE_PLATFORM,
    arch: UPDATE_ARCH,
    version,
    assetName,
    sha256: await sha256(assetPath),
    size: stat.size,
    publicKeyId: derivedKeyId,
  };
  const signature = crypto.sign(
    null,
    Buffer.from(canonicalUpdatePayload(manifest), "utf8"),
    privateKey,
  ).toString("base64");
  const signedManifest = { ...manifest, signature };
  const verification = verifyUpdateManifest(signedManifest, { arch: UPDATE_ARCH, publicKeyPem });
  if (!verification.ok) throw new Error(`generated update manifest did not verify: ${verification.reason}`);
  const manifestPath = path.join(output, UPDATE_MANIFEST_NAME);
  fs.writeFileSync(manifestPath, `${JSON.stringify(signedManifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return { manifestPath, assetName, version, sha256: manifest.sha256, size: stat.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  signMacosUpdate()
    .then((report) => console.log(JSON.stringify({ schemaVersion: "org-workbench-update-signature.v1", ...report })))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

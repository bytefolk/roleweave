/**
 * Trust root for the free GitHub update channel.
 *
 * This is deliberately separate from Apple's code-signing identity. The
 * private Ed25519 key never ships in the app; it is held by the release
 * workflow as OWB_UPDATE_SIGNING_PRIVATE_KEY. The public key is safe to embed
 * here because it only verifies release metadata.
 */

const crypto = require("node:crypto");

const UPDATE_MANIFEST_SCHEMA = "org-workbench-update.v1";
const UPDATE_REPOSITORY = "bytefolk/roleweave";
const UPDATE_MANIFEST_NAME = "latest-mac.json";
const UPDATE_PLATFORM = "darwin";
const UPDATE_ARCH = "arm64";
const UPDATE_APP_NAME = "RoleWeave";
const UPDATE_ASSET_PREFIX = "roleweave";
const MAX_UPDATE_BYTES = 512 * 1024 * 1024;

// Generated once for this repository. This public half is intentionally
// committed; the private half exists only in GitHub Actions Secrets.
const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA54GwE4fXKaIiU17E3a/Ns8ihWaZUMaEOyO4WkUCYf7A=
-----END PUBLIC KEY-----
`;

function publicKeyId(publicKeyPem = UPDATE_PUBLIC_KEY_PEM) {
  const der = crypto.createPublicKey(publicKeyPem).export({ format: "der", type: "spki" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

const UPDATE_PUBLIC_KEY_ID = publicKeyId();

function canonicalUpdatePayload(manifest) {
  return [
    manifest.schemaVersion,
    manifest.repository,
    manifest.tag,
    manifest.platform,
    manifest.arch,
    manifest.version,
    manifest.assetName,
    manifest.sha256,
    String(manifest.size),
    manifest.publicKeyId,
  ].join("\n");
}

function semverParts(version) {
  if (typeof version !== "string") return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split(".").map((part) => {
    if (/^\d+$/.test(part)) return Number(part);
    return part;
  });
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (index >= left.length) return -1;
    if (index >= right.length) return 1;
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function compareVersions(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  if (a === null || b === null) return null;
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function expectedAssetName(version, arch = UPDATE_ARCH) {
  return `${UPDATE_ASSET_PREFIX}-${version}-${arch}.zip`;
}

function invalid(reason) {
  return { ok: false, reason };
}

/** Validate the signed release metadata without performing any network I/O. */
function verifyUpdateManifest(manifest, { arch = UPDATE_ARCH, publicKeyPem = UPDATE_PUBLIC_KEY_PEM } = {}) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return invalid("the update manifest is not an object");
  }
  if (manifest.schemaVersion !== UPDATE_MANIFEST_SCHEMA) return invalid("unsupported update manifest schema");
  if (manifest.repository !== UPDATE_REPOSITORY) return invalid("the update manifest names an unexpected repository");
  if (manifest.platform !== UPDATE_PLATFORM) return invalid("the update manifest names an unexpected platform");
  if (manifest.arch !== arch) return invalid("the update manifest names an unexpected architecture");
  if (manifest.publicKeyId !== publicKeyId(publicKeyPem)) return invalid("the update manifest uses an unexpected signing key");
  if (semverParts(manifest.version) === null) return invalid("the update manifest contains an invalid version");
  if (manifest.tag !== `v${manifest.version}`) return invalid("the release tag does not match the version");
  if (manifest.assetName !== expectedAssetName(manifest.version, arch)) return invalid("the update asset name does not match the version");
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) return invalid("the update asset hash is invalid");
  if (!Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.size > MAX_UPDATE_BYTES) {
    return invalid("the update asset size is invalid");
  }
  if (typeof manifest.signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(manifest.signature)) {
    return invalid("the update manifest signature is invalid");
  }
  const signature = Buffer.from(manifest.signature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== manifest.signature) {
    return invalid("the update manifest signature is malformed");
  }
  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(canonicalUpdatePayload(manifest), "utf8"),
      publicKeyPem,
      signature,
    );
  } catch {
    return invalid("the update manifest signature could not be checked");
  }
  return verified ? { ok: true } : invalid("the update manifest signature does not match");
}

module.exports = {
  MAX_UPDATE_BYTES,
  UPDATE_APP_NAME,
  UPDATE_ARCH,
  UPDATE_ASSET_PREFIX,
  UPDATE_MANIFEST_NAME,
  UPDATE_MANIFEST_SCHEMA,
  UPDATE_PLATFORM,
  UPDATE_PUBLIC_KEY_ID,
  UPDATE_PUBLIC_KEY_PEM,
  UPDATE_REPOSITORY,
  canonicalUpdatePayload,
  compareVersions,
  expectedAssetName,
  publicKeyId,
  semverParts,
  verifyUpdateManifest,
};

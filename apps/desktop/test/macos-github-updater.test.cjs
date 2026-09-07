const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createMacGithubUpdaterService,
  githubReleaseAssetUrl,
  parseLatestReleaseTagFromAtom,
} = require("../src/macos-github-updater.cjs");
const trust = require("../src/update-trust.cjs");

function testManifestPair({ version = "0.2.0", body = "signed update" } = {}) {
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const assetName = trust.expectedAssetName(version);
  const bytes = Buffer.from(body);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    schemaVersion: trust.UPDATE_MANIFEST_SCHEMA,
    repository: trust.UPDATE_REPOSITORY,
    tag: `v${version}`,
    platform: trust.UPDATE_PLATFORM,
    arch: trust.UPDATE_ARCH,
    version,
    assetName,
    sha256,
    size: bytes.length,
    publicKeyId: trust.publicKeyId(publicKeyPem),
  };
  manifest.signature = crypto.sign(
    null,
    Buffer.from(trust.canonicalUpdatePayload(manifest)),
    pair.privateKey,
  ).toString("base64");
  return { manifest, publicKeyPem, bytes };
}

test("the free channel verifies a signed manifest, downloads the ZIP, and schedules replacement on quit", async (t) => {
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "owb-github-updater-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const appPath = path.join(fixture, "RoleWeave.app");
  fs.mkdirSync(appPath);
  const { manifest, publicKeyPem, bytes } = testManifestPair();
  const events = [];
  const spawns = [];
  let quitCalls = 0;
  const service = createMacGithubUpdaterService({
    currentVersion: "0.1.0",
    appPath,
    tempDirectory: fixture,
    helperPath: "/private/helper/macos-update-helper.cjs",
    execPath: "/private/RoleWeave",
    parentPid: 12345,
    onState: (event) => events.push(event),
    fetchLatestRelease: async () => ({
      tag_name: manifest.tag,
      draft: false,
      prerelease: false,
      assets: [
        { name: trust.UPDATE_MANIFEST_NAME, size: 1 },
        { name: manifest.assetName, size: manifest.size, digest: `sha256:${manifest.sha256}` },
      ],
    }),
    fetchManifest: async () => manifest,
    verifyManifest: (candidate, options) => trust.verifyUpdateManifest(candidate, { ...options, publicKeyPem }),
    download: async (_url, destination, options) => {
      fs.writeFileSync(destination, bytes, { mode: 0o600 });
      options.onProgress(100);
      return { bytes: bytes.length };
    },
    spawnProcess: (_command, args) => {
      spawns.push({ args });
      return { unref() {} };
    },
    quit: () => { quitCalls += 1; },
  });

  const result = await service.check({ automatic: true });
  assert.deepEqual(result, { state: "downloaded", version: "0.2.0" });
  assert.equal(service.updateVerified, true);
  assert.equal(service.state, "downloaded");
  assert.deepEqual(events.map((event) => event.state), [
    "checking", "available", "downloading", "downloading", "downloaded",
  ]);
  assert.equal(spawns.length, 0, "automatic download must not restart the app mid-session");

  const install = await service.installOnQuit();
  assert.equal(install.installing, true);
  assert.equal(quitCalls, 0, "before-quit already owns the normal app exit");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].args[0], "/private/helper/macos-update-helper.cjs");
  const requestPath = spawns[0].args[1];
  assert.equal(path.basename(requestPath), "request.json");
  assert.equal(path.dirname(requestPath).startsWith(fixture), true);
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  assert.equal(request.manifest.signature, manifest.signature);
  assert.equal(request.targetAppPath, appPath);
  assert.equal(path.basename(request.zipPath), manifest.assetName);
  assert.equal(path.dirname(request.zipPath), path.dirname(requestPath));
});

test("the free channel rejects tampered release metadata and never downloads it", async () => {
  const { manifest, publicKeyPem } = testManifestPair();
  manifest.sha256 = "0".repeat(64);
  const service = createMacGithubUpdaterService({
    currentVersion: "0.1.0",
    appPath: "/Applications/RoleWeave.app",
    fetchLatestRelease: async () => ({ tag_name: "v0.2.0", assets: [] }),
    fetchManifest: async () => manifest,
    verifyManifest: (candidate, options) => trust.verifyUpdateManifest(candidate, { ...options, publicKeyPem }),
    download: async () => { throw new Error("download must not run"); },
  });
  const result = await service.check();
  assert.equal(result.state, "error");
  assert.match(result.reason, /signature/);
});

test("the free channel falls back to the public Atom feed when GitHub API is rate limited", async (t) => {
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "owb-github-atom-fallback-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const appPath = path.join(fixture, "RoleWeave.app");
  fs.mkdirSync(appPath);
  const { manifest, publicKeyPem, bytes } = testManifestPair();
  let fallbackCalls = 0;
  const service = createMacGithubUpdaterService({
    currentVersion: "0.1.0",
    appPath,
    tempDirectory: fixture,
    fetchLatestRelease: async () => {
      const error = new Error("GitHub returned HTTP 403");
      error.statusCode = 403;
      throw error;
    },
    fetchLatestReleaseFromFallback: async () => {
      fallbackCalls += 1;
      return { tag_name: manifest.tag, draft: false, prerelease: false, source: "atom" };
    },
    fetchManifest: async () => manifest,
    verifyManifest: (candidate, options) => trust.verifyUpdateManifest(candidate, { ...options, publicKeyPem }),
    download: async (_url, destination, options) => {
      fs.writeFileSync(destination, bytes, { mode: 0o600 });
      options.onProgress(100);
      return { bytes: bytes.length };
    },
  });

  const result = await service.check({ automatic: true });
  assert.deepEqual(result, { state: "downloaded", version: "0.2.0" });
  assert.equal(fallbackCalls, 1);
});

test("the Atom fallback accepts only a same-repository release-tag link", () => {
  const feed = [
    "<feed xmlns=\"http://www.w3.org/2005/Atom\">",
    "<entry><link rel=\"alternate\" type=\"text/html\" href=\"https://github.com/bytefolk/roleweave/releases/tag/v0.2.0\"/></entry>",
    "</feed>",
  ].join("");
  assert.equal(parseLatestReleaseTagFromAtom(feed), "v0.2.0");
  assert.throws(
    () => parseLatestReleaseTagFromAtom(feed.replace("bytefolk/roleweave", "other/repository")),
    /without a valid release tag/,
  );
});

test("release asset URLs are fixed to the repository and HTTPS", () => {
  assert.equal(
    githubReleaseAssetUrl("v0.2.0", "roleweave-0.2.0-arm64.zip"),
    "https://github.com/bytefolk/roleweave/releases/download/v0.2.0/roleweave-0.2.0-arm64.zip",
  );
  assert.throws(() => githubReleaseAssetUrl("https://evil.example/v0.2.0", "x.zip"), /tag is invalid/);
  assert.throws(() => githubReleaseAssetUrl("v0.2.0", "../../evil.zip"), /asset name is invalid/);
});

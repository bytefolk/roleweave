/**
 * Free macOS update channel.
 *
 * Electron's Squirrel.Mac updater requires an Apple code-signing identity. This
 * service intentionally does not use Squirrel.Mac: it reads a signed manifest
 * from the public GitHub Releases API (with an Atom-feed fallback), downloads
 * the matching ZIP, verifies the asset, and delegates the replacement to a
 * small detached helper. The update signing key is independent of Apple and
 * the private half never ships.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  MAX_UPDATE_BYTES,
  UPDATE_APP_NAME,
  UPDATE_ARCH,
  UPDATE_MANIFEST_NAME,
  UPDATE_REPOSITORY,
  compareVersions,
  verifyUpdateManifest,
} = require("./update-trust.cjs");

const UPDATE_STATES = Object.freeze([
  "idle",
  "unavailable",
  "checking",
  "current",
  "available",
  "downloading",
  "downloaded",
  "error",
]);
const API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
// GitHub's REST API has a low anonymous per-IP limit. The public Atom feed is
// served by github.com rather than api.github.com and gives us the published
// release tag without requiring a token. It is the recovery path when the API
// responds with a rate-limit 403.
const RELEASES_ATOM_URL = `https://github.com/${UPDATE_REPOSITORY}/releases.atom`;
const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);
const MAX_MANIFEST_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_REDIRECTS = 5;
const APPLE_SECRET_ENV_NAMES = [
  "MACOS_CERTIFICATE",
  "MACOS_CERTIFICATE_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
];

function normalizedError(error) {
  if (error === null || error === undefined) return "update failed for an unstated reason";
  return String(typeof error === "string" ? error : error.message ?? error).slice(0, 512);
}

function githubHttpError(statusCode, suffix = "") {
  const error = new Error(`GitHub returned HTTP ${statusCode ?? "unknown"}${suffix}`);
  error.statusCode = statusCode;
  return error;
}

function isGithubRateLimitError(error) {
  const statusCode = Number(error?.statusCode);
  return statusCode === 403 || statusCode === 429 || /GitHub returned HTTP (?:403|429)\b/.test(normalizedError(error));
}

function githubReleaseAssetUrl(tag, name) {
  if (typeof tag !== "string" || !/^v[0-9A-Za-z.+-]+$/.test(tag)) throw new Error("the GitHub release tag is invalid");
  if (typeof name !== "string" || !/^[A-Za-z0-9._+-]+$/.test(name)) throw new Error("the GitHub release asset name is invalid");
  return `https://github.com/${UPDATE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function assertHttpsUrl(value, { api = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("the update URL is invalid");
  }
  if (url.protocol !== "https:") throw new Error("the update URL must use HTTPS");
  if (api && url.hostname !== "api.github.com") throw new Error("the update API host is not GitHub");
  if (!api && !DOWNLOAD_HOSTS.has(url.hostname)) throw new Error("the update download host is not GitHub");
  return url;
}

function requestBuffer(urlValue, { maxBytes, timeoutMs, requestImpl = https.request, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = assertHttpsUrl(urlValue, { api: urlValue === API_URL });
    } catch (error) {
      reject(error);
      return;
    }
    const request = requestImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "roleweave-updater",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (urlValue === API_URL || redirects >= MAX_REDIRECTS) {
          reject(new Error("the update metadata redirected unexpectedly"));
          return;
        }
        let next;
        try {
          next = new URL(response.headers.location, url).toString();
          assertHttpsUrl(next);
        } catch (error) {
          reject(error);
          return;
        }
        requestBuffer(next, { maxBytes, timeoutMs, requestImpl, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(githubHttpError(response.statusCode));
        response.resume();
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          request.destroy(new Error("the update response is too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("the update request timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function fetchJson(url, options = {}) {
  const body = await requestBuffer(url, { ...options, maxBytes: options.maxBytes ?? MAX_MANIFEST_BYTES });
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("GitHub returned invalid update metadata");
  }
}

/**
 * Extract the first published release tag from GitHub's Atom feed. Keep this
 * parser deliberately narrow: the link must point back to this repository's
 * GitHub release-tag URL, so feed content cannot redirect the updater to an
 * arbitrary repository or host.
 */
function parseLatestReleaseTagFromAtom(body) {
  const entry = /<entry\b[\s\S]*?<\/entry>/i.exec(String(body))?.[0];
  if (entry === undefined) throw new Error("GitHub returned an empty releases feed");

  for (const match of entry.matchAll(/<link\b([^>]*)>/gi)) {
    const attributes = match[1];
    if (!/\brel\s*=\s*["']alternate["']/i.test(attributes)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (href === undefined) continue;
    let url;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    const expectedPrefix = `/${UPDATE_REPOSITORY}/releases/tag/`;
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith(expectedPrefix)) continue;
    const tag = url.pathname.slice(expectedPrefix.length);
    if (/^v[0-9A-Za-z.+-]+$/.test(tag)) return tag;
  }
  throw new Error("GitHub returned a releases feed without a valid release tag");
}

async function fetchLatestReleaseFromAtom() {
  const body = await requestBuffer(RELEASES_ATOM_URL, {
    maxBytes: MAX_MANIFEST_BYTES,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  return {
    tag_name: parseLatestReleaseTagFromAtom(body.toString("utf8")),
    // Atom only exposes published entries, so drafts are excluded. The signed
    // manifest remains the authority for the version and artifact details.
    draft: false,
    prerelease: false,
    source: "atom",
  };
}

function downloadFile(urlValue, destination, { expectedBytes, onProgress = () => {}, requestImpl = https.request } = {}) {
  return new Promise((resolve, reject) => {
    const follow = (value, redirects) => {
      let url;
      try {
        url = assertHttpsUrl(value);
      } catch (error) {
        reject(error);
        return;
      }
      const request = requestImpl(url, {
        method: "GET",
        headers: { "User-Agent": "roleweave-updater", Accept: "application/octet-stream" },
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirects >= MAX_REDIRECTS) {
            reject(new Error("the update download redirected too many times"));
            return;
          }
          const next = new URL(response.headers.location, url).toString();
          follow(next, redirects + 1);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(githubHttpError(response.statusCode, " for the update"));
          return;
        }
        const contentLength = Number(response.headers["content-length"]);
        if (Number.isSafeInteger(contentLength) && contentLength > MAX_UPDATE_BYTES) {
          response.resume();
          reject(new Error("the update asset is too large"));
          return;
        }
        const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
        let bytes = 0;
        let rejected = false;
        const fail = (error) => {
          if (rejected) return;
          rejected = true;
          output.destroy();
          response.destroy();
          reject(error);
        };
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_UPDATE_BYTES || (expectedBytes !== undefined && bytes > expectedBytes)) {
            fail(new Error("the downloaded update is larger than its signed size"));
            return;
          }
          onProgress(expectedBytes ? Math.round((bytes / expectedBytes) * 100) : null);
        });
        response.on("error", fail);
        output.on("error", fail);
        output.on("finish", () => {
          if (rejected) return;
          if (expectedBytes !== undefined && bytes !== expectedBytes) {
            fail(new Error("the downloaded update size does not match its signed size"));
            return;
          }
          resolve({ bytes });
        });
        response.pipe(output);
      });
      request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => request.destroy(new Error("the update download timed out")));
      request.on("error", reject);
      request.end();
    };
    follow(urlValue, 0);
  });
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function safeHelperEnvironment() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const name of APPLE_SECRET_ENV_NAMES) delete env[name];
  return env;
}

function cleanupDirectory(directory) {
  if (typeof directory !== "string" || directory.length === 0) return;
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // The helper can clean a failed download on the next launch; cleanup is
    // best effort and never turns a verified download into a false failure.
  }
}

function createMacGithubUpdaterService({
  currentVersion,
  appPath = null,
  arch = UPDATE_ARCH,
  onState = () => {},
  tempDirectory = os.tmpdir(),
  helperPath = path.join(__dirname, "macos-update-helper.cjs"),
  execPath = process.execPath,
  parentPid = process.pid,
  quit = null,
  spawnProcess = spawn,
  fetchLatestRelease = () => fetchJson(API_URL, { timeoutMs: REQUEST_TIMEOUT_MS }),
  fetchLatestReleaseFromFallback = fetchLatestReleaseFromAtom,
  fetchManifest = (url) => fetchJson(url, { timeoutMs: REQUEST_TIMEOUT_MS }),
  download = (url, destination, options) => downloadFile(url, destination, options),
  verifyManifest = verifyUpdateManifest,
} = {}) {
  const availability = appPath === null
    ? { available: false, requiresConfirmation: false, reason: "no packaged macOS app path; this is a source-tree run" }
    : arch !== UPDATE_ARCH
      ? { available: false, requiresConfirmation: false, reason: `this macOS build has no ${arch} GitHub update artifact` }
      : { available: true, requiresConfirmation: false };
  let state = availability.available ? "idle" : "unavailable";
  let latest = null;
  let downloaded = null;
  let installing = false;

  const publish = (next, detail = {}) => {
    state = next;
    onState({ state: next, ...detail });
  };
  const fail = (error) => {
    const reason = normalizedError(error);
    cleanupDirectory(downloaded?.directory);
    downloaded = null;
    publish("error", { reason });
    return { state: "error", reason };
  };

  const service = {
    get state() { return state; },
    availability,
    // `signed` is the native Apple publisher identity. This free channel uses
    // `updateVerified` below instead, so the UI can distinguish the two.
    build: { signed: false, reason: null },
    updateVerified: availability.available,

    async check({ automatic = false } = {}) {
      if (!availability.available) {
        publish("unavailable", { reason: availability.reason });
        return { state: "unavailable", reason: availability.reason };
      }
      if (state === "downloading" || state === "downloaded") return { state, version: latest?.version ?? null };
      publish("checking");
      try {
        let release;
        try {
          release = await fetchLatestRelease();
        } catch (error) {
          if (!isGithubRateLimitError(error)) throw error;
          // Do not make an anonymous API retry: it would only prolong the
          // failure window. The Atom feed supplies the tag and the manifest
          // download below supplies the signed release details.
          release = await fetchLatestReleaseFromFallback();
        }
        if (release?.draft === true || release?.prerelease === true) throw new Error("the latest GitHub release is not public");
        const tag = release?.tag_name;
        const manifestUrl = githubReleaseAssetUrl(tag, UPDATE_MANIFEST_NAME);
        const manifest = await fetchManifest(manifestUrl);
        const verification = verifyManifest(manifest, { arch });
        if (!verification.ok) throw new Error(verification.reason);
        if (tag !== manifest.tag) throw new Error("the GitHub release tag does not match its signed manifest");
        if (release.source === "atom") {
          // The Atom fallback has no asset inventory. Fetching the signed
          // manifest from the tag-specific asset URL already proves that the
          // named asset exists; the ZIP is checked again by size and SHA-256
          // before it can be installed.
        } else {
          const assets = Array.isArray(release.assets) ? release.assets : [];
          const asset = assets.find((entry) => entry?.name === manifest.assetName);
          if (asset === undefined) throw new Error("the signed macOS update asset is missing from the release");
          if (Number.isSafeInteger(asset.size) && asset.size !== manifest.size) throw new Error("the GitHub asset size does not match its signed manifest");
          if (typeof asset.digest === "string" && asset.digest !== `sha256:${manifest.sha256}`) throw new Error("the GitHub asset digest does not match its signed manifest");
        }
        const comparison = compareVersions(manifest.version, currentVersion);
        if (comparison === null) throw new Error("the running app version is invalid");
        if (comparison <= 0) {
          latest = null;
          publish("current");
          return { state: "current", version: currentVersion };
        }
        latest = { ...manifest, downloadUrl: githubReleaseAssetUrl(manifest.tag, manifest.assetName) };
        publish("available", { version: manifest.version });
        if (automatic) return service.download({ automatic: true });
        return { state: "available", version: manifest.version };
      } catch (error) {
        return fail(error);
      }
    },

    async download({ confirmedByUser = false, automatic = false } = {}) {
      if (!availability.available) return { state: "unavailable", reason: availability.reason };
      if (state !== "available" || latest === null) return { state, reason: "no update is available to download" };
      if (!automatic && confirmedByUser !== true) return { state, reason: "downloading an update requires explicit confirmation" };
      const directory = fs.mkdtempSync(path.join(tempDirectory, "org-workbench-update-"));
      const destination = path.join(directory, latest.assetName);
      try {
        publish("downloading", { version: latest.version, percent: 0 });
        await download(latest.downloadUrl, destination, {
          expectedBytes: latest.size,
          onProgress: (percent) => publish("downloading", { version: latest.version, percent }),
        });
        const stat = fs.statSync(destination);
        const hash = await sha256File(destination);
        if (stat.size !== latest.size || hash !== latest.sha256) throw new Error("the downloaded update failed its signed hash check");
        downloaded = { directory, zipPath: destination, manifest: latest };
        publish("downloaded", { version: latest.version });
        return { state: "downloaded", version: latest.version };
      } catch (error) {
        cleanupDirectory(directory);
        return fail(error);
      }
    },

    async install({ confirmedByUser = false, automatic = false } = {}) {
      if (!availability.available) return { state: "unavailable", reason: availability.reason };
      if (state !== "downloaded" || downloaded === null) return { state, reason: "no downloaded update is ready to install" };
      if (!automatic && confirmedByUser !== true) return { state, reason: "installing an update requires explicit confirmation" };
      if (installing) return { state: "downloaded", installing: true, version: downloaded.manifest.version };
      if (typeof quit !== "function") return fail("the app quit callback is unavailable");
      const requestPath = path.join(downloaded.directory, "request.json");
      const request = {
        schemaVersion: "org-workbench-update-request.v1",
        parentPid,
        targetAppPath: appPath,
        zipPath: downloaded.zipPath,
        manifest: downloaded.manifest,
        appName: UPDATE_APP_NAME,
        arch,
      };
      try {
        fs.writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        const child = spawnProcess(execPath, [helperPath, requestPath], {
          detached: true,
          stdio: "ignore",
          env: safeHelperEnvironment(),
        });
        child.unref?.();
        installing = true;
        if (!automatic) quit();
        return { state: "downloaded", installing: true, version: downloaded.manifest.version };
      } catch (error) {
        return fail(error);
      }
    },

    /** Called from `before-quit`: verified updates replace the app on a normal exit. */
    async installOnQuit() {
      if (installing || state !== "downloaded") return { state };
      return service.install({ automatic: true });
    },
  };
  return service;
}

module.exports = {
  API_URL,
  DOWNLOAD_HOSTS,
  RELEASES_ATOM_URL,
  UPDATE_STATES,
  createMacGithubUpdaterService,
  fetchLatestReleaseFromAtom,
  githubReleaseAssetUrl,
  githubHttpError,
  isGithubRateLimitError,
  normalizedError,
  parseLatestReleaseTagFromAtom,
  sha256File,
};

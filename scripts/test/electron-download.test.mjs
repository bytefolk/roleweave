import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"));
const { downloadElectronArtifactZip } = builderRequire("./out/util/electronGet.js");

// Exercise the builder's real downloader, including its CommonJS -> ESM boundary.
// The fixture serves only loopback data; SHA256 verification remains enabled.
test("builder and Electron share the downloader without the vulnerable HTTP cache", async () => {
  assert.equal(builderRequire.resolve("@electron/get"), require.resolve("@electron/get"));
  const lock = JSON.parse(await fs.readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
  for (const name of Object.keys(lock.packages)) {
    assert.ok(!/(?:^|\/)node_modules\/(?:http-cache-semantics|got|cacheable-request)$/.test(name), name);
  }
});

test("builder downloads, verifies and reuses an artifact; rejects corrupt bytes", { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-electron-download-"));
  const payload = Buffer.from("fixture artifact bytes\n");
  const filename = "electron-v43.7.6-linux-x64.zip";
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (req.url !== `/v43.7.6/${filename}`) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-length": payload.length });
    res.end(payload);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const options = {
    artifactName: "electron", version: "43.7.6", platformName: "linux", arch: "x64",
    cacheDir: root,
    electronDownload: {
      mirrorOptions: { mirror: `http://127.0.0.1:${server.address().port}/`, customDir: "v43.7.6" },
      checksums: { [filename]: createHash("sha256").update(payload).digest("hex") },
    },
  };
  const first = await downloadElectronArtifactZip(options);
  assert.deepEqual(await fs.readFile(first), payload);
  assert.equal(requests, 1);
  const cached = await downloadElectronArtifactZip(options);
  assert.deepEqual(await fs.readFile(cached), payload);
  assert.equal(requests, 1, "verified cache avoids a second HTTP request");
  await assert.rejects(downloadElectronArtifactZip({
    ...options, cacheDir: path.join(root, "bad-checksum"),
    electronDownload: { ...options.electronDownload, checksums: { [filename]: "0".repeat(64) } },
  }), /checksum|does not match/i);
});

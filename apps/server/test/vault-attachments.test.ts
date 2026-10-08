import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";
import type { OpenWorkspace } from "../src/workspace-state.js";
import type { ServiceConnection } from "../src/services/connections.js";
import { attachMemAsset, prepareVaultAttachments, hydrateVaultAttachments, referencedVaultAssetPaths, normalizeVaultAssetReferences } from "../src/vault/attachments.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");
const FILE = "00000000-0000-4000-8000-000000000011";
const UPLOADED = "00000000-0000-4000-8000-000000000012";
const WORKSPACE = "00000000-0000-4000-8000-000000000013";
const VAULT = "00000000-0000-4000-8000-000000000014";
const TOKEN = "fixture-mem-private-token";
const hash = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
type FileValue = { id: string; name: string; mime: string; size: number; sha256: string; data: Buffer };
type State = { file: FileValue; redirect?: string; uploads: number; uploadBody?: Buffer; failDownloads?: Set<string>; beforeDownload?: (fileId: string) => Promise<void> };

async function fixture(state: State) {
  const versions = new Map<string, FileValue>([[state.file.id, state.file]]);
  const requests: Array<{ url: string; auth: string | undefined; workspace: string | string[] | undefined }> = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ url: req.url ?? "", auth: req.headers.authorization, workspace: req.headers["x-workspace-id"] });
    const route = req.url?.replace(/^\/mem/, "") ?? "";
    if (req.method === "POST" && route === "/v1/files") {
      const parts: Buffer[] = []; for await (const chunk of req) parts.push(Buffer.from(chunk));
      const body = Buffer.concat(parts); state.uploads++; state.uploadBody = body;
      const boundary = /boundary=(.+)$/i.exec(req.headers["content-type"] ?? "")?.[1];
      assert.ok(boundary);
      const headerEnd = body.indexOf("\r\n\r\n"); const end = body.indexOf("\r\n--" + boundary, headerEnd + 4);
      const data = body.subarray(headerEnd + 4, end); const header = body.subarray(0, headerEnd).toString("utf8");
      const type = /Content-Type: ([^\r\n]+)/i.exec(header)?.[1] ?? "application/octet-stream";
      const existing = [...versions.values()].find(value => value.id !== FILE && value.sha256 === hash(data));
      state.file = existing ?? { id: versions.has(UPLOADED) ? crypto.randomUUID() : UPLOADED, name: "old-dedup-name.png", mime: type, size: data.length, sha256: hash(data), data };
      versions.set(state.file.id, state.file);
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ file: { ...state.file, data: undefined, path: "/OldFolder" }, deduped: true })); return;
    }
    const id = /^\/v1\/files\/([^/]+)/u.exec(route)?.[1]; const file = id ? versions.get(id) : undefined;
    if (!file) { res.statusCode = 404; res.end(); return; }
    if (route.endsWith("/content")) {
      if (state.redirect) { res.writeHead(302, { location: state.redirect }); res.end(); return; }
      await state.beforeDownload?.(file.id);
      if (state.failDownloads?.has(file.id)) { res.statusCode = 503; res.end(); return; }
      res.setHeader("Content-Type", file.mime); res.end(file.data); return;
    }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ...file, data: undefined }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const connection: ServiceConnection = { kind: "mem", apiUrl: `http://127.0.0.1:${address.port}/mem`, webUrl: "http://localhost", token: TOKEN, workspaceId: WORKSPACE };
  return { connection, requests, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
function state(data = PNG, mime = "image/png", name = "original.png"): State {
  return { file: { id: FILE, name, mime, data, size: data.length, sha256: hash(data) }, uploads: 0 };
}
async function localWorkspace(): Promise<OpenWorkspace> {
  return { dir: await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-vault-asset-test-")) } as OpenWorkspace;
}
async function cleanup(workspace: OpenWorkspace) { await fs.rm(workspace.dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
function pixelPNG(red: number, green: number, blue: number): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name); let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, data])) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, red, green, blue, 255]))), chunk("IEND", Buffer.alloc(0))]);
}
async function initialVersion(workspace: OpenWorkspace, connection: ServiceConnection) {
  await fs.mkdir(path.join(workspace.dir, "notes", "assets"), { recursive: true });
  await fs.writeFile(path.join(workspace.dir, "notes", "assets", "initial.png"), PNG);
  return prepareVaultAttachments(workspace, [{ noteId: "photo-note", path: "note.md", content: "![Photo](assets/initial.png)", properties: {} }], connection, VAULT);
}
function firstAsset(entries: Array<{ properties?: Record<string, unknown> }>) {
  return (entries[0]!.properties!.assets as Array<{ path: string; fileId: string; mime: string; sha256: string }>)[0]!;
}

test("attach preserves verified original raster/file bytes and records private metadata without tokens", async () => {
  for (const value of [state(), state(Buffer.from("plain original file"), "text/plain", "notes.txt")]) {
    const upstream = await fixture(value); const workspace = await localWorkspace();
    try {
      const attached = await attachMemAsset(workspace, upstream.connection, FILE);
      assert.equal(attached.name, value.file.name); assert.equal(attached.mime, value.file.mime);
      assert.deepEqual(await fs.readFile(path.join(workspace.dir, "notes", attached.path)), value.file.data);
      const ledger = await fs.readFile(path.join(workspace.dir, ".roleweave", "vault", "assets.json"), "utf8");
      assert.match(ledger, new RegExp(value.file.sha256)); assert.equal(ledger.includes(TOKEN), false);
      for (const request of upstream.requests) { assert.equal(request.auth, "Bearer " + TOKEN); assert.equal(request.workspace, WORKSPACE); }
      assert.deepEqual(upstream.requests.map(item => item.url), [`/mem/v1/files/${FILE}`, `/mem/v1/files/${FILE}/content`]);
    } finally { await upstream.close(); await cleanup(workspace); }
  }
});

test("attachments refuse forged hashes, size mismatch, oversized objects and redirected originals", async () => {
  const receiver = http.createServer((_req, res) => { res.end("should not be reached"); }); let reached = 0;
  receiver.on("request", () => reached++); await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address(); assert.ok(address && typeof address !== "string");
  const broken = [state(), state(), state(), state()];
  broken[0]!.file.sha256 = "a".repeat(64); broken[1]!.file.size++;
  broken[2]!.file.size = 32 * 1024 * 1024 + 1; broken[3]!.redirect = `http://127.0.0.1:${address.port}/target`;
  try {
    for (const value of broken) {
      const upstream = await fixture(value); const workspace = await localWorkspace();
      try {
        await assert.rejects(attachMemAsset(workspace, upstream.connection, FILE), error => error instanceof Error && !error.message.includes(TOKEN));
        await assert.rejects(fs.stat(path.join(workspace.dir, "notes", "assets", value.file.sha256 + ".png")), { code: "ENOENT" });
      } finally { await upstream.close(); await cleanup(workspace); }
    }
    assert.equal(reached, 0, "credentials must never follow the redirect");
  } finally { receiver.closeAllConnections(); await new Promise<void>(resolve => receiver.close(() => resolve())); }
});

test("Obsidian assets upload once, rewrite relative/wiki links to hash versions, and hydrate intact", async () => {
  const value = state(); const upstream = await fixture(value); const first = await localWorkspace(); const second = await localWorkspace();
  try {
    await fs.mkdir(path.join(first.dir, "notes", "assets"), { recursive: true });
    await fs.writeFile(path.join(first.dir, "notes", "assets", "草地 金毛.png"), PNG);
    const entries = [{ noteId: "note", revision: 1, deleted: false, path: "客户/方案.md", content: "![[assets/草地 金毛.png]]\n![photo](../assets/草地%20金毛.png)", properties: {} }];
    const prepared = await prepareVaultAttachments(first, entries, upstream.connection, VAULT);
    assert.equal(value.uploads, 1);
    const references = prepared[0]!.properties.assets as Array<{ path: string; fileId: string; sha256: string }>;
    assert.equal(references.length, 1); assert.equal(references[0]!.path, `assets/${hash(PNG)}.png`); assert.equal(references[0]!.fileId, UPLOADED);
    assert.equal(references[0]!.sha256, hash(PNG)); assert.ok(value.uploadBody?.includes(Buffer.from(`/Vaults/${VAULT}/assets`)));
    await prepareVaultAttachments(first, prepared, upstream.connection, VAULT);
    assert.equal(value.uploads, 1, "unchanged originals should reuse the verified blob reference");
    await hydrateVaultAttachments(second, prepared, upstream.connection);
    assert.deepEqual(await fs.readFile(path.join(second.dir, "notes", references[0]!.path)), PNG);
    assert.match(prepared[0]!.content, new RegExp(`!\\[\\[assets/${hash(PNG)}\\.png\\]\\]`));
    assert.match(prepared[0]!.content, new RegExp(`\\.\\./assets/${hash(PNG)}\\.png`));
    assert.deepEqual(await fs.readFile(path.join(first.dir, "notes", "assets", "草地 金毛.png")), PNG, "legacy original remains intact");
    assert.equal(JSON.stringify(prepared).includes(TOKEN), false);
  } finally { await upstream.close(); await cleanup(first); await cleanup(second); }
});

test("hydrate rejects conflicting local originals without overwriting or downloading", async () => {
  const upstream = await fixture(state()); const workspace = await localWorkspace();
  try {
    await fs.mkdir(path.join(workspace.dir, "notes", "assets"), { recursive: true });
    const original = Buffer.from("local edit must survive"); const file = path.join(workspace.dir, "notes", "assets", "photo.png"); await fs.writeFile(file, original);
    const entry = { path: "sub/note.md", content: "![photo](../assets/photo.png)", properties: { assets: [{ path: "assets/photo.png", fileId: FILE, mime: "image/png", sha256: hash(PNG) }] } };
    await assert.rejects(hydrateVaultAttachments(workspace, [entry], upstream.connection), /existing files were preserved/);
    assert.deepEqual(await fs.readFile(file), original); assert.equal(upstream.requests.length, 0);
  } finally { await upstream.close(); await cleanup(workspace); }
});

test("single-side picture edit creates a new immutable path and another client updates without conflict", async () => {
  const value = state(); const upstream = await fixture(value); const first = await localWorkspace(); const second = await localWorkspace();
  try {
    const base = await initialVersion(first, upstream.connection); const original = firstAsset(base);
    await hydrateVaultAttachments(second, base, upstream.connection);
    const updatedBytes = pixelPNG(255, 0, 0);
    await fs.writeFile(path.join(first.dir, "notes", original.path), updatedBytes);
    const updated = await prepareVaultAttachments(first, base, upstream.connection, VAULT); const next = firstAsset(updated);
    assert.equal(next.path, `assets/${hash(updatedBytes)}.png`); assert.notEqual(next.path, original.path);
    assert.deepEqual(await fs.readFile(path.join(first.dir, "notes", original.path)), PNG, "old note/history image must be restored");
    assert.deepEqual(await fs.readFile(path.join(first.dir, "notes", next.path)), updatedBytes);
    await hydrateVaultAttachments(second, updated, upstream.connection);
    assert.deepEqual(await fs.readFile(path.join(second.dir, "notes", next.path)), updatedBytes);
    assert.deepEqual(await fs.readFile(path.join(second.dir, "notes", original.path)), PNG);
    assert.ok(updated[0]!.content.includes(next.path));
  } finally { await upstream.close(); await cleanup(first); await cleanup(second); }
});

test("two clients edit the same picture independently and conflict notes retain both exact versions", async () => {
  const value = state(); const upstream = await fixture(value); const first = await localWorkspace(); const second = await localWorkspace();
  try {
    const base = await initialVersion(first, upstream.connection); const original = firstAsset(base);
    await hydrateVaultAttachments(second, base, upstream.connection);
    const red = pixelPNG(255, 0, 0); const green = pixelPNG(0, 255, 0);
    await fs.writeFile(path.join(first.dir, "notes", original.path), red);
    await fs.writeFile(path.join(second.dir, "notes", original.path), green);
    const a = await prepareVaultAttachments(first, base, upstream.connection, VAULT);
    const b = await prepareVaultAttachments(second, base, upstream.connection, VAULT);
    const assetA = firstAsset(a); const assetB = firstAsset(b);
    assert.notEqual(assetA.path, assetB.path);
    const merged = [a[0]!, { ...b[0]!, noteId: "conflict-copy", path: "note-conflict.md" }];
    await hydrateVaultAttachments(first, merged, upstream.connection);
    await hydrateVaultAttachments(second, merged, upstream.connection);
    for (const workspace of [first, second]) {
      assert.deepEqual(await fs.readFile(path.join(workspace.dir, "notes", assetA.path)), red);
      assert.deepEqual(await fs.readFile(path.join(workspace.dir, "notes", assetB.path)), green);
      assert.deepEqual(await fs.readFile(path.join(workspace.dir, "notes", original.path)), PNG);
    }
  } finally { await upstream.close(); await cleanup(first); await cleanup(second); }
});

test("editing an active image does not redirect an archived note to the new version", async () => {
  const value = state(); const upstream = await fixture(value); const workspace = await localWorkspace();
  try {
    const base = await initialVersion(workspace, upstream.connection); const original = firstAsset(base);
    const archived = { ...base[0]!, noteId: "archived-note", properties: { ...base[0]!.properties, archived: true } };
    const edited = pixelPNG(255, 0, 0); await fs.writeFile(path.join(workspace.dir, "notes", original.path), edited);
    const updated = await prepareVaultAttachments(workspace, [base[0]!, archived], upstream.connection, VAULT);
    assert.equal(firstAsset([updated[0]!]).sha256, hash(edited));
    assert.equal(firstAsset([updated[1]!]).sha256, hash(PNG)); assert.ok(updated[1]!.content.includes(original.path));
    assert.deepEqual(await fs.readFile(path.join(workspace.dir, "notes", original.path)), PNG);
  } finally { await upstream.close(); await cleanup(workspace); }
});

test("failed original restore preserves the edit and retry reuses its verified upload", async () => {
  const value = state(); const upstream = await fixture(value); const workspace = await localWorkspace();
  try {
    const base = await initialVersion(workspace, upstream.connection); const original = firstAsset(base);
    const edit = pixelPNG(0, 0, 255); const version = `assets/${hash(edit)}.png`;
    await fs.writeFile(path.join(workspace.dir, "notes", original.path), edit);
    value.failDownloads = new Set([original.fileId]);
    await assert.rejects(prepareVaultAttachments(workspace, base, upstream.connection, VAULT), /unavailable/);
    assert.deepEqual(await fs.readFile(path.join(workspace.dir, "notes", version)), edit);
    assert.deepEqual(await fs.readFile(path.join(workspace.dir, "notes", original.path)), edit, "failed old download must not overwrite the user edit");
    const uploadCount = value.uploads; value.failDownloads.clear();
    const retried = await prepareVaultAttachments(workspace, base, upstream.connection, VAULT);
    assert.equal(value.uploads, uploadCount); assert.equal(firstAsset(retried).path, version);
    assert.deepEqual(await fs.readFile(path.join(workspace.dir, "notes", original.path)), PNG);
  } finally { await upstream.close(); await cleanup(workspace); }
});

test("a later external edit during old-version download is not overwritten and a fresh retry succeeds", async () => {
  const value = state(); const upstream = await fixture(value); const workspace = await localWorkspace();
  try {
    const base = await initialVersion(workspace, upstream.connection); const original = firstAsset(base);
    const firstEdit = pixelPNG(255, 0, 0); const laterEdit = pixelPNG(0, 255, 0);
    const file = path.join(workspace.dir, "notes", original.path); await fs.writeFile(file, firstEdit);
    value.beforeDownload = async id => { if (id === original.fileId) { value.beforeDownload = undefined; await fs.writeFile(file, laterEdit); } };
    await assert.rejects(prepareVaultAttachments(workspace, base, upstream.connection, VAULT), /existing files were preserved/);
    assert.deepEqual(await fs.readFile(file), laterEdit);
    assert.deepEqual(await fs.readFile(path.join(workspace.dir, "notes", `assets/${hash(firstEdit)}.png`)), firstEdit);
    const updated = await prepareVaultAttachments(workspace, base, upstream.connection, VAULT);
    assert.equal(firstAsset(updated).sha256, hash(laterEdit)); assert.deepEqual(await fs.readFile(file), PNG);
  } finally { await upstream.close(); await cleanup(workspace); }
});

test("legacy remote and base references normalize deterministically without network or input mutation", () => {
  const entry = { path: "sub/note.md", content: "![[assets/旧图.png|200]]\n![Caption](<../assets/旧图.png> \"title\")",
    properties: { assets: [{ path: "assets/旧图.png", fileId: FILE, mime: "image/png", sha256: hash(PNG) }] } };
  const normalized = normalizeVaultAssetReferences([entry]); const canonical = `assets/${hash(PNG)}.png`;
  assert.ok(normalized[0]!.content.includes(`![[${canonical}|200]]`));
  assert.ok(normalized[0]!.content.includes(`(<../${canonical}> "title")`));
  assert.equal(firstAsset(normalized).path, canonical); assert.ok(entry.content.includes("旧图"));
  assert.deepEqual(normalizeVaultAssetReferences(normalized), normalized);
});

test("asset references ignore external URLs and reject traversal or hidden paths", () => {
  const entry = { path: "sub/note.md", content: "![a](../assets/a.png)\n![[assets/中文.png|100]]\n![external](https://external.example/assets/other.png)" };
  assert.deepEqual(referencedVaultAssetPaths(entry), ["assets/a.png", "assets/中文.png"]);
  for (const content of ["![a](../../../assets/private.png)", "![[assets/.secret.png]]", "![a](assets/%2e%2e/private.png)"]) {
    assert.throws(() => referencedVaultAssetPaths({ path: "sub/note.md", content }));
  }
});

test("case and NFC aliases with different images conflict before rewrites or uploads", async () => {
  const upstream = await fixture(state()); const workspace = await localWorkspace();
  try {
    for (const [first, second] of [["assets/Logo.png", "assets/logo.png"], ["assets/caf\u00e9.png", "assets/cafe\u0301.png"]]) {
      const entry = { path: "note.md", content: `![[${first}]]\n![[${second}]]`, properties: { assets: [
        { path: first!, fileId: FILE, mime: "image/png", sha256: hash(PNG) },
        { path: second!, fileId: UPLOADED, mime: "image/png", sha256: hash(pixelPNG(255, 0, 0)) },
      ] } };
      const before = JSON.stringify(entry);
      assert.throws(() => normalizeVaultAssetReferences([entry]), /existing files were preserved/);
      await assert.rejects(prepareVaultAttachments(workspace, [entry], upstream.connection, VAULT), /existing files were preserved/);
      assert.equal(JSON.stringify(entry), before);
    }
    await fs.mkdir(path.join(workspace.dir, "notes", "assets"), { recursive: true });
    const first = path.join(workspace.dir, "notes", "assets", "caf\u00e9.png");
    const second = path.join(workspace.dir, "notes", "assets", "cafe\u0301.png");
    const other = pixelPNG(0, 255, 0); await fs.writeFile(first, PNG); await fs.writeFile(second, other);
    const entry = { path: "note.md", content: "![[assets/caf\u00e9.png]]\n![[assets/cafe\u0301.png]]" };
    await assert.rejects(prepareVaultAttachments(workspace, [entry], upstream.connection, VAULT), /existing files were preserved/);
    assert.deepEqual(await fs.readFile(first), PNG); assert.deepEqual(await fs.readFile(second), other);
    assert.equal(upstream.requests.length, 0);
    await assert.rejects(fs.stat(path.join(workspace.dir, ".roleweave", "vault", "assets.json")), { code: "ENOENT" });
  } finally { await upstream.close(); await cleanup(workspace); }
});

test("asset writes reject symlink directory escapes", async t => {
  const upstream = await fixture(state()); const workspace = await localWorkspace(); const outside = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-asset-outside-test-"));
  try {
    await fs.mkdir(path.join(workspace.dir, "notes"));
    try { await fs.symlink(outside, path.join(workspace.dir, "notes", "assets"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("this OS denies creating a test directory link"); return; } throw error; }
    await assert.rejects(attachMemAsset(workspace, upstream.connection, FILE), /outside the permitted/);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await upstream.close(); await cleanup(workspace); await fs.rm(outside, { recursive: true, force: true }); }
});

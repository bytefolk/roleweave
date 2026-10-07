import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { DRIVE_PREVIEW_MAX_BYTES } from "@roleweave/shared";
import type { DriveObjectPreviewResponse } from "@roleweave/shared";
import { api, startTestServer } from "./helpers.js";
import { configureService } from "../src/services/connections.js";
import { fetchMemImagePreview, validateRaster } from "../src/services/drive-preview.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const TOKEN = "mem-preview-private-fixture-token";
const meta = { id: "preview-image", name: "image.png", size: PNG.length, mime: "image/png", created_at: "2026-10-07T00:00:00Z" };
type State = { metadata: typeof meta; bytes: Buffer; type: string; status: number; declaredLength?: number; redirect?: string };
async function fixture(state: State, onMetadata?: () => void) {
  const requests: Array<{ path: string | undefined; token: string | undefined; workspace: string | string[] | undefined }> = [];
  const upstream = http.createServer((req, res) => {
    requests.push({ path: req.url, token: req.headers.authorization, workspace: req.headers["x-workspace-id"] });
    if (!req.url?.endsWith("/content")) {
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(state.metadata)); onMetadata?.(); return;
    }
    if (state.redirect) { res.writeHead(302, { location: state.redirect }); res.end(); return; }
    res.statusCode = state.status; res.setHeader("Content-Type", state.type);
    if (state.declaredLength !== undefined) res.setHeader("Content-Length", state.declaredLength);
    res.end(state.bytes);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, requests,
    async close() { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); } };
}
const state = (): State => ({ metadata: { ...meta }, bytes: PNG, type: "image/png", status: 200 });

test("preview route requires boot auth and valid object identifiers before upstream access", async () => {
  const upstream = await fixture(state()); const server = await startTestServer();
  try {
    configureService(server.ctx, { kind: "mem", apiUrl: upstream.url, token: TOKEN, workspaceId: WORKSPACE });
    assert.equal((await api(server.baseUrl, "/drive/preview?id=preview-image")).status, 401);
    for (const id of ["", "..", "../other", "a\\b", "a".repeat(129)]) {
      const response = await api(server.baseUrl, `/drive/preview?id=${encodeURIComponent(id)}`, { token: server.token });
      assert.equal(response.status, 400);
    }
    assert.equal(upstream.requests.length, 0);
  } finally { await server.close(); await upstream.close(); }
});

test("preview returns verified private raster bytes with server-only PAT/workspace and reverse proxy prefix", async () => {
  const upstream = await fixture(state()); const server = await startTestServer();
  try {
    configureService(server.ctx, { kind: "mem", apiUrl: upstream.url + "/mem", token: TOKEN, workspaceId: WORKSPACE });
    const response = await api(server.baseUrl, "/drive/preview?id=preview-image", { token: server.token });
    assert.equal(response.status, 200); const body = response.body as DriveObjectPreviewResponse;
    assert.equal(body.schemaVersion, "drive-object-preview.v1");
    assert.deepEqual(body.preview, { objectId: meta.id, mime: "image/png", dataUrl: "data:image/png;base64," + PNG.toString("base64") });
    assert.deepEqual(upstream.requests.map(item => item.path), ["/mem/v1/files/preview-image", "/mem/v1/files/preview-image/content"]);
    for (const request of upstream.requests) { assert.equal(request.token, "Bearer " + TOKEN); assert.equal(request.workspace, WORKSPACE); }
    assert.equal(JSON.stringify(body).includes(TOKEN), false); assert.equal(JSON.stringify(body).includes(upstream.url), false);
    const raw = await fetch(server.baseUrl + "/drive/preview?id=preview-image", { headers: { authorization: "Bearer " + server.token } });
    assert.equal(raw.headers.get("cache-control"), "no-store"); await raw.body?.cancel();
  } finally { await server.close(); await upstream.close(); }
});

test("preview rejects vectors/HTML, changed content MIME, forged bytes and mismatched file identity", async () => {
  const value = state(); const upstream = await fixture(value); const server = await startTestServer();
  try {
    configureService(server.ctx, { kind: "mem", apiUrl: upstream.url, token: TOKEN });
    for (const mime of ["image/svg+xml", "text/html", "application/pdf"]) {
      value.metadata = { ...meta, mime };
      const response = await api(server.baseUrl, "/drive/preview?id=preview-image", { token: server.token });
      assert.equal(response.status, 415); assert.equal((response.body as { code: string }).code, "drive_preview_unsupported");
    }
    assert.equal(upstream.requests.some(item => item.path?.endsWith("/content")), false);
    value.metadata = { ...meta }; value.type = "image/jpeg";
    assert.equal((await api(server.baseUrl, "/drive/preview?id=preview-image", { token: server.token })).status, 502);
    value.type = "image/png"; value.bytes = Buffer.from("<html><script>unsafe image impostor</script></html>"); value.metadata.size = value.bytes.length;
    const forged = await api(server.baseUrl, "/drive/preview?id=preview-image", { token: server.token });
    assert.equal((forged.body as { code: string }).code, "drive_preview_invalid"); assert.equal("preview" in (forged.body as object), false);
    value.metadata = { ...meta, id: "different-object" };
    assert.equal((await api(server.baseUrl, "/drive/preview?id=preview-image", { token: server.token })).status, 502);
  } finally { await server.close(); await upstream.close(); }
});

test("preview enforces metadata, Content-Length and actual streamed byte limits", async () => {
  const value = state(); const upstream = await fixture(value); const server = await startTestServer();
  try {
    configureService(server.ctx, { kind: "mem", apiUrl: upstream.url });
    value.metadata.size = DRIVE_PREVIEW_MAX_BYTES + 1;
    assert.equal((await api(server.baseUrl, "/drive/preview?id=preview-image", { token: server.token })).status, 413);
    assert.equal(upstream.requests.length, 1);
    value.metadata = { ...meta }; value.declaredLength = DRIVE_PREVIEW_MAX_BYTES + 1;
    assert.equal((await api(server.baseUrl, "/drive/preview?id=preview-image", { token: server.token })).status, 413);
    delete value.declaredLength; value.bytes = Buffer.alloc(DRIVE_PREVIEW_MAX_BYTES + 1);
    const streamed = await api(server.baseUrl, "/drive/preview?id=preview-image", { token: server.token });
    assert.equal(streamed.status, 413); assert.equal((streamed.body as { code: string }).code, "drive_preview_too_large");
  } finally { await server.close(); await upstream.close(); }
});

test("content authorization failure and redirects never disclose private errors or forward PAT to another origin", async () => {
  const value = state(); const upstream = await fixture(value); let redirectedRequests = 0;
  const target = http.createServer((_req, res) => { redirectedRequests++; res.end(PNG); });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  const address = target.address(); assert.ok(address && typeof address !== "string");
  const server = await startTestServer();
  try {
    configureService(server.ctx, { kind: "mem", apiUrl: upstream.url, token: TOKEN, workspaceId: WORKSPACE });
    value.status = 403; value.bytes = Buffer.from(TOKEN + " private-host.invalid"); value.type = "text/plain";
    const denied = await api(server.baseUrl, "/drive/preview?id=preview-image", { token: server.token });
    assert.equal(denied.status, 403); assert.equal((denied.body as { code: string }).code, "drive_upstream_failed");
    assert.doesNotMatch(JSON.stringify(denied.body), /mem-preview-private|private-host/);
    value.redirect = `http://127.0.0.1:${address.port}/private`;
    const redirected = await api(server.baseUrl, "/drive/preview?id=preview-image", { token: server.token });
    assert.equal(redirected.status, 502); assert.equal((redirected.body as { code: string }).code, "drive_upstream_unavailable"); assert.equal(redirectedRequests, 0);
  } finally { await server.close(); await upstream.close(); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve())); }
});

test("preview snapshots one connection so a settings change cannot switch workspace between metadata and bytes", async () => {
  const server = await startTestServer(); const other = await fixture(state());
  const first = await fixture(state(), () => configureService(server.ctx, { kind: "mem", apiUrl: other.url, token: "other-workspace-token", workspaceId: "00000000-0000-4000-8000-000000000002" }));
  try {
    configureService(server.ctx, { kind: "mem", apiUrl: first.url, token: TOKEN, workspaceId: WORKSPACE });
    const response = await api(server.baseUrl, "/drive/preview?id=preview-image", { token: server.token });
    assert.equal(response.status, 200); assert.equal(first.requests.length, 2); assert.equal(other.requests.length, 0);
    assert.equal(first.requests[1]!.workspace, WORKSPACE);
  } finally { await server.close(); await first.close(); await other.close(); }
});

test("bdpan preview is explicitly unsupported without invoking another provider", async () => {
  const previous = process.env.ORG_WORKBENCH_DRIVE_PROVIDER; process.env.ORG_WORKBENCH_DRIVE_PROVIDER = "bdpan";
  const server = await startTestServer();
  try {
    const response = await api(server.baseUrl, "/drive/preview?id=preview-image", { token: server.token });
    assert.equal(response.status, 501); assert.equal((response.body as { code: string }).code, "drive_action_unsupported");
  } finally { await server.close(); if (previous === undefined) delete process.env.ORG_WORKBENCH_DRIVE_PROVIDER; else process.env.ORG_WORKBENCH_DRIVE_PROVIDER = previous; }
});

test("magic and canvas checks bound decode dimensions for all supported raster headers", () => {
  validateRaster(PNG, "image/png");
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"); validateRaster(gif, "image/gif");
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 0, 0xff, 0xd9]); validateRaster(jpeg, "image/jpeg");
  const webp = Buffer.alloc(26); webp.write("RIFF"); webp.writeUInt32LE(18, 4); webp.write("WEBPVP8L", 8); webp.writeUInt32LE(5, 16); webp[20] = 0x2f; validateRaster(webp, "image/webp");
  assert.throws(() => validateRaster(PNG, "image/jpeg"), { code: "drive_preview_invalid" });
  const bomb = Buffer.from(PNG); bomb.writeUInt32BE(100_000, 16);
  assert.throws(() => validateRaster(bomb, "image/png"), { code: "drive_preview_too_large" });
});

test("binary timeout is bounded even after valid headers arrive", async () => {
  const upstream = http.createServer((_req, res) => { res.setHeader("Content-Type", "image/png"); res.write(PNG.subarray(0, 10)); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(fetchMemImagePreview({ kind: "mem", apiUrl: `http://127.0.0.1:${address.port}`, webUrl: "http://localhost", token: TOKEN },
      { id: meta.id, name: meta.name, size: meta.size, mime: meta.mime, createdAt: meta.created_at }, 30), { code: "drive_upstream_unavailable" });
  } finally { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

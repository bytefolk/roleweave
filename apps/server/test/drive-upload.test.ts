import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { DRIVE_UPLOAD_MAX_BYTES } from "@roleweave/shared";
import { configureService, disconnectService } from "../src/services/connections.js";
import { api, startTestServer } from "./helpers.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const upstreamToken = "mem-upload-fixture-secret";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const record = (bytes: Buffer, name = "素材.png") => ({ id: "uploaded-file", name, size: bytes.length, mime: "image/png", sha256: sha(bytes), created_at: "2026-10-15T00:00:00.000Z" });

async function fixture() {
  const calls: Array<{ url: string; headers: http.IncomingHttpHeaders; bytes: Buffer }> = [];
  let status = 201; let contentType = "application/json";
  let reply: ((bytes: Buffer) => unknown) | null = null;
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    calls.push({ url: req.url!, headers: req.headers, bytes });
    res.writeHead(status, { "content-type": contentType, ...(status === 307 ? { location: "/redirect-target" } : {}) });
    res.end(JSON.stringify(reply ? reply(bytes) : { file: record(bytes), deduped: status === 200 }));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address() as { port: number };
  const server = await startTestServer();
  configureService(server.ctx, { kind: "mem", apiUrl: `http://127.0.0.1:${address.port}/mem`, token: upstreamToken, workspaceId });
  async function upload(bytes = Buffer.from([0, 255, 1, 128]), suffix = "", extraHeaders: Record<string, string> = {}) {
    const response = await fetch(server.baseUrl + "/drive/upload?name=" + encodeURIComponent("素材.png") + "&mime=image%2Fpng" + suffix, {
      method: "POST", headers: { authorization: "Bearer " + server.token, "content-type": "application/octet-stream", ...extraHeaders }, body: new Uint8Array(bytes),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  return { calls, server, upload, setStatus: (value: number) => { status = value; },
    setReply: (value: (bytes: Buffer) => unknown, type = "application/json") => { reply = value; contentType = type; },
    close: async () => { await server.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); },
  };
}

test("drive uploads binary assets larger than the JSON limit using saved scope, and normalizes new/deduplicated results", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.alloc(1024 * 1024 + 17, 0x80); bytes[0] = 0; bytes[1] = 255;
    const result = await f.upload(bytes);
    assert.equal(result.status, 201);
    assert.deepEqual(result.body, { schemaVersion: "drive-object-upload.v1", object: {
      id: "uploaded-file", name: "素材.png", size: bytes.length, mime: "image/png", createdAt: "2026-10-15T00:00:00.000Z",
    }, deduped: false });
    const call = f.calls[0]!;
    assert.deepEqual(call.bytes, bytes);
    const target = new URL(call.url, "http://fixture");
    assert.equal(target.pathname, "/mem/v1/files");
    assert.equal(target.searchParams.get("name"), "素材.png");
    assert.equal(target.searchParams.get("size"), String(bytes.length));
    assert.equal(target.searchParams.get("path"), "/");
    assert.equal(call.headers.authorization, "Bearer " + upstreamToken);
    assert.equal(call.headers["x-workspace-id"], workspaceId);
    assert.equal(call.headers["content-type"], "image/png");
    assert.doesNotMatch(JSON.stringify(result.body), /secret|filePath|storage_key|sha256/);
    f.setStatus(200);
    f.setReply(bytes => ({ file: record(bytes, "already-stored.png"), deduped: true }));
    const existing = await f.upload();
    assert.equal(existing.status, 200); assert.equal(existing.body.deduped, true);
    assert.equal((existing.body.object as { name: string }).name, "already-stored.png");
  } finally { await f.close(); }
});

test("drive uploads reject malformed metadata, JSON/path placeholders and absent boot authentication before contacting Mem", async () => {
  const f = await fixture();
  try {
    for (const suffix of ["&name=duplicate", "&filePath=C%3A%5Cprivate.png", "&path=%2Fother", "&mime=duplicate"]) {
      assert.equal((await f.upload(Buffer.from("x"), suffix)).status, 400);
    }
    for (const name of ["", ".", "..", "../private.png", "C:\\private.png", "bad\nname", "x".repeat(513)]) {
      const response = await fetch(f.server.baseUrl + "/drive/upload?name=" + encodeURIComponent(name) + "&mime=image%2Fpng", {
        method: "POST", headers: { authorization: "Bearer " + f.server.token, "content-type": "application/octet-stream" }, body: "x",
      });
      assert.equal(response.status, 400); await response.body?.cancel();
    }
    assert.equal((await api(f.server.baseUrl, "/drive/upload", { method: "POST", token: f.server.token, body: { filePath: "/private.png" } })).status, 400);
    assert.equal((await f.upload(Buffer.from("x"), "", { authorization: "Bearer wrong" })).status, 401);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("drive upload size limits are enforced before reading a declared oversized body", async () => {
  const f = await fixture();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(f.server.baseUrl + "/drive/upload?name=asset.png&mime=image%2Fpng", { method: "POST", headers: {
        authorization: "Bearer " + f.server.token, "content-type": "application/octet-stream", "content-length": DRIVE_UPLOAD_MAX_BYTES + 1,
      } }, res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 413); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("drive upload explicitly denies missing Mem and unsupported providers", async () => {
  const f = await fixture(); const previous = process.env.ORG_WORKBENCH_DRIVE_PROVIDER;
  try {
    disconnectService(f.server.ctx, "mem");
    assert.equal((await f.upload()).status, 503);
    process.env.ORG_WORKBENCH_DRIVE_PROVIDER = "bdpan";
    assert.equal((await f.upload()).status, 501);
    assert.equal(f.calls.length, 0);
  } finally {
    if (previous === undefined) delete process.env.ORG_WORKBENCH_DRIVE_PROVIDER; else process.env.ORG_WORKBENCH_DRIVE_PROVIDER = previous;
    await f.close();
  }
});

test("drive upload maps authorization/permission errors and suppresses reflected upstream diagnostics", async () => {
  const f = await fixture();
  try {
    for (const [status, code] of [[401, "drive_auth_expired"], [403, "drive_permission_denied"], [413, "drive_upload_too_large"], [500, "drive_upstream_failed"]] as const) {
      f.setStatus(status); f.setReply(() => ({ error: upstreamToken + " /private/path" }));
      const response = await f.upload();
      assert.equal(response.status, status === 500 ? 502 : status); assert.equal(response.body.code, code);
      assert.doesNotMatch(JSON.stringify(response.body), /fixture-secret|private\/path/);
    }
  } finally { await f.close(); }
});

test("successful HTTP replies require valid metadata and matching bytes; upload redirects are never followed", async () => {
  const f = await fixture();
  try {
    const bad = [() => ({ stub: true }), () => null, (bytes: Buffer) => ({ file: record(bytes), deduped: "false" }),
      (bytes: Buffer) => ({ file: { ...record(bytes), size: 99 }, deduped: false }),
      (bytes: Buffer) => ({ file: { ...record(bytes), sha256: "0".repeat(64) }, deduped: false }),
      () => "x".repeat(70 * 1024)];
    for (const reply of bad) { f.setReply(reply); assert.equal((await f.upload()).status, 502); }
    f.setReply(bytes => ({ file: record(bytes), deduped: false }), "text/html");
    assert.equal((await f.upload()).status, 502);
    const before = f.calls.length; f.setStatus(307);
    assert.equal((await f.upload()).status, 502);
    assert.equal(f.calls.length, before + 1);
  } finally { await f.close(); }
});

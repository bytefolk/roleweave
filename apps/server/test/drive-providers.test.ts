import assert from "node:assert/strict";
import http from "node:http";
import test, { type TestContext } from "node:test";
import { OrgApiError, errorCodes, parseDriveProviderKind } from "@roleweave/shared";
import type { DriveProviderStatus } from "@roleweave/shared";
import {
  BdpanDriveProvider,
  MemDriveProvider,
  mimeFromBdpanName,
  resolveDriveProvider,
} from "../src/services/drive-providers.js";
import type { BdpanRunner } from "../src/services/drive-providers.js";
import { configureService, disconnectService, resolveServiceConnection } from "../src/services/connections.js";
import { startTestServer } from "./helpers.js";

const SNAPSHOT_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");
const SNAPSHOT_WORKSPACE_A = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT_WORKSPACE_B = "00000000-0000-4000-8000-000000000002";

function isolateMemEnvironment(t: TestContext) {
  const keys = ["ORG_WORKBENCH_DRIVE_PROVIDER", "MEM_URL", "ORG_WORKBENCH_MEM_URL", "MEM_TOKEN", "ORG_WORKBENCH_MEM_TOKEN", "MEM_WORKSPACE", "ORG_WORKBENCH_MEM_WORKSPACE_ID"];
  const previous = keys.map(key => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  process.env.ORG_WORKBENCH_DRIVE_PROVIDER = "mem";
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function memSnapshotFixture(t: TestContext, name: string) {
  const record = { id: "snapshot-image", name, size: SNAPSHOT_PNG.length, mime: "image/png", created_at: "2026-10-09T00:00:00.000Z" };
  const object = { id: record.id, name, size: record.size, mime: record.mime, createdAt: record.created_at };
  const requests: Array<{ path: string | undefined; token: string | undefined; workspace: string | string[] | undefined }> = [];
  const upstream = http.createServer((request, response) => {
    requests.push({ path: request.url, token: request.headers.authorization, workspace: request.headers["x-workspace-id"] });
    if (request.url === "/v1/files/snapshot-image/content") {
      response.setHeader("content-type", "image/png");
      response.end(SNAPSHOT_PNG);
    } else {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/files?limit=200&page=1") response.end(JSON.stringify({ files: [record] }));
      else if (request.url === "/v1/files/snapshot-image") response.end(JSON.stringify(record));
      else { response.statusCode = 404; response.end(JSON.stringify({ error: "fixture_path_missing" })); }
    }
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, object, requests };
}

const LS_RECORDS = [
  {
    fs_id: 752001,
    path: "我的应用数据/bdpan/notes.md",
    server_filename: "notes.md",
    size: 128,
    isdir: false,
    md5: "a1b2c3",
    server_mtime: "2026-09-30T10:00:00+08:00",
    server_ctime: "2026-09-01T09:00:00+08:00",
  },
  {
    fs_id: 752002,
    path: "我的应用数据/bdpan/photos",
    server_filename: "photos",
    size: 0,
    isdir: true,
    md5: "",
    server_mtime: "2026-09-30T10:00:00+08:00",
    server_ctime: "2026-09-02T09:00:00+08:00",
  },
  {
    fs_id: 752003,
    path: "我的应用数据/bdpan/blob.bin",
    server_filename: "blob.bin",
    size: 10,
    isdir: false,
    server_mtime: "2026-09-30T10:00:00+08:00",
  },
];

function okRunner(stdoutFor: (args: readonly string[]) => string): BdpanRunner {
  return async (args) => stdoutFor(args);
}

function failingRunner(error: Error): BdpanRunner {
  return async () => {
    throw error;
  };
}

function codeOf(error: unknown): { code: string; status: number; retryable: boolean } {
  assert.ok(error instanceof OrgApiError, `expected OrgApiError, got ${String(error)}`);
  return { code: error.code, status: error.status, retryable: error.retryable };
}

test("parseDriveProviderKind defaults to mem and rejects unknown kinds", () => {
  assert.equal(parseDriveProviderKind(undefined), "mem");
  assert.equal(parseDriveProviderKind(""), "mem");
  assert.equal(parseDriveProviderKind("  "), "mem");
  assert.equal(parseDriveProviderKind("mem"), "mem");
  assert.equal(parseDriveProviderKind("bdpan"), "bdpan");
  assert.equal(parseDriveProviderKind("sftp"), null);
  assert.equal(parseDriveProviderKind(5), null);
});

test("resolveDriveProvider selects by environment and rejects invalid names", () => {
  const ctx = {} as Parameters<typeof resolveDriveProvider>[0];
  const previous = process.env.ORG_WORKBENCH_DRIVE_PROVIDER;
  try {
    delete process.env.ORG_WORKBENCH_DRIVE_PROVIDER;
    assert.equal(resolveDriveProvider(ctx).kind, "mem");
    assert.ok(resolveDriveProvider(ctx) instanceof MemDriveProvider);

    process.env.ORG_WORKBENCH_DRIVE_PROVIDER = "bdpan";
    assert.equal(resolveDriveProvider(ctx).kind, "bdpan");
    assert.ok(resolveDriveProvider(ctx) instanceof BdpanDriveProvider);

    process.env.ORG_WORKBENCH_DRIVE_PROVIDER = "sftp";
    assert.throws(
      () => resolveDriveProvider(ctx),
      (error: unknown) => {
        const typed = codeOf(error);
        assert.equal(typed.code, "drive_provider_invalid");
        assert.equal(typed.status, 400);
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.ORG_WORKBENCH_DRIVE_PROVIDER;
    else process.env.ORG_WORKBENCH_DRIVE_PROVIDER = previous;
  }
});

test("a captured mem provider keeps its origin, token and workspace after live settings and the captured object change", async (t) => {
  isolateMemEnvironment(t);
  const first = await memSnapshotFixture(t, "Snapshot A.png");
  const second = await memSnapshotFixture(t, "Live B.png");
  const server = await startTestServer();
  t.after(() => server.close());
  configureService(server.ctx, { kind: "mem", apiUrl: first.url, token: "snapshot-a-token", workspaceId: SNAPSHOT_WORKSPACE_A });
  const captured = resolveServiceConnection(server.ctx, "mem");
  assert.ok(captured);
  const provider = resolveDriveProvider(server.ctx, { memConnection: captured });

  configureService(server.ctx, { kind: "mem", apiUrl: second.url, token: "live-b-token", workspaceId: SNAPSHOT_WORKSPACE_B });
  captured.apiUrl = second.url;
  captured.webUrl = second.url;
  captured.token = "mutated-captured-token";
  captured.workspaceId = SNAPSHOT_WORKSPACE_B;

  assert.deepEqual(await provider.list("Snapshot A"), [first.object]);
  assert.deepEqual(await provider.detail(first.object.id), first.object);
  assert.ok(provider.preview);
  assert.deepEqual(await provider.preview(first.object.id), {
    objectId: first.object.id, mime: "image/png", dataUrl: `data:image/png;base64,${SNAPSHOT_PNG.toString("base64")}`,
  });
  assert.equal((await provider.probe()).state, "ready");
  assert.deepEqual(first.requests, [
    "/v1/files?limit=200&page=1", "/v1/files/snapshot-image", "/v1/files/snapshot-image", "/v1/files/snapshot-image/content",
  ].map(path => ({ path, token: "Bearer snapshot-a-token", workspace: SNAPSHOT_WORKSPACE_A })));
  assert.equal(second.requests.length, 0, "no read may switch to the live connection's origin");
});

test("an explicit null mem snapshot cannot fall back to configured environment or runtime settings", async (t) => {
  isolateMemEnvironment(t);
  const server = await startTestServer();
  t.after(() => server.close());
  const provider = resolveDriveProvider(server.ctx, { memConnection: null });
  process.env.MEM_URL = "http://127.0.0.1:1";
  process.env.MEM_TOKEN = "env-fallback-token";
  process.env.MEM_WORKSPACE = SNAPSHOT_WORKSPACE_A;
  configureService(server.ctx, { kind: "mem", apiUrl: "http://127.0.0.1:2", token: "runtime-fallback-token", workspaceId: SNAPSHOT_WORKSPACE_B });
  assert.ok(resolveServiceConnection(server.ctx, "mem"), "the live context is configured while the snapshot remains disconnected");
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("null snapshot must not request any origin"); });
  const disconnected = (error: unknown) => {
    const typed = codeOf(error);
    assert.equal(typed.code, "drive_not_configured");
    assert.equal(typed.status, 503);
    return true;
  };
  await assert.rejects(provider.list(""), disconnected);
  await assert.rejects(provider.detail("snapshot-image"), disconnected);
  assert.ok(provider.preview);
  await assert.rejects(provider.preview("snapshot-image"), disconnected);
  assert.deepEqual(await provider.probe(), { schemaVersion: "drive-provider.v1", kind: "mem", state: "not_connected" });
  assert.equal(network.mock.callCount(), 0);
});

test("a mem provider without a snapshot still follows environment and runtime connection updates", async (t) => {
  isolateMemEnvironment(t);
  const first = await memSnapshotFixture(t, "Environment A.png");
  const second = await memSnapshotFixture(t, "Environment B.png");
  const server = await startTestServer();
  t.after(() => server.close());
  const provider = resolveDriveProvider(server.ctx);
  process.env.MEM_URL = first.url;
  process.env.MEM_TOKEN = "environment-a-token";
  process.env.MEM_WORKSPACE = SNAPSHOT_WORKSPACE_A;
  assert.deepEqual(await provider.list(""), [first.object]);

  process.env.MEM_URL = second.url;
  process.env.MEM_TOKEN = "environment-b-token";
  process.env.MEM_WORKSPACE = SNAPSHOT_WORKSPACE_B;
  assert.deepEqual(await provider.list(""), [second.object]);
  configureService(server.ctx, { kind: "mem", apiUrl: first.url, token: "runtime-a-token", workspaceId: SNAPSHOT_WORKSPACE_A });
  assert.deepEqual(await provider.detail(first.object.id), first.object);
  assert.equal((await provider.probe()).state, "ready");
  assert.deepEqual(first.requests, [
    { path: "/v1/files?limit=200&page=1", token: "Bearer environment-a-token", workspace: SNAPSHOT_WORKSPACE_A },
    { path: "/v1/files/snapshot-image", token: "Bearer runtime-a-token", workspace: SNAPSHOT_WORKSPACE_A },
  ]);
  assert.deepEqual(second.requests, [{ path: "/v1/files?limit=200&page=1", token: "Bearer environment-b-token", workspace: SNAPSHOT_WORKSPACE_B }]);
  disconnectService(server.ctx, "mem");
  assert.equal((await provider.probe()).state, "not_connected");
  await assert.rejects(provider.list(""), { code: "drive_not_configured" });
  assert.equal(second.requests.length, 1, "a runtime disconnect must override the still-configured environment");
});

test("bdpan list maps ls records into drive-object.v1 with inferred mime types", async () => {
  const provider = new BdpanDriveProvider(
    { command: "bdpan" },
    okRunner((args) => {
      assert.deepEqual(args, ["ls", "--json"]);
      assert.ok(args.includes("--json"));
      return JSON.stringify(LS_RECORDS);
    }),
  );
  const objects = await provider.list("");
  assert.deepEqual(objects, [
    { id: "752001", name: "notes.md", size: 128, mime: "text/markdown", createdAt: "2026-09-01T09:00:00+08:00" },
    { id: "752002", name: "photos", size: 0, mime: "inode/directory", createdAt: "2026-09-02T09:00:00+08:00" },
    { id: "752003", name: "blob.bin", size: 10, mime: "application/octet-stream", createdAt: "2026-09-30T10:00:00+08:00" },
  ]);
});

test("bdpan list with a query uses server-side search and skips malformed records", async () => {
  const provider = new BdpanDriveProvider(
    { command: "bdpan" },
    okRunner((args) => {
      assert.equal(args[0], "search");
      assert.equal(args[1], "报告");
      assert.ok(args.includes("--page-size"));
      return JSON.stringify({
        total: 3,
        page: 1,
        page_size: 50,
        results: [
          { fs_id: 900001, server_filename: "报告.pdf", size: 4096, isdir: false, server_mtime: "2026-09-30T10:00:00+08:00" },
          { fs_id: "not-a-number", server_filename: "bad", size: 1, isdir: false, server_mtime: "2026-09-30T10:00:00+08:00" },
          { fs_id: 900002, server_filename: "图.png", size: 2048, isdir: false, server_mtime: "invalid-time" },
        ],
      });
    }),
  );
  const objects = await provider.list("报告");
  assert.deepEqual(objects, [
    { id: "900001", name: "报告.pdf", size: 4096, mime: "application/pdf", createdAt: "2026-09-30T10:00:00+08:00" },
  ]);
});

test("bdpan list is bounded to 200 records and rejects option-like queries before spawn", async () => {
  let calls = 0;
  const many = Array.from({ length: 300 }, (_, index) => ({
    fs_id: index,
    server_filename: `file-${index}.txt`,
    size: 1,
    isdir: false,
    server_mtime: "2026-09-30T10:00:00+08:00",
  }));
  const provider = new BdpanDriveProvider({ command: "bdpan" }, async () => {
    calls += 1;
    return JSON.stringify(many);
  });
  const objects = await provider.list("");
  assert.equal(calls, 1);
  assert.equal(objects.length, 200);

  const error = codeOf(await provider.list("-d").catch((caught) => caught));
  assert.equal(error.code, "drive_request_invalid");
  assert.equal(error.status, 400);
  assert.equal(calls, 1);
});

test("bdpan list surfaces an exit-0 failure envelope as auth expiry or upstream failure", async () => {
  const expired = new BdpanDriveProvider(
    { command: "bdpan" },
    okRunner(() => "很抱歉，内部服务错误。\n{\"code\":1,\"error\":\"列表请求失败: baidupan: API error token expired\"}"),
  );
  const expiredError = codeOf(await expired.list("").catch((caught) => caught));
  assert.equal(expiredError.code, "drive_auth_expired");
  assert.equal(expiredError.status, 503);

  const failed = new BdpanDriveProvider(
    { command: "bdpan" },
    okRunner(() => "{\"code\":1,\"error\":\"list: quota exceeded\"}"),
  );
  const failedError = codeOf(await failed.list("").catch((caught) => caught));
  assert.equal(failedError.code, "drive_upstream_failed");
  assert.equal(failedError.status, 502);
});

test("bdpan list fails closed on unparsable output instead of returning an empty list", async () => {
  const provider = new BdpanDriveProvider({ command: "bdpan" }, okRunner(() => "not json at all"));
  const error = codeOf(await provider.list("").catch((caught) => caught));
  assert.equal(error.code, "drive_upstream_failed");
  assert.equal(error.status, 502);
});

test("bdpan detail is explicitly unsupported instead of guessing from names", async () => {
  const provider = new BdpanDriveProvider({ command: "bdpan" }, failingRunner(new Error("must not spawn")));
  const error = codeOf(await provider.detail("752001").catch((caught) => caught));
  assert.equal(error.code, "drive_action_unsupported");
  assert.equal(error.status, 501);
});

test("bdpan probe classifies whoami output into explicit provider states", async () => {
  const ready = await new BdpanDriveProvider({ command: "bdpan" }, okRunner(() => "{\"authenticated\":true,\"user\":\"peter\"}")).probe();
  assert.equal(ready.state, "ready");

  const connectedText = await new BdpanDriveProvider({ command: "bdpan" }, okRunner(() => "认证状态: 已登录\n用户名: peter")).probe();
  assert.equal(connectedText.state, "ready");

  const loggedOut = await new BdpanDriveProvider({ command: "bdpan" }, okRunner(() => "认证状态: 未登录")).probe();
  assert.equal(loggedOut.state, "not_connected");

  const expiring = await new BdpanDriveProvider({ command: "bdpan" }, okRunner(() => "已登录\n⚠ Token 已过期或即将过期")).probe();
  assert.equal(expiring.state, "auth_expired");

  const garbage = await new BdpanDriveProvider({ command: "bdpan" }, okRunner(() => "total nonsense output")).probe();
  assert.equal(garbage.state, "error");
});

test("bdpan probe and list classify a missing CLI as not_installed and upstream unavailable", async () => {
  const provider = new BdpanDriveProvider({ command: "definitely-not-bdpan-anywhere" });
  const status = await provider.probe();
  assert.equal(status.kind, "bdpan");
  assert.equal(status.state, "not_installed");
  assert.equal(status.reason, "bdpan_cli_missing");

  const error = codeOf(await provider.list("").catch((caught) => caught));
  assert.equal(error.code, "drive_upstream_unavailable");
  assert.equal(error.status, 502);
});

test("bdpan spawn enforces timeouts and bounded output", async () => {
  const slow = new BdpanDriveProvider(
    { command: process.execPath, prefixArgs: ["-e", "setTimeout(() => {}, 30000)"] },
    undefined,
    { listMs: 300 },
  );
  const timeoutError = codeOf(await slow.list("").catch((caught) => caught));
  assert.equal(timeoutError.code, "drive_upstream_unavailable");
  assert.equal(timeoutError.status, 502);
  assert.equal(timeoutError.retryable, true);

  const huge = new BdpanDriveProvider(
    { command: process.execPath, prefixArgs: ["-e", "console.log('x'.repeat(3 * 1024 * 1024))"] },
    undefined,
    { listMs: 8000 },
  );
  const oversizeError = codeOf(await huge.list("").catch((caught) => caught));
  assert.equal(oversizeError.code, "drive_upstream_failed");
  assert.equal(oversizeError.status, 502);
});

test("bdpan non-zero exit with an expired-token diagnostic maps to drive_auth_expired", async () => {
  const provider = new BdpanDriveProvider(
    {
      command: process.execPath,
      prefixArgs: ["-e", "console.error('请将错误 ID 反馈给官方客服'); console.log(JSON.stringify({code:1,error:'token expired'})); process.exit(1)"],
    },
    undefined,
    { listMs: 8000 },
  );
  const error = codeOf(await provider.list("").catch((caught) => caught));
  assert.equal(error.code, "drive_auth_expired");
  assert.equal(error.status, 503);
});

test("mime inference covers knowledge-work extensions and falls back safely", () => {
  assert.equal(mimeFromBdpanName("a.md", false), "text/markdown");
  assert.equal(mimeFromBdpanName("b.PDF", false), "application/pdf");
  assert.equal(mimeFromBdpanName("c.mp4", false), "video/mp4");
  assert.equal(mimeFromBdpanName("no-extension", false), "application/octet-stream");
  assert.equal(mimeFromBdpanName("photos", true), "inode/directory");
});

test("the drive provider endpoint reports the selected provider without decorating reads", async () => {
  // The provider status surface is exercised through the route-level contract
  // test in drive.test.ts style: mem without a connection must report
  // not_connected instead of pretending readiness.
  const ctx = {} as Parameters<typeof resolveDriveProvider>[0];
  const previousUrl = process.env.MEM_URL;
  const previousAlias = process.env.ORG_WORKBENCH_MEM_URL;
  delete process.env.MEM_URL;
  delete process.env.ORG_WORKBENCH_MEM_URL;
  try {
    const provider = resolveDriveProvider(ctx);
    const status: DriveProviderStatus = await provider.probe();
    assert.equal(status.kind, "mem");
    assert.equal(status.state, "not_connected");
    assert.equal(status.schemaVersion, "drive-provider.v1");
  } finally {
    if (previousUrl === undefined) delete process.env.MEM_URL;
    else process.env.MEM_URL = previousUrl;
    if (previousAlias === undefined) delete process.env.ORG_WORKBENCH_MEM_URL;
    else process.env.ORG_WORKBENCH_MEM_URL = previousAlias;
  }
});


test("endpoint errno -7 is an upstream failure rather than an invitation to log in again", async () => {
  const providers = [
    new BdpanDriveProvider({command: "bdpan"}, okRunner(() => JSON.stringify({code: 1, error: "API error errno=-7"}))),
    new BdpanDriveProvider({command: process.execPath, prefixArgs: ["-e", "console.log(JSON.stringify({code:1,error:'API error errno=-7'})); process.exit(1)"]}),
  ];
  for (const provider of providers) {
    const error = codeOf(await provider.list("").catch((caught) => caught));
    assert.equal(error.code, "drive_upstream_failed");
    assert.equal(error.status, 502);
  }
  const status = await new BdpanDriveProvider({command: "bdpan"}, okRunner(() => JSON.stringify({code: 1, error: "API error errno=-7"}))).probe();
  assert.equal(status.state, "error");
});

test("the real subprocess receives a search as one literal argument", async () => {
  // Run a disposable node fixture through the production runner, with no shell.
  const query = "report; echo shell $(echo substitution) --help";
  const fixture = "const args=process.argv.slice(1); if(args[0]!=='search'||args[1]!==process.env.DRIVE_TEST_QUERY) process.exit(2); console.log('[]')";
  const previous = process.env.DRIVE_TEST_QUERY;
  try {
    process.env.DRIVE_TEST_QUERY = query;
    const provider = new BdpanDriveProvider({command: process.execPath, prefixArgs: ["-e", fixture]});
    assert.deepEqual(await provider.list(query), []);
  } finally {
    if (previous === undefined) delete process.env.DRIVE_TEST_QUERY;
    else process.env.DRIVE_TEST_QUERY = previous;
  }
});

test("a probe honors its configured timeout", async () => {
  const provider = new BdpanDriveProvider({command: process.execPath, prefixArgs: ["-e", "setTimeout(() => {}, 30000)"]}, undefined, {probeMs: 100});
  const started = Date.now();
  await provider.probe();
  assert.ok(Date.now() - started < 4000);
});

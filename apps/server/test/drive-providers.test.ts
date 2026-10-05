import assert from "node:assert/strict";
import test from "node:test";
import { OrgApiError, errorCodes, parseDriveProviderKind } from "@roleweave/shared";
import type { DriveProviderStatus } from "@roleweave/shared";
import {
  BdpanDriveProvider,
  MemDriveProvider,
  mimeFromBdpanName,
  resolveDriveProvider,
} from "../src/services/drive-providers.js";
import type { BdpanRunner } from "../src/services/drive-providers.js";

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

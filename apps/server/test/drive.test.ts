import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { api, startTestServer } from "./helpers.js";
import { configureService } from "../src/services/connections.js";

function listen(server: http.Server): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("mem fixture did not bind"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

test("drive fails closed when mem is not configured", async () => {
  const previousUrl = process.env.MEM_URL;
  const previousAlias = process.env.ORG_WORKBENCH_MEM_URL;
  delete process.env.MEM_URL;
  delete process.env.ORG_WORKBENCH_MEM_URL;
  const server = await startTestServer();
  try {
    const response = await api(server.baseUrl, "/drive/list", { token: server.token });
    assert.equal(response.status, 503);
    assert.equal((response.body as { code: string }).code, "drive_not_configured");
  } finally {
    await server.close();
    if (previousUrl === undefined) delete process.env.MEM_URL;
    else process.env.MEM_URL = previousUrl;
    if (previousAlias === undefined) delete process.env.ORG_WORKBENCH_MEM_URL;
    else process.env.ORG_WORKBENCH_MEM_URL = previousAlias;
  }
});

test("drive proxies mem files and filters the returned records", async () => {
  const upstream = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/files?limit=200&page=1") {
      response.end(JSON.stringify({
        files: [
          {
            id: "mem-001",
            name: "会议纪要-Q3.md",
            size: 4821,
            mime: "text/markdown",
            created_at: "2026-08-30T09:14:22.000Z",
            summary: "Q3 规划复盘与关键风险。",
          },
          {
            id: "mem-002",
            name: "客户访谈.m4a",
            size: 2318411,
            mime: "audio/mp4",
            created_at: "2026-08-27T15:02:08.000Z",
          },
        ],
      }));
      return;
    }
    if (request.url === "/v1/files/mem-001") {
      response.end(JSON.stringify({
        id: "mem-001",
        name: "会议纪要-Q3.md",
        size: 4821,
        mime: "text/markdown",
        created_at: "2026-08-30T09:14:22.000Z",
        summary: "Q3 规划复盘与关键风险。",
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  const fixture = await listen(upstream);
  const previousUrl = process.env.MEM_URL;
  const previousToken = process.env.MEM_TOKEN;
  process.env.MEM_URL = fixture.url;
  process.env.MEM_TOKEN = "mem-test-token";
  const server = await startTestServer();
  try {
    const filtered = await api(server.baseUrl, "/drive/list?q=客户", { token: server.token });
    assert.equal(filtered.status, 200);
    assert.deepEqual((filtered.body as { objects: Array<{ id: string }>; mocked: boolean }).objects.map((object) => object.id), ["mem-002"]);
    assert.equal((filtered.body as { mocked: boolean }).mocked, false);

    const detail = await api(server.baseUrl, "/drive/detail?id=mem-001", { token: server.token });
    assert.equal(detail.status, 200);
    assert.equal((detail.body as { object: { name: string } }).object.name, "会议纪要-Q3.md");
  } finally {
    await server.close();
    await fixture.close();
    if (previousUrl === undefined) delete process.env.MEM_URL;
    else process.env.MEM_URL = previousUrl;
    if (previousToken === undefined) delete process.env.MEM_TOKEN;
    else process.env.MEM_TOKEN = previousToken;
  }
});

const fileRecord = {
  id: "mem-001",
  name: "Planning.md",
  size: 128,
  mime: "text/markdown",
  created_at: "2026-08-30T09:14:22.000Z",
  summary: null,
  caption: "Approved project plan",
};

test("drive uses the configured mem connection and forwards its workspace and token", async () => {
  const requests: Array<{ url: string | undefined; authorization: string | undefined; workspace: string | string[] | undefined }> = [];
  const upstream = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization, workspace: request.headers["x-workspace-id"] });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url?.startsWith("/v1/files?") ? { files: [fileRecord] } : fileRecord));
  });
  const fixture = await listen(upstream);
  const server = await startTestServer();
  try {
    configureService(server.ctx, {
      kind: "mem",
      apiUrl: fixture.url,
      token: "mem-scoped-test-token",
      workspaceId: "00000000-0000-4000-8000-000000000001",
    });
    const list = await api(server.baseUrl, "/drive/list?q=Approved", { token: server.token });
    assert.equal(list.status, 200);
    assert.deepEqual((list.body as { objects: unknown[] }).objects, [{
      id: fileRecord.id,
      name: fileRecord.name,
      size: fileRecord.size,
      mime: fileRecord.mime,
      createdAt: fileRecord.created_at,
      summary: fileRecord.caption,
    }]);
    const detail = await api(server.baseUrl, "/drive/detail?id=mem-001", { token: server.token });
    assert.equal(detail.status, 200);
    assert.deepEqual(requests.map((request) => request.url), ["/v1/files?limit=200&page=1", "/v1/files/mem-001"]);
    for (const request of requests) {
      assert.equal(request.authorization, "Bearer mem-scoped-test-token");
      assert.equal(request.workspace, "00000000-0000-4000-8000-000000000001");
    }
    assert.doesNotMatch(JSON.stringify(list.body), /mem-scoped-test-token/);
  } finally {
    await server.close();
    await fixture.close();
  }
});

test("drive accepts mem's empty nil slice but rejects malformed or unbounded file lists", async () => {
  let body: unknown = { files: null };
  const fixture = await listen(http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  }));
  const server = await startTestServer();
  try {
    configureService(server.ctx, { kind: "mem", apiUrl: fixture.url });
    for (const empty of [null, []]) {
      body = { files: empty };
      const response = await api(server.baseUrl, "/drive/list", { token: server.token });
      assert.equal(response.status, 200);
      assert.deepEqual((response.body as { objects: unknown[] }).objects, []);
    }
    for (const malformed of [
      null,
      [],
      {},
      { items: [fileRecord] },
      { files: {} },
      { files: [null] },
      { files: [{ ...fileRecord, id: "" }] },
      { files: [{ ...fileRecord, id: ".." }] },
      { files: [{ ...fileRecord, size: -1 }] },
      { files: [{ ...fileRecord, size: 1.5 }] },
      { files: [{ ...fileRecord, created_at: "invalid" }] },
      { files: [{ ...fileRecord, summary: {} }] },
      { files: Array.from({ length: 201 }, () => fileRecord) },
    ]) {
      body = malformed;
      const response = await api(server.baseUrl, "/drive/list", { token: server.token });
      assert.equal(response.status, 502);
      assert.equal((response.body as { code: string }).code, "drive_upstream_failed");
      assert.equal("objects" in (response.body as object), false);
    }
  } finally {
    await server.close();
    await fixture.close();
  }
});

test("drive rejects invalid detail payloads and mismatched object identities", async () => {
  let body: unknown = null;
  const fixture = await listen(http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  }));
  const server = await startTestServer();
  try {
    configureService(server.ctx, { kind: "mem", apiUrl: fixture.url });
    for (const malformed of [null, {}, { ...fileRecord, id: "other-file" }]) {
      body = malformed;
      const response = await api(server.baseUrl, "/drive/detail?id=mem-001", { token: server.token });
      assert.equal(response.status, 502);
      assert.equal((response.body as { code: string }).code, "drive_upstream_failed");
    }
  } finally {
    await server.close();
    await fixture.close();
  }
});

test("drive preserves upstream authorization errors without reflecting its response body", async () => {
  const fixture = await listen(http.createServer((_request, response) => {
    response.statusCode = 403;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "workspace_forbidden", hint: "mem-private-test-token private-host.internal" }));
  }));
  const server = await startTestServer();
  try {
    configureService(server.ctx, { kind: "mem", apiUrl: fixture.url, token: "mem-private-test-token" });
    const response = await api(server.baseUrl, "/drive/list", { token: server.token });
    assert.equal(response.status, 403);
    assert.equal((response.body as { code: string }).code, "drive_upstream_failed");
    assert.doesNotMatch(JSON.stringify(response.body), /mem-private-test-token|private-host/);
  } finally {
    await server.close();
    await fixture.close();
  }
});

test("drive fails closed on redirects without forwarding credentials to the target", async () => {
  let targetRequests = 0;
  const target = await listen(http.createServer((_request, response) => {
    targetRequests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ files: [fileRecord] }));
  }));
  const fixture = await listen(http.createServer((_request, response) => {
    response.writeHead(302, { location: `${target.url}/v1/files` });
    response.end();
  }));
  const server = await startTestServer();
  try {
    configureService(server.ctx, { kind: "mem", apiUrl: fixture.url, token: "mem-private-test-token" });
    const response = await api(server.baseUrl, "/drive/list", { token: server.token });
    assert.equal(response.status, 502);
    assert.equal((response.body as { code: string }).code, "drive_upstream_unavailable");
    assert.equal(targetRequests, 0);
    assert.doesNotMatch(JSON.stringify(response.body), /mem-private-test-token/);
  } finally {
    await server.close();
    await fixture.close();
    await target.close();
  }
});

test("drive validates file identifiers and bounded filtering before contacting mem", async () => {
  let upstreamRequests = 0;
  const fixture = await listen(http.createServer((_request, response) => {
    upstreamRequests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ files: [] }));
  }));
  const server = await startTestServer();
  try {
    configureService(server.ctx, { kind: "mem", apiUrl: fixture.url });
    for (const id of ["", ".", "..", "../capabilities", "a\\b", "a".repeat(129)]) {
      const response = await api(server.baseUrl, `/drive/detail?id=${encodeURIComponent(id)}`, { token: server.token });
      assert.equal(response.status, 400);
      assert.equal((response.body as { code: string }).code, "drive_request_invalid");
    }
    const response = await api(server.baseUrl, `/drive/list?q=${"q".repeat(257)}`, { token: server.token });
    assert.equal(response.status, 400);
    assert.equal(upstreamRequests, 0);
  } finally {
    await server.close();
    await fixture.close();
  }
});

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { api, startTestServer } from "./helpers.js";

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

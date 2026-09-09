import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { DOC_PLANE_DETAIL_SCHEMA_VERSION, DOC_PLANE_LIST_SCHEMA_VERSION, routes } from "@roleweave/shared";
import type { DocPlaneDetailResponse, DocPlaneListResponse } from "@roleweave/shared";
import { api, startTestServer } from "./helpers.js";

test("doc-plane bridge reads the documented bytefolk/doc API and follows cursors", async () => {
  const requests: Array<{ path: string; authorization: string | undefined }> = [];
  const upstream = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ path: `${requestUrl.pathname}${requestUrl.search}`, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json; charset=utf-8");

    if (requestUrl.pathname === "/api/v1/documents" && req.method === "GET") {
      const page = requestUrl.searchParams.get("cursor");
      const data = page === "next-page"
        ? [{ id: "doc-2", title: "Second", icon: null, updatedAt: "2026-09-01T00:00:00.000Z", starred: false }]
        : [{ id: "doc-1", title: "Runbook", icon: "📘", updatedAt: "2026-09-02T00:00:00.000Z", starred: true }];
      res.writeHead(200);
      res.end(JSON.stringify({ data, meta: { nextCursor: page === "next-page" ? null : "next-page" } }));
      return;
    }

    if (requestUrl.pathname === "/api/v1/documents/doc-1" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({
        data: {
          id: "doc-1",
          title: "Runbook",
          icon: "📘",
          updatedAt: "2026-09-02T00:00:00.000Z",
          content: {
            type: "doc",
            content: [
              { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Runbook" }] },
              { type: "paragraph", content: [{ type: "text", text: "First response steps." }] },
            ],
          },
        },
      }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: { code: "document_not_found", message: "Document not found" } }));
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const server = await startTestServer();
  server.ctx.config.docPlaneUrl = `http://127.0.0.1:${address.port}`;
  server.ctx.config.docPlaneToken = "doc_pat_test-read-token";

  try {
    const list = await api(server.baseUrl, `${routes.docPlaneList}?q=run`, { token: server.token });
    assert.equal(list.status, 200);
    const listed = list.body as DocPlaneListResponse;
    assert.equal(listed.schemaVersion, DOC_PLANE_LIST_SCHEMA_VERSION);
    assert.equal(listed.source, "upstream");
    assert.deepEqual(listed.entries.map((entry) => entry.id), ["doc-1", "doc-2"]);

    const detail = await api(server.baseUrl, `${routes.docPlaneDetail}?id=doc-1`, { token: server.token });
    assert.equal(detail.status, 200);
    const document = detail.body as DocPlaneDetailResponse;
    assert.equal(document.schemaVersion, DOC_PLANE_DETAIL_SCHEMA_VERSION);
    assert.match(document.content, /# Runbook/);
    assert.match(document.content, /First response steps/);

    assert.ok(requests.every((request) => request.authorization === "Bearer doc_pat_test-read-token"));
    assert.ok(requests.some((request) => request.path.includes("cursor=next-page")), "must follow nextCursor");
  } finally {
    await server.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
  }
});

test("doc-plane bridge fails closed when a real URL has no PAT", async () => {
  const server = await startTestServer();
  server.ctx.config.docPlaneUrl = "http://127.0.0.1:9";
  try {
    const response = await api(server.baseUrl, routes.docPlaneList, { token: server.token });
    assert.equal(response.status, 503);
    assert.equal((response.body as { code: string }).code, "doc_plane_unconfigured");
  } finally {
    await server.close();
  }
});

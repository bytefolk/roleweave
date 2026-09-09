import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { routes } from "@roleweave/shared";
import { FakeDriver, api, connectSse, copyExampleWorkspace, startTestServer } from "./helpers.js";

/**
 * D0 acceptance 8: the implementation must match docs/api-contract-v0.md
 * endpoint by endpoint — routes exist, auth applies everywhere except /health,
 * and the version header is present on every response.
 */
test("contract v0: every frozen endpoint exists with the contracted auth behavior", async () => {
  const server = await startTestServer(new FakeDriver({ status: "applied" }));
  const dir = await copyExampleWorkspace();
  try {
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    // Seed an undo entry so POST /org/undo answers 200 (it legitimately 404s when nothing is undoable).
    await api(server.baseUrl, "/org/apply", {
      method: "POST",
      token: server.token,
      body: {
        schemaVersion: "change-manifest.v1",
        changes: [
          { op: "reorder", parentId: "repo-owner", order: ["release-engineer", "community-operator", "issue-researcher"] },
        ],
      },
    });

    // /health is the only token-exempt endpoint.
    const health = await api(server.baseUrl, routes.health);
    assert.equal(health.status, 200);
    assert.equal(health.header("x-orgworkbench-api"), "v0");

    const protectedRoutes: Array<{ path: string; method: string }> = [
      { path: routes.workspace, method: "GET" },
      { path: routes.workspaceOpen, method: "POST" },
      { path: routes.orgTree, method: "GET" },
      { path: routes.orgApply, method: "POST" },
      { path: routes.orgBackups, method: "GET" },
      { path: routes.orgRestore, method: "POST" },
      { path: routes.orgUndo, method: "POST" },
      { path: `${routes.positions}/repo-owner`, method: "GET" },
      { path: routes.reports, method: "GET" },
      { path: `${routes.turns}?positionId=repo-owner`, method: "GET" },
      { path: routes.turns, method: "POST" },
      { path: routes.groups, method: "GET" },
      { path: routes.groups, method: "POST" },
    ];
    for (const route of protectedRoutes) {
      const unauthenticated = await api(server.baseUrl, route.path, { method: route.method });
      assert.equal(unauthenticated.status, 401, `unauthenticated ${route.path} must be 401`);
      assert.equal((unauthenticated.body as { code: string }).code, "unauthorized");
      const authenticated = await api(server.baseUrl, route.path, {
        method: route.method,
        token: server.token,
        body: route.method === "POST" ? minimalBody(route.path) : undefined,
      });
      assert.notEqual(authenticated.status, 404, `${route.path} must exist`);
      assert.notEqual(authenticated.status, 405, `${route.path} must accept ${route.method}`);
      assert.equal(authenticated.header("x-orgworkbench-api"), "v0");
    }

    // /events answers as an event stream.
    const sse = connectSse(server.baseUrl, server.token);
    await new Promise((resolve) => setTimeout(resolve, 150));
    sse.close();

    // Unknown routes and wrong methods get stable codes.
    const unknown = await api(server.baseUrl, "/nope", { token: server.token });
    assert.equal(unknown.status, 404);
    assert.equal((unknown.body as { code: string }).code, "not_found");
    const wrongMethod = await api(server.baseUrl, routes.orgTree, { method: "POST", token: server.token });
    assert.equal(wrongMethod.status, 405);
    assert.equal((wrongMethod.body as { code: string }).code, "method_not_allowed");

    // Error body shape is contracted: code + message + retryable.
    const errorBody = unknown.body as Record<string, unknown>;
    assert.ok("code" in errorBody && "message" in errorBody && "retryable" in errorBody);
  } finally {
    await server.close();
  }
});

function minimalBody(path: string): unknown {
  if (path === routes.workspaceOpen) return { path: "." };
  if (path === routes.turns) {
    return { positionId: "repo-owner", input: "hello", engine: "qoder" };
  }
  if (path === routes.groups) {
    return { memberPositionIds: ["repo-owner", "release-engineer"] };
  }
  if (path === routes.orgRestore) return { backupId: "repo-owner-1700000000000-abcdef" };
  return { schemaVersion: "change-manifest.v1", changes: [] };
}

test("contract v0: SSE endpoint advertises text/event-stream with version header", async () => {
  const server = await startTestServer();
  try {
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve) => {
      const req = http.get(
        `${server.baseUrl}${routes.events}`,
        { headers: { authorization: `Bearer ${server.token}` } },
        (res) => {
          resolve(res.headers);
          req.destroy();
        },
      );
      req.on("error", () => {
        // Expected once we destroy the stream connection after reading headers.
      });
    });
    assert.equal(headers["content-type"], "text/event-stream");
    assert.equal(headers["x-orgworkbench-api"], "v0");
  } finally {
    await server.close();
  }
});

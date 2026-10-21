import assert from "node:assert/strict";
import test from "node:test";
import { api, startTestServer } from "./helpers.js";

test("desktop status requires authentication and counts only live reservations across workspaces", async () => {
  const server = await startTestServer();
  try {
    assert.equal((await api(server.baseUrl, "/desktop/status")).status, 401);
    const first = server.ctx.runningTurns.reserve("/workspace/a", "writer", "one");
    const second = server.ctx.runningTurns.reserve("/workspace/b", "writer", "two");
    const mutation = server.ctx.runningTurns.reserveMutation("/workspace/a", "editor");
    const status = () => api(server.baseUrl, "/desktop/status", { token: server.token });
    assert.deepEqual((await status()).body, { runningTurns: 2, pendingApprovals: 0 });
    first.release(); second.release(); mutation();
    assert.deepEqual((await status()).body, { runningTurns: 0, pendingApprovals: 0 });
  } finally { await server.close(); }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import type { TurnRunDriver, TurnRunRequest, TurnRunResult } from "@roleweave/shared";
import { api, connectSse, copyExampleWorkspace, startTestServer } from "./helpers.js";

/** Mirrors DigitalEmployeeCliDriver cancel semantics: the turn hangs until
 * the registered abort hook fires, then settles indeterminate/turn_cancelled. */
class HangingTurnDriver implements TurnRunDriver {
  abortRegistered = false;

  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    return new Promise((resolve) => {
      this.abortRegistered = true;
      request.setAbort?.(() => {
        resolve({
          status: "indeterminate",
          events: [],
          diagnostic: "",
          code: "turn_cancelled",
        });
      });
    });
  }
}

async function openWorkspace(baseUrl: string, token: string, dir: string): Promise<void> {
  const opened = await api(baseUrl, "/workspace/open", {
    method: "POST",
    token,
    body: { path: dir },
  });
  assert.equal(opened.status, 200);
}

test("POST /turns/cancel aborts the in-flight turn as indeterminate/turn_cancelled", async () => {
  const driver = new HangingTurnDriver();
  const server = await startTestServer(undefined, driver);
  const workspace = await copyExampleWorkspace();
  const sse = connectSse(server.baseUrl, server.token);
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const turnPromise = api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", input: "long task", engine: "qoder" },
    });
    // Wait until the driver has registered its abort hook.
    while (!driver.abortRegistered) await new Promise((r) => setTimeout(r, 5));

    const indeterminate = sse.waitForEvent("turn.indeterminate");
    const cancel = await api(server.baseUrl, "/turns/cancel", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner" },
    });
    assert.equal(cancel.status, 200);
    assert.deepEqual(cancel.body, { cancelled: true, positionId: "repo-owner" });

    const record = (await turnPromise).body as Record<string, unknown>;
    assert.equal(record.status, "indeterminate");
    assert.deepEqual(record.error, {
      code: "turn_cancelled",
      message: "the engine process ended without a trusted terminal; no automatic retry was attempted",
      retryable: false,
    });

    const broadcast = JSON.parse((await indeterminate).data) as {
      payload: Record<string, unknown>;
    };
    assert.equal(broadcast.payload.code, "turn_cancelled");
    assert.equal(broadcast.payload.positionId, "repo-owner");

    // Registry is cleaned up: cancelling again finds no running turn.
    const again = await api(server.baseUrl, "/turns/cancel", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner" },
    });
    assert.equal(again.status, 404);
  } finally {
    sse.close();
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("POST /turns/cancel rejects when no turn is running", async () => {
  const server = await startTestServer(undefined, new HangingTurnDriver());
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const response = await api(server.baseUrl, "/turns/cancel", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner" },
    });
    assert.equal(response.status, 404);
    const body = response.body as { code: string };
    assert.equal(body.code, "not_found");
  } finally {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("POST /turns/cancel validates the request shape", async () => {
  const server = await startTestServer(undefined, new HangingTurnDriver());
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const missing = await api(server.baseUrl, "/turns/cancel", {
      method: "POST",
      token: server.token,
      body: {},
    });
    assert.equal(missing.status, 400);
    assert.equal((missing.body as { code: string }).code, "turn_request_invalid");

    const extra = await api(server.baseUrl, "/turns/cancel", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", reason: "changed my mind" },
    });
    assert.equal(extra.status, 400);
    assert.equal((extra.body as { code: string }).code, "turn_request_invalid");

    const malformed = await api(server.baseUrl, "/turns/cancel", {
      method: "POST",
      token: server.token,
      body: { positionId: "../escape" },
    });
    assert.equal(malformed.status, 400);
    assert.equal((malformed.body as { code: string }).code, "turn_position_invalid");
  } finally {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("POST /turns/cancel requires bearer auth and rejects other methods", async () => {
  const server = await startTestServer(undefined, new HangingTurnDriver());
  try {
    const unauthenticated = await api(server.baseUrl, "/turns/cancel", {
      method: "POST",
      body: { positionId: "repo-owner" },
    });
    assert.equal(unauthenticated.status, 401);

    const get = await api(server.baseUrl, "/turns/cancel", {
      method: "GET",
      token: server.token,
    });
    assert.equal(get.status, 405);
  } finally {
    await server.close();
  }
});

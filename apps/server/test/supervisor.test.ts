import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { routes } from "@roleweave/shared";
import { SupervisorStore } from "../src/supervisor/store.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

/**
 * Additive #635: read-only supervisor surface. One-time pairing (boot token
 * only), a snapshot projection readable with either credential, and strict
 * scoping — a supervisor token unlocks exactly GET /supervisor/snapshot and
 * GET /events, never a write path, and never survives a restart.
 */

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

test("supervisor: pair -> snapshot with supervisor token -> list -> revoke -> 401", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });

    // Operator pairs a dashboard; the token is returned exactly once.
    const pair = await api(server.baseUrl, routes.supervisorPair, {
      method: "POST",
      token: server.token,
      body: { label: "orca-supervisor" },
    });
    assert.equal(pair.status, 201);
    const pairing = pair.body as { id: string; token: string; label: string; createdAt: string };
    assert.match(pairing.token, TOKEN_PATTERN);
    assert.equal(pairing.label, "orca-supervisor");

    // Supervisor token reads the snapshot...
    const snapshot = await api(server.baseUrl, routes.supervisorSnapshot, { token: pairing.token });
    assert.equal(snapshot.status, 200);
    const body = snapshot.body as {
      schemaVersion: string;
      workspace: { open: boolean };
      orgTree: { schemaVersion: string } | null;
      positions: Array<{ id: string; budget: { declared: unknown } | null; runningTurn: unknown }>;
    };
    assert.equal(body.schemaVersion, "supervisor-snapshot.v1alpha1");
    assert.equal(body.workspace.open, true);
    assert.equal(body.orgTree?.schemaVersion, "org-tree.v1");
    assert.ok(body.positions.some((position) => position.id === "repo-owner"));
    const owner = body.positions.find((position) => position.id === "repo-owner")!;
    assert.ok(owner.budget?.declared, "budget projection must come from the shared reports semantics");

    // ...and the SSE stream, but nothing else.
    const sseStatus = await new Promise<number>((resolve) => {
      const req = http.get(
        `${server.baseUrl}${routes.events}`,
        { headers: { authorization: `Bearer ${pairing.token}` } },
        (res) => {
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on("error", () => undefined);
    });
    assert.equal(sseStatus, 200);

    const forbiddenTree = await api(server.baseUrl, routes.orgTree, { token: pairing.token });
    assert.equal(forbiddenTree.status, 401);
    const forbiddenWrite = await api(server.baseUrl, routes.orgApply, {
      method: "POST",
      token: pairing.token,
      body: { schemaVersion: "change-manifest.v1", changes: [] },
    });
    assert.equal(forbiddenWrite.status, 401);
    const forbiddenPair = await api(server.baseUrl, routes.supervisorPair, {
      method: "POST",
      token: pairing.token,
      body: { label: "escalation" },
    });
    assert.equal(forbiddenPair.status, 401);

    // Operator lists pairings: metadata only, never the token.
    const list = await api(server.baseUrl, routes.supervisorPairings, { token: server.token });
    assert.equal(list.status, 200);
    const listBody = list.body as { pairings: Array<{ id: string; token?: string; lastUsedAt: string | null }> };
    assert.equal(listBody.pairings.length, 1);
    assert.equal(listBody.pairings[0]!.id, pairing.id);
    assert.ok(!("token" in (listBody.pairings[0] as object)));
    assert.ok(listBody.pairings[0]!.lastUsedAt, "snapshot reads must touch lastUsedAt");

    // Revocation cuts access immediately; replaying revoke is 404.
    const revoke = await api(server.baseUrl, `${routes.supervisorPairings}/${pairing.id}`, {
      method: "DELETE",
      token: server.token,
    });
    assert.equal(revoke.status, 200);
    const replay = await api(server.baseUrl, `${routes.supervisorPairings}/${pairing.id}`, {
      method: "DELETE",
      token: server.token,
    });
    assert.equal(replay.status, 404);
    assert.equal((replay.body as { code: string }).code, "supervisor_pairing_missing");
    const afterRevoke = await api(server.baseUrl, routes.supervisorSnapshot, { token: pairing.token });
    assert.equal(afterRevoke.status, 401);
  } finally {
    await server.close();
  }
});

test("supervisor: request shape is fail-closed and the pairing limit is enforced", async () => {
  const server = await startTestServer();
  try {
    for (const bad of [
      {}, // missing label
      { label: "" }, // empty
      { label: "   " }, // whitespace-only
      { label: "x".repeat(65) }, // > 64 bytes
      { label: "ok", extra: true }, // extra field
    ]) {
      const res = await api(server.baseUrl, routes.supervisorPair, {
        method: "POST",
        token: server.token,
        body: bad,
      });
      assert.equal(res.status, 400, `invalid body ${JSON.stringify(bad)} must be 400`);
      assert.equal((res.body as { code: string }).code, "supervisor_request_invalid");
    }

    // Fill the surface to the limit, then one more must be rejected.
    for (let index = 0; index < 8; index++) {
      const res = await api(server.baseUrl, routes.supervisorPair, {
        method: "POST",
        token: server.token,
        body: { label: `dashboard-${index}` },
      });
      assert.equal(res.status, 201);
    }
    const overflow = await api(server.baseUrl, routes.supervisorPair, {
      method: "POST",
      token: server.token,
      body: { label: "one-too-many" },
    });
    assert.equal(overflow.status, 409);
    assert.equal((overflow.body as { code: string }).code, "supervisor_pairing_limit");

    // Revoking one frees exactly one slot.
    const list = await api(server.baseUrl, routes.supervisorPairings, { token: server.token });
    const first = (list.body as { pairings: Array<{ id: string }> }).pairings[0]!.id;
    await api(server.baseUrl, `${routes.supervisorPairings}/${first}`, { method: "DELETE", token: server.token });
    const retry = await api(server.baseUrl, routes.supervisorPair, {
      method: "POST",
      token: server.token,
      body: { label: "fits-now" },
    });
    assert.equal(retry.status, 201);
  } finally {
    await server.close();
  }
});

test("supervisor: tokens are memory-only — replacing the store invalidates them", async () => {
  const server = await startTestServer();
  try {
    const pair = await api(server.baseUrl, routes.supervisorPair, {
      method: "POST",
      token: server.token,
      body: { label: "restart-stand-in" },
    });
    const pairing = pair.body as { token: string };
    assert.equal(
      (await api(server.baseUrl, routes.supervisorSnapshot, { token: pairing.token })).status,
      200,
    );
    // A control-plane restart builds a fresh store; the old token must die.
    server.ctx.supervisorStore = new SupervisorStore();
    const afterRestart = await api(server.baseUrl, routes.supervisorSnapshot, { token: pairing.token });
    assert.equal(afterRestart.status, 401);
  } finally {
    await server.close();
  }
});

test("supervisor: snapshot without an open workspace reports open:false instead of 422", async () => {
  const server = await startTestServer();
  try {
    const pair = await api(server.baseUrl, routes.supervisorPair, {
      method: "POST",
      token: server.token,
      body: { label: "idle-dashboard" },
    });
    const pairing = pair.body as { token: string };
    const res = await api(server.baseUrl, routes.supervisorSnapshot, { token: pairing.token });
    assert.equal(res.status, 200);
    const body = res.body as { workspace: { open: boolean }; orgTree: unknown; positions: unknown[] };
    assert.equal(body.workspace.open, false);
    assert.equal(body.orgTree, null);
    assert.deepEqual(body.positions, []);
  } finally {
    await server.close();
  }
});

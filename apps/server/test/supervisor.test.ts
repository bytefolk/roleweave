import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { routes } from "@roleweave/shared";
import { SupervisorStore } from "../src/supervisor/store.js";
import { api, connectSse, copyExampleWorkspace, startTestServer } from "./helpers.js";

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
      null, // #639: JSON null must be a 400, never a 500
      [], // #639: array body
      ["label"], // #639: array with a member
      "orca", // #639: scalar body
      42, // #639: numeric body
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

test("supervisor: /events payloads are projected server-side for supervisor tokens (replay + live), operator stream untouched", async () => {
  const server = await startTestServer();
  try {
    const pair = await api(server.baseUrl, routes.supervisorPair, {
      method: "POST",
      token: server.token,
      body: { label: "projection" },
    });
    const pairing = pair.body as { id: string; token: string };

    // Batch A is published before any listener connects: the supervisor
    // Last-Event-ID replay must be projected exactly like live push.
    server.ctx.bus.publish("turn.progress", {
      taskId: "task-1",
      positionId: "repo-owner",
      employeeId: "repo-owner",
      employeeName: "Agent Smith",
      taskTitle: "CONFIDENTIAL TASK TITLE",
      progress: 40,
      currentStep: 2,
      steps: [{ label: "SECRET STEP" }],
      overallStatus: "running",
      startedAt: "2026-10-27T00:00:00.000Z",
      updatedAt: "2026-10-27T00:00:01.000Z",
      workspacePath: "C://ws",
    });
    server.ctx.bus.publish("turn.model.delta", { runId: "run-1", timestamp: "2026-10-27T00:00:02.000Z", text: "RAW MODEL OUTPUT" });
    server.ctx.bus.publish("turn.approval.requested", {
      runId: "run-1",
      timestamp: "2026-10-27T00:00:03.000Z",
      approvalId: "approval-1",
      action: { kind: "exec", description: "SECRET COMMAND preview", target: "C://secrets" },
      reason: "operator asked nicely",
    });

    const supervisor = connectSse(server.baseUrl, pairing.token, "0");
    const progressFrame = await supervisor.waitForEvent("turn.progress");
    const progress = JSON.parse(progressFrame.data) as { payload: Record<string, unknown> };
    assert.equal(progress.payload.taskId, "task-1");
    assert.equal(progress.payload.overallStatus, "running");
    assert.equal(progress.payload.taskTitle, undefined);
    assert.equal(progress.payload.employeeName, undefined);
    assert.equal("steps" in progress.payload, false);
    const approvalFrame = await supervisor.waitForEvent("turn.approval.requested");
    const approval = JSON.parse(approvalFrame.data) as { payload: Record<string, unknown> };
    assert.equal(approval.payload.approvalId, "approval-1");
    assert.equal("action" in approval.payload, false);
    assert.equal("reason" in approval.payload, false);
    const supervisorRaw = supervisor.events.map((frame) => frame.data).join("\n");
    assert.ok(!supervisorRaw.includes("RAW MODEL OUTPUT"), "model output must never reach a supervisor consumer");
    assert.ok(!supervisorRaw.includes("CONFIDENTIAL TASK TITLE"));
    assert.ok(!supervisorRaw.includes("SECRET COMMAND"));
    assert.ok(!supervisorRaw.includes("turn.model.delta"), "the model delta type is not part of the supervisor surface");

    // Live push on the already-established connection is projected too.
    server.ctx.bus.publish("turn.progress", {
      taskId: "task-2",
      positionId: "repo-owner",
      employeeId: "repo-owner",
      employeeName: "Agent Smith",
      taskTitle: "LIVE SECRET TITLE",
      progress: 80,
      currentStep: 3,
      steps: [],
      overallStatus: "running",
      startedAt: "2026-10-27T00:00:04.000Z",
      updatedAt: "2026-10-27T00:00:05.000Z",
      workspacePath: "C://ws",
    });
    const liveDeadline = Date.now() + 5000;
    let liveFrame = supervisor.events.find((frame) => frame.data.includes("task-2"));
    while (liveFrame === undefined && Date.now() < liveDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      liveFrame = supervisor.events.find((frame) => frame.data.includes("task-2"));
    }
    assert.ok(liveFrame, "the live turn.progress event must arrive on the supervisor stream");
    assert.ok(!liveFrame.data.includes("LIVE SECRET TITLE"), "live task titles must be projected out");
    assert.ok(liveFrame.data.includes("overallStatus"), "live metadata fields must survive the projection");

    // The operator stream keeps the frozen v0 semantics: full payloads.
    const operator = connectSse(server.baseUrl, server.token, "0");
    const opProgressFrame = await operator.waitForEvent("turn.progress");
    const opProgress = JSON.parse(opProgressFrame.data) as { payload: { taskTitle?: string; steps?: unknown[] } };
    assert.equal(opProgress.payload.taskTitle, "CONFIDENTIAL TASK TITLE");
    assert.ok(Array.isArray(opProgress.payload.steps));
    operator.close();
    supervisor.close();
  } finally {
    await server.close();
  }
});

test("supervisor: revoking a pairing immediately closes the established SSE connection", async () => {
  const server = await startTestServer();
  try {
    const pair = await api(server.baseUrl, routes.supervisorPair, {
      method: "POST",
      token: server.token,
      body: { label: "live-stream" },
    });
    const pairing = pair.body as { id: string; token: string };

    const streamClosed = new Promise<void>((resolve, reject) => {
      const req = http.get(
        `${server.baseUrl}${routes.events}`,
        { headers: { authorization: `Bearer ${pairing.token}`, accept: "text/event-stream" } },
        (res) => {
          res.resume(); // drain frames; we only care about the close
          res.on("close", resolve);
        },
      );
      req.on("error", () => resolve());
      setTimeout(() => reject(new Error("SSE connection was not closed within 5s of revocation")), 5000);
    });
    // Registration happens synchronously during dispatch, before the headers
    // are flushed; this beat just makes the race explicit and bounded.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const revoke = await api(server.baseUrl, `${routes.supervisorPairings}/${pairing.id}`, {
      method: "DELETE",
      token: server.token,
    });
    assert.equal(revoke.status, 200);
    await streamClosed;
  } finally {
    await server.close();
  }
});

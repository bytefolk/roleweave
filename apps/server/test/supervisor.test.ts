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

/** Rejects when the promise does not settle within timeoutMs; runs cleanup on failure. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, cleanup?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          cleanup?.();
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
    // Last-Event-ID replay must be projected exactly like live push. The
    // turn.progress events come from the real ProgressTracker (review
    // round 2: never hand-write a snapshot shape for these), so the
    // allowlist is exercised against the actual TaskProgressEvent producer.
    server.ctx.progressTracker.begin({
      workspacePath: "C://ws",
      taskId: "task-1",
      positionId: "repo-owner",
      employeeName: "Agent Smith",
      taskTitle: "CONFIDENTIAL TASK TITLE",
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
    // Real metadata survives: step index/status/total/timestamp (the event
    // shape ProgressTracker.publish actually emits).
    assert.equal(progress.payload.stepIndex, 0);
    assert.equal(progress.payload.stepStatus, "running");
    assert.equal(progress.payload.totalSteps, 5);
    assert.equal(typeof progress.payload.timestamp, "number");
    assert.equal(progress.payload.stepName, "Assemble thread context");
    // Body text does not: title, employee name, step message, step objects.
    assert.equal(progress.payload.taskTitle, undefined);
    assert.equal(progress.payload.employeeName, undefined);
    assert.equal("steps" in progress.payload, false);
    assert.equal("message" in progress.payload, false);
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

    // Live push on the already-established connection is projected too, and
    // step transitions stay readable: finish step 0, then fail step 1 with a
    // secret message that must not cross the boundary.
    server.ctx.progressTracker.reportStepFinish("task-1", 0, "SECRET STEP MESSAGE");
    server.ctx.progressTracker.reportStepFail("task-1", 1, "SECRET FAILURE MESSAGE");
    const liveDeadline = Date.now() + 5000;
    const findLive = (needle: string): { data: string } | undefined =>
      supervisor.events.find((frame) => frame.event === "turn.progress" && frame.data.includes(needle));
    let finishFrame = findLive('"stepStatus":"success"');
    let failFrame = findLive('"stepStatus":"failed"');
    while ((finishFrame === undefined || failFrame === undefined) && Date.now() < liveDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      finishFrame = finishFrame ?? findLive('"stepStatus":"success"');
      failFrame = failFrame ?? findLive('"stepStatus":"failed"');
    }
    assert.ok(finishFrame, "the live step-success event must arrive on the supervisor stream");
    assert.ok(failFrame, "the live step-failure event must arrive on the supervisor stream");
    const finished = JSON.parse(finishFrame.data) as { payload: Record<string, unknown> };
    const failed = JSON.parse(failFrame.data) as { payload: Record<string, unknown> };
    assert.equal(finished.payload.stepIndex, 0);
    assert.equal(finished.payload.stepStatus, "success");
    assert.equal(failed.payload.stepIndex, 1);
    assert.equal(failed.payload.stepStatus, "failed");
    assert.ok(!failFrame.data.includes("SECRET FAILURE MESSAGE"), "failure messages must be projected out");
    assert.ok(!finishFrame.data.includes("SECRET STEP MESSAGE"));

    // The operator stream keeps the frozen v0 semantics: full payloads.
    const operator = connectSse(server.baseUrl, server.token, "0");
    const opProgressFrame = await operator.waitForEvent("turn.progress");
    const opProgress = JSON.parse(opProgressFrame.data) as { payload: { taskTitle?: string; employeeName?: string } };
    assert.equal(opProgress.payload.taskTitle, "CONFIDENTIAL TASK TITLE");
    assert.equal(opProgress.payload.employeeName, "Agent Smith");
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
    let req!: http.ClientRequest;
    try {
      let readyResolve!: () => void;
      const ready = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });
      const streamClosed = new Promise<void>((resolve) => {
        req = http.get(
          `${server.baseUrl}${routes.events}`,
          { headers: { authorization: `Bearer ${pairing.token}`, accept: "text/event-stream" } },
          (res) => {
            readyResolve();
            res.resume(); // drain frames; we only care about the close
            res.on("close", resolve);
          },
        );
        req.on("error", () => resolve());
      });
      // Registration happens synchronously during dispatch, before the
      // headers flush — wait for real readiness instead of a fixed sleep,
      // with cleanup on timeout (review round 4).
      await withTimeout(ready, 5000, "SSE headers did not arrive within 5s", () => req.destroy());

      const revoke = await api(server.baseUrl, `${routes.supervisorPairings}/${pairing.id}`, {
        method: "DELETE",
        token: server.token,
      });
      assert.equal(revoke.status, 200);
      await withTimeout(streamClosed, 5000, "SSE connection was not closed within 5s of revocation");
    } finally {
      req.destroy();
    }
  } finally {
    await server.close();
  }
});

test("supervisor: normally closed SSE connections unregister — repeated reconnects never grow the registry", async () => {
  const server = await startTestServer();
  // Review round 4: tracked from before the try block so the outer finally
  // can reach it on every failure path.
  const liveStreams: Array<{ destroy: () => void }> = [];
  try {
    const pair = await api(server.baseUrl, routes.supervisorPair, {
      method: "POST",
      token: server.token,
      body: { label: "reconnect-churn" },
    });
    const pairing = pair.body as { id: string; token: string };
    const store = server.ctx.supervisorStore!;

    // Review round 3: a client-side close/error is NOT a signal that the
    // server has finished its own finish()/unregister — req.destroy() can
    // fire the local handlers first. Every registry assertion therefore
    // waits on a bounded condition instead of a fixed sleep.
    const waitForCount = async (expected: number, timeoutMs = 5000, cleanup?: () => void): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (store.connectionCount(pairing.id) !== expected) {
        if (Date.now() > deadline) {
          cleanup?.();
          throw new Error(
            `connectionCount did not reach ${expected} within ${timeoutMs}ms (currently ${store.connectionCount(pairing.id)})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    // Review round 4 (non-blocking maintenance suggestion from 2026-10-28
    // review): every created stream is tracked and the outer finally destroys
    // them all, so a failed ready/count wait can never leak a socket into
    // server.close().
    const openStream = (): { ready: Promise<void>; closed: Promise<void>; destroy: () => void } => {
      let req!: http.ClientRequest;
      let readyResolve!: () => void;
      // The server registers the connection synchronously during dispatch,
      // before the headers flush — so resolved headers imply registered.
      const ready = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });
      const closed = new Promise<void>((resolve) => {
        req = http.get(
          `${server.baseUrl}${routes.events}`,
          { headers: { authorization: `Bearer ${pairing.token}`, accept: "text/event-stream" } },
          (res) => {
            readyResolve();
            res.resume();
            res.on("close", resolve);
          },
        );
        req.on("error", () => resolve());
      });
      const stream = { ready, closed, destroy: () => req.destroy() };
      liveStreams.push(stream);
      return stream;
    };

    // 12 establish/disconnect cycles: every normal close must unregister its
    // closer, so the registry drains back to zero each time (review round 2).
    for (let cycle = 0; cycle < 12; cycle++) {
      const stream = openStream();
      await withTimeout(stream.ready, 5000, "SSE headers did not arrive within 5s", () => stream.destroy());
      if (cycle === 0) {
        await waitForCount(1, 5000, () => stream.destroy());
      }
      stream.destroy();
      await withTimeout(stream.closed, 5000, `client stream did not close within 5s (cycle ${cycle})`);
      await waitForCount(0, 5000);
    }

    // Multiple concurrent connections + revocation: all closers fire and the
    // registry ends empty, not holding the revoked pairing's sockets.
    const streams = [0, 1, 2].map(() => openStream());
    await withTimeout(Promise.all(streams.map((stream) => stream.ready)), 5000, "concurrent SSE headers did not arrive within 5s", () => {
      for (const stream of streams) stream.destroy();
    });
    await waitForCount(3, 5000, () => {
      for (const stream of streams) stream.destroy();
    });
    const revoke = await api(server.baseUrl, `${routes.supervisorPairings}/${pairing.id}`, {
      method: "DELETE",
      token: server.token,
    });
    assert.equal(revoke.status, 200);
    // Review round 3: wait on the streams' actual close promises (an await
    // of the wrapper objects resolves immediately), bound it, and destroy
    // every stream on failure so a broken assertion cannot leave sockets.
    await withTimeout(
      Promise.all(streams.map((stream) => stream.closed)),
      5000,
      "streams did not close within 5s of revocation",
      () => {
        for (const stream of streams) stream.destroy();
      },
    );
    await waitForCount(0, 5000, () => {
      for (const stream of streams) stream.destroy();
    });
  } finally {
    // Review round 4: no matter how this test ends — assertion failure,
    // wait timeout, anything — every created stream is destroyed before the
    // server shuts down, so no socket outlives the test.
    for (const stream of liveStreams) stream.destroy();
    await server.close();
  }
});

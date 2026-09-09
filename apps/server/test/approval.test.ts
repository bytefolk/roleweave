import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  EngineEvent,
  TurnPendingApproval,
  TurnRunDriver,
  TurnRunRequest,
  TurnRunResult,
} from "@roleweave/shared";
import { validatePendingApproval } from "@roleweave/shared";
import { DigitalEmployeeCliDriver } from "../src/engine/driver-cli.js";
import { createTurnEnvelope } from "../src/turns/envelope.js";
import { api, connectSse, copyExampleWorkspace, startTestServer } from "./helpers.js";

const VERDICT: TurnPendingApproval = {
  approvalId: "appr-1",
  decision: "granted",
  decidedBy: "operator",
  scope: "once",
};

async function openWorkspace(baseUrl: string, token: string, dir: string): Promise<void> {
  const opened = await api(baseUrl, "/workspace/open", {
    method: "POST",
    token,
    body: { path: dir },
  });
  assert.equal(opened.status, 200);
}

class FakeTurnDriver implements TurnRunDriver {
  readonly calls: TurnRunRequest[] = [];

  constructor(private readonly result: TurnRunResult) {}

  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    this.calls.push(request);
    for (const event of this.result.events) request.onEvent?.(event);
    return this.result;
  }
}

const trustedOutcome: TurnRunResult = {
  status: "trusted",
  events: [
    { type: "run.started", runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" },
    { type: "run.completed", runId: "run-1", timestamp: "2026-08-24T00:00:01.000Z", output: "ok", terminalReason: "goal_met" },
  ],
  diagnostic: "",
};

test("turn envelope digest with pendingApproval is byte-compatible with upstream #193", () => {
  const envelope = createTurnEnvelope({
    workspaceRef: "/workspace",
    positionId: "repo-owner",
    turnId: "turn-1",
    message: "resume",
    pendingApproval: VERDICT,
  });
  // Vector cross-validated against digital-employee computeEnvelopeDigest
  // at b3d54bf (envelope.ts carrying the #193 pendingApproval addition).
  assert.equal(
    envelope.envelopeDigest,
    "sha256:bb59fc99a36f0a73d099b4101c44a71ba6d3e146275483e2aa0a00684e178187",
  );
  assert.deepEqual(envelope.pendingApproval, VERDICT);
});

test("turn envelope without pendingApproval keeps the frozen digest byte-for-byte", () => {
  const envelope = createTurnEnvelope({
    workspaceRef: "/workspace",
    positionId: "repo-owner",
    turnId: "turn-1",
    message: "hello",
  });
  assert.equal(
    envelope.envelopeDigest,
    "sha256:86df4dc79d1c535b4401b1641594819fe4388a595df00da786ff4108b34ec8c7",
  );
  assert.equal("pendingApproval" in envelope, false);
});

async function fixtureCli(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-approval-driver-"));
  const file = path.join(dir, "fixture.mjs");
  await fs.writeFile(file, source, { mode: 0o600 });
  return `${process.execPath} ${file}`;
}

const ENVELOPE = createTurnEnvelope({
  workspaceRef: "/workspace",
  positionId: "repo-owner",
  turnId: "turn-1",
  message: "hello",
});

test("CLI driver mirrors the engine.v1 approval events verbatim into a trusted stream", async () => {
  const command = await fixtureCli(`
    process.stdin.resume();
    const base = { runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" };
    console.log(JSON.stringify({ ...base, type: "run.started" }));
    console.log(JSON.stringify({
      ...base,
      type: "approval.requested",
      approvalId: "appr-1",
      action: { kind: "exec", description: "rm -rf build", target: "scripts/clean.sh" },
      reason: "destructive command",
      expiresAt: "2026-08-24T01:00:00.000Z",
    }));
    console.log(JSON.stringify({ ...base, type: "approval.granted", approvalId: "appr-1", grantedBy: "operator", scope: "once" }));
    console.log(JSON.stringify({ ...base, type: "approval.denied", approvalId: "appr-2", deniedBy: "operator", reason: "out of scope" }));
    console.log(JSON.stringify({
      ...base,
      type: "run.failed",
      error: { code: "engine.approval_required", message: "awaiting operator verdict", retryable: true, terminalReason: "engine_internal_error" },
    }));
  `);
  const driver = new DigitalEmployeeCliDriver(command);
  const result = await driver.turnRun({
    workspace: "/workspace",
    positionId: "repo-owner",
    engine: "qoder",
    envelope: ENVELOPE,
  });
  assert.equal(result.status, "trusted");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["run.started", "approval.requested", "approval.granted", "approval.denied", "run.failed"],
  );
  const requested = result.events[1];
  assert.equal(requested?.type, "approval.requested");
  if (requested?.type === "approval.requested") {
    assert.deepEqual(requested.action, {
      kind: "exec",
      description: "rm -rf build",
      target: "scripts/clean.sh",
    });
    assert.equal(requested.reason, "destructive command");
    assert.equal(requested.expiresAt, "2026-08-24T01:00:00.000Z");
  }
});

test("CLI driver fails closed on malformed approval events without faking a terminal", async () => {
  for (const line of [
    // unknown extra field
    JSON.stringify({
      runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z", type: "approval.requested",
      approvalId: "appr-1", action: { kind: "exec", description: "run" }, credential: "leak",
    }),
    // unknown action kind
    JSON.stringify({
      runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z", type: "approval.requested",
      approvalId: "appr-1", action: { kind: "spawn", description: "run" },
    }),
    // approvalId beyond the 256 bound
    JSON.stringify({
      runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z", type: "approval.requested",
      approvalId: "a".repeat(257), action: { kind: "exec", description: "run" },
    }),
    // grantedBy must be the operator constant
    JSON.stringify({
      runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z", type: "approval.granted",
      approvalId: "appr-1", grantedBy: "model", scope: "once",
    }),
    // scope outside once|run
    JSON.stringify({
      runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z", type: "approval.granted",
      approvalId: "appr-1", grantedBy: "operator", scope: "always",
    }),
    // deniedBy must be the operator constant
    JSON.stringify({
      runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z", type: "approval.denied",
      approvalId: "appr-1", deniedBy: "admin",
    }),
  ]) {
    const command = await fixtureCli(`
      process.stdin.resume();
      const base = { runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" };
      console.log(JSON.stringify({ ...base, type: "run.started" }));
      console.log(${JSON.stringify(line)});
    `);
    const driver = new DigitalEmployeeCliDriver(command);
    const result = await driver.turnRun({
      workspace: "/workspace",
      positionId: "repo-owner",
      engine: "qoder",
      envelope: ENVELOPE,
    });
    assert.equal(result.status, "indeterminate", `expected fail closed for ${line}`);
    assert.equal(result.code, "turn_protocol_invalid");
  }
});

test("POST /turns accepts a mirrored pendingApproval and seals it into the envelope digest", async () => {
  const turnDriver = new FakeTurnDriver(trustedOutcome);
  const server = await startTestServer(undefined, turnDriver);
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const response = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: {
        positionId: "repo-owner",
        input: "[verdict] resume",
        engine: "qoder",
        pendingApproval: VERDICT,
      },
    });
    assert.equal(response.status, 200);
    const record = response.body as Record<string, unknown>;
    assert.equal(record.status, "completed");
    assert.equal(turnDriver.calls.length, 1);
    const envelope = turnDriver.calls[0]!.envelope;
    assert.deepEqual(envelope.pendingApproval, VERDICT);
    assert.equal(envelope.envelopeDigest, record.envelopeDigest);
    const expected = createTurnEnvelope({
      workspaceRef: envelope.workspaceRef,
      positionId: "repo-owner",
      turnId: envelope.turnId,
      message: "[verdict] resume",
      pendingApproval: VERDICT,
    });
    assert.equal(envelope.envelopeDigest, expected.envelopeDigest);
  } finally {
    await server.close();
  }
});

test("POST /turns rejects pendingApproval boundary violations fail closed before spawn", async () => {
  const turnDriver = new FakeTurnDriver(trustedOutcome);
  const server = await startTestServer(undefined, turnDriver);
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const oversizedReason = "字".repeat(342); // 342 * 3 bytes > 1024
    assert.ok(Buffer.byteLength(oversizedReason, "utf8") > 1024);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["missing decision", { approvalId: "appr-1", decidedBy: "operator" }],
      ["missing decidedBy", { approvalId: "appr-1", decision: "granted" }],
      ["decidedBy is not the operator constant", { approvalId: "appr-1", decision: "granted", decidedBy: "model" }],
      ["decision outside granted|denied", { approvalId: "appr-1", decision: "maybe", decidedBy: "operator" }],
      ["empty approvalId", { approvalId: "   ", decision: "granted", decidedBy: "operator" }],
      ["approvalId beyond the 256 bound", { approvalId: "a".repeat(257), decision: "granted", decidedBy: "operator" }],
      ["scope outside once|run", { approvalId: "appr-1", decision: "granted", decidedBy: "operator", scope: "always" }],
      ["reason beyond 1024 bytes", { approvalId: "appr-1", decision: "denied", decidedBy: "operator", reason: oversizedReason }],
      ["empty reason", { approvalId: "appr-1", decision: "denied", decidedBy: "operator", reason: "   " }],
      ["expiresAt not ISO 8601", { approvalId: "appr-1", decision: "granted", decidedBy: "operator", expiresAt: "yesterday" }],
      ["extra field rejected", { approvalId: "appr-1", decision: "granted", decidedBy: "operator", note: "side channel" }],
      ["non-object verdict", "granted" as unknown as Record<string, unknown>],
    ];
    for (const [name, pendingApproval] of cases) {
      const response = await api(server.baseUrl, "/turns", {
        method: "POST",
        token: server.token,
        body: { positionId: "repo-owner", input: "resume", engine: "qoder", pendingApproval },
      });
      assert.equal(response.status, 400, name);
      assert.equal((response.body as { code: string }).code, "turn_request_invalid", name);
    }
    const unknownTopLevel = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", input: "resume", engine: "qoder", pendingApproval: VERDICT, verdictSource: "card" },
    });
    assert.equal(unknownTopLevel.status, 400);
    assert.equal(turnDriver.calls.length, 0, "no engine spawn on boundary violations");
  } finally {
    await server.close();
  }
});

test("approval events broadcast as turn.approval.* SSE with the validated engine payload", async () => {
  const turnDriver = new FakeTurnDriver({
    status: "trusted",
    events: [
      { type: "run.started", runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" },
      {
        type: "approval.requested",
        runId: "run-1",
        timestamp: "2026-08-24T00:00:01.000Z",
        approvalId: "appr-1",
        action: { kind: "exec", description: "rm -rf build" },
      },
      {
        type: "run.failed",
        runId: "run-1",
        timestamp: "2026-08-24T00:00:02.000Z",
        error: {
          code: "engine.approval_required",
          message: "awaiting operator verdict",
          retryable: true,
          terminalReason: "engine_internal_error",
        },
      },
    ],
    diagnostic: "",
  });
  const server = await startTestServer(undefined, turnDriver);
  const workspace = await copyExampleWorkspace();
  const sse = connectSse(server.baseUrl, server.token);
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const response = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", input: "run the risky step", engine: "qoder" },
    });
    assert.equal(response.status, 200);
    const record = response.body as Record<string, unknown>;
    assert.equal(record.status, "failed");

    const requested = await sse.waitForEvent("turn.approval.requested");
    const requestedPayload = JSON.parse(requested.data) as { payload: Record<string, unknown> };
    assert.deepEqual(requestedPayload.payload, {
      workspacePath: workspace, turnId: record.turnId, positionId: "repo-owner", engine: "qoder",
      type: "approval.requested",
      runId: "run-1",
      timestamp: "2026-08-24T00:00:01.000Z",
      approvalId: "appr-1",
      action: { kind: "exec", description: "rm -rf build" },
    });
    const storedRequested = (record.events as Record<string, unknown>[]).find((event) => event.type === "approval.requested");
    assert.deepEqual(storedRequested, { type: "approval.requested", runId: "run-1", timestamp: "2026-08-24T00:00:01.000Z", approvalId: "appr-1", action: { kind: "exec", description: "rm -rf build" } });
    const failed = await sse.waitForEvent("turn.failed");
    const failedPayload = JSON.parse(failed.data) as { payload: { error?: { code?: string } } };
    assert.equal(failedPayload.payload.error?.code, "engine.approval_required");
  } finally {
    sse.close();
    await server.close();
  }
});

test("turn records containing approval events persist and read back intact", async () => {
  const approvalEvents: EngineEvent[] = [
    { type: "run.started", runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" },
    {
      type: "approval.requested",
      runId: "run-1",
      timestamp: "2026-08-24T00:00:01.000Z",
      approvalId: "appr-1",
      action: { kind: "exec", description: "rm -rf build", target: "scripts/clean.sh" },
      reason: "destructive command",
      expiresAt: "2026-08-26T23:59:59.000Z",
    },
    {
      type: "approval.granted",
      runId: "run-1",
      timestamp: "2026-08-24T00:00:02.000Z",
      approvalId: "appr-1",
      grantedBy: "operator",
      scope: "once",
    },
    {
      type: "approval.denied",
      runId: "run-1",
      timestamp: "2026-08-24T00:00:03.000Z",
      approvalId: "appr-2",
      deniedBy: "operator",
      reason: "out of position scope",
    },
    {
      type: "run.failed",
      runId: "run-1",
      timestamp: "2026-08-24T00:00:04.000Z",
      error: {
        code: "engine.approval_required",
        message: "awaiting operator verdict",
        retryable: true,
        terminalReason: "engine_internal_error",
      },
    },
  ];
  const turnDriver = new FakeTurnDriver({
    status: "trusted",
    events: approvalEvents,
    diagnostic: "",
  });
  const server = await startTestServer(undefined, turnDriver);
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const created = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", input: "run the risky step", engine: "qoder" },
    });
    assert.equal(created.status, 200);

    const history = await api(server.baseUrl, "/turns?positionId=repo-owner", {
      method: "GET",
      token: server.token,
    });
    assert.equal(history.status, 200, "read-after-write must not fail closed on approval events");
    const body = history.body as { turns: Array<{ events: EngineEvent[] }> };
    assert.equal(body.turns.length, 1);
    assert.deepEqual(body.turns[0]!.events, approvalEvents);
  } finally {
    await server.close();
  }
});

test("session turn accepts the same mirrored pendingApproval and rejects violations", async () => {
  const turnDriver = new FakeTurnDriver(trustedOutcome);
  const server = await startTestServer(undefined, turnDriver);
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const created = await api(server.baseUrl, "/sessions", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner" },
    });
    assert.equal(created.status, 201);
    const sessionId = (created.body as { sessionId: string }).sessionId;

    const accepted = await api(server.baseUrl, `/sessions/${sessionId}/turns`, {
      method: "POST",
      token: server.token,
      body: { input: "[verdict] resume", engine: "qoder", pendingApproval: VERDICT },
    });
    assert.equal(accepted.status, 200);
    assert.equal(turnDriver.calls.length, 1);
    assert.deepEqual(turnDriver.calls[0]!.envelope.pendingApproval, VERDICT);

    const rejected = await api(server.baseUrl, `/sessions/${sessionId}/turns`, {
      method: "POST",
      token: server.token,
      body: {
        input: "[verdict] resume",
        engine: "qoder",
        pendingApproval: { approvalId: "appr-1", decision: "granted", decidedBy: "model" },
      },
    });
    assert.equal(rejected.status, 400);
    assert.equal(turnDriver.calls.length, 1, "no engine spawn on session verdict violation");
  } finally {
    await server.close();
  }
});

test("shared pendingApproval validator is the single source for both boundaries (#46)", () => {
  // The ESM surface must delegate to the same CJS contract the IPC boundary
  // requires, so upstream bound changes touch exactly one module.
  const accepted = validatePendingApproval(VERDICT);
  assert.deepEqual(accepted, { ok: true, value: VERDICT });

  const cjsSurface = createRequire(import.meta.url)("@roleweave/shared/pending-approval");
  assert.equal(validatePendingApproval, cjsSurface.validatePendingApproval, "ESM wrapper must re-export the CJS contract function identity");

  const deniedWithReason = validatePendingApproval({
    approvalId: "appr-2",
    decision: "denied",
    decidedBy: "operator",
    reason: "超出岗位授权",
  });
  assert.equal(deniedWithReason.ok, true);

  for (const bad of [
    null,
    "granted",
    { approvalId: "", decision: "granted", decidedBy: "operator" },
    { approvalId: "a".repeat(257), decision: "granted", decidedBy: "operator" },
    { approvalId: "appr-1", decision: "maybe", decidedBy: "operator" },
    { approvalId: "appr-1", decision: "granted", decidedBy: "model" },
    { approvalId: "appr-1", decision: "granted" },
    { ...VERDICT, scope: "always" },
    { ...VERDICT, reason: "   " },
    { ...VERDICT, reason: "字".repeat(342) },
    { ...VERDICT, expiresAt: "yesterday" },
    { ...VERDICT, note: "side channel" },
  ]) {
    const result = validatePendingApproval(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    if (!result.ok) assert.ok(result.message.length > 0);
  }
});

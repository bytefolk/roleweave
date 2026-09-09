import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  TurnRecord,
  TurnRunDriver,
  TurnRunRequest,
  TurnRunResult,
  WorkbenchSession,
} from "@roleweave/shared";
import {
  ContextExportService,
  readContextExportState,
  type ContextAdapterClient,
  type ContextOccurrence,
} from "../src/context-export/exporter.js";
import { ContextCliAdapterClient } from "../src/context-export/adapter-cli.js";
import { api, assertPosixMode, copyExampleWorkspace, startTestServer } from "./helpers.js";

function session(): WorkbenchSession {
  return {
    schemaVersion: "workbench-session.v1",
    sessionId: "28d2702d-6fc6-4eb0-bd4e-99d93c2e4534",
    workspaceInstanceId: "466fdb7a-041c-49e6-8711-6f7ffb9c2507",
    positionId: "repo-owner",
    principal: "position.repo-owner",
    status: "active",
    rotatedFrom: null,
    rotatedTo: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    rotatedAt: null,
  };
}

function completedTurn(): TurnRecord {
  return {
    schemaVersion: "turn-record.v1",
    conversationId: "28d2702d-6fc6-4eb0-bd4e-99d93c2e4534",
    turnId: "turn-001",
    positionId: "repo-owner",
    engine: "qoder",
    status: "completed",
    input: "Summarize the release decision.",
    envelopeDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-08-24T00:00:01.000Z",
    updatedAt: "2026-08-24T00:00:02.000Z",
    events: [
      { type: "run.started", runId: "run-001", timestamp: "2026-08-24T00:00:01.000Z" },
      {
        type: "run.completed",
        runId: "run-001",
        timestamp: "2026-08-24T00:00:02.000Z",
        output: "The release remains gated on CI.",
        terminalReason: "goal_met",
      },
    ],
    runId: "run-001",
    output: "The release remains gated on CI.",
  };
}

class RecordingAdapter implements ContextAdapterClient {
  readonly calls: Array<{ command: "ingest" | "distill"; value: string }> = [];
  readonly occurrences = new Map<string, ContextOccurrence>();
  readonly distilled = new Set<string>();
  failWith: string | null = null;
  failRole: "user" | "assistant" | null = null;

  async ingest(occurrence: ContextOccurrence): Promise<{
    inserted: boolean;
    occurrenceId: string;
    status: "pending" | "done";
  }> {
    this.calls.push({ command: "ingest", value: occurrence.occurrenceId });
    if (this.failWith !== null || this.failRole === occurrence.source.role) {
      throw new Error(this.failWith ?? "role export failed");
    }
    const existing = this.occurrences.get(occurrence.occurrenceId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(occurrence)) {
      throw new Error("conflicting occurrence");
    }
    this.occurrences.set(occurrence.occurrenceId, occurrence);
    return {
      inserted: existing === undefined,
      occurrenceId: occurrence.occurrenceId,
      status: this.distilled.has(occurrence.occurrenceId) ? "done" : "pending",
    };
  }

  async distill(occurrenceId: string): Promise<{ occurrenceId: string; status: "done"; artifacts: number }> {
    this.calls.push({ command: "distill", value: occurrenceId });
    if (this.failWith !== null) throw new Error(this.failWith);
    this.distilled.add(occurrenceId);
    return { occurrenceId, status: "done", artifacts: 1 };
  }
}

test("completed durable session turn exports exactly two idempotent scoped occurrences", async () => {
  const workspace = await copyExampleWorkspace();
  const adapter = new RecordingAdapter();
  const exporter = new ContextExportService(adapter);
  const sourceSession = session();
  const turn = completedTurn();

  await exporter.enqueueCompletedTurn(workspace, sourceSession, turn);
  await exporter.waitForIdle();
  await exporter.enqueueCompletedTurn(workspace, sourceSession, turn);
  await exporter.waitForIdle();

  assert.equal(adapter.occurrences.size, 2);
  assert.deepEqual(
    [...adapter.occurrences.values()].map((item) => item.source.role).sort(),
    ["assistant", "user"],
  );
  for (const occurrence of adapter.occurrences.values()) {
    assert.deepEqual(occurrence.scope, {
      workspaceId: sourceSession.workspaceInstanceId,
      positionId: sourceSession.positionId,
      principal: sourceSession.principal,
    });
    assert.equal(occurrence.source.conversationId, sourceSession.sessionId);
    assert.equal(occurrence.source.turnId, turn.turnId);
  }
  assert.equal(adapter.calls.length, 4, "done replay must not call the adapter again");

  const state = await readContextExportState(workspace, sourceSession.sessionId, turn.turnId);
  assert.equal(state.status, "done");
  assert.equal(state.occurrences.length, 2);
  assert.match(state.exportDigest, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(state), /Summarize|release remains|Authorization|Bearer|token/i);
  const stateFile = path.join(
    workspace,
    ".digital-employee",
    "workbench",
    "context-exports",
    sourceSession.sessionId,
    `${turn.turnId}.json`,
  );
  await assertPosixMode(stateFile, 0o600);
  await assertPosixMode(path.dirname(stateFile), 0o700);
});

test("restart retries only a failed export and never requires another Host turn", async () => {
  const workspace = await copyExampleWorkspace();
  const sourceSession = session();
  const turn = completedTurn();
  const unavailable = new RecordingAdapter();
  unavailable.failWith = "secret adapter outage detail";
  const beforeRestart = new ContextExportService(unavailable);

  await beforeRestart.enqueueCompletedTurn(workspace, sourceSession, turn);
  await beforeRestart.waitForIdle();
  const failed = await readContextExportState(workspace, sourceSession.sessionId, turn.turnId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 1);
  assert.doesNotMatch(JSON.stringify(failed), /secret adapter outage detail/);

  const recoveredAdapter = new RecordingAdapter();
  const afterRestart = new ContextExportService(recoveredAdapter);
  await afterRestart.enqueueCompletedTurn(workspace, sourceSession, turn);
  await afterRestart.waitForIdle();
  const done = await readContextExportState(workspace, sourceSession.sessionId, turn.turnId);
  assert.equal(done.status, "done");
  assert.equal(done.attempts, 2);
  assert.equal(recoveredAdapter.occurrences.size, 2);
});

test("restart safely replays a partially exported role without duplicating the done occurrence", async () => {
  const workspace = await copyExampleWorkspace();
  const adapter = new RecordingAdapter();
  adapter.failRole = "assistant";
  const sourceSession = session();
  const turn = completedTurn();
  const beforeRestart = new ContextExportService(adapter);
  await beforeRestart.enqueueCompletedTurn(workspace, sourceSession, turn);
  await beforeRestart.waitForIdle();
  assert.equal(adapter.occurrences.size, 1);
  assert.equal(adapter.distilled.size, 1);

  adapter.failRole = null;
  const afterRestart = new ContextExportService(adapter);
  await afterRestart.enqueueCompletedTurn(workspace, sourceSession, turn);
  await afterRestart.waitForIdle();
  assert.equal(adapter.occurrences.size, 2);
  assert.equal(adapter.distilled.size, 2);
  assert.equal((await readContextExportState(workspace, sourceSession.sessionId, turn.turnId)).status, "done");
});

test("failed, indeterminate, malformed, and mismatched turns never reach the adapter", async () => {
  const workspace = await copyExampleWorkspace();
  const adapter = new RecordingAdapter();
  const exporter = new ContextExportService(adapter);
  const sourceSession = session();
  const completed = completedTurn();

  for (const turn of [
    { ...completed, status: "failed", output: undefined },
    { ...completed, status: "indeterminate", output: undefined },
    { ...completed, positionId: "maintainer" },
    { ...completed, accessToken: "must-not-survive" },
  ]) {
    await assert.rejects(
      () => exporter.enqueueCompletedTurn(workspace, sourceSession, turn as TurnRecord),
      /eligible|invalid|mismatch/,
    );
  }
  await exporter.waitForIdle();
  assert.equal(adapter.calls.length, 0);
});

test("CLI adapter passes only runtime Context authority through environment", async () => {
  const fixture = fileURLToPath(new URL("../../test/fixtures/context-adapter-fixture.mjs", import.meta.url));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CONTEXT_VAULT: "fixture-vault",
    CONTEXT_RUNTIME_TOKEN: "fixture-runtime-secret",
    CONTEXT_OPERATOR_TOKEN: "must-not-pass",
    CONTEXT_OPERATOR_TOKEN_SHA256: `sha256:${"b".repeat(64)}`,
    ORG_WORKBENCH_BOOT_TOKEN: "must-not-pass",
    QODER_PERSONAL_ACCESS_TOKEN: "must-not-pass",
    ANTHROPIC_API_KEY: "must-not-pass",
  };
  const client = new ContextCliAdapterClient(`node ${fixture}`, environment);
  const sourceSession = session();
  const turn = completedTurn();
  const adapter = new RecordingAdapter();
  const probeExporter = new ContextExportService(adapter);
  const workspace = await copyExampleWorkspace();
  await probeExporter.enqueueCompletedTurn(workspace, sourceSession, turn);
  await probeExporter.waitForIdle();
  const occurrence = [...adapter.occurrences.values()][0]!;
  const ingest = await client.ingest(occurrence);
  assert.equal(ingest.occurrenceId, occurrence.occurrenceId);
  assert.equal((await client.distill(occurrence.occurrenceId)).status, "done");
});

test("symlinked or corrupted export state fails closed before adapter access", async () => {
  const sourceSession = session();
  const turn = completedTurn();
  {
    const workspace = await copyExampleWorkspace();
    const outside = await fs.mkdtemp(path.join(path.dirname(workspace), "owb-export-outside-"));
    const workbench = path.join(workspace, ".digital-employee", "workbench");
    await fs.mkdir(workbench, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(outside, sourceSession.sessionId), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(outside, sourceSession.sessionId, `${turn.turnId}.json`),
      '{"credential":"outside-must-not-be-read"}\n',
      { mode: 0o600 },
    );
    await fs.symlink(outside, path.join(workbench, "context-exports"));
    const adapter = new RecordingAdapter();
    await assert.rejects(
      () => new ContextExportService(adapter).enqueueCompletedTurn(workspace, sourceSession, turn),
      /unsafe/,
    );
    assert.equal(adapter.calls.length, 0);
  }
  {
    const workspace = await copyExampleWorkspace();
    const adapter = new RecordingAdapter();
    adapter.failWith = "unavailable";
    const exporter = new ContextExportService(adapter);
    await exporter.enqueueCompletedTurn(workspace, sourceSession, turn);
    await exporter.waitForIdle();
    const file = path.join(
      workspace,
      ".digital-employee",
      "workbench",
      "context-exports",
      sourceSession.sessionId,
      `${turn.turnId}.json`,
    );
    await fs.writeFile(file, '{"credential":"must-not-echo"}\n', { mode: 0o600 });
    const retry = new RecordingAdapter();
    await assert.rejects(
      () => new ContextExportService(retry).enqueueCompletedTurn(workspace, sourceSession, turn),
      (error: Error) => !error.message.includes("must-not-echo") && /invalid/.test(error.message),
    );
    assert.equal(retry.calls.length, 0);
  }
});

test("control plane exports only after a completed session turn is durable", async () => {
  const workspace = await copyExampleWorkspace();
  const adapter = new RecordingAdapter();
  const exporter = new ContextExportService(adapter);
  const host = new CountingHostDriver("completed");
  const server = await startTestServer(undefined, host, exporter);
  try {
    const opened = await api(server.baseUrl, "/workspace/open", {
      method: "POST", token: server.token, body: { path: workspace },
    });
    assert.equal(opened.status, 200);
    const created = await api(server.baseUrl, "/sessions", {
      method: "POST", token: server.token, body: { positionId: "repo-owner" },
    });
    const sourceSession = created.body as WorkbenchSession;
    const response = await api(server.baseUrl, `/sessions/${sourceSession.sessionId}/turns`, {
      method: "POST", token: server.token, body: { input: "durable first", engine: "qoder" },
    });
    assert.equal(response.status, 200);
    assert.equal((response.body as TurnRecord).status, "completed");
    await exporter.waitForIdle();
    assert.equal(host.calls, 1);
    assert.equal(adapter.occurrences.size, 2);
    const state = await readContextExportState(
      workspace,
      sourceSession.sessionId,
      (response.body as TurnRecord).turnId,
    );
    assert.equal(state.status, "done");
  } finally {
    await server.close();
  }
});

test("workspace-open restart resumes failed export without invoking the Host", async () => {
  const workspace = await copyExampleWorkspace();
  const unavailable = new RecordingAdapter();
  unavailable.failWith = "adapter unavailable";
  const firstExporter = new ContextExportService(unavailable);
  const firstHost = new CountingHostDriver("completed");
  const before = await startTestServer(undefined, firstHost, firstExporter);
  let sourceSession!: WorkbenchSession;
  let turn!: TurnRecord;
  try {
    await api(before.baseUrl, "/workspace/open", {
      method: "POST", token: before.token, body: { path: workspace },
    });
    sourceSession = (await api(before.baseUrl, "/sessions", {
      method: "POST", token: before.token, body: { positionId: "repo-owner" },
    })).body as WorkbenchSession;
    turn = (await api(before.baseUrl, `/sessions/${sourceSession.sessionId}/turns`, {
      method: "POST", token: before.token, body: { input: "resume export", engine: "qoder" },
    })).body as TurnRecord;
    await firstExporter.waitForIdle();
    assert.equal((await readContextExportState(workspace, sourceSession.sessionId, turn.turnId)).status, "failed");
    assert.equal(firstHost.calls, 1);
  } finally {
    await before.close();
  }

  const recoveredAdapter = new RecordingAdapter();
  const recoveredExporter = new ContextExportService(recoveredAdapter);
  const forbiddenHost = new CountingHostDriver("indeterminate");
  const after = await startTestServer(undefined, forbiddenHost, recoveredExporter);
  try {
    const opened = await api(after.baseUrl, "/workspace/open", {
      method: "POST", token: after.token, body: { path: workspace },
    });
    assert.equal(opened.status, 200);
    await recoveredExporter.waitForIdle();
    const recovered = await readContextExportState(workspace, sourceSession.sessionId, turn.turnId);
    assert.equal(recovered.status, "done");
    assert.equal(recovered.attempts, 2);
    assert.equal(recoveredAdapter.occurrences.size, 2);
    assert.equal(forbiddenHost.calls, 0);
  } finally {
    await after.close();
  }
});

test("failed and indeterminate Host terminals create no export state", async () => {
  for (const outcome of ["failed", "indeterminate"] as const) {
    const workspace = await copyExampleWorkspace();
    const adapter = new RecordingAdapter();
    const exporter = new ContextExportService(adapter);
    const server = await startTestServer(undefined, new CountingHostDriver(outcome), exporter);
    try {
      await api(server.baseUrl, "/workspace/open", {
        method: "POST", token: server.token, body: { path: workspace },
      });
      const sourceSession = (await api(server.baseUrl, "/sessions", {
        method: "POST", token: server.token, body: { positionId: "repo-owner" },
      })).body as WorkbenchSession;
      const turn = (await api(server.baseUrl, `/sessions/${sourceSession.sessionId}/turns`, {
        method: "POST", token: server.token, body: { input: "do not export", engine: "qoder" },
      })).body as TurnRecord;
      assert.equal(turn.status, outcome);
      await exporter.waitForIdle();
      assert.equal(adapter.calls.length, 0);
      await assert.rejects(
        () => readContextExportState(workspace, sourceSession.sessionId, turn.turnId),
        /missing/,
      );
    } finally {
      await server.close();
    }
  }
});

class CountingHostDriver implements TurnRunDriver {
  calls = 0;

  constructor(private readonly outcome: "completed" | "failed" | "indeterminate") {}

  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    this.calls += 1;
    if (this.outcome === "indeterminate") {
      return { status: "indeterminate", events: [], diagnostic: "", code: "fixture_indeterminate" };
    }
    const timestamp = new Date().toISOString();
    const started = { type: "run.started" as const, runId: "fixture-host", timestamp };
    if (this.outcome === "completed") {
      const terminal = {
        type: "run.completed" as const,
        runId: "fixture-host",
        timestamp,
        output: "fixture assistant output",
        terminalReason: "goal_met" as const,
      };
      request.onEvent?.(started);
      request.onEvent?.(terminal);
      return { status: "trusted", events: [started, terminal], diagnostic: "" };
    }
    const terminal = {
      type: "run.failed" as const,
      runId: "fixture-host",
      timestamp,
      error: {
        code: "fixture_failure",
        message: "fixture failure",
        retryable: false,
        terminalReason: "engine_internal_error" as const,
      },
    };
    request.onEvent?.(started);
    request.onEvent?.(terminal);
    return { status: "trusted", events: [started, terminal], diagnostic: "" };
  }
}

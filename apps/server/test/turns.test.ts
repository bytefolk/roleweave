import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type {
  TurnEngine,
  TurnRunDriver,
  TurnRunRequest,
  TurnRunResult,
} from "@roleweave/shared";
import { POSITION_ID_PATTERN } from "@roleweave/shared";
import { api, assertPosixMode, connectSse, copyExampleWorkspace, startTestServer } from "./helpers.js";
import {
  TurnStore,
  assertPositionId,
  isTurnRecord,
  nodeAtomicTurnWriteOperations,
} from "../src/turns/store.js";
import type { AtomicTurnWriteOperations } from "../src/turns/store.js";
import { createTurnEnvelope } from "../src/turns/envelope.js";

test("turn envelope digest is byte-compatible with digital-employee 0c4cd54", () => {
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
});

class FakeTurnDriver implements TurnRunDriver {
  readonly calls: TurnRunRequest[] = [];

  constructor(
    private readonly result: TurnRunResult = {
      status: "trusted",
      events: [
        {
          type: "run.started",
          runId: "run-1",
          timestamp: "2026-08-24T00:00:00.000Z",
        },
        {
          type: "model.delta",
          runId: "run-1",
          timestamp: "2026-08-24T00:00:01.000Z",
          text: "hello",
        },
        {
          type: "run.completed",
          runId: "run-1",
          timestamp: "2026-08-24T00:00:02.000Z",
          output: "hello",
          terminalReason: "goal_met",
        },
      ],
      diagnostic: "",
    },
  ) {}

  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    this.calls.push(request);
    for (const event of this.result.events) request.onEvent?.(event);
    return this.result;
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

test("POST /turns seals one Qoder turn, persists it with 0600 mode, and publishes attributed turn SSE without changing engine events", async () => {
  const turnDriver = new FakeTurnDriver();
  const server = await startTestServer(undefined, turnDriver);
  const workspace = await copyExampleWorkspace();
  const sse = connectSse(server.baseUrl, server.token);
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const response = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", input: "What should we do?", engine: "qoder" },
    });

    assert.equal(response.status, 200);
    const record = response.body as Record<string, unknown>;
    assert.equal(record.schemaVersion, "turn-record.v1");
    assert.equal(record.positionId, "repo-owner");
    assert.equal(record.engine, "qoder");
    assert.equal(record.status, "completed");
    assert.match(String(record.envelopeDigest), /^sha256:[a-f0-9]{64}$/);
    assert.equal(turnDriver.calls.length, 1);
    assert.equal(turnDriver.calls[0]!.engine, "qoder");
    assert.equal(turnDriver.calls[0]!.envelope.positionId, "repo-owner");
    assert.equal(turnDriver.calls[0]!.envelope.input, "What should we do?");
    assert.equal(turnDriver.calls[0]!.envelope.envelopeDigest, record.envelopeDigest);

    const started = await sse.waitForEvent("turn.started");
    const startedEnvelope = JSON.parse(started.data) as { payload: Record<string, unknown> };
    assert.deepEqual(startedEnvelope.payload, {
      turnId: record.turnId, positionId: "repo-owner", engine: "qoder", workspacePath: workspace,
      type: "run.started",
      runId: "run-1",
      timestamp: "2026-08-24T00:00:00.000Z",
    });
    const completed = await sse.waitForEvent("turn.completed");
    const completedEnvelope = JSON.parse(completed.data) as { payload: Record<string, unknown> };
    assert.equal(completedEnvelope.payload.type, "run.completed");
    assert.deepEqual((record.events as Record<string, unknown>[])[0], { type: "run.started", runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" });

    const history = await api(
      server.baseUrl,
      "/turns?positionId=repo-owner",
      { token: server.token },
    );
    assert.equal(history.status, 200);
    const body = history.body as { schemaVersion: string; conversationId: string; turns: unknown[] };
    assert.equal(body.schemaVersion, "turn-history.v1");
    assert.equal(typeof body.conversationId, "string");
    assert.equal(body.turns.length, 1);

    const turnFile = path.join(
      workspace,
      ".digital-employee",
      "workbench",
      "conversations",
      "repo-owner",
      "turns",
      `${String(record.turnId)}.json`,
    );
    await assertPosixMode(turnFile, 0o600);
    const conversationFile = path.join(
      workspace,
      ".digital-employee",
      "workbench",
      "conversations",
      "repo-owner",
      "conversation.json",
    );
    await assertPosixMode(conversationFile, 0o600);
    await assertPosixMode(path.dirname(turnFile), 0o700);
    const persisted = await fs.readFile(turnFile, "utf8");
    assert.doesNotMatch(persisted, /QODER_PERSONAL_ACCESS_TOKEN|ANTHROPIC_API_KEY/);
  } finally {
    sse.close();
    await server.close();
  }
});

test("POST /turns only accepts qoder and claude-code and remains bearer protected", async () => {
  const turnDriver = new FakeTurnDriver();
  const server = await startTestServer(undefined, turnDriver);
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const unauthenticated = await api(server.baseUrl, "/turns", {
      method: "POST",
      body: { positionId: "repo-owner", input: "hello", engine: "qoder" },
    });
    assert.equal(unauthenticated.status, 401);

    for (const engine of ["deterministic", "claude", "openai"]) {
      const rejected = await api(server.baseUrl, "/turns", {
        method: "POST",
        token: server.token,
        body: { positionId: "repo-owner", input: "hello", engine },
      });
      assert.equal(rejected.status, 400);
      assert.equal((rejected.body as { code: string }).code, "turn_engine_unsupported");
    }
    assert.equal(turnDriver.calls.length, 0);

    const accepted = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", input: "hello", engine: "claude-code" },
    });
    assert.equal(accepted.status, 200);
    assert.equal((accepted.body as { engine: TurnEngine }).engine, "claude-code");

    const acceptedLocal = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", input: "hello", engine: "claude-local" },
    });
    assert.equal(acceptedLocal.status, 200);
    assert.equal((acceptedLocal.body as { engine: TurnEngine }).engine, "claude-local");
  } finally {
    await server.close();
  }
});

test("exit 1 is persisted as indeterminate and is never automatically retried", async () => {
  const turnDriver = new FakeTurnDriver({
    status: "indeterminate",
    events: [],
    diagnostic: "digital-employee: engine.model_unavailable: token-super-secret-value",
    code: "engine.model_unavailable",
  });
  const server = await startTestServer(undefined, turnDriver);
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const response = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", input: "hello", engine: "qoder" },
    });
    assert.equal(response.status, 200);
    const record = response.body as { status: string; error: { code: string } };
    assert.equal(record.status, "indeterminate");
    assert.equal(record.error.code, "engine.model_unavailable");
    assert.equal(turnDriver.calls.length, 1, "indeterminate turn must not auto-retry");
    assert.doesNotMatch(JSON.stringify(response.body), /token-super-secret-value/);

    const history = await api(server.baseUrl, "/turns?positionId=repo-owner", {
      token: server.token,
    });
    assert.equal((history.body as { turns: Array<{ status: string }> }).turns[0]!.status, "indeterminate");
    assert.doesNotMatch(JSON.stringify(history.body), /token-super-secret-value/);
  } finally {
    await server.close();
  }
});

test("GET /turns requires a bounded positionId and never crosses workspace state", async () => {
  const server = await startTestServer(undefined, new FakeTurnDriver());
  try {
    const unopened = await api(server.baseUrl, "/turns?positionId=repo-owner", {
      token: server.token,
    });
    assert.equal(unopened.status, 422);
    assert.equal((unopened.body as { code: string }).code, "workspace_not_open");

    const workspace = await copyExampleWorkspace();
    await openWorkspace(server.baseUrl, server.token, workspace);
    const traversal = await api(server.baseUrl, "/turns?positionId=..%2F..%2Fsecret", {
      token: server.token,
    });
    assert.equal(traversal.status, 400);
    assert.equal((traversal.body as { code: string }).code, "turn_position_invalid");
  } finally {
    await server.close();
  }
});

test("legacy history rejects credential-shaped and invalid persisted event fields without echo", async () => {
  const server = await startTestServer(undefined, new FakeTurnDriver());
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const created = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", input: "persist safely", engine: "qoder" },
    });
    assert.equal(created.status, 200);
    const turnId = String((created.body as { turnId: string }).turnId);
    const turnFile = path.join(
      workspace,
      ".digital-employee",
      "workbench",
      "conversations",
      "repo-owner",
      "turns",
      `${turnId}.json`,
    );
    const valid = JSON.parse(await fs.readFile(turnFile, "utf8")) as Record<string, unknown>;

    for (const [secret, tampered] of [
      ["legacy-top-secret", { ...valid, token: "legacy-top-secret" }],
      [
        "legacy-event-secret",
        {
          ...valid,
          events: (valid.events as Array<Record<string, unknown>>).map((event, index) =>
            index === 0 ? { ...event, apiToken: "legacy-event-secret" } : event),
        },
      ],
    ] as const) {
      await fs.writeFile(turnFile, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
      const response = await api(server.baseUrl, "/turns?positionId=repo-owner", {
        token: server.token,
      });
      assert.equal(response.status, 500);
      assert.equal((response.body as { code: string }).code, "turn_storage_failed");
      assert.doesNotMatch(JSON.stringify(response.body), new RegExp(secret));
    }
  } finally {
    await server.close();
  }
});

test("legacy history rejects date-only and non-canonical persisted record timestamps", async () => {
  const server = await startTestServer(undefined, new FakeTurnDriver());
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const created = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", input: "preserve chronology", engine: "qoder" },
    });
    assert.equal(created.status, 200);
    const valid = created.body as Record<string, unknown>;
    const turnFile = path.join(
      workspace,
      ".digital-employee",
      "workbench",
      "conversations",
      "repo-owner",
      "turns",
      `${String(valid.turnId)}.json`,
    );
    for (const tampered of [
      { ...valid, createdAt: "2026-08-24", updatedAt: "2026-08-24T01:00:00.000Z" },
      {
        ...valid,
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24t01:00:00.000z",
      },
      {
        ...valid,
        createdAt: "2026-08-24T00:00:00.000000002Z",
        updatedAt: "2026-08-24T00:00:00.000000001Z",
      },
    ]) {
      await fs.writeFile(turnFile, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
      const response = await api(server.baseUrl, "/turns?positionId=repo-owner", {
        token: server.token,
      });
      assert.equal(response.status, 500);
      assert.equal((response.body as { code: string }).code, "turn_storage_failed");
    }
  } finally {
    await server.close();
  }
});

test("persisted timestamp validation accepts legal nanoseconds and equivalent offsets", () => {
  assert.equal(isTurnRecord({
    schemaVersion: "turn-record.v1",
    conversationId: "equivalent-offset-conversation",
    turnId: "equivalent-offset-turn",
    positionId: "repo-owner",
    engine: "qoder",
    status: "completed",
    input: "valid chronology",
    envelopeDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-08-24T08:00:00.1+08:00",
    updatedAt: "2026-08-24T00:00:00.100000000Z",
    runId: "equivalent-offset-run",
    output: "done",
    events: [
      {
        type: "run.started",
        runId: "equivalent-offset-run",
        timestamp: "2026-08-24T08:00:00.000000001+08:00",
      },
      {
        type: "run.completed",
        runId: "equivalent-offset-run",
        timestamp: "2026-08-24T00:00:00.000000001Z",
        output: "done",
        terminalReason: "goal_met",
      },
    ],
  }), true);
});

test("turn position ids mirror the digital-employee organization contract", () => {
  for (const valid of ["7x", "1st-responder", "repo-owner"]) {
    assert.equal(POSITION_ID_PATTERN.test(valid), true);
    assert.equal(assertPositionId(valid), valid);
  }
  for (const invalid of ["a--b", "a-", "RepoOwner"]) {
    assert.equal(POSITION_ID_PATTERN.test(invalid), false);
    assert.throws(() => assertPositionId(invalid));
  }
});

test("history leaves a turn owned by the active store in running state", async () => {
  const workspace = await copyExampleWorkspace();
  const store = new TurnStore();
  await store.begin({
    workspace,
    positionId: "repo-owner",
    turnId: "active-turn",
    engine: "qoder",
    message: "still running",
    envelopeDigest: `sha256:${"a".repeat(64)}`,
    now: "2026-08-24T01:00:00.000Z",
  });

  const history = await store.history(
    workspace,
    "repo-owner",
    "2026-08-24T01:00:01.000Z",
  );
  assert.equal(history.turns[0]?.status, "running");
  assert.equal(history.turns[0]?.error, undefined);
});

test("atomic turn writes clean temporary files across write, fsync, rename, and directory-fsync faults", async () => {
  const stages = ["write", "file-sync", "rename", "directory-sync"] as const;
  for (const stage of stages) {
    const workspace = await copyExampleWorkspace();
    const normal = new TurnStore();
    await normal.history(workspace, "repo-owner", "2026-08-24T01:00:00.000Z");
    const base = nodeAtomicTurnWriteOperations;
    const operations: AtomicTurnWriteOperations = {
      ...base,
      openTemporary: async (file) => {
        const handle = await base.openTemporary(file);
        return {
          writeFile: async (payload) => {
            if (stage === "write") throw new Error("injected write fault");
            await handle.writeFile(payload);
          },
          sync: async () => {
            if (stage === "file-sync") throw new Error("injected file fsync fault");
            await handle.sync();
          },
          close: () => handle.close(),
        };
      },
      rename: async (source, target) => {
        if (stage === "rename") throw new Error("injected rename fault");
        await base.rename(source, target);
      },
      openDirectory: async (directory) => {
        const handle = await base.openDirectory(directory);
        return {
          sync: async () => {
            if (stage === "directory-sync") throw new Error("injected directory fsync fault");
            await handle.sync();
          },
          close: () => handle.close(),
        };
      },
    };
    const faulting = new TurnStore({ atomicWriteOperations: operations });
    await assert.rejects(
      faulting.begin({
        workspace,
        positionId: "repo-owner",
        turnId: `fault-${stage}`,
        engine: "qoder",
        message: "must fail atomically",
        envelopeDigest: `sha256:${"a".repeat(64)}`,
        now: "2026-08-24T01:00:01.000Z",
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "turn_storage_failed",
    );
    const turnsDir = path.join(
      workspace,
      ".digital-employee",
      "workbench",
      "conversations",
      "repo-owner",
      "turns",
    );
    assert.deepEqual(
      (await fs.readdir(turnsDir)).filter((name) => name.endsWith(".tmp")),
      [],
      `${stage} must not leave temporary debris`,
    );
  }
});

test("turn store persists the upstream one-megachar output boundary", async () => {
  const workspace = await copyExampleWorkspace();
  const store = new TurnStore();
  const output = "a".repeat(1_048_576);
  const running = await store.begin({
    workspace,
    positionId: "repo-owner",
    turnId: "max-output-turn",
    engine: "qoder",
    message: "produce a bounded result",
    envelopeDigest: `sha256:${"a".repeat(64)}`,
    now: "2026-08-24T01:00:00.000Z",
  });
  const base = { runId: "max-output-run", timestamp: "2026-08-24T01:00:01.000Z" };
  await store.finish(workspace, {
    ...running,
    status: "completed",
    updatedAt: "2026-08-24T01:00:02.000Z",
    runId: base.runId,
    output,
    events: [
      { ...base, type: "run.started" },
      { ...base, type: "model.delta", text: output },
      { ...base, type: "run.completed", output, terminalReason: "goal_met" },
    ],
  });
  const history = await store.history(
    workspace,
    "repo-owner",
    "2026-08-24T01:00:03.000Z",
  );
  assert.equal(history.turns[0]?.status, "completed");
  assert.equal(
    typeof history.turns[0]?.output === "string" ? history.turns[0].output.length : 0,
    1_048_576,
  );
});

test("a terminal SSE event is not published when durable finish fails", async () => {
  class FailingFinishTurnStore extends TurnStore {
    override async finish(): Promise<void> {
      throw new Error("simulated durable finish failure");
    }
  }

  const server = await startTestServer(undefined, new FakeTurnDriver());
  server.ctx.turnStore = new FailingFinishTurnStore();
  const workspace = await copyExampleWorkspace();
  const published: string[] = [];
  const unsubscribe = server.ctx.bus.subscribe((event) => published.push(event.type));
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const response = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", input: "hello", engine: "qoder" },
    });
    assert.equal(response.status, 500);
    assert.ok(published.includes("turn.started"));
    assert.equal(published.includes("turn.completed"), false);
    assert.equal(published.includes("turn.failed"), false);
    assert.equal(published.includes("turn.indeterminate"), false);
  } finally {
    unsubscribe();
    await server.close();
  }
});

test("turn store recovers a persisted running record as indeterminate after restart", async () => {
  const workspace = await copyExampleWorkspace();
  const envelope = createTurnEnvelope({
    workspaceRef: workspace,
    positionId: "repo-owner",
    turnId: "interrupted-turn",
    message: "remember this decision",
  });
  const beforeRestart = new TurnStore();
  await beforeRestart.begin({
    workspace,
    positionId: "repo-owner",
    turnId: "interrupted-turn",
    engine: "qoder",
    message: "remember this decision",
    envelopeDigest: envelope.envelopeDigest,
    now: "2026-08-24T01:00:00.000Z",
  });

  const afterRestart = new TurnStore();
  const history = await afterRestart.history(
    workspace,
    "repo-owner",
    "2026-08-24T01:01:00.000Z",
  );
  assert.equal(history.turns.length, 1);
  assert.equal(history.turns[0]!.status, "indeterminate");
  assert.equal(history.turns[0]!.error?.code, "turn_interrupted");
});

test("turn store rejects a persisted traversal turnId without writing outside turns", async () => {
  const workspace = await copyExampleWorkspace();
  const store = new TurnStore();
  const now = "2026-08-24T01:00:00.000Z";
  const initialized = await store.history(workspace, "repo-owner", now);
  const turnsDir = path.join(
    workspace,
    ".digital-employee",
    "workbench",
    "conversations",
    "repo-owner",
    "turns",
  );
  const poisonFile = path.join(turnsDir, "poison.json");
  const outsideFile = path.join(workspace, "pwned.json");
  const poison = {
    schemaVersion: "turn-record.v1",
    conversationId: initialized.conversationId,
    turnId: "../../../../../pwned",
    positionId: "repo-owner",
    engine: "qoder",
    status: "running",
    input: "poison",
    envelopeDigest: `sha256:${"a".repeat(64)}`,
    createdAt: now,
    updatedAt: now,
    events: [],
  };
  await fs.writeFile(poisonFile, `${JSON.stringify(poison)}\n`, { mode: 0o600 });

  await assert.rejects(
    store.history(workspace, "repo-owner", "2026-08-24T01:01:00.000Z"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "turn_storage_failed",
  );
  await assert.rejects(fs.stat(outsideFile), { code: "ENOENT" });
  assert.equal(JSON.parse(await fs.readFile(poisonFile, "utf8")).status, "running");
});

test("turn store rejects a symlinked local-state path instead of writing outside the workspace", async () => {
  const workspace = await copyExampleWorkspace();
  const outside = await fs.mkdtemp(path.join(workspace, "..", "owb-outside-"));
  await fs.mkdir(path.join(workspace, ".digital-employee"), { recursive: true });
  await fs.symlink(outside, path.join(workspace, ".digital-employee", "workbench"));
  const store = new TurnStore();
  await assert.rejects(
    store.history(workspace, "repo-owner", "2026-08-24T01:00:00.000Z"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "turn_storage_failed",
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

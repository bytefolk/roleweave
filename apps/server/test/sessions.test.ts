import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TurnRunDriver, TurnRunRequest, TurnRunResult, WorkbenchSession } from "@roleweave/shared";
import { api, assertPosixMode, copyExampleWorkspace, startTestServer } from "./helpers.js";
import { SessionStore } from "../src/sessions/store.js";
import { TurnStore } from "../src/turns/store.js";

async function openWorkspace(baseUrl: string, token: string, dir: string): Promise<void> {
  const opened = await api(baseUrl, "/workspace/open", {
    method: "POST",
    token,
    body: { path: dir },
  });
  assert.equal(opened.status, 200);
}

test("explicit session create, turn, rotate, and restart preserve an empty successor", async () => {
  const workspace = await copyExampleWorkspace();
  const before = await startTestServer();
  let first: WorkbenchSession;
  let second: WorkbenchSession;
  try {
    await openWorkspace(before.baseUrl, before.token, workspace);
    const created = await api(before.baseUrl, "/sessions", {
      method: "POST",
      token: before.token,
      body: { positionId: "repo-owner" },
    });
    assert.equal(created.status, 201);
    first = created.body as WorkbenchSession;
    assert.equal(first.schemaVersion, "workbench-session.v1");
    assert.equal(first.principal, "position.repo-owner");
    assert.equal(first.status, "active");
    assert.doesNotMatch(JSON.stringify(created.body), /owb-workspace-|Authorization|Bearer|TOKEN|API_KEY/);
    const sessionRoot = path.join(workspace, ".digital-employee", "workbench", "sessions");
    await assertPosixMode(sessionRoot, 0o700);
    await assertPosixMode(path.join(sessionRoot, "workspace-instance.json"), 0o600);
    await assertPosixMode(path.join(sessionRoot, "positions", "repo-owner.json"), 0o600);

    const turn = await api(before.baseUrl, `/sessions/${first.sessionId}/turns`, {
      method: "POST",
      token: before.token,
      body: { input: "remember this decision", engine: "qoder" },
    });
    assert.equal(turn.status, 200);

    const rotated = await api(before.baseUrl, `/sessions/${first.sessionId}/rotate`, {
      method: "POST",
      token: before.token,
      body: {},
    });
    assert.equal(rotated.status, 201);
    second = rotated.body as WorkbenchSession;
    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(second.rotatedFrom, first.sessionId);
  } finally {
    await before.close();
  }

  const after = await startTestServer();
  try {
    await openWorkspace(after.baseUrl, after.token, workspace);
    const oldHistory = await api(after.baseUrl, `/sessions/${first!.sessionId}/turns`, { token: after.token });
    const newHistory = await api(after.baseUrl, `/sessions/${second!.sessionId}/turns`, { token: after.token });
    assert.equal(oldHistory.status, 200);
    assert.equal((oldHistory.body as { turns: unknown[] }).turns.length, 1);
    assert.equal(newHistory.status, 200);
    assert.equal((newHistory.body as { turns: unknown[] }).turns.length, 0);

    const old = await api(after.baseUrl, `/sessions/${first!.sessionId}`, { token: after.token });
    assert.equal((old.body as WorkbenchSession).status, "rotated");
    assert.equal((old.body as WorkbenchSession).rotatedTo, second!.sessionId);
    const denied = await api(after.baseUrl, `/sessions/${first!.sessionId}/turns`, {
      method: "POST",
      token: after.token,
      body: { input: "must not run", engine: "qoder" },
    });
    assert.equal(denied.status, 409);
  } finally {
    await after.close();
  }
});

test("session request validation fails before invoking a Host", async () => {
  class RecordingDriver implements TurnRunDriver {
    calls: TurnRunRequest[] = [];
    async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
      this.calls.push(request);
      return { status: "indeterminate", events: [], diagnostic: "", code: "not_expected" };
    }
  }
  const driver = new RecordingDriver();
  const server = await startTestServer(undefined, driver);
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    for (const body of [
      { positionId: "missing-position" },
      { positionId: "repo-owner", principal: "admin" },
      { positionId: "../../escape" },
    ]) {
      const response = await api(server.baseUrl, "/sessions", {
        method: "POST",
        token: server.token,
        body,
      });
      assert.ok([400, 404].includes(response.status));
    }
    const malformed = await api(server.baseUrl, "/sessions/not-a-uuid", { token: server.token });
    assert.equal(malformed.status, 400);
    assert.equal(driver.calls.length, 0);
  } finally {
    await server.close();
  }
});

test("session history rejects credential-shaped and invalid persisted event fields without echo", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const created = await api(server.baseUrl, "/sessions", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner" },
    });
    const session = created.body as WorkbenchSession;
    const turn = await api(server.baseUrl, `/sessions/${session.sessionId}/turns`, {
      method: "POST",
      token: server.token,
      body: { input: "persist safely", engine: "qoder" },
    });
    assert.equal(turn.status, 200);
    const turnId = String((turn.body as { turnId: string }).turnId);
    const turnFile = path.join(
      workspace,
      ".digital-employee",
      "workbench",
      "sessions",
      "conversations",
      session.sessionId,
      "turns",
      `${turnId}.json`,
    );
    const valid = JSON.parse(await fs.readFile(turnFile, "utf8")) as Record<string, unknown>;

    for (const [secret, tampered] of [
      ["session-top-secret", { ...valid, accessToken: "session-top-secret" }],
      [
        "session-event-secret",
        {
          ...valid,
          events: (valid.events as Array<Record<string, unknown>>).map((event, index) =>
            index === 0 ? { ...event, credential: "session-event-secret" } : event),
        },
      ],
    ] as const) {
      await fs.writeFile(turnFile, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
      const response = await api(server.baseUrl, `/sessions/${session.sessionId}/turns`, {
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

test("session history compares persisted record timestamps as instants across offsets", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const created = await api(server.baseUrl, "/sessions", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner" },
    });
    const session = created.body as WorkbenchSession;
    const turn = await api(server.baseUrl, `/sessions/${session.sessionId}/turns`, {
      method: "POST",
      token: server.token,
      body: { input: "preserve chronology", engine: "qoder" },
    });
    assert.equal(turn.status, 200);
    const valid = turn.body as Record<string, unknown>;
    const turnFile = path.join(
      workspace,
      ".digital-employee",
      "workbench",
      "sessions",
      "conversations",
      session.sessionId,
      "turns",
      `${String(valid.turnId)}.json`,
    );
    for (const timestamps of [
      {
        createdAt: "2026-08-24T01:00:00.000-08:00",
        updatedAt: "2026-08-24T08:30:00.000+00:00",
      },
      {
        createdAt: "2026-08-24T00:00:00.000000002Z",
        updatedAt: "2026-08-24T00:00:00.000000001Z",
      },
    ]) {
      await fs.writeFile(turnFile, `${JSON.stringify({ ...valid, ...timestamps })}\n`, {
        mode: 0o600,
      });
      const response = await api(server.baseUrl, `/sessions/${session.sessionId}/turns`, {
        token: server.token,
      });
      assert.equal(response.status, 500);
      assert.equal((response.body as { code: string }).code, "turn_storage_failed");
    }
  } finally {
    await server.close();
  }
});

test("double rotation creates one durable successor and returns it on retry", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const created = await api(server.baseUrl, "/sessions", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner" },
    });
    const source = created.body as WorkbenchSession;
    const duplicateCreate = await api(server.baseUrl, "/sessions", {
      method: "POST", token: server.token, body: { positionId: "repo-owner" },
    });
    assert.equal(duplicateCreate.status, 409);
    const [left, right] = await Promise.all([
      api(server.baseUrl, `/sessions/${source.sessionId}/rotate`, { method: "POST", token: server.token, body: {} }),
      api(server.baseUrl, `/sessions/${source.sessionId}/rotate`, { method: "POST", token: server.token, body: {} }),
    ]);
    assert.deepEqual([left.status, right.status].sort(), [200, 201]);
    assert.equal((left.body as WorkbenchSession).sessionId, (right.body as WorkbenchSession).sessionId);
    const listed = await api(server.baseUrl, "/sessions?positionId=repo-owner", { token: server.token });
    assert.equal((listed.body as { sessions: unknown[] }).sessions.length, 2);
  } finally {
    await server.close();
  }
});

test("restart recovers an interrupted session turn before rotation without invoking a Host", async () => {
  const workspace = await copyExampleWorkspace();
  const sessionStore = new SessionStore();
  const session = await sessionStore.create(workspace, "repo-owner", "2026-08-24T00:00:00.000Z");
  const beforeRestart = new TurnStore();
  await beforeRestart.beginSession({
    workspace,
    sessionId: session.sessionId,
    positionId: session.positionId,
    turnId: "interrupted-session-turn",
    engine: "qoder",
    message: "do not retry me",
    envelopeDigest: `sha256:${"a".repeat(64)}`,
    now: "2026-08-24T00:01:00.000Z",
  });
  class NoCallDriver implements TurnRunDriver {
    calls = 0;
    async turnRun(): Promise<TurnRunResult> {
      this.calls += 1;
      throw new Error("must not be invoked");
    }
  }
  const driver = new NoCallDriver();
  const afterRestart = await startTestServer(undefined, driver);
  try {
    await openWorkspace(afterRestart.baseUrl, afterRestart.token, workspace);
    const rotated = await api(afterRestart.baseUrl, `/sessions/${session.sessionId}/rotate`, {
      method: "POST", token: afterRestart.token, body: {},
    });
    assert.equal(rotated.status, 201);
    const oldHistory = await api(afterRestart.baseUrl, `/sessions/${session.sessionId}/turns`, {
      token: afterRestart.token,
    });
    assert.equal((oldHistory.body as { turns: Array<{ status: string; error?: { code: string } }> }).turns[0]?.status, "indeterminate");
    assert.equal((oldHistory.body as { turns: Array<{ error?: { code: string } }> }).turns[0]?.error?.code, "turn_interrupted");
    assert.equal(driver.calls, 0);
  } finally {
    await afterRestart.close();
  }
});

test("rotation conflicts with a running turn and never starts a second Host call", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  class BlockingDriver implements TurnRunDriver {
    calls = 0;
    async turnRun(_request: TurnRunRequest): Promise<TurnRunResult> {
      this.calls += 1;
      markStarted();
      await released;
      return {
        status: "trusted",
        diagnostic: "",
        events: [
          { type: "run.started", runId: "run-blocked", timestamp: "2026-08-24T00:00:00.000Z" },
          { type: "run.completed", runId: "run-blocked", timestamp: "2026-08-24T00:00:01.000Z", output: "done", terminalReason: "goal_met" },
        ],
      };
    }
  }
  const driver = new BlockingDriver();
  const server = await startTestServer(undefined, driver);
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const created = await api(server.baseUrl, "/sessions", {
      method: "POST", token: server.token, body: { positionId: "repo-owner" },
    });
    const session = created.body as WorkbenchSession;
    const running = api(server.baseUrl, `/sessions/${session.sessionId}/turns`, {
      method: "POST", token: server.token, body: { input: "long task", engine: "qoder" },
    });
    await started;
    const rotate = await api(server.baseUrl, `/sessions/${session.sessionId}/rotate`, {
      method: "POST", token: server.token, body: {},
    });
    assert.equal(rotate.status, 409);
    assert.equal((rotate.body as { code: string }).code, "session_conflict");
    assert.equal(driver.calls, 1);
    release();
    assert.equal((await running).status, 200);
  } finally {
    release();
    await server.close();
  }
});

test("unsafe, corrupt, wrong-workspace, and unbounded persisted session state fails closed", async () => {
  const workspace = await copyExampleWorkspace();
  const store = new SessionStore();
  const created = await store.create(workspace, "repo-owner", "2026-08-24T00:00:00.000Z");
  const positionsDir = path.join(workspace, ".digital-employee", "workbench", "sessions", "positions");
  const stateFile = path.join(positionsDir, "repo-owner.json");
  const valid = await fs.readFile(stateFile, "utf8");

  await fs.writeFile(stateFile, "{broken", { mode: 0o600 });
  await assert.rejects(() => store.get(workspace, created.sessionId));
  await fs.writeFile(stateFile, valid, { mode: 0o600 });

  const crossPosition = JSON.parse(valid) as { sessions: WorkbenchSession[] };
  crossPosition.sessions[0]!.positionId = "release-engineer";
  crossPosition.sessions[0]!.principal = "position.release-engineer";
  await fs.writeFile(stateFile, `${JSON.stringify(crossPosition)}\n`, { mode: 0o600 });
  await assert.rejects(() => store.get(workspace, created.sessionId));
  await fs.writeFile(stateFile, valid, { mode: 0o600 });

  const state = JSON.parse(valid) as { workspaceInstanceId: string; sessions: WorkbenchSession[] };
  state.workspaceInstanceId = "00000000-0000-4000-8000-000000000000";
  await fs.writeFile(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await assert.rejects(() => store.get(workspace, created.sessionId));
  await fs.writeFile(stateFile, valid, { mode: 0o600 });

  await fs.writeFile(stateFile, "x".repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(() => store.get(workspace, created.sessionId));
  await fs.writeFile(stateFile, valid, { mode: 0o600 });

  await fs.rename(positionsDir, `${positionsDir}.real`);
  await fs.symlink(`${positionsDir}.real`, positionsDir);
  await assert.rejects(() => store.list(workspace, "repo-owner"));
});

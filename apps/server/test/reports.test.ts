import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type {
  ReportsResponse,
  TurnRecord,
  TurnRunDriver,
  TurnRunRequest,
  TurnRunResult,
  WorkbenchSession,
} from "@roleweave/shared";
import { compareReportRecords } from "../src/turns/store.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

async function open(server: Awaited<ReturnType<typeof startTestServer>>, dir: string): Promise<void> {
  const response = await api(server.baseUrl, "/workspace/open", {
    method: "POST", token: server.token, body: { path: dir },
  });
  assert.equal(response.status, 200);
}

async function writeTurn(dir: string, record: TurnRecord): Promise<void> {
  const conversation = path.join(dir, ".digital-employee", "workbench", "conversations", record.positionId);
  const turns = path.join(conversation, "turns");
  await fs.mkdir(turns, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(conversation, "conversation.json"), `${JSON.stringify({
    schemaVersion: "conversation.v1",
    conversationId: record.conversationId,
    positionId: record.positionId,
    createdAt: record.createdAt,
  })}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(turns, `${record.turnId}.json`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function writeSessionTurn(dir: string, sessionId: string, record: TurnRecord): Promise<void> {
  const conversation = path.join(
    dir,
    ".digital-employee",
    "workbench",
    "sessions",
    "conversations",
    sessionId,
  );
  const turns = path.join(conversation, "turns");
  await fs.mkdir(turns, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(conversation, "conversation.json"), `${JSON.stringify({
    schemaVersion: "conversation.v1",
    conversationId: sessionId,
    positionId: record.positionId,
    createdAt: record.createdAt,
  })}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(turns, `${record.turnId}.json`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function turn(overrides: Partial<TurnRecord>): TurnRecord {
  return {
    schemaVersion: "turn-record.v1",
    conversationId: "conversation-report",
    turnId: "turn-report",
    positionId: "community-operator",
    engine: "qoder",
    status: "completed",
    input: "sensitive raw input",
    envelopeDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-08-24T06:00:00.000Z",
    updatedAt: "2026-08-24T06:01:00.000Z",
    events: [
      { type: "run.started", runId: "run-report", timestamp: "2026-08-24T06:00:00.000Z" },
      { type: "usage", runId: "run-report", timestamp: "2026-08-24T06:00:30.000Z", inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      { type: "run.completed", runId: "run-report", timestamp: "2026-08-24T06:01:00.000Z", output: "sensitive raw output", terminalReason: "goal_met" },
    ],
    runId: "run-report",
    output: "sensitive raw output",
    ...overrides,
  };
}

function audit(workspace: string): Record<string, unknown> {
  return {
    schemaVersion: "org-audit.v1",
    at: "2026-08-24T06:00:00.000Z",
    actor: "digital-employee org apply",
    workspace,
    bootstrapped: false,
    changes: { hired: [], moved: [], dismissed: [], budgetUpdated: [] },
    positionCount: 4,
  };
}

class ReportsTurnDriver implements TurnRunDriver {
  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    const runId = `run-${request.envelope.turnId}`;
    const timestamp = new Date().toISOString();
    const events: TurnRunResult["events"] = [
      { type: "run.started", runId, timestamp },
      {
        type: "usage",
        runId,
        timestamp,
        inputTokens: 21,
        outputTokens: 13,
        totalTokens: 34,
      },
      {
        type: "run.completed",
        runId,
        timestamp,
        output: "sensitive session output",
        terminalReason: "goal_met",
      },
    ];
    for (const event of events) request.onEvent?.(event);
    return { status: "trusted", events, diagnostic: "" };
  }
}

async function createSessionTurn(
  server: Awaited<ReturnType<typeof startTestServer>>,
  positionId = "repo-owner",
): Promise<{ session: WorkbenchSession; record: TurnRecord }> {
  const created = await api(server.baseUrl, "/sessions", {
    method: "POST",
    token: server.token,
    body: { positionId },
  });
  assert.equal(created.status, 201);
  const session = created.body as WorkbenchSession;
  const completed = await api(server.baseUrl, `/sessions/${session.sessionId}/turns`, {
    method: "POST",
    token: server.token,
    body: { input: "sensitive session input", engine: "qoder" },
  });
  assert.equal(completed.status, 200);
  return { session, record: completed.body as TurnRecord };
}

test("reports: empty workspace returns truthful empty streams and declared budgets", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await open(server, dir);
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 200);
    const body = response.body as ReportsResponse;
    assert.deepEqual(body.streams, { escalations: [], audits: [], evidence: [] });
    assert.ok(body.budgets.length > 0);
    assert.ok(body.budgets.every((budget) => budget.state === "unobserved"));
  } finally {
    await server.close();
  }
});

test("#112 reports: durable session turns survive rotate/restart and remain public-safe evidence", async () => {
  const dir = await copyExampleWorkspace();
  const before = await startTestServer(undefined, new ReportsTurnDriver());
  let session: WorkbenchSession;
  let turnDigest: string;
  try {
    await open(before, dir);
    const created = await api(before.baseUrl, "/sessions", {
      method: "POST",
      token: before.token,
      body: { positionId: "repo-owner" },
    });
    assert.equal(created.status, 201);
    session = created.body as WorkbenchSession;

    const completed = await api(before.baseUrl, `/sessions/${session.sessionId}/turns`, {
      method: "POST",
      token: before.token,
      body: { input: "sensitive session input", engine: "qoder" },
    });
    assert.equal(completed.status, 200);
    turnDigest = (completed.body as TurnRecord).envelopeDigest;

    const rotated = await api(before.baseUrl, `/sessions/${session.sessionId}/rotate`, {
      method: "POST",
      token: before.token,
      body: {},
    });
    assert.equal(rotated.status, 201);
  } finally {
    await before.close();
  }

  const after = await startTestServer();
  try {
    await open(after, dir);
    const response = await api(after.baseUrl, "/reports", { token: after.token });
    assert.equal(response.status, 200);
    const body = response.body as ReportsResponse;
    assert.equal(body.streams.evidence.length, 1);
    const evidence = body.streams.evidence[0]!;
    assert.equal(evidence.conversationId, session!.sessionId);
    assert.equal(evidence.positionId, "repo-owner");
    assert.equal(evidence.engine, "qoder");
    assert.equal(evidence.status, "completed");
    assert.equal(evidence.envelopeDigest, turnDigest!);
    assert.deepEqual(evidence.usage, { inputTokens: 21, outputTokens: 13, totalTokens: 34 });
    const budget = body.budgets.find((candidate) => candidate.positionId === "repo-owner");
    assert.deepEqual(budget?.recorded, { inputTokens: 21, outputTokens: 13, totalTokens: 34 });
    assert.deepEqual(budget?.latestTurn, { inputTokens: 21, outputTokens: 13, totalTokens: 34 });
    assert.equal(budget?.state, "within");
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("sensitive session input"), false);
    assert.equal(serialized.includes("sensitive session output"), false);
  } finally {
    await after.close();
  }
});

test("#112 reports: legacy and session conversations share one newest-first projection", async () => {
  const server = await startTestServer(undefined, new ReportsTurnDriver());
  const dir = await copyExampleWorkspace();
  try {
    await writeTurn(dir, turn({
      turnId: "legacy-report-turn",
      createdAt: "2026-08-24T05:00:00.000Z",
      updatedAt: "2026-08-24T05:01:00.000Z",
    }));
    await open(server, dir);
    const created = await api(server.baseUrl, "/sessions", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner" },
    });
    assert.equal(created.status, 201);
    const session = created.body as WorkbenchSession;
    const completed = await api(server.baseUrl, `/sessions/${session.sessionId}/turns`, {
      method: "POST",
      token: server.token,
      body: { input: "session report turn", engine: "qoder" },
    });
    assert.equal(completed.status, 200);
    const sessionTurnId = (completed.body as TurnRecord).turnId;

    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 200);
    const body = response.body as ReportsResponse;
    assert.deepEqual(
      body.streams.evidence.map((entry) => entry.turnId),
      [sessionTurnId, "legacy-report-turn"],
    );
  } finally {
    await server.close();
  }
});

test("#112 reports: symlinked session conversation roots fail closed", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  const outside = await fs.mkdtemp(path.join(dir, "..", "owb-session-report-outside-"));
  try {
    const sessions = path.join(dir, ".digital-employee", "workbench", "sessions");
    await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
    await fs.symlink(outside, path.join(sessions, "conversations"));
    await open(server, dir);
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
    assert.equal(JSON.stringify(response.body).includes(outside), false);
  } finally {
    await server.close();
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("#112 reports: inconsistent session conversation metadata fails closed", async () => {
  const server = await startTestServer(undefined, new ReportsTurnDriver());
  const dir = await copyExampleWorkspace();
  try {
    await open(server, dir);
    const created = await api(server.baseUrl, "/sessions", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner" },
    });
    assert.equal(created.status, 201);
    const session = created.body as WorkbenchSession;
    const completed = await api(server.baseUrl, `/sessions/${session.sessionId}/turns`, {
      method: "POST",
      token: server.token,
      body: { input: "sensitive session input", engine: "qoder" },
    });
    assert.equal(completed.status, 200);
    const metadataFile = path.join(
      dir,
      ".digital-employee",
      "workbench",
      "sessions",
      "conversations",
      session.sessionId,
      "conversation.json",
    );
    const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8")) as Record<string, unknown>;
    await fs.writeFile(
      metadataFile,
      `${JSON.stringify({ ...metadata, conversationId: "wrong-session" })}\n`,
      { mode: 0o600 },
    );

    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
    assert.equal(JSON.stringify(response.body).includes("sensitive session input"), false);
  } finally {
    await server.close();
  }
});

test("#112 reports: an orphan session conversation fails closed against authoritative session state", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  const sessionId = testUuid(1);
  try {
    await writeSessionTurn(dir, sessionId, turn({
      conversationId: sessionId,
      turnId: "orphan-session-turn",
      positionId: "repo-owner",
      conversationRef: sessionId,
    }));
    await open(server, dir);
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
  } finally {
    await server.close();
  }
});

test("#112 reports: wrong-workspace authoritative session state fails closed", async () => {
  const server = await startTestServer(undefined, new ReportsTurnDriver());
  const dir = await copyExampleWorkspace();
  try {
    await open(server, dir);
    await createSessionTurn(server);
    const stateFile = path.join(
      dir,
      ".digital-employee",
      "workbench",
      "sessions",
      "positions",
      "repo-owner.json",
    );
    const state = JSON.parse(await fs.readFile(stateFile, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    state.sessions[0]!.workspaceInstanceId = testUuid(2);
    await fs.writeFile(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });

    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
  } finally {
    await server.close();
  }
});

test("#112 reports: internally consistent session facts cannot change their authoritative position", async () => {
  const server = await startTestServer(undefined, new ReportsTurnDriver());
  const dir = await copyExampleWorkspace();
  try {
    await open(server, dir);
    const { session, record } = await createSessionTurn(server);
    const conversation = path.join(
      dir,
      ".digital-employee",
      "workbench",
      "sessions",
      "conversations",
      session.sessionId,
    );
    const metadataFile = path.join(conversation, "conversation.json");
    const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8")) as Record<string, unknown>;
    await fs.writeFile(
      metadataFile,
      `${JSON.stringify({ ...metadata, positionId: "release-engineer" })}\n`,
      { mode: 0o600 },
    );
    const recordFile = path.join(conversation, "turns", `${record.turnId}.json`);
    const persisted = JSON.parse(await fs.readFile(recordFile, "utf8")) as Record<string, unknown>;
    await fs.writeFile(
      recordFile,
      `${JSON.stringify({ ...persisted, positionId: "release-engineer" })}\n`,
      { mode: 0o600 },
    );

    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
  } finally {
    await server.close();
  }
});

test("#112 reports: duplicate authoritative session ids across positions fail closed", async () => {
  const server = await startTestServer(undefined, new ReportsTurnDriver());
  const dir = await copyExampleWorkspace();
  try {
    await open(server, dir);
    await createSessionTurn(server);
    const positions = path.join(dir, ".digital-employee", "workbench", "sessions", "positions");
    const source = JSON.parse(await fs.readFile(path.join(positions, "repo-owner.json"), "utf8")) as {
      positionId: string;
      sessions: Array<{ positionId: string; principal: string }>;
    };
    source.positionId = "release-engineer";
    for (const session of source.sessions) {
      session.positionId = "release-engineer";
      session.principal = "position.release-engineer";
    }
    await fs.writeFile(
      path.join(positions, "release-engineer.json"),
      `${JSON.stringify(source)}\n`,
      { mode: 0o600 },
    );

    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
  } finally {
    await server.close();
  }
});

test("#112 reports: duplicate conversationId/turnId facts across roots fail closed", async () => {
  const server = await startTestServer(undefined, new ReportsTurnDriver());
  const dir = await copyExampleWorkspace();
  try {
    await open(server, dir);
    const { record } = await createSessionTurn(server);
    await writeTurn(dir, record);

    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
  } finally {
    await server.close();
  }
});

test("#112 reports: equal updatedAt and turnId facts use conversationId as a total-order tie-breaker", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await writeTurn(dir, turn({
      conversationId: "conversation-a",
      turnId: "equal-report-turn",
      positionId: "community-operator",
    }));
    await writeTurn(dir, turn({
      conversationId: "conversation-z",
      turnId: "equal-report-turn",
      positionId: "repo-owner",
    }));
    await open(server, dir);
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 200);
    assert.deepEqual(
      (response.body as ReportsResponse).streams.evidence.map((entry) => entry.conversationId),
      ["conversation-z", "conversation-a"],
    );
  } finally {
    await server.close();
  }
});

test("#112 reports: canonically equivalent Unicode keys sort by code units independent of enumeration", () => {
  const composed = turn({ conversationId: "\u00e9", turnId: "same-turn" });
  const decomposed = turn({ conversationId: "e\u0301", turnId: "same-turn" });
  const expected = ["\u00e9", "e\u0301"];

  assert.deepEqual(
    [decomposed, composed].sort(compareReportRecords).map((record) => record.conversationId),
    expected,
  );
  assert.deepEqual(
    [composed, decomposed].sort(compareReportRecords).map((record) => record.conversationId),
    expected,
  );
});

test("#112 reports: nested turn entries fail closed", async () => {
  const server = await startTestServer(undefined, new ReportsTurnDriver());
  const dir = await copyExampleWorkspace();
  try {
    await open(server, dir);
    const { session } = await createSessionTurn(server);
    const turns = path.join(
      dir,
      ".digital-employee",
      "workbench",
      "sessions",
      "conversations",
      session.sessionId,
      "turns",
    );
    await fs.mkdir(path.join(turns, "nested"), { mode: 0o700 });
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
  } finally {
    await server.close();
  }
});

test("#112 reports: malformed and symlinked atomic temp entries fail closed", async () => {
  for (const variant of ["malformed", "symlink"] as const) {
    const server = await startTestServer(undefined, new ReportsTurnDriver());
    const dir = await copyExampleWorkspace();
    const outside = path.join(path.dirname(dir), `owb-report-temp-${variant}-${path.basename(dir)}`);
    try {
      await open(server, dir);
      const { session } = await createSessionTurn(server);
      const turns = path.join(
        dir,
        ".digital-employee",
        "workbench",
        "sessions",
        "conversations",
        session.sessionId,
        "turns",
      );
      if (variant === "malformed") {
        await fs.writeFile(path.join(turns, ".not-an-atomic-name.tmp"), "", { mode: 0o600 });
      } else {
        await fs.writeFile(outside, "outside", { mode: 0o600 });
        await fs.symlink(outside, path.join(turns, `.stale.json.${testUuid(3)}.tmp`));
      }
      const response = await api(server.baseUrl, "/reports", { token: server.token });
      assert.equal(response.status, 500, variant);
      assert.equal((response.body as { code: string }).code, "reports_data_invalid", variant);
      assert.equal(JSON.stringify(response.body).includes(outside), false, variant);
    } finally {
      await server.close();
      await fs.rm(outside, { force: true });
    }
  }
});

test("#112 reports: oversized atomic temp records fail closed", async () => {
  const server = await startTestServer(undefined, new ReportsTurnDriver());
  const dir = await copyExampleWorkspace();
  try {
    await open(server, dir);
    const { session } = await createSessionTurn(server);
    const temporary = path.join(
      dir,
      ".digital-employee",
      "workbench",
      "sessions",
      "conversations",
      session.sessionId,
      "turns",
      `.stale.json.${testUuid(4)}.tmp`,
    );
    await fs.writeFile(temporary, "", { mode: 0o600 });
    await fs.truncate(temporary, 20 * 1024 * 1024 + 1);
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
  } finally {
    await server.close();
  }
});

test("#112 reports: total turn-directory entries are bounded even when extras are valid temps", async () => {
  const server = await startTestServer(undefined, new ReportsTurnDriver());
  const dir = await copyExampleWorkspace();
  try {
    await open(server, dir);
    const { session } = await createSessionTurn(server);
    const turns = path.join(
      dir,
      ".digital-employee",
      "workbench",
      "sessions",
      "conversations",
      session.sessionId,
      "turns",
    );
    for (let offset = 0; offset < 512; offset += 64) {
      await Promise.all(Array.from({ length: 64 }, (_, index) => {
        const serial = offset + index + 10;
        return fs.writeFile(
          path.join(turns, `.stale-${serial}.json.${testUuid(serial)}.tmp`),
          "",
          { mode: 0o600 },
        );
      }));
    }
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
  } finally {
    await server.close();
  }
});

test("#112 reports: each conversation accepts at most 256 otherwise-valid atomic temps", async () => {
  const server = await startTestServer(undefined, new ReportsTurnDriver());
  const dir = await copyExampleWorkspace();
  try {
    await open(server, dir);
    const { session } = await createSessionTurn(server);
    const turns = path.join(
      dir,
      ".digital-employee",
      "workbench",
      "sessions",
      "conversations",
      session.sessionId,
      "turns",
    );
    for (let offset = 0; offset < 257; offset += 64) {
      const count = Math.min(64, 257 - offset);
      await Promise.all(Array.from({ length: count }, (_, index) => {
        const serial = offset + index + 2000;
        return fs.writeFile(
          path.join(turns, `.stale-${serial}.json.${testUuid(serial)}.tmp`),
          "",
          { mode: 0o600 },
        );
      }));
    }
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
  } finally {
    await server.close();
  }
});

test("#112 reports: authoritative position files share one 64 MiB aggregate byte budget", async () => {
  const server = await startTestServer(undefined, new ReportsTurnDriver());
  const dir = await copyExampleWorkspace();
  try {
    await open(server, dir);
    await createSessionTurn(server);
    const positions = path.join(dir, ".digital-employee", "workbench", "sessions", "positions");
    for (let index = 0; index < 16; index += 1) {
      const temporary = path.join(
        positions,
        `.repo-owner.json.${testUuid(index + 3000)}.tmp`,
      );
      await fs.writeFile(temporary, "", { mode: 0o600 });
      await fs.truncate(temporary, 4 * 1024 * 1024);
    }
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
  } finally {
    await server.close();
  }
});

test("#112 reports: legacy and session conversations share one global conversation bound", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await writeTurn(dir, turn({ turnId: "legacy-bound-turn" }));
    const sessions = path.join(
      dir,
      ".digital-employee",
      "workbench",
      "sessions",
      "conversations",
    );
    await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
    for (let offset = 0; offset < 1024; offset += 64) {
      await Promise.all(Array.from({ length: 64 }, (_, index) =>
        fs.mkdir(path.join(sessions, testUuid(offset + index + 1000)), { mode: 0o700 })));
    }
    await open(server, dir);
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
  } finally {
    await server.close();
  }
});

test("reports: covers success, failure, indeterminate and budget refusal without exposing raw content", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    const failed = turn({
      status: "failed",
      error: { code: "position_budget_exceeded", message: "secret provider detail", retryable: false },
      events: [
        { type: "run.started", runId: "run-report", timestamp: "2026-08-24T06:00:00.000Z" },
        { type: "usage", runId: "run-report", timestamp: "2026-08-24T06:00:30.000Z", totalTokens: 30000 },
        { type: "run.failed", runId: "run-report", timestamp: "2026-08-24T06:01:00.000Z", error: { code: "position_budget_exceeded", message: "secret provider detail", retryable: false, terminalReason: "position_budget_exceeded" } },
      ],
      output: undefined,
    });
    const completed = turn({ turnId: "turn-completed", createdAt: "2026-08-24T05:00:00.000Z", updatedAt: "2026-08-24T05:01:00.000Z" });
    const indeterminate = turn({
      turnId: "turn-indeterminate",
      status: "indeterminate",
      createdAt: "2026-08-24T05:30:00.000Z",
      updatedAt: "2026-08-24T05:31:00.000Z",
      events: [{ type: "run.started", runId: "run-indeterminate", timestamp: "2026-08-24T05:30:00.000Z" }],
      runId: "run-indeterminate",
      output: undefined,
      error: { code: "turn_process_exit_1", message: "private diagnostic", retryable: false },
    });
    await writeTurn(dir, completed);
    await writeTurn(dir, indeterminate);
    await writeTurn(dir, failed);
    await open(server, dir);

    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 200);
    const body = response.body as ReportsResponse;
    assert.equal(body.streams.evidence.length, 3);
    const budgetEvidence = body.streams.evidence.find((item) => item.errorCode === "position_budget_exceeded");
    assert.deepEqual(budgetEvidence?.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 30000 });
    assert.deepEqual(new Set(body.streams.evidence.map((item) => item.status)), new Set(["completed", "failed", "indeterminate"]));
    for (const evidence of body.streams.evidence) {
      assert.equal("input" in (evidence as unknown as Record<string, unknown>), false);
      assert.equal("output" in (evidence as unknown as Record<string, unknown>), false);
      assert.equal("message" in (evidence as unknown as Record<string, unknown>), false);
    }
    assert.equal(body.streams.escalations.length, 2);
    assert.ok(body.streams.escalations.every((item) =>
      item.reportingChain.join("/") === "community-operator/repo-owner"));
    assert.equal(body.streams.escalations.find((item) => item.code === "position_budget_exceeded")?.budgetRelated, true);
    assert.equal(body.streams.escalations.find((item) => item.code === "turn_process_exit_1")?.budgetRelated, false);
    assert.equal(body.budgets.find((item) => item.positionId === "community-operator")?.state, "exceeded");
  } finally {
    await server.close();
  }
});

test("reports: corrupt audit or turn data fails closed with a stable public-safe error", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    const runtime = path.join(dir, ".digital-employee");
    await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(runtime, "org-audit.jsonl"), "{not-json}\n", { mode: 0o600 });
    await open(server, dir);
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
    assert.equal(JSON.stringify(response.body).includes(dir), false);
  } finally {
    await server.close();
  }
});

test("#112 reports: malformed UTF-8 in persisted input or output text fails closed", async (t) => {
  for (const field of ["input", "output"] as const) {
    await t.test(field, async () => {
      const server = await startTestServer();
      const dir = await copyExampleWorkspace();
      const marker = `malformed-${field}-marker`;
      try {
        const base = turn({ turnId: `malformed-utf8-${field}` });
        const record = field === "input"
          ? { ...base, input: marker }
          : {
              ...base,
              output: marker,
              events: base.events.map((event) =>
                event.type === "run.completed" ? { ...event, output: marker } : event),
            };
        await writeTurn(dir, record);
        const file = path.join(
          dir,
          ".digital-employee",
          "workbench",
          "conversations",
          record.positionId,
          "turns",
          `${record.turnId}.json`,
        );
        const payload = await fs.readFile(file);
        const markerBytes = Buffer.from(marker, "utf8");
        let markerOffset = payload.indexOf(markerBytes);
        let corruptedCount = 0;
        while (markerOffset !== -1) {
          payload[markerOffset] = 0xff;
          corruptedCount += 1;
          markerOffset = payload.indexOf(markerBytes, markerOffset + markerBytes.length);
        }
        assert.equal(corruptedCount, field === "input" ? 1 : 2, field);
        await fs.writeFile(file, payload, { mode: 0o600 });

        await open(server, dir);
        const response = await api(server.baseUrl, "/reports", { token: server.token });
        assert.equal(response.status, 500, field);
        assert.equal((response.body as { code: string }).code, "reports_data_invalid", field);
        const serialized = JSON.stringify(response.body);
        assert.equal(serialized.includes(marker), false, field);
        assert.equal(serialized.includes("�"), false, field);
      } finally {
        await server.close();
      }
    });
  }
});

test("#112 reports: legitimate Unicode persisted text remains valid and private", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    const base = turn({
      turnId: "legitimate-unicode-text",
      input: "合法输入：你好",
    });
    await writeTurn(dir, {
      ...base,
      output: "合法输出：完成 🚀",
      events: base.events.map((event) =>
        event.type === "run.completed" ? { ...event, output: "合法输出：完成 🚀" } : event),
    });
    await open(server, dir);
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 200);
    assert.equal((response.body as ReportsResponse).streams.evidence.length, 1);
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes("合法输入：你好"), false);
    assert.equal(serialized.includes("合法输出：完成 🚀"), false);
  } finally {
    await server.close();
  }
});

test("reports: malformed persisted turn events fail closed instead of becoming inferred metrics", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    const malformed = turn({ turnId: "turn-malformed" });
    await writeTurn(dir, malformed);
    const file = path.join(dir, ".digital-employee", "workbench", "conversations", malformed.positionId, "turns", `${malformed.turnId}.json`);
    await fs.writeFile(file, `${JSON.stringify({ ...malformed, events: [null] })}\n`, { mode: 0o600 });
    await open(server, dir);
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
    assert.equal(JSON.stringify(response.body).includes("sensitive raw input"), false);
  } finally {
    await server.close();
  }
});

test("reports: reversed persisted event timestamps fail closed instead of creating false chronology", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    const reversed = turn({
      turnId: "turn-reversed-time",
      events: [
        { type: "run.started", runId: "run-report", timestamp: "2026-08-24T06:00:00.000Z" },
        {
          type: "run.completed",
          runId: "run-report",
          timestamp: "2026-08-24T05:59:59.999Z",
          output: "sensitive raw output",
          terminalReason: "goal_met",
        },
      ],
    });
    await writeTurn(dir, reversed);
    await open(server, dir);
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
    assert.equal(JSON.stringify(response.body).includes("sensitive raw output"), false);
  } finally {
    await server.close();
  }
});

test("reports: nanosecond-reversed persisted events fail closed without truncation", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    const reversed = turn({
      turnId: "turn-reversed-nanoseconds",
      events: [
        {
          type: "run.started",
          runId: "run-report",
          timestamp: "2026-08-24T06:00:00.000000002Z",
        },
        {
          type: "run.completed",
          runId: "run-report",
          timestamp: "2026-08-24T06:00:00.000000001Z",
          output: "sensitive raw output",
          terminalReason: "goal_met",
        },
      ],
    });
    await writeTurn(dir, reversed);
    await open(server, dir);
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
    assert.equal(JSON.stringify(response.body).includes("sensitive raw output"), false);
  } finally {
    await server.close();
  }
});

test("reports: symlinked local report roots are rejected without reading outside the workspace", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  const outside = await fs.mkdtemp(path.join(dir, "..", "owb-report-outside-"));
  try {
    const workbench = path.join(dir, ".digital-employee", "workbench");
    await fs.mkdir(workbench, { recursive: true, mode: 0o700 });
    await fs.symlink(outside, path.join(workbench, "conversations"));
    await open(server, dir);
    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
  } finally {
    await server.close();
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("reports: rejects a valid workspace-external org audit symlink before reading it", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  const outside = path.join(path.dirname(dir), `owb-external-audit-${path.basename(dir)}.jsonl`);
  try {
    const runtime = path.join(dir, ".digital-employee");
    await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
    await fs.writeFile(outside, `${JSON.stringify({ ...audit(dir), message: "RAW_EXTERNAL_SENTINEL" })}\n`, { mode: 0o600 });
    await fs.symlink(outside, path.join(runtime, "org-audit.jsonl"));
    await open(server, dir);

    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
    assert.equal(JSON.stringify(response.body).includes("RAW_EXTERNAL_SENTINEL"), false);
  } finally {
    await server.close();
    await fs.rm(outside, { force: true });
  }
});

test("reports: projects ordinary org audits onto an exact allowlist and drops raw fields", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    const runtime = path.join(dir, ".digital-employee");
    await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(runtime, "org-audit.jsonl"), `${JSON.stringify({
      ...audit(dir),
      message: "RAW_AUDIT_SENTINEL",
      changes: { hired: [], moved: [], dismissed: [], budgetUpdated: [], message: "RAW_NESTED_SENTINEL" },
    })}\n`, { mode: 0o600 });
    await open(server, dir);

    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 200);
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes("RAW_AUDIT_SENTINEL"), false);
    assert.equal(serialized.includes("RAW_NESTED_SENTINEL"), false);
    const entry = (response.body as ReportsResponse).streams.audits[0] as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(entry).sort(), ["actor", "bootstrapped", "changes", "positionCount", "schemaVersion", "workspace", "at"].sort());
    assert.deepEqual(Object.keys(entry.changes as Record<string, unknown>).sort(), ["budgetUpdated", "dismissed", "hired", "moved"].sort());
  } finally {
    await server.close();
  }
});

test("reports: rejects an oversized org audit source", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    const runtime = path.join(dir, ".digital-employee");
    await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
    const file = path.join(runtime, "org-audit.jsonl");
    await fs.writeFile(file, "{}\n", { mode: 0o600 });
    await fs.truncate(file, 16 * 1024 * 1024 + 1);
    await open(server, dir);

    const response = await api(server.baseUrl, "/reports", { token: server.token });
    assert.equal(response.status, 500);
    assert.equal((response.body as { code: string }).code, "reports_data_invalid");
  } finally {
    await server.close();
  }
});

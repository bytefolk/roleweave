import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TurnRecord, WorkbenchSession } from "@roleweave/shared";
import { ContextCliAdapterClient } from "../src/context-export/adapter-cli.js";
import { ContextExportService, readContextExportState } from "../src/context-export/exporter.js";
import { splitCommand } from "../src/engine/probe.js";

const contextCommand = process.env.ORG_WORKBENCH_CONTEXT_E3_CLI;
if (process.env.ORG_WORKBENCH_REQUIRE_CONTEXT_E3 === "1" && contextCommand === undefined) {
  throw new Error("ORG_WORKBENCH_CONTEXT_E3_CLI is required for the pinned Context E3 lane");
}

test("pinned Context CLI ingests and reads back one durable turn through the public adapter", {
  skip: contextCommand === undefined,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owb-context-e3-"));
  const workspace = path.join(root, "workspace");
  const vault = path.join(root, "vault.db");
  await fs.mkdir(workspace, { mode: 0o700 });
  const runtimeToken = `runtime-${crypto.randomUUID()}`;
  const operatorToken = `operator-${crypto.randomUUID()}`;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CONTEXT_VAULT: vault,
    CONTEXT_RUNTIME_TOKEN: runtimeToken,
    CONTEXT_OPERATOR_TOKEN: operatorToken,
    CONTEXT_OPERATOR_TOKEN_SHA256: digest(operatorToken),
  };
  const sourceSession: WorkbenchSession = {
    schemaVersion: "workbench-session.v1",
    sessionId: crypto.randomUUID(),
    workspaceInstanceId: crypto.randomUUID(),
    positionId: "repo-owner",
    principal: "position.repo-owner",
    status: "active",
    rotatedFrom: null,
    rotatedTo: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    rotatedAt: null,
  };
  const turn: TurnRecord = {
    schemaVersion: "turn-record.v1",
    conversationId: sourceSession.sessionId,
    turnId: crypto.randomUUID(),
    positionId: sourceSession.positionId,
    engine: "qoder",
    status: "completed",
    input: "ProjectAtlas release gate",
    envelopeDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-08-24T00:00:01.000Z",
    updatedAt: "2026-08-24T00:00:02.000Z",
    events: [
      { type: "run.started", runId: "fixture-run", timestamp: "2026-08-24T00:00:01.000Z" },
      {
        type: "run.completed",
        runId: "fixture-run",
        timestamp: "2026-08-24T00:00:02.000Z",
        output: "CI is still required",
        terminalReason: "goal_met",
      },
    ],
    runId: "fixture-run",
    output: "CI is still required",
  };

  try {
    const now = Date.now();
    await executeContext(contextCommand!, "admin-grant", {
      scope: {
        workspaceId: sourceSession.workspaceInstanceId,
        positionId: sourceSession.positionId,
        principal: sourceSession.principal,
      },
      expiresAt: now + 300_000,
      tokenExpiresAt: now + 300_000,
    }, environment);

    const exporter = new ContextExportService(
      new ContextCliAdapterClient(contextCommand!, environment),
    );
    await exporter.enqueueCompletedTurn(workspace, sourceSession, turn);
    await exporter.waitForIdle();
    const state = await readContextExportState(workspace, sourceSession.sessionId, turn.turnId);
    assert.equal(state.status, "done");

    const bundle = await executeContext(contextCommand!, "recall", {
      maxItems: 32,
      maxBytes: 32 * 1024,
    }, environment) as { items: Array<{ kind: string; locator: string; text: string }> };
    const raw = bundle.items.filter((item) => item.kind === "raw_excerpt");
    assert.equal(raw.length, 2);
    assert.deepEqual(
      raw.map((item) => item.locator.split("/artifacts/")[0]).sort(),
      state.occurrences.map((item) => item.sourceLocator).sort(),
    );

    const replay = new ContextExportService(new ContextCliAdapterClient(contextCommand!, environment));
    await replay.enqueueCompletedTurn(workspace, sourceSession, turn);
    await replay.waitForIdle();
    const replayBundle = await executeContext(contextCommand!, "recall", {
      maxItems: 32,
      maxBytes: 32 * 1024,
    }, environment) as { items: Array<{ kind: string }> };
    assert.equal(replayBundle.items.filter((item) => item.kind === "raw_excerpt").length, 2);
    assert.doesNotMatch(JSON.stringify(state), /ProjectAtlas|CI is still|required|runtime-|operator-/);

    const wrongScopeSession = {
      ...sourceSession,
      sessionId: crypto.randomUUID(),
      workspaceInstanceId: crypto.randomUUID(),
    };
    const wrongScopeTurn = {
      ...turn,
      conversationId: wrongScopeSession.sessionId,
      turnId: crypto.randomUUID(),
    };
    const wrongScopeExporter = new ContextExportService(
      new ContextCliAdapterClient(contextCommand!, environment),
    );
    await wrongScopeExporter.enqueueCompletedTurn(workspace, wrongScopeSession, wrongScopeTurn);
    await wrongScopeExporter.waitForIdle();
    const wrongScopeState = await readContextExportState(
      workspace,
      wrongScopeSession.sessionId,
      wrongScopeTurn.turnId,
    );
    assert.equal(wrongScopeState.status, "failed");
    assert.equal(wrongScopeState.errorCode, "context_adapter_failed");

    await executeContext(contextCommand!, "admin-revoke-token", {}, environment);
    const revokedSession = { ...sourceSession, sessionId: crypto.randomUUID() };
    const revokedTurn = {
      ...turn,
      conversationId: revokedSession.sessionId,
      turnId: crypto.randomUUID(),
    };
    const revokedExporter = new ContextExportService(
      new ContextCliAdapterClient(contextCommand!, environment),
    );
    await revokedExporter.enqueueCompletedTurn(workspace, revokedSession, revokedTurn);
    await revokedExporter.waitForIdle();
    const revokedState = await readContextExportState(workspace, revokedSession.sessionId, revokedTurn.turnId);
    assert.equal(revokedState.status, "failed");
    assert.doesNotMatch(JSON.stringify(revokedState), /ProjectAtlas|CI is still|required|runtime-|operator-/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function digest(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function executeContext(
  command: string,
  adapterCommand: string,
  request: unknown,
  environment: NodeJS.ProcessEnv,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const { bin, prefix } = splitCommand(command);
    const child = spawn(bin, [...prefix, "adapter", adapterCommand], {
      stdio: ["pipe", "pipe", "pipe"],
      env: environment,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", () => reject(new Error("pinned context adapter could not be spawned")));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`pinned context adapter failed (${String(code)}): ${stderr.slice(0, 200)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as unknown);
      } catch {
        reject(new Error("pinned context adapter returned invalid JSON"));
      }
    });
    child.stdin.end(JSON.stringify(request), "utf8");
  });
}

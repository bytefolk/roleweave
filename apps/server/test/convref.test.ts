import assert from "node:assert/strict";
import test from "node:test";
import { routes, TURN_ENVELOPE_SCHEMA_VERSION, TURN_ENVELOPE_SCHEMA_VERSION_V1ALPHA2 } from "@roleweave/shared";
import type { GroupConversation, TurnEnvelope, TurnRecord, TurnRunDriver, TurnRunRequest, TurnRunResult, WorkbenchSession } from "@roleweave/shared";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";
import { createTurnEnvelope, isValidConversationRef } from "../src/turns/envelope.js";

async function openWorkspace(baseUrl: string, token: string, dir: string): Promise<void> {
  const opened = await api(baseUrl, "/workspace/open", {
    method: "POST",
    token,
    body: { path: dir },
  });
  assert.equal(opened.status, 200);
}

class CapturingTurnDriver implements TurnRunDriver {
  envelopes: TurnEnvelope[] = [];

  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    this.envelopes.push(request.envelope);
    const runId = "fake-run";
    const timestamp = new Date().toISOString();
    const events: TurnRunResult["events"] = [
      { type: "run.started", runId, timestamp },
      {
        type: "run.completed",
        runId,
        timestamp,
        output: "fake turn output",
        terminalReason: "goal_met",
      },
    ];
    for (const event of events) request.onEvent?.(event);
    return { status: "trusted", events, diagnostic: "" };
  }
}

test("envelope builder keeps v1 byte-exact and pairs v1alpha2 strictly (#63 AC-1)", async () => {
  const legacy = createTurnEnvelope({
    workspaceRef: "ws",
    positionId: "repo-owner",
    turnId: "turn-1",
    message: "hello",
  });
  assert.equal(legacy.schemaVersion, TURN_ENVELOPE_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(legacy).sort(), [
    "envelopeDigest",
    "input",
    "positionId",
    "schemaVersion",
    "turnId",
    "workspaceRef",
  ]);
  assert.equal("conversationRef" in legacy, false, "v1 must never carry the back-link");

  const upgraded = createTurnEnvelope({
    workspaceRef: "ws",
    positionId: "repo-owner",
    turnId: "turn-2",
    message: "hello",
    conversationRef: "conv-1",
  });
  assert.equal(upgraded.schemaVersion, TURN_ENVELOPE_SCHEMA_VERSION_V1ALPHA2);
  assert.equal(upgraded.conversationRef, "conv-1");
  assert.notEqual(upgraded.envelopeDigest, legacy.envelopeDigest, "back-link must ride the digest");

  assert.ok(isValidConversationRef("conv-1"));
  assert.equal(isValidConversationRef(""), false);
  assert.equal(isValidConversationRef("x".repeat(257)), false);
  assert.equal(isValidConversationRef(42), false);
  for (const bad of ["", "x".repeat(257)]) {
    assert.throws(
      () =>
        createTurnEnvelope({
          workspaceRef: "ws",
          positionId: "repo-owner",
          turnId: "turn-3",
          message: "hello",
          conversationRef: bad,
        }),
      /conversationRef must be a non-empty string no longer than 256 characters/,
    );
  }
});

test("bare personal turn stays turn-envelope.v1 without a back-link (#63 AC-1)", async () => {
  const turnDriver = new CapturingTurnDriver();
  const server = await startTestServer(undefined, turnDriver);
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const turn = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { input: "personal task", engine: "qoder", positionId: "repo-owner" },
    });
    assert.equal(turn.status, 200);
    assert.equal(turnDriver.envelopes.length, 1);
    const envelope = turnDriver.envelopes[0]!;
    assert.equal(envelope.schemaVersion, TURN_ENVELOPE_SCHEMA_VERSION);
    assert.equal("conversationRef" in envelope, false, "no-session personal turns keep v1 byte-exact");
    const record = (turn.body as TurnRecord);
    assert.equal(record.conversationRef, undefined);
  } finally {
    await server.close();
  }
});

test("session turn rides v1alpha2 with conversationRef == sessionId (#63 AC-3)", async () => {
  const turnDriver = new CapturingTurnDriver();
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
    const session = created.body as WorkbenchSession;

    const turn = await api(server.baseUrl, `/sessions/${session.sessionId}/turns`, {
      method: "POST",
      token: server.token,
      body: { input: "remember this decision", engine: "qoder" },
    });
    assert.equal(turn.status, 200);
    const envelope = turnDriver.envelopes[0]!;
    assert.equal(envelope.schemaVersion, TURN_ENVELOPE_SCHEMA_VERSION_V1ALPHA2);
    assert.equal(envelope.conversationRef, session.sessionId);
    const record = turn.body as TurnRecord;
    assert.equal(record.conversationRef, session.sessionId);
    assert.equal(record.groupRef, undefined, "session turns are not group turns");
  } finally {
    await server.close();
  }
});

test("group spawn rides v1alpha2 with conversationRef == groupRef; legacy groupRef records stay readable (#63 AC-2/AC-5)", async () => {
  const turnDriver = new CapturingTurnDriver();
  const server = await startTestServer(undefined, turnDriver);
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const created = await api(server.baseUrl, routes.groups, {
      method: "POST",
      token: server.token,
      body: { memberPositionIds: ["repo-owner", "release-engineer"] },
    });
    assert.equal(created.status, 201);
    const group = created.body as GroupConversation;

    const accepted = await api(server.baseUrl, `${routes.groups}/${group.conversationRef}/turns`, {
      method: "POST",
      token: server.token,
      body: { input: "release status?", engine: "qoder", mentions: ["repo-owner"] },
    });
    assert.equal(accepted.status, 202);

    // Background spawn: wait for the single mentioned member to settle.
    let record: TurnRecord | undefined;
    for (let attempt = 0; attempt < 100 && record === undefined; attempt += 1) {
      const history = await api(server.baseUrl, `${routes.turns}?positionId=repo-owner`, {
        token: server.token,
      });
      if (history.status !== 200) {
        throw new Error(`history GET failed: ${history.status} ${JSON.stringify(history.body)}`);
      }
      const candidate = (history.body as { turns: TurnRecord[] }).turns.find(
        (turn) => turn.groupRef === group.conversationRef && turn.status !== "running",
      );
      record = candidate;
      if (record === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(record, "spawned group turn must settle");

    const envelope = turnDriver.envelopes[0]!;
    assert.equal(envelope.schemaVersion, TURN_ENVELOPE_SCHEMA_VERSION_V1ALPHA2);
    assert.equal(envelope.conversationRef, group.conversationRef, "group spawn echoes the group ref");
    assert.equal(record.conversationRef, group.conversationRef, "dual-write keeps the back-link persisted");
    assert.equal(record.groupRef, group.conversationRef, "legacy tag survives the clearing window");

    // AC-5: a pre-clearing record carrying only groupRef must still surface.
    const legacyTurnId = "legacy-0001";
    await server.ctx.turnStore.begin({
      workspace,
      positionId: "repo-owner",
      turnId: legacyTurnId,
      message: "legacy group turn",
      engine: "qoder",
      envelopeDigest: `sha256:${"a".repeat(64)}`,
      now: new Date().toISOString(),
      groupRef: group.conversationRef,
    });
    const timeline = await api(server.baseUrl, `${routes.groups}/${group.conversationRef}/turns`, {
      token: server.token,
    });
    assert.equal(timeline.status, 200);
    const items = (timeline.body as { items: Array<{ kind: string; turn?: TurnRecord }> }).items;
    const memberTurns = items
      .filter((item) => item.kind === "member")
      .map((item) => item.turn)
      .filter((turn): turn is TurnRecord => turn !== undefined);
    assert.ok(memberTurns.some((turn) => turn.turnId === record!.turnId), "v1alpha2 record surfaces via back-link");
    assert.ok(memberTurns.some((turn) => turn.turnId === legacyTurnId), "legacy groupRef record surfaces via fallback");
  } finally {
    await server.close();
  }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { routes } from "@roleweave/shared";
import type {
  GroupConversation,
  GroupTimeline,
  TurnRecord,
  TurnRunDriver,
  WorkbenchSession,
  WorkbenchSessionList,
} from "@roleweave/shared";
import { api, assertPosixMode, connectSse, copyExampleWorkspace, startTestServer } from "./helpers.js";

async function openWorkspace(baseUrl: string, token: string, dir: string): Promise<void> {
  const opened = await api(baseUrl, "/workspace/open", {
    method: "POST",
    token,
    body: { path: dir },
  });
  assert.equal(opened.status, 200);
}

async function createGroup(
  baseUrl: string,
  token: string,
  members: string[] = ["repo-owner", "release-engineer"],
): Promise<GroupConversation> {
  const created = await api(baseUrl, routes.groups, {
    method: "POST",
    token,
    body: { memberPositionIds: members },
  });
  assert.equal(created.status, 201);
  return created.body as GroupConversation;
}

test("group create anchors a real session, persists 0o700/0o600 state, and lists/gets by ref", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const group = await createGroup(server.baseUrl, server.token);
    assert.equal(group.schemaVersion, "conversation-group.v1");
    assert.match(group.conversationRef, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.deepEqual(group.members, ["repo-owner", "release-engineer"]);
    assert.doesNotMatch(
      JSON.stringify(group),
      /owb-workspace-|Authorization|Bearer|TOKEN|API_KEY/,
    );

    // AC-004: the group is a real #14 session anchored on the first member.
    const sessions = await api(server.baseUrl, "/sessions?positionId=repo-owner", {
      token: server.token,
    });
    assert.equal(sessions.status, 200);
    const ids = (sessions.body as { sessions: Array<{ sessionId: string }> }).sessions.map(
      (session) => session.sessionId,
    );
    assert.ok(ids.includes(group.sessionId), "group must bind an existing session");

    // Storage discipline: dirs 0o700, records 0o600.
    const groupDir = path.join(workspace, ".digital-employee", "workbench", "groups", group.conversationRef);
    await assertPosixMode(groupDir, 0o700);
    await assertPosixMode(path.join(groupDir, "group.json"), 0o600);

    const listed = await api(server.baseUrl, routes.groups, { token: server.token });
    assert.equal(listed.status, 200);
    assert.equal((listed.body as GroupConversation & { groups: GroupConversation[] }).groups.length, 1);

    const fetched = await api(server.baseUrl, `${routes.groups}/${group.conversationRef}`, {
      token: server.token,
    });
    assert.equal(fetched.status, 200);
    assert.equal((fetched.body as GroupConversation).conversationRef, group.conversationRef);

    const missing = await api(server.baseUrl, `${routes.groups}/${"0".repeat(36)}`, {
      token: server.token,
    });
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { code: string }).code, "group_missing");

    const unsafeRef = await api(server.baseUrl, `${routes.groups}/..%2Fescape`, {
      token: server.token,
    });
    assert.equal(unsafeRef.status, 400);
    assert.equal((unsafeRef.body as { code: string }).code, "group_request_invalid");
  } finally {
    await server.close();
  }
});

test("group create reuses an already-active member session as its anchor (#116)", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const personal = await api(server.baseUrl, "/sessions", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner" },
    });
    assert.equal(personal.status, 201);
    const anchor = personal.body as WorkbenchSession;

    // AC-001: the create that used to answer 409 session_conflict now answers
    // 201 and binds the session the member already had.
    const created = await api(server.baseUrl, routes.groups, {
      method: "POST",
      token: server.token,
      body: { memberPositionIds: ["repo-owner", "release-engineer"] },
    });
    assert.equal(created.status, 201);
    const group = created.body as GroupConversation;
    assert.equal(group.sessionId, anchor.sessionId);

    // AC-002: reuse is read-only — one session, still active, untouched.
    const listed = await api(server.baseUrl, "/sessions?positionId=repo-owner", {
      token: server.token,
    });
    assert.equal(listed.status, 200);
    const state = listed.body as WorkbenchSessionList;
    assert.equal(state.activeSessionId, anchor.sessionId);
    assert.deepEqual(state.sessions.map((session) => session.sessionId), [anchor.sessionId]);
    assert.equal(state.sessions[0]?.status, "active");
    assert.equal(state.sessions[0]?.rotatedAt, null);
    assert.equal(state.sessions[0]?.rotatedTo, null);

    // AC-002: the member keeps reserving and completing work on that session.
    const turn = await api(server.baseUrl, `/sessions/${anchor.sessionId}/turns`, {
      method: "POST",
      token: server.token,
      body: { input: "still my personal session", engine: "qoder" },
    });
    assert.equal(turn.status, 200);
    const history = await api(server.baseUrl, `/sessions/${anchor.sessionId}/turns`, {
      token: server.token,
    });
    assert.equal((history.body as { turns: unknown[] }).turns.length, 1);

    // REQ-001/002 boundary: only the eager group anchor adopts an active
    // session. Asking for a new one still conflicts, rotation still required.
    const explicit = await api(server.baseUrl, "/sessions", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner" },
    });
    assert.equal(explicit.status, 409);
    assert.equal((explicit.body as { code: string }).code, "session_conflict");

    // Reuse must not mint a session per group, not even under concurrency.
    const second = await createGroup(server.baseUrl, server.token, ["repo-owner", "issue-researcher"]);
    assert.equal(second.sessionId, anchor.sessionId);
    const raced = await Promise.all([
      api(server.baseUrl, routes.groups, {
        method: "POST",
        token: server.token,
        body: { memberPositionIds: ["release-engineer", "repo-owner"] },
      }),
      api(server.baseUrl, routes.groups, {
        method: "POST",
        token: server.token,
        body: { memberPositionIds: ["release-engineer", "issue-researcher"] },
      }),
    ]);
    assert.deepEqual(raced.map((response) => response.status), [201, 201]);
    const racedIds = raced.map((response) => (response.body as GroupConversation).sessionId);
    assert.equal(new Set(racedIds).size, 1, "concurrent creates must not fork a second active session");
    const after = await api(server.baseUrl, "/sessions?positionId=release-engineer", { token: server.token });
    assert.equal((after.body as WorkbenchSessionList).sessions.length, 1);
  } finally {
    await server.close();
  }
});

test("group create validation fails closed before any persistence", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const bodies = [
      {},
      { memberPositionIds: ["repo-owner"] },
      { memberPositionIds: ["repo-owner", "repo-owner"] },
      { memberPositionIds: ["repo-owner", "../../escape"] },
      { memberPositionIds: ["repo-owner", "release-engineer"], extra: true },
      { memberPositionIds: ["repo-owner", "not-a-position"] },
    ];
    for (const body of bodies) {
      const response = await api(server.baseUrl, routes.groups, {
        method: "POST",
        token: server.token,
        body,
      });
      assert.ok([400, 404].includes(response.status), `${JSON.stringify(body)} → ${response.status}`);
    }
    const listed = await api(server.baseUrl, routes.groups, { token: server.token });
    assert.equal((listed.body as { groups: unknown[] }).groups.length, 0);
  } finally {
    await server.close();
  }
});

test("group addMember appends once and conflicts on duplicates", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const group = await createGroup(server.baseUrl, server.token);
    const added = await api(server.baseUrl, `${routes.groups}/${group.conversationRef}/members`, {
      method: "POST",
      token: server.token,
      body: { positionId: "issue-researcher" },
    });
    assert.equal(added.status, 200);
    assert.deepEqual((added.body as GroupConversation).members, [
      "repo-owner",
      "release-engineer",
      "issue-researcher",
    ]);
    const duplicate = await api(server.baseUrl, `${routes.groups}/${group.conversationRef}/members`, {
      method: "POST",
      token: server.token,
      body: { positionId: "issue-researcher" },
    });
    assert.equal(duplicate.status, 409);
    assert.equal((duplicate.body as { code: string }).code, "group_conflict");
    const missingPosition = await api(server.baseUrl, `${routes.groups}/${group.conversationRef}/members`, {
      method: "POST",
      token: server.token,
      body: { positionId: "not-a-position" },
    });
    assert.ok([400, 404].includes(missingPosition.status));
  } finally {
    await server.close();
  }
});

test("group turn answers 202 with pre-assigned spawns and persists per-member records tagged groupRef", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  const sse = connectSse(server.baseUrl, server.token);
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const group = await createGroup(server.baseUrl, server.token);

    const accepted = await api(server.baseUrl, `${routes.groups}/${group.conversationRef}/turns`, {
      method: "POST",
      token: server.token,
      body: { input: "release status?", engine: "qoder", mentions: ["repo-owner", "release-engineer"] },
    });
    assert.equal(accepted.status, 202);
    const acceptedBody = accepted.body as {
      conversationRef: string;
      messageId: string;
      spawns: Array<{ turnId: string; positionId: string }>;
    };
    assert.equal(acceptedBody.conversationRef, group.conversationRef);
    assert.equal(acceptedBody.spawns.length, 2);
    assert.deepEqual(
      acceptedBody.spawns.map((spawn) => spawn.positionId),
      ["repo-owner", "release-engineer"],
    );

    // Explicit routing attribution rides the shared SSE channel: one spawn
    // event per mentioned member, then terminals tagged for split/aggregate.
    const spawned = await sse.waitForEvent("group.turn.spawned");
    const spawnedPayload = (JSON.parse(spawned.data) as { payload: Record<string, unknown> }).payload;
    assert.equal(spawnedPayload.groupRef, group.conversationRef);
    assert.equal(spawnedPayload.messageId, acceptedBody.messageId);
    assert.equal(spawnedPayload.engine, "qoder");
    const completed = await sse.waitForEvent("turn.completed", 10000);
    const completedPayload = (JSON.parse(completed.data) as { payload: Record<string, unknown> }).payload;
    assert.equal(completedPayload.groupRef, group.conversationRef);
    assert.equal(completedPayload.messageId, acceptedBody.messageId);
    assert.equal(completedPayload.engine, "qoder");
    assert.ok(typeof completedPayload.turnId === "string" && completedPayload.turnId.length > 0);
    assert.ok(typeof completedPayload.positionId === "string");

    // Spawn execution is background; wait until both member records settle.
    const expectedTurnIds = new Set(acceptedBody.spawns.map((spawn) => spawn.turnId));
    const settled: TurnRecord[] = [];
    for (let attempt = 0; attempt < 100 && settled.length < 2; attempt += 1) {
      settled.length = 0;
      for (const positionId of ["repo-owner", "release-engineer"]) {
        const history = await api(server.baseUrl, `${routes.turns}?positionId=${positionId}`, {
          token: server.token,
        });
        const turn = (history.body as { turns: TurnRecord[] }).turns.find(
          (record) => record.groupRef === group.conversationRef,
        );
        if (turn !== undefined && turn.status !== "running") settled.push(turn);
      }
      if (settled.length < 2) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(settled.length, 2, "both mentioned members must persist a settled turn");
    for (const record of settled) {
      assert.equal(record.groupRef, group.conversationRef);
      assert.equal(record.status, "completed");
      assert.ok(expectedTurnIds.has(record.turnId), "spawn turnId must match the persisted record");
    }
    assert.doesNotMatch(JSON.stringify(settled), /owb-workspace-|Authorization|Bearer|TOKEN|API_KEY/);

    // Timeline merges the user echo and the member turns chronologically.
    const timeline = await api(server.baseUrl, `${routes.groups}/${group.conversationRef}/turns`, {
      token: server.token,
    });
    assert.equal(timeline.status, 200);
    const parsed = timeline.body as GroupTimeline;
    assert.equal(parsed.schemaVersion, "group-timeline.v1");
    assert.equal(parsed.items.filter((item) => item.kind === "user").length, 1);
    assert.equal(parsed.items.filter((item) => item.kind === "member").length, 2);
    const userItem = parsed.items.find((item) => item.kind === "user");
    assert.ok(userItem !== undefined && userItem.kind === "user");
    assert.equal(userItem.input, "release status?");
    assert.deepEqual(userItem.mentions, ["repo-owner", "release-engineer"]);
  } finally {
    sse.close();
    await server.close();
  }
});

test("group driver failure publishes indeterminate with the complete exact attribution", async () => {
  const failingDriver: TurnRunDriver = {
    async turnRun() {
      throw new Error("synthetic driver failure");
    },
  };
  const server = await startTestServer(undefined, failingDriver);
  const workspace = await copyExampleWorkspace();
  const sse = connectSse(server.baseUrl, server.token);
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const group = await createGroup(server.baseUrl, server.token);
    const accepted = await api(server.baseUrl, `${routes.groups}/${group.conversationRef}/turns`, {
      method: "POST",
      token: server.token,
      body: { input: "failure attribution", engine: "qoder", mentions: ["repo-owner"] },
    });
    assert.equal(accepted.status, 202);
    const body = accepted.body as {
      messageId: string;
      spawns: Array<{ turnId: string; positionId: string }>;
    };

    const indeterminate = await sse.waitForEvent("turn.indeterminate", 10000);
    const payload = (JSON.parse(indeterminate.data) as { payload: Record<string, unknown> }).payload;
    assert.deepEqual(
      {
        groupRef: payload.groupRef,
        conversationRef: payload.conversationRef,
        messageId: payload.messageId,
        turnId: payload.turnId,
        positionId: payload.positionId,
        engine: payload.engine,
      },
      {
        groupRef: group.conversationRef,
        conversationRef: group.conversationRef,
        messageId: body.messageId,
        turnId: body.spawns[0]!.turnId,
        positionId: "repo-owner",
        engine: "qoder",
      },
    );
  } finally {
    sse.close();
    await server.close();
  }
});

test("group turn validation rejects broadcast, non-members, and extra keys", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const group = await createGroup(server.baseUrl, server.token);
    const bodies = [
      { input: "hi", engine: "qoder", mentions: [] },
      { input: "hi", engine: "qoder", mentions: ["issue-researcher"] },
      { input: "hi", engine: "qoder", mentions: ["repo-owner", "repo-owner"] },
      { input: "", engine: "qoder", mentions: ["repo-owner"] },
      { input: "hi", engine: "nope", mentions: ["repo-owner"] },
      { input: "hi", engine: "qoder", mentions: ["repo-owner"], extra: true },
    ];
    for (const body of bodies) {
      const response = await api(server.baseUrl, `${routes.groups}/${group.conversationRef}/turns`, {
        method: "POST",
        token: server.token,
        body,
      });
      assert.equal(response.status, 400, `${JSON.stringify(body)} → ${response.status}`);
    }
    const notGroup = await api(server.baseUrl, `${routes.groups}/${"0".repeat(36)}/turns`, {
      method: "POST",
      token: server.token,
      body: { input: "hi", engine: "qoder", mentions: ["repo-owner"] },
    });
    assert.equal(notGroup.status, 404);
    assert.equal((notGroup.body as { code: string }).code, "group_missing");
  } finally {
    await server.close();
  }
});

test("corrupt or unsafe local group state fails closed without echoing content", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const group = await createGroup(server.baseUrl, server.token);
    const groupFile = path.join(
      workspace,
      ".digital-employee",
      "workbench",
      "groups",
      group.conversationRef,
      "group.json",
    );
    await fs.writeFile(groupFile, "{broken", { mode: 0o600 });
    const corrupt = await api(server.baseUrl, `${routes.groups}/${group.conversationRef}`, {
      token: server.token,
    });
    assert.equal(corrupt.status, 500);
    assert.equal((corrupt.body as { code: string }).code, "group_storage_failed");

    const tampered = { ...group, members: ["repo-owner"] };
    await fs.writeFile(groupFile, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    const invalid = await api(server.baseUrl, `${routes.groups}/${group.conversationRef}`, {
      token: server.token,
    });
    assert.equal(invalid.status, 500);
    assert.equal((invalid.body as { code: string }).code, "group_storage_failed");

    const secret = { ...group, sessionSecret: "group-secret-value" };
    await fs.writeFile(groupFile, `${JSON.stringify(secret)}\n`, { mode: 0o600 });
    const leaked = await api(server.baseUrl, routes.groups, { token: server.token });
    assert.equal(leaked.status, 500);
    assert.doesNotMatch(JSON.stringify(leaked.body), /group-secret-value/);

    await fs.rm(path.join(workspace, ".digital-employee", "workbench", "groups", group.conversationRef), { recursive: true });
    const real = path.join(workspace, ".digital-employee", "workbench", "groups", group.conversationRef);
    await fs.mkdir(real, { mode: 0o700 });
    await fs.writeFile(path.join(real, "group.json"), `${JSON.stringify(group)}\n`, { mode: 0o600 });
    await fs.rename(real, `${real}.real`);
    await fs.symlink(`${real}.real`, real);
    const symlinked = await api(server.baseUrl, `${routes.groups}/${group.conversationRef}`, {
      token: server.token,
    });
    assert.equal(symlinked.status, 500);
    assert.equal((symlinked.body as { code: string }).code, "group_storage_failed");
  } finally {
    await server.close();
  }
});

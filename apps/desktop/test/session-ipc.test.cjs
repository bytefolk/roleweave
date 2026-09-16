const assert = require("node:assert/strict");
const test = require("node:test");
const {
  sessionListPath,
  sessionPath,
  validateSessionCreateRequest,
  validateSessionTurnRequest,
} = require("../src/session-ipc.cjs");

const sessionId = "11111111-1111-4111-8111-111111111111";

test("session IPC accepts exact typed fields and never accepts authority data", () => {
  assert.deepEqual(validateSessionCreateRequest({ positionId: "repo-owner" }), {
    ok: true,
    request: { positionId: "repo-owner" },
  });
  assert.equal(validateSessionCreateRequest({ positionId: "repo-owner", principal: "admin" }).ok, false);
  assert.deepEqual(validateSessionTurnRequest({ sessionId, input: "ship", engine: "qoder" }), {
    ok: true,
    sessionId,
    request: { input: "ship", engine: "qoder" },
  });
  assert.equal(validateSessionTurnRequest({ sessionId, input: "ship", engine: "claude-local" }).ok, true);
  assert.equal(validateSessionTurnRequest({ sessionId, input: "ship", engine: "openai" }).ok, false);
  assert.equal(validateSessionTurnRequest({ sessionId, input: "ship", engine: "qoder", token: "secret" }).ok, false);
});

test("session IPC constructs only bounded enumerated paths", () => {
  assert.equal(sessionListPath("repo-owner"), "/sessions?positionId=repo-owner");
  assert.equal(sessionListPath("../../secret"), null);
  assert.equal(sessionPath(sessionId), `/sessions/${sessionId}`);
  assert.equal(sessionPath(sessionId, "/rotate"), `/sessions/${sessionId}/rotate`);
  assert.equal(sessionPath("../../secret", "/turns"), null);
});

test("session context IPC permits only the session id and explicit boolean", () => {
  const { validateSessionContextRequest } = require("../src/session-ipc.cjs");
  assert.deepEqual(validateSessionContextRequest({ sessionId, enabled: false }), { ok: true, sessionId, request: { enabled: false } });
  for (const value of [{ sessionId, enabled: "false" }, { sessionId: "../escape", enabled: true }, { sessionId, enabled: true, principal: "admin" }]) {
    assert.equal(validateSessionContextRequest(value).ok, false);
  }
});

test("group dispatch IPC forwards validated explicit modes and preserves recipient order", () => {
  const { validateGroupTurnRequest } = require("../src/group-ipc.cjs");
  const value = { conversationRef: "group-one", engine: "qoder", input: "draft then review", mentions: ["writer", "reviewer"], mode: "relay" };
  assert.deepEqual(validateGroupTurnRequest(value).request, { engine: "qoder", input: "draft then review", mentions: ["writer", "reviewer"], mode: "relay" });
  assert.deepEqual(
    validateGroupTurnRequest({ ...value, engines: { writer: "qoder", reviewer: "codex-local" } }).request,
    { engine: "qoder", engines: { writer: "qoder", reviewer: "codex-local" }, input: "draft then review", mentions: ["writer", "reviewer"], mode: "relay" },
  );
  assert.equal(validateGroupTurnRequest({ ...value, engines: { writer: "qoder" } }).ok, false);
  assert.equal(validateGroupTurnRequest({ ...value, engines: { writer: "qoder", reviewer: "invalid" } }).ok, false);
  assert.equal(validateGroupTurnRequest({ ...value, mode: "automatic" }).ok, false);
  assert.equal(validateGroupTurnRequest({ ...value, principal: "admin" }).ok, false);
});

test("session retry IPC forwards only a bounded server turn identity", () => {
  const retryOf = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(validateSessionTurnRequest({ sessionId, input: "try again", engine: "qoder", retryOf }), {
    ok: true, sessionId, request: { input: "try again", engine: "qoder", retryOf },
  });
  for (const invalid of ["", "../escape", "\\escape", "x".repeat(257), null, 7]) {
    assert.equal(validateSessionTurnRequest({ sessionId, input: "try again", engine: "qoder", retryOf: invalid }).ok, false);
  }
  assert.equal(validateSessionTurnRequest({ sessionId, input: "try again", engine: "qoder", retryOf, principal: "admin" }).ok, false);
});

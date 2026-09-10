const assert = require("node:assert/strict");
const test = require("node:test");
const { turnHistoryPath, validateCancelRequest, validateCreateTurnRequest } = require("../src/turn-ipc.cjs");

test("turn IPC accepts only the three contracted Hosts and exact request fields", () => {
  assert.deepEqual(validateCreateTurnRequest({
    positionId: "repo-owner",
    input: "ship the release",
    engine: "qoder",
  }), {
    ok: true,
    request: { positionId: "repo-owner", input: "ship the release", engine: "qoder" },
  });
  assert.equal(validateCreateTurnRequest({
    positionId: "repo-owner",
    input: "ship",
    engine: "claude-code",
  }).ok, true);
  assert.equal(validateCreateTurnRequest({
    positionId: "repo-owner",
    input: "ship",
    engine: "claude-local",
  }).ok, true);
  assert.equal(validateCreateTurnRequest({
    positionId: "repo-owner",
    input: "ship",
    engine: "openai",
  }).ok, false);
  assert.equal(validateCreateTurnRequest({
    positionId: "repo-owner",
    input: "ship",
    engine: "qoder",
    token: "must-never-cross-the-bridge",
  }).ok, false);
});

test("turn history IPC constructs only a bounded position query", () => {
  assert.equal(turnHistoryPath("repo-owner"), "/turns?positionId=repo-owner");
  assert.equal(turnHistoryPath("7x"), "/turns?positionId=7x");
  assert.equal(turnHistoryPath("a--b"), null);
  assert.equal(turnHistoryPath("a-"), null);
  assert.equal(turnHistoryPath("../../secret"), null);
  assert.equal(turnHistoryPath(""), null);
});

test("cancel IPC accepts exactly {positionId} with a bounded position id", () => {
  assert.deepEqual(validateCancelRequest({ positionId: "repo-owner" }), {
    ok: true,
    request: { positionId: "repo-owner" },
  });
  assert.equal(validateCancelRequest({}).ok, false);
  assert.equal(validateCancelRequest({ positionId: "repo-owner", reason: "x" }).ok, false);
  assert.equal(validateCancelRequest({ positionId: "../../secret" }).ok, false);
  assert.equal(validateCancelRequest({ positionId: "" }).ok, false);
  assert.equal(validateCancelRequest(null).ok, false);
  assert.equal(validateCancelRequest(["repo-owner"]).ok, false);
});

test("cancel IPC forwards only a bounded explicit owner and optional safe turn identity", () => {
  const request = { positionId: "repo-owner", workspacePath: "/workspace/A", turnId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  assert.deepEqual(validateCancelRequest(request), { ok: true, request });
  assert.equal(validateCancelRequest({ ...request, turnId: "old-turn" }).ok, true);
  assert.equal(validateCancelRequest({ positionId: request.positionId, workspacePath: request.workspacePath }).ok, true);
  for (const invalid of [
    { ...request, workspacePath: "" }, { ...request, workspacePath: " " },
    { ...request, workspacePath: "a\0b" }, { ...request, workspacePath: "界".repeat(1366) },
    { ...request, turnId: "../../turn" }, { ...request, turnId: "x".repeat(129) }, { ...request, turnId: undefined },
    { ...request, command: "not-allowed" }, { positionId: request.positionId, turnId: request.turnId },
  ]) assert.equal(validateCancelRequest(invalid).ok, false);
});

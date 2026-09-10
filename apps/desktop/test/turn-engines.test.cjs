const assert = require("node:assert/strict");
const test = require("node:test");
const { TURN_ENGINE_IDS, turnEngineMessage } = require("@roleweave/shared/turn-engines");
const { validateCreateTurnRequest } = require("../src/turn-ipc.cjs");
const { validateSessionTurnRequest } = require("../src/session-ipc.cjs");
const { validateGroupTurnRequest } = require("../src/group-ipc.cjs");

const SESSION_ID = "00000000-0000-4000-8000-000000000000";

/**
 * #206 regression: the three IPC validators each carried their own hardcoded
 * engine list, so an engine added to the shared contract was still rejected as
 * turn_engine_unsupported before the request could reach a route. Adding an id
 * to the contract without teaching every boundary about it must fail here.
 */
test("every contracted turn engine is accepted by all three IPC validators", () => {
  assert.ok(TURN_ENGINE_IDS.length >= 1, "the contract must list at least one engine");

  for (const engine of TURN_ENGINE_IDS) {
    assert.equal(
      validateCreateTurnRequest({ positionId: "repo-owner", input: "ship", engine }).ok,
      true,
      `personal turn IPC must accept ${engine}`,
    );
    assert.equal(
      validateSessionTurnRequest({ sessionId: SESSION_ID, input: "ship", engine }).ok,
      true,
      `session turn IPC must accept ${engine}`,
    );
    assert.equal(
      validateGroupTurnRequest({ conversationRef: "team-answer", input: "ship", engine, mentions: ["repo-owner"] }).ok,
      true,
      `group turn IPC must accept ${engine}`,
    );
  }
});

test("an engine outside the contract is still rejected at every IPC boundary", () => {
  for (const engine of ["openai", "codex-cli", "", "qoder "]) {
    assert.equal(
      validateCreateTurnRequest({ positionId: "repo-owner", input: "ship", engine }).ok,
      false,
      `personal turn IPC must reject ${JSON.stringify(engine)}`,
    );
    assert.equal(
      validateSessionTurnRequest({ sessionId: SESSION_ID, input: "ship", engine }).ok,
      false,
      `session turn IPC must reject ${JSON.stringify(engine)}`,
    );
    assert.equal(
      validateGroupTurnRequest({ conversationRef: "team-answer", input: "ship", engine, mentions: ["repo-owner"] }).ok,
      false,
      `group turn IPC must reject ${JSON.stringify(engine)}`,
    );
  }
});

test("the rejection message names the contracted engines", () => {
  const message = turnEngineMessage();
  for (const engine of TURN_ENGINE_IDS) {
    assert.ok(message.includes(engine), `${engine} must appear in the rejection message`);
  }
  assert.equal(turnEngineMessage(["a"]), "a");
  assert.equal(turnEngineMessage(["a", "b"]), "a or b");
  assert.equal(turnEngineMessage(["a", "b", "c"]), "a, b, or c");
});

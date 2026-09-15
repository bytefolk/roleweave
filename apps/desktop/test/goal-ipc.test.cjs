const assert = require("node:assert/strict");
const test = require("node:test");
const { goalPath, validateGoalId, validateGoalCreateRequest, validateGoalUpdateRequest } = require("../src/goal-ipc.cjs");

test("validateGoalCreateRequest accepts title and description", () => {
  const result = validateGoalCreateRequest({ title: "Ship v2", description: "Migrate all endpoints" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.request, { title: "Ship v2", description: "Migrate all endpoints" });
});

test("validateGoalCreateRequest accepts acceptanceCriteria", () => {
  const result = validateGoalCreateRequest({ title: "Ship v2", description: "Migrate", acceptanceCriteria: ["All tests pass", "Docs updated"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.request.acceptanceCriteria, ["All tests pass", "Docs updated"]);
});

test("validateGoalCreateRequest rejects missing title", () => {
  const result = validateGoalCreateRequest({ description: "No title" });
  assert.equal(result.ok, false);
});

test("validateGoalCreateRequest rejects empty title", () => {
  const result = validateGoalCreateRequest({ title: "  ", description: "Empty title" });
  assert.equal(result.ok, false);
});

test("validateGoalCreateRequest rejects extra keys", () => {
  const result = validateGoalCreateRequest({ title: "Ship", description: "Desc", unknown: true });
  assert.equal(result.ok, false);
});

test("validateGoalCreateRequest rejects non-array criteria", () => {
  const result = validateGoalCreateRequest({ title: "Ship", description: "Desc", acceptanceCriteria: "not array" });
  assert.equal(result.ok, false);
});

test("validateGoalCreateRequest rejects too many criteria", () => {
  const criteria = Array.from({ length: 17 }, (_, i) => `criterion ${i}`);
  const result = validateGoalCreateRequest({ title: "Ship", description: "Desc", acceptanceCriteria: criteria });
  assert.equal(result.ok, false);
});

test("validateGoalUpdateRequest accepts partial status update", () => {
  const result = validateGoalUpdateRequest({ status: "in_progress" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.request, { status: "in_progress" });
});

test("validateGoalUpdateRequest accepts title and health", () => {
  const result = validateGoalUpdateRequest({ title: "Updated", health: "on_track" });
  assert.equal(result.ok, true);
});

test("validateGoalUpdateRequest rejects empty object", () => {
  const result = validateGoalUpdateRequest({});
  assert.equal(result.ok, false);
});

test("validateGoalUpdateRequest rejects unknown keys", () => {
  const result = validateGoalUpdateRequest({ title: "OK", unknown: true });
  assert.equal(result.ok, false);
});

test("validateGoalUpdateRequest rejects invalid status", () => {
  const result = validateGoalUpdateRequest({ status: "invalid" });
  assert.equal(result.ok, false);
});

test("validateGoalUpdateRequest rejects invalid health", () => {
  const result = validateGoalUpdateRequest({ health: "invalid" });
  assert.equal(result.ok, false);
});

test("goalPath constructs correct path", () => {
  assert.equal(goalPath("abc-123"), "/goals/abc-123");
  assert.equal(goalPath("abc-123", "/turns"), "/goals/abc-123/turns");
});

test("goalPath rejects invalid goalId", () => {
  assert.equal(goalPath(""), null);
  assert.equal(goalPath("has space"), null);
  assert.equal(goalPath("a".repeat(129)), null);
});

test("validateGoalId accepts valid IDs", () => {
  assert.equal(validateGoalId("abc-123"), true);
  assert.equal(validateGoalId("ABC_def"), true);
});

test("validateGoalId rejects invalid IDs", () => {
  assert.equal(validateGoalId(""), false);
  assert.equal(validateGoalId("has space"), false);
  assert.equal(validateGoalId(null), false);
  assert.equal(validateGoalId(123), false);
});

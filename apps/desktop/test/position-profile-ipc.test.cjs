const assert = require("node:assert/strict");
const test = require("node:test");
const { validatePositionProfileRequest } = require("../src/position-profile-ipc.cjs");

const PERMISSIONS = {
  tools: ["Read", "Grep", "Glob"],
  rules: [{ scope: "position", resource: "./knowledge/**", actions: ["read"] }],
  skills: [{ id: "docs-review" }],
  mcpServers: [{ id: "issue-tracker", tools: ["search"] }],
};

test("profile IPC accepts a name-only, mode-only or permissions-only patch", () => {
  assert.deepEqual(
    validatePositionProfileRequest({ positionId: "docs-writer", name: "文档工程师" }),
    { ok: true, request: { positionId: "docs-writer", name: "文档工程师" } },
  );
  assert.equal(validatePositionProfileRequest({ positionId: "docs-writer", mode: "read_only" }).ok, true);
  assert.equal(validatePositionProfileRequest({ positionId: "docs-writer", permissions: PERMISSIONS }).ok, true);
  assert.equal(
    validatePositionProfileRequest({ positionId: "docs-writer", name: "A", mode: "approval_required", permissions: { tools: ["Read"], rules: [] } }).ok,
    true,
  );
  // Exactly at the server's UTF-8 byte bound.
  assert.equal(validatePositionProfileRequest({ positionId: "docs-writer", name: "名".repeat(42) }).ok, true);
});

test("profile IPC fails closed on malformed patches and never echoes the id into the body", () => {
  const cases = [
    [null, "not an object"],
    [[], "array"],
    [{ positionId: "docs-writer" }, "empty patch"],
    [{ positionId: "docs-writer", name: "" }, "empty name"],
    [{ positionId: "docs-writer", name: "   " }, "blank name"],
    [{ positionId: "docs-writer", name: "名".repeat(43) }, "name over 128 bytes"],
    [{ positionId: "docs-writer", name: 7 }, "non-string name"],
    [{ positionId: "docs-writer", mode: "autonomous" }, "unknown mode"],
    [{ positionId: "Docs-Writer", name: "A" }, "position id outside the contract"],
    [{ positionId: "a--b", name: "A" }, "malformed position id"],
    [{ positionId: "", name: "A" }, "empty position id"],
    [{ positionId: "docs-writer", description: "smuggled" }, "field the surface does not own"],
    [{ positionId: "docs-writer", budget: { perDay: { tokens: 1 } } }, "budget must stay on its own channel"],
    [{ positionId: "docs-writer", name: "A", permissions: [] }, "permissions must be an object"],
    [{ positionId: "docs-writer", permissions: { token: "x" } }, "unknown permissions key"],
    [{ positionId: "docs-writer", permissions: { tools: "Read" } }, "tools must be an array"],
    [{ positionId: "docs-writer", permissions: { tools: [""] } }, "empty tool name"],
    [{ positionId: "docs-writer", permissions: { tools: new Array(33).fill("Read") } }, "too many tools"],
    [{ positionId: "docs-writer", permissions: { tools: ["Read"], rules: [{ scope: "galaxy", resource: "./x", actions: ["read"] }] } }, "unknown scope"],
    [{ positionId: "docs-writer", permissions: { tools: ["Read"], rules: [{ scope: "position", resource: "", actions: ["read"] }] } }, "empty resource"],
    [{ positionId: "docs-writer", permissions: { tools: ["Read"], rules: [{ scope: "position", resource: "./x", actions: [] }] } }, "empty actions"],
    [{ positionId: "docs-writer", permissions: { tools: ["Read"], rules: [{ scope: "position", resource: "./x", actions: ["teleport"] }] } }, "unknown action"],
    [{ positionId: "docs-writer", permissions: { tools: ["Read"], rules: [{ scope: "position", resource: "./x", actions: ["read"], effect: "maybe" }] } }, "unknown effect"],
    [{ positionId: "docs-writer", permissions: { tools: ["Read"], rules: [{ scope: "position", resource: "./x", actions: ["read"], approval: "yes" }] } }, "non-boolean approval"],
    [{ positionId: "docs-writer", permissions: { tools: ["Read"], rules: [], skills: [{ id: 1 }] } }, "non-string Skill id"],
    [{ positionId: "docs-writer", permissions: { tools: ["Read"], rules: [], mcpServers: [{ id: "x", tools: "search" }] } }, "MCP tools must be an array"],
  ];
  for (const [candidate, label] of cases) {
    const result = validatePositionProfileRequest(candidate);
    assert.equal(result.ok, false, label);
    assert.equal(result.response.status, 400, label);
    assert.equal(result.response.body.code, "position_profile_invalid", label);
    assert.equal(result.response.body.retryable, false, label);
  }
});

test("profile IPC forwards the patch verbatim and leaves catalog membership to the control plane", () => {
  const candidate = { positionId: "docs-writer", name: "文档工程师", mode: "approval_required", permissions: PERMISSIONS };
  const result = validatePositionProfileRequest(candidate);
  assert.equal(result.ok, true);
  // Identity, not a copy: the renderer's object must reach the request untouched.
  assert.equal(result.request, candidate);
  // An unregistered Skill or MCP id is structurally valid here on purpose. The
  // bridge does not own the catalogs, and a second copy of them would drift.
  assert.equal(
    validatePositionProfileRequest({ positionId: "docs-writer", permissions: { tools: ["Read"], rules: [], skills: [{ id: "ghost-skill" }] } }).ok,
    true,
  );
});

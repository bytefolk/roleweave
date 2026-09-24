const assert = require("node:assert/strict");
const test = require("node:test");
const {
  validateDocsCreateRequest,
  validateDocsDeleteRequest,
  validateDocsListRequest,
  validateDocsPathRequest,
  validateDocsReadRequest,
  validateDocsRenameRequest,
  validateDocsResolveRequest,
  validateDocsWriteRequest,
} = require("../src/docs-ipc.cjs");

test("docs list IPC bounds the position id and encodes the contract route (#35 S2)", () => {
  const ok = validateDocsListRequest("repo-owner");
  assert.equal(ok.ok, true);
  assert.equal(ok.pathname, "/docs/list?position=repo-owner");

  for (const bad of ["", 42, null, undefined, { positionId: "repo-owner" }]) {
    const invalid = validateDocsListRequest(bad);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.response.body.code, "docs_request_invalid");
  }
});

test("docs read IPC forwards both arguments encoded and refuses empty input (#35 S2)", () => {
  const ok = validateDocsReadRequest("repo-owner", "knowledge/README.md");
  assert.equal(ok.ok, true);
  assert.equal(ok.pathname, "/docs/read?position=repo-owner&path=knowledge%2FREADME.md");

  const missingPath = validateDocsReadRequest("repo-owner", "");
  assert.equal(missingPath.ok, false);
  assert.equal(missingPath.response.body.message, "filePath required");

  const missingPosition = validateDocsReadRequest("", "SKILL.md");
  assert.equal(missingPosition.ok, false);
  assert.equal(missingPosition.response.body.message, "positionId required");

  // Traversal attempts pass through only encoded — the server guards decide.
  const traversal = validateDocsReadRequest("repo-owner", "../../workspace.json");
  assert.equal(traversal.ok, true);
  assert.equal(
    traversal.pathname,
    "/docs/read?position=repo-owner&path=..%2F..%2Fworkspace.json",
  );
});

test("docs create IPC bounds the exactKeys create shape (#35 S4)", () => {
  const ok = validateDocsCreateRequest({ positionId: "repo-owner", path: "notes.md", content: "" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.request, { positionId: "repo-owner", path: "notes.md", content: "" });

  for (const bad of [
    null,
    "notes.md",
    [],
    { positionId: "repo-owner", path: "notes.md" },
    { positionId: "repo-owner", path: "notes.md", content: "", evil: true },
    { positionId: "", path: "notes.md", content: "" },
    { positionId: "repo-owner", path: "", content: "" },
    { positionId: "repo-owner", path: "notes.md", content: 42 },
  ]) {
    const invalid = validateDocsCreateRequest(bad);
    assert.equal(invalid.ok, false, `must refuse ${JSON.stringify(bad)}`);
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.response.body.code, "docs_request_invalid");
  }
});

test("docs resolve IPC bounds the doc-ref envelope (#35 S4)", () => {
  const ok = validateDocsResolveRequest({ ref: { uri: "owb-doc://repo-owner/SKILL.md", version: "2026-08-27T00:00:00.000Z" } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.request, { ref: { uri: "owb-doc://repo-owner/SKILL.md", version: "2026-08-27T00:00:00.000Z" } });

  for (const bad of [
    null,
    { uri: "owb-doc://repo-owner/SKILL.md" },
    { ref: "owb-doc://repo-owner/SKILL.md" },
    { ref: { uri: "" } },
    { ref: { uri: "owb-doc://repo-owner/SKILL.md", evil: true } },
    { ref: { uri: "owb-doc://repo-owner/SKILL.md" }, extra: true },
  ]) {
    const invalid = validateDocsResolveRequest(bad);
    assert.equal(invalid.ok, false, `must refuse ${JSON.stringify(bad)}`);
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.response.body.code, "docs_request_invalid");
  }
});

test("docs list IPC encodes the archived query (#347)", () => {
  const archived = validateDocsListRequest("repo-owner", { archived: true });
  assert.equal(archived.ok, true);
  assert.equal(archived.pathname, "/docs/list?position=repo-owner&archived=1");
});

test("docs write/rename/archive/restore/delete IPC bound exactKeys (#347)", () => {
  const write = validateDocsWriteRequest({
    positionId: "repo-owner",
    path: "knowledge/README.md",
    content: "edited",
  });
  assert.equal(write.ok, true);

  const rename = validateDocsRenameRequest({
    positionId: "repo-owner",
    from: "knowledge/README.md",
    to: "knowledge/handbook.md",
  });
  assert.equal(rename.ok, true);
  assert.deepEqual(rename.request, {
    positionId: "repo-owner",
    from: "knowledge/README.md",
    to: "knowledge/handbook.md",
  });

  const archive = validateDocsPathRequest({ positionId: "repo-owner", path: "knowledge/README.md" });
  assert.equal(archive.ok, true);

  const deleted = validateDocsDeleteRequest({
    positionId: "repo-owner",
    path: "knowledge/README.md",
    archived: true,
  });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.request.archived, true);

  for (const bad of [
    { positionId: "repo-owner", path: "knowledge/README.md", evil: true },
    { positionId: "", path: "knowledge/README.md" },
    null,
  ]) {
    assert.equal(validateDocsPathRequest(bad).ok, false);
    assert.equal(validateDocsDeleteRequest(bad).ok, false);
  }
});

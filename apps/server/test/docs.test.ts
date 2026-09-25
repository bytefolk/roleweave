import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ASSET_RECORD_SCHEMA_VERSION,
  DOCS_ARCHIVE_SCHEMA_VERSION,
  DOCS_CREATE_SCHEMA_VERSION,
  DOCS_DELETE_SCHEMA_VERSION,
  DOCS_FILE_LIST_SCHEMA_VERSION,
  DOCS_FILE_SCHEMA_VERSION,
  DOCS_RENAME_SCHEMA_VERSION,
  DOCS_RESOLVE_SCHEMA_VERSION,
  DOCS_RESTORE_SCHEMA_VERSION,
  formatDocRefUri,
  parseAssetRecord,
  parseDocRef,
  routes,
} from "@roleweave/shared";
import type {
  DocsArchiveResponse,
  DocsCreateResponse,
  DocsDeleteResponse,
  DocsFileListResponse,
  DocsFileResponse,
  DocsRenameResponse,
  DocsResolveResponse,
  DocsRestoreResponse,
} from "@roleweave/shared";
import { api, assertPosixMode, copyExampleWorkspace, startTestServer } from "./helpers.js";

async function openWorkspace(baseUrl: string, token: string, dir: string): Promise<void> {
  const opened = await api(baseUrl, routes.workspaceOpen, {
    method: "POST",
    token,
    body: { path: dir },
  });
  assert.equal(opened.status, 200);
}

test("docs routing lists position files deterministically and reads them with file-level version (#35 S2)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, dir);

    const list = await api(server.baseUrl, `${routes.docsList}?position=repo-owner`, { token: server.token });
    assert.equal(list.status, 200);
    const listed = list.body as DocsFileListResponse;
    assert.equal(listed.schemaVersion, DOCS_FILE_LIST_SCHEMA_VERSION);
    assert.equal(listed.positionId, "repo-owner");
    const paths = listed.files.map((entry) => entry.path);
    assert.ok(paths.includes("SKILL.md"), `expected SKILL.md in ${paths.join(", ")}`);
    assert.ok(paths.includes("knowledge/README.md"), "expected nested knowledge/README.md");
    assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b)), "listing must be deterministic");

    const read = await api(server.baseUrl, `${routes.docsRead}?position=repo-owner&path=SKILL.md`, {
      token: server.token,
    });
    assert.equal(read.status, 200);
    const doc = read.body as DocsFileResponse;
    assert.equal(doc.schemaVersion, DOCS_FILE_SCHEMA_VERSION);
    assert.equal(doc.path, "SKILL.md");
    assert.ok(doc.content.length > 0, "SKILL.md must not be served empty");
    assert.match(doc.version, /^\d{4}-\d{2}-\d{2}T/, "file-level version is an ISO mtime");
    assert.equal(doc.version, doc.modifiedAt);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("docs routing follows nested position package bindings (#35 S2)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, dir);

    const list = await api(server.baseUrl, `${routes.docsList}?position=issue-researcher`, {
      token: server.token,
    });
    assert.equal(list.status, 200);
    const listed = list.body as DocsFileListResponse;
    assert.equal(listed.positionId, "issue-researcher");
    assert.ok(listed.files.some((entry) => entry.path === "SKILL.md"));
    assert.ok(listed.files.some((entry) => entry.path === "knowledge/README.md"));

    const read = await api(
      server.baseUrl,
      `${routes.docsRead}?position=issue-researcher&path=SKILL.md`,
      { token: server.token },
    );
    assert.equal(read.status, 200);
    assert.equal((read.body as DocsFileResponse).path, "SKILL.md");
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("docs routing refuses escapes, symlinks, hidden segments, and non-allowlisted extensions (#35 S2)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  const positionDir = path.join(dir, "positions", "repo-owner");
  try {
    await fs.writeFile(path.join(dir, "outside-secret.md"), "must never be served\n");
    await fs.writeFile(path.join(positionDir, "binary.bin"), Buffer.from([0x00, 0x01]));
    await fs.symlink(path.join(dir, "outside-secret.md"), path.join(positionDir, "linked.md"));

    await openWorkspace(server.baseUrl, server.token, dir);

    const escape = await api(
      server.baseUrl,
      `${routes.docsRead}?position=repo-owner&path=${encodeURIComponent("../../outside-secret.md")}`,
      { token: server.token },
    );
    assert.equal(escape.status, 403);
    assert.equal((escape.body as { code: string }).code, "docs_forbidden");

    const symlink = await api(server.baseUrl, `${routes.docsRead}?position=repo-owner&path=linked.md`, {
      token: server.token,
    });
    assert.equal(symlink.status, 403);
    assert.equal((symlink.body as { code: string }).code, "docs_forbidden");

    const hidden = await api(server.baseUrl, `${routes.docsRead}?position=repo-owner&path=./SKILL.md`, {
      token: server.token,
    });
    assert.equal(hidden.status, 200, "plain relative paths stay routable");

    const binary = await api(server.baseUrl, `${routes.docsRead}?position=repo-owner&path=binary.bin`, {
      token: server.token,
    });
    assert.equal(binary.status, 403);
    assert.equal((binary.body as { code: string }).code, "docs_forbidden");

    const list = await api(server.baseUrl, `${routes.docsList}?position=repo-owner`, { token: server.token });
    const listed = list.body as DocsFileListResponse;
    assert.ok(!listed.files.some((entry) => entry.path === "linked.md"), "symlinks never appear in listings");
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("docs routing fails closed on missing files, positions, and closed workspaces (#35 S2)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    const closed = await api(server.baseUrl, `${routes.docsList}?position=repo-owner`, { token: server.token });
    assert.equal(closed.status, 422);
    assert.equal((closed.body as { code: string }).code, "workspace_not_open");

    await openWorkspace(server.baseUrl, server.token, dir);

    const missingFile = await api(server.baseUrl, `${routes.docsRead}?position=repo-owner&path=no-such.md`, {
      token: server.token,
    });
    assert.equal(missingFile.status, 404);
    assert.equal((missingFile.body as { code: string }).code, "docs_missing");

    const missingPosition = await api(server.baseUrl, `${routes.docsList}?position=ghost-role`, {
      token: server.token,
    });
    assert.equal(missingPosition.status, 404);
    assert.equal((missingPosition.body as { code: string }).code, "position_missing");

    const badParam = await api(server.baseUrl, routes.docsRead, { token: server.token });
    assert.equal(badParam.status, 400);
    assert.equal((badParam.body as { code: string }).code, "docs_request_invalid");
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("docs create lands a 0600 file and registers an asset-record.v1 with the frozen doc-ref (#35 S4)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, dir);

    const created = await api(server.baseUrl, routes.docsCreate, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "notes/runbook.md", content: "# Runbook\n" },
    });
    assert.equal(created.status, 201);
    const body = created.body as DocsCreateResponse;
    assert.equal(body.schemaVersion, DOCS_CREATE_SCHEMA_VERSION);
    assert.equal(body.positionId, "repo-owner");
    assert.equal(body.path, "notes/runbook.md");
    assert.match(body.version, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(body.size > 0, "created doc reports its landed size");
    assert.match(body.assetId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const file = path.join(dir, "positions", "repo-owner", "notes", "runbook.md");
    await assertPosixMode(file, 0o600);
    assert.equal(await fs.readFile(file, "utf8"), "# Runbook\n");

    const recordRaw = JSON.parse(
      await fs.readFile(
        path.join(dir, ".roleweave", "drive", "assets", body.assetId, "record.json"),
        "utf8",
      ),
    ) as unknown;
    const parsed = parseAssetRecord(recordRaw);
    assert.ok(parsed.ok, `asset record must satisfy asset-record.v1 exactKeys: ${parsed.message ?? ""}`);
    assert.equal(parsed.record?.schemaVersion, ASSET_RECORD_SCHEMA_VERSION);
    assert.equal(parsed.record?.assetId, body.assetId);
    assert.equal(parsed.record?.kind, "doc");
    assert.equal(parsed.record?.title, "runbook.md");
    assert.deepEqual(parsed.record?.sourceRef, { positionId: "repo-owner" });
    assert.equal(parsed.record?.docRef?.uri, formatDocRefUri("repo-owner", "notes/runbook.md"));
    assert.equal(parsed.record?.docRef?.version, body.version);

    const indexRaw = JSON.parse(
      await fs.readFile(path.join(dir, ".roleweave", "drive", "assets", "asset-index.json"), "utf8"),
    ) as { assets: Array<{ assetId: string }> };
    assert.ok(indexRaw.assets.some((entry) => entry.assetId === body.assetId), "index ledger carries the new asset");

    const list = await api(server.baseUrl, `${routes.docsList}?position=repo-owner`, { token: server.token });
    const listed = list.body as DocsFileListResponse;
    assert.ok(listed.files.some((entry) => entry.path === "notes/runbook.md"), "created doc appears in the listing");
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("docs create never overwrites and rejects unsafe shapes (#35 S4)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, dir);

    const first = await api(server.baseUrl, routes.docsCreate, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "notes.md", content: "original\n" },
    });
    assert.equal(first.status, 201);

    const again = await api(server.baseUrl, routes.docsCreate, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "notes.md", content: "overwrite attempt\n" },
    });
    assert.equal(again.status, 409);
    assert.equal((again.body as { code: string }).code, "docs_exists");
    assert.equal(
      await fs.readFile(path.join(dir, "positions", "repo-owner", "notes.md"), "utf8"),
      "original\n",
      "creation never overwrites",
    );

    const extraKey = await api(server.baseUrl, routes.docsCreate, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "x.md", content: "", evil: true },
    });
    assert.equal(extraKey.status, 400);
    assert.equal((extraKey.body as { code: string }).code, "docs_request_invalid");

    const badExtension = await api(server.baseUrl, routes.docsCreate, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "payload.bin", content: "x" },
    });
    assert.equal(badExtension.status, 400);
    assert.equal((badExtension.body as { code: string }).code, "docs_request_invalid");

    const escape = await api(server.baseUrl, routes.docsCreate, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "../outside.md", content: "x" },
    });
    assert.equal(escape.status, 400);
    assert.equal((escape.body as { code: string }).code, "docs_request_invalid");

    const hidden = await api(server.baseUrl, routes.docsCreate, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: ".secret.md", content: "x" },
    });
    assert.equal(hidden.status, 400);
    assert.equal((hidden.body as { code: string }).code, "docs_request_invalid");

    const ghost = await api(server.baseUrl, routes.docsCreate, {
      method: "POST",
      token: server.token,
      body: { positionId: "ghost-role", path: "x.md", content: "" },
    });
    assert.equal(ghost.status, 404);
    assert.equal((ghost.body as { code: string }).code, "position_missing");
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("docs resolve answers the deterministic three states of doc-ref.v1alpha1 (#35 S4)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, dir);

    const present = await api(server.baseUrl, routes.docsResolve, {
      method: "POST",
      token: server.token,
      body: { ref: { uri: formatDocRefUri("repo-owner", "SKILL.md") } },
    });
    assert.equal(present.status, 200);
    const resolved = present.body as DocsResolveResponse;
    assert.equal(resolved.schemaVersion, DOCS_RESOLVE_SCHEMA_VERSION);
    assert.equal(resolved.resolved.positionId, "repo-owner");
    assert.equal(resolved.resolved.path, "SKILL.md");
    assert.ok(resolved.resolved.size > 0);
    assert.match(resolved.resolved.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);

    const missing = await api(server.baseUrl, routes.docsResolve, {
      method: "POST",
      token: server.token,
      body: { ref: { uri: formatDocRefUri("repo-owner", "no-such.md") } },
    });
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { code: string }).code, "docs_missing");

    const ghostPosition = await api(server.baseUrl, routes.docsResolve, {
      method: "POST",
      token: server.token,
      body: { ref: { uri: formatDocRefUri("ghost-role", "SKILL.md") } },
    });
    assert.equal(ghostPosition.status, 404);
    assert.equal((ghostPosition.body as { code: string }).code, "docs_missing");

    const badScheme = await api(server.baseUrl, routes.docsResolve, {
      method: "POST",
      token: server.token,
      body: { ref: { uri: "https://example.com/SKILL.md" } },
    });
    assert.equal(badScheme.status, 400);
    assert.equal((badScheme.body as { code: string }).code, "doc_ref_invalid");

    const extraKey = await api(server.baseUrl, routes.docsResolve, {
      method: "POST",
      token: server.token,
      body: { ref: { uri: formatDocRefUri("repo-owner", "SKILL.md"), evil: true } },
    });
    assert.equal(extraKey.status, 400);
    assert.equal((extraKey.body as { code: string }).code, "doc_ref_invalid");

    const hiddenSegment = await api(server.baseUrl, routes.docsResolve, {
      method: "POST",
      token: server.token,
      body: { ref: { uri: "owb-doc://repo-owner/.hidden.md" } },
    });
    assert.equal(hiddenSegment.status, 400);
    assert.equal((hiddenSegment.body as { code: string }).code, "doc_ref_invalid");

    const badBody = await api(server.baseUrl, routes.docsResolve, {
      method: "POST",
      token: server.token,
      body: { wrong: true },
    });
    assert.equal(badBody.status, 400);
    assert.equal((badBody.body as { code: string }).code, "docs_request_invalid");
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("parseDocRef is three-state-safe against the frozen doc-ref.v1alpha1 shape (#35 S4)", () => {
  const ok = parseDocRef({ uri: "owb-doc://repo-owner/knowledge/README.md", anchor: "intro", version: "2026-08-27T00:00:00.000Z" });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.ref.uri, "owb-doc://repo-owner/knowledge/README.md");
    assert.equal(ok.ref.anchor, "intro");
    assert.equal(ok.ref.version, "2026-08-27T00:00:00.000Z");
  }

  const minimal = parseDocRef({ uri: "owb-doc://repo-owner/SKILL.md" });
  assert.ok(minimal.ok);

  for (const bad of [
    null,
    "owb-doc://repo-owner/SKILL.md",
    {},
    { uri: "https://elsewhere/SKILL.md" },
    { uri: "owb-doc://repo-owner/SKILL.md", evil: true },
    { uri: "owb-doc://UPPER CASE/SKILL.md" },
    { uri: "owb-doc://repo-owner/.hidden.md" },
    { uri: "owb-doc://repo-owner/../escape.md" },
    { uri: "owb-doc://repo-owner/SKILL.md", anchor: "#not-anchor" },
    { uri: "owb-doc://repo-owner/SKILL.md", version: "" },
  ]) {
    const result = parseDocRef(bad);
    assert.equal(result.ok, false, `must reject ${JSON.stringify(bad)}`);
    if (!result.ok) assert.equal(result.code, "doc_ref_invalid");
  }
});

test("knowledge write/rename/archive/restore/delete stay inside knowledge/ and refuse SKILL.md (#347)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  const positionDir = path.join(dir, "positions", "repo-owner");
  try {
    await openWorkspace(server.baseUrl, server.token, dir);

    const written = await api(server.baseUrl, routes.docsWrite, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/README.md", content: "# Edited knowledge\n" },
    });
    assert.equal(written.status, 200);
    const writtenBody = written.body as DocsFileResponse;
    assert.equal(writtenBody.schemaVersion, DOCS_FILE_SCHEMA_VERSION);
    assert.equal(writtenBody.path, "knowledge/README.md");
    assert.equal(writtenBody.content, "# Edited knowledge\n");
    assert.equal(await fs.readFile(path.join(positionDir, "knowledge", "README.md"), "utf8"), "# Edited knowledge\n");

    const skillWrite = await api(server.baseUrl, routes.docsWrite, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "SKILL.md", content: "should stay bound\n" },
    });
    assert.equal(skillWrite.status, 403);
    assert.equal((skillWrite.body as { code: string }).code, "docs_forbidden");
    assert.notEqual(await fs.readFile(path.join(positionDir, "SKILL.md"), "utf8"), "should stay bound\n");

    const renamed = await api(server.baseUrl, routes.docsRename, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", from: "knowledge/README.md", to: "knowledge/handbook.md" },
    });
    assert.equal(renamed.status, 200);
    const renamedBody = renamed.body as DocsRenameResponse;
    assert.equal(renamedBody.schemaVersion, DOCS_RENAME_SCHEMA_VERSION);
    assert.equal(renamedBody.to, "knowledge/handbook.md");
    assert.equal(await fs.readFile(path.join(positionDir, "knowledge", "handbook.md"), "utf8"), "# Edited knowledge\n");

    const renameToSkill = await api(server.baseUrl, routes.docsRename, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", from: "knowledge/handbook.md", to: "SKILL.md" },
    });
    assert.equal(renameToSkill.status, 403);
    assert.equal((renameToSkill.body as { code: string }).code, "docs_forbidden");

    const archived = await api(server.baseUrl, routes.docsArchive, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/handbook.md" },
    });
    assert.equal(archived.status, 200);
    assert.equal((archived.body as DocsArchiveResponse).schemaVersion, DOCS_ARCHIVE_SCHEMA_VERSION);
    await fs.access(path.join(positionDir, "knowledge", "handbook.md")).then(
      () => {
        throw new Error("archived knowledge file must leave the live tree");
      },
      () => undefined,
    );

    const liveList = await api(server.baseUrl, `${routes.docsList}?position=repo-owner`, { token: server.token });
    const livePaths = (liveList.body as DocsFileListResponse).files.map((entry) => entry.path);
    assert.ok(!livePaths.includes("knowledge/handbook.md"), "archived file must not appear in the live list");
    assert.ok(livePaths.includes("SKILL.md"));

    const archiveList = await api(server.baseUrl, `${routes.docsList}?position=repo-owner&archived=1`, {
      token: server.token,
    });
    assert.equal(archiveList.status, 200);
    const archivedPaths = (archiveList.body as DocsFileListResponse).files.map((entry) => entry.path);
    assert.deepEqual(archivedPaths, ["knowledge/handbook.md"]);

    const archiveRead = await api(
      server.baseUrl,
      `${routes.docsRead}?position=repo-owner&path=knowledge%2Fhandbook.md&archived=1`,
      { token: server.token },
    );
    assert.equal(archiveRead.status, 200);
    assert.equal((archiveRead.body as DocsFileResponse).content, "# Edited knowledge\n");

    const restored = await api(server.baseUrl, routes.docsRestore, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/handbook.md" },
    });
    assert.equal(restored.status, 200);
    assert.equal((restored.body as DocsRestoreResponse).schemaVersion, DOCS_RESTORE_SCHEMA_VERSION);
    assert.equal(await fs.readFile(path.join(positionDir, "knowledge", "handbook.md"), "utf8"), "# Edited knowledge\n");

    const deleted = await api(server.baseUrl, routes.docsDelete, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/handbook.md" },
    });
    assert.equal(deleted.status, 200);
    assert.equal((deleted.body as DocsDeleteResponse).schemaVersion, DOCS_DELETE_SCHEMA_VERSION);
    await fs.access(path.join(positionDir, "knowledge", "handbook.md")).then(
      () => {
        throw new Error("deleted knowledge file must be gone");
      },
      () => undefined,
    );

    const skillDelete = await api(server.baseUrl, routes.docsDelete, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "SKILL.md" },
    });
    assert.equal(skillDelete.status, 403);
    assert.equal((skillDelete.body as { code: string }).code, "docs_forbidden");
    await fs.access(path.join(positionDir, "SKILL.md"));
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("knowledge lifecycle refuses missing files, extra keys, and archive collisions (#347)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, dir);

    const missingWrite = await api(server.baseUrl, routes.docsWrite, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/missing.md", content: "x" },
    });
    assert.equal(missingWrite.status, 404);
    assert.equal((missingWrite.body as { code: string }).code, "docs_missing");

    const extra = await api(server.baseUrl, routes.docsArchive, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/README.md", evil: true },
    });
    assert.equal(extra.status, 400);
    assert.equal((extra.body as { code: string }).code, "docs_request_invalid");

    const first = await api(server.baseUrl, routes.docsArchive, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/README.md" },
    });
    assert.equal(first.status, 200);

    await api(server.baseUrl, routes.docsCreate, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/README.md", content: "again\n" },
    });
    const collision = await api(server.baseUrl, routes.docsArchive, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/README.md" },
    });
    assert.equal(collision.status, 409);
    assert.equal((collision.body as { code: string }).code, "docs_exists");

    const archivedDelete = await api(server.baseUrl, routes.docsDelete, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/README.md", archived: true },
    });
    assert.equal(archivedDelete.status, 200);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("review: write refuses a nested knowledge ancestor symlink (#347)", { skip: process.platform === "win32" }, async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  const positionDir = path.join(dir, "positions", "repo-owner");
  const outside = path.join(dir, "outside-victim.md");
  try {
    await fs.writeFile(outside, "secret\n");
    await fs.mkdir(path.join(positionDir, "knowledge", "escape-link"));
    await fs.rm(path.join(positionDir, "knowledge", "escape-link"), { recursive: true });
    await fs.symlink(path.dirname(outside), path.join(positionDir, "knowledge", "escape"));

    await openWorkspace(server.baseUrl, server.token, dir);
    const written = await api(server.baseUrl, routes.docsWrite, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/escape/outside-victim.md", content: "pwned\n" },
    });
    assert.equal(written.status, 403);
    assert.equal((written.body as { code: string }).code, "docs_forbidden");
    assert.equal(await fs.readFile(outside, "utf8"), "secret\n");

    const renamed = await api(server.baseUrl, routes.docsRename, {
      method: "POST",
      token: server.token,
      body: {
        positionId: "repo-owner",
        from: "knowledge/README.md",
        to: "knowledge/escape/stolen.md",
      },
    });
    assert.equal(renamed.status, 403);
    assert.equal((renamed.body as { code: string }).code, "docs_forbidden");
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("review: archive refuses a symlinked archive root (#347)", { skip: process.platform === "win32" }, async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  const positionDir = path.join(dir, "positions", "repo-owner");
  const outsideDir = path.join(dir, "outside-archive");
  try {
    await fs.mkdir(outsideDir);
    await fs.symlink(outsideDir, path.join(positionDir, ".owb-docs-archive"));
    const original = await fs.readFile(path.join(positionDir, "knowledge", "README.md"), "utf8");

    await openWorkspace(server.baseUrl, server.token, dir);
    const archived = await api(server.baseUrl, routes.docsArchive, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/README.md" },
    });
    assert.equal(archived.status, 403);
    assert.equal((archived.body as { code: string }).code, "docs_forbidden");
    assert.equal(await fs.readFile(path.join(positionDir, "knowledge", "README.md"), "utf8"), original);
    const leaked = await fs.readdir(outsideDir);
    assert.deepEqual(leaked, []);

    const restore = await api(server.baseUrl, routes.docsRestore, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/README.md" },
    });
    assert.equal(restore.status, 403);

    const listed = await api(server.baseUrl, `${routes.docsList}?position=repo-owner&archived=1`, {
      token: server.token,
    });
    assert.equal(listed.status, 403);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("review: invalid archived query fails closed (#347)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, dir);
    const banana = await api(server.baseUrl, `${routes.docsList}?position=repo-owner&archived=banana`, {
      token: server.token,
    });
    assert.equal(banana.status, 400);
    assert.equal((banana.body as { code: string }).code, "docs_request_invalid");

    const duplicated = await api(
      server.baseUrl,
      `${routes.docsList}?position=repo-owner&archived=1&archived=1`,
      { token: server.token },
    );
    assert.equal(duplicated.status, 400);

    const bananaRead = await api(
      server.baseUrl,
      `${routes.docsRead}?position=repo-owner&path=knowledge%2FREADME.md&archived=banana`,
      { token: server.token },
    );
    assert.equal(bananaRead.status, 400);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("archived knowledge leaves bindings and doc-ref resolution (#347)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, dir);
    const before = await api(server.baseUrl, "/positions/repo-owner", { token: server.token });
    assert.equal(before.status, 200);
    const beforeCount = (before.body as { position: { contextSources: Array<{ readOnly?: boolean; itemCount?: number }> } })
      .position.contextSources[0]?.itemCount ?? 0;
    assert.equal(
      (before.body as { position: { contextSources: Array<{ readOnly?: boolean }> } }).position.contextSources[0]
        ?.readOnly,
      false,
    );

    const archived = await api(server.baseUrl, routes.docsArchive, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/README.md" },
    });
    assert.equal(archived.status, 200);

    const resolved = await api(server.baseUrl, routes.docsResolve, {
      method: "POST",
      token: server.token,
      body: { ref: { uri: formatDocRefUri("repo-owner", "knowledge/README.md") } },
    });
    assert.equal(resolved.status, 404);
    assert.equal((resolved.body as { code: string }).code, "docs_missing");

    const after = await api(server.baseUrl, "/positions/repo-owner", { token: server.token });
    const afterCount = (after.body as { position: { contextSources: Array<{ itemCount?: number }> } }).position
      .contextSources[0]?.itemCount ?? 0;
    assert.equal(afterCount, beforeCount - 1);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("knowledge move refuses to replace an existing destination (#347)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  const positionDir = path.join(dir, "positions", "repo-owner");
  try {
    await openWorkspace(server.baseUrl, server.token, dir);
    await api(server.baseUrl, routes.docsCreate, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "knowledge/keep.md", content: "keep\n" },
    });
    const renamed = await api(server.baseUrl, routes.docsRename, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", from: "knowledge/README.md", to: "knowledge/keep.md" },
    });
    assert.equal(renamed.status, 409);
    assert.equal(await fs.readFile(path.join(positionDir, "knowledge", "keep.md"), "utf8"), "keep\n");
    assert.ok((await fs.readFile(path.join(positionDir, "knowledge", "README.md"), "utf8")).length > 0);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

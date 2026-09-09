import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ASSET_RECORD_SCHEMA_VERSION,
  DOCS_CREATE_SCHEMA_VERSION,
  DOCS_FILE_LIST_SCHEMA_VERSION,
  DOCS_FILE_SCHEMA_VERSION,
  DOCS_RESOLVE_SCHEMA_VERSION,
  formatDocRefUri,
  parseAssetRecord,
  parseDocRef,
  routes,
} from "@roleweave/shared";
import type { DocsCreateResponse, DocsFileListResponse, DocsFileResponse, DocsResolveResponse } from "@roleweave/shared";
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
        path.join(dir, ".digital-employee", "workbench", "drive", "assets", body.assetId, "record.json"),
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
      await fs.readFile(path.join(dir, ".digital-employee", "workbench", "drive", "assets", "asset-index.json"), "utf8"),
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

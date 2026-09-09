import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ASSET_RECORD_SCHEMA_VERSION,
  ASSETS_LIST_SCHEMA_VERSION,
  routes,
} from "@roleweave/shared";
import type { AssetRecord, AssetsListResponse } from "@roleweave/shared";
import { api, assertPosixMode, copyExampleWorkspace, startTestServer } from "./helpers.js";

const DRIVE = path.join(".digital-employee", "workbench", "drive", "assets");

async function openWorkspace(baseUrl: string, token: string, dir: string): Promise<void> {
  const opened = await api(baseUrl, routes.workspaceOpen, {
    method: "POST",
    token,
    body: { path: dir },
  });
  assert.equal(opened.status, 200);
}

test("assets create lands non-document kinds as exactKeys asset-record.v1 records (#36 S1)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, dir);

    const created = await api(server.baseUrl, routes.assetsCreate, {
      method: "POST",
      token: server.token,
      body: {
        kind: "conversation-excerpt",
        title: "发布节奏复盘要点",
        sourceRef: { sessionId: "sess-1", positionId: "repo-owner", conversationRef: "owb-conv:release" },
      },
    });
    assert.equal(created.status, 201);
    const record = created.body as AssetRecord;
    assert.equal(record.schemaVersion, ASSET_RECORD_SCHEMA_VERSION);
    assert.equal(record.kind, "conversation-excerpt");
    assert.equal(record.title, "发布节奏复盘要点");
    assert.match(record.assetId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(record.sourceRef, {
      sessionId: "sess-1",
      positionId: "repo-owner",
      conversationRef: "owb-conv:release",
    });
    assert.equal("docRef" in record, false, "non-doc records carry no docRef key");

    const file = path.join(dir, DRIVE, record.assetId, "record.json");
    await assertPosixMode(file, 0o600);
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(raw).sort(),
      ["assetId", "createdAt", "kind", "schemaVersion", "sourceRef", "title"],
      "landed record carries exactly the six non-doc exactKeys",
    );

    const indexRaw = JSON.parse(await fs.readFile(path.join(dir, DRIVE, "asset-index.json"), "utf8")) as {
      assets: Array<{ assetId: string }>;
    };
    assert.ok(indexRaw.assets.some((entry) => entry.assetId === record.assetId), "index ledger carries the new asset");

    const decision = await api(server.baseUrl, routes.assetsCreate, {
      method: "POST",
      token: server.token,
      body: { kind: "decision", title: "采用本地倒排索引" },
    });
    assert.equal(decision.status, 201, "decision kind without sourceRef lands as well");
    assert.deepEqual((decision.body as AssetRecord).sourceRef, {});
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("assets create rejects anything outside the frozen allowlist (#36 S1)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, dir);

    const docKind = await api(server.baseUrl, routes.assetsCreate, {
      method: "POST",
      token: server.token,
      body: { kind: "doc", title: "bypass.md" },
    });
    assert.equal(docKind.status, 400, "doc assets stay produced exclusively by document creation");
    assert.equal((docKind.body as { code: string }).code, "asset_request_invalid");

    const ghostKind = await api(server.baseUrl, routes.assetsCreate, {
      method: "POST",
      token: server.token,
      body: { kind: "memory", title: "x" },
    });
    assert.equal(ghostKind.status, 400);
    assert.equal((ghostKind.body as { code: string }).code, "asset_request_invalid");

    const extraKey = await api(server.baseUrl, routes.assetsCreate, {
      method: "POST",
      token: server.token,
      body: { kind: "decision", title: "x", evil: true },
    });
    assert.equal(extraKey.status, 400);

    const emptyTitle = await api(server.baseUrl, routes.assetsCreate, {
      method: "POST",
      token: server.token,
      body: { kind: "decision", title: "" },
    });
    assert.equal(emptyTitle.status, 400);

    const badSourceKey = await api(server.baseUrl, routes.assetsCreate, {
      method: "POST",
      token: server.token,
      body: { kind: "decision", title: "x", sourceRef: { user: "someone" } },
    });
    assert.equal(badSourceKey.status, 400);

    const badPositionId = await api(server.baseUrl, routes.assetsCreate, {
      method: "POST",
      token: server.token,
      body: { kind: "decision", title: "x", sourceRef: { positionId: "UPPER CASE" } },
    });
    assert.equal(badPositionId.status, 400);

    const emptySource = await api(server.baseUrl, routes.assetsCreate, {
      method: "POST",
      token: server.token,
      body: { kind: "decision", title: "x", sourceRef: {} },
    });
    assert.equal(emptySource.status, 400, "an explicit sourceRef must carry provenance");
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("assets list is deterministic and rebuilds the index from landed records (#36 S1)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, dir);

    // A doc asset produced by document creation shares the same ledger.
    const docCreated = await api(server.baseUrl, routes.docsCreate, {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", path: "runbook.md", content: "# Runbook\n" },
    });
    assert.equal(docCreated.status, 201);

    const first = await api(server.baseUrl, routes.assetsCreate, {
      method: "POST",
      token: server.token,
      body: { kind: "decision", title: "决策一", sourceRef: { positionId: "repo-owner" } },
    });
    assert.equal(first.status, 201);
    const second = await api(server.baseUrl, routes.assetsCreate, {
      method: "POST",
      token: server.token,
      body: { kind: "conversation-excerpt", title: "沉淀二" },
    });
    assert.equal(second.status, 201);

    // Delete the ledger: listing must rebuild it byte-identically from records.
    await fs.rm(path.join(dir, DRIVE, "asset-index.json"));

    const listed = await api(server.baseUrl, routes.assetsList, { token: server.token });
    assert.equal(listed.status, 200);
    const body = listed.body as AssetsListResponse;
    assert.equal(body.schemaVersion, ASSETS_LIST_SCHEMA_VERSION);
    assert.equal(body.assets.length, 3, "doc + two non-doc assets all listable");
    const kinds = body.assets.map((asset) => asset.kind);
    assert.deepEqual(kinds.sort(), ["conversation-excerpt", "decision", "doc"]);
    const sorted = [...body.assets].sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.assetId.localeCompare(right.assetId)
        : left.createdAt < right.createdAt
          ? -1
          : 1,
    );
    assert.deepEqual(body.assets, sorted, "listing is sorted by createdAt then assetId");

    const rebuilt = JSON.parse(await fs.readFile(path.join(dir, DRIVE, "asset-index.json"), "utf8"));
    const listedAgain = await api(server.baseUrl, routes.assetsList, { token: server.token });
    assert.deepEqual(
      (listedAgain.body as AssetsListResponse).assets,
      body.assets,
      "same input, same output (rebuild determinism)",
    );
    const rebuiltAgain = JSON.parse(await fs.readFile(path.join(dir, DRIVE, "asset-index.json"), "utf8"));
    assert.deepEqual(rebuiltAgain, rebuilt, "index ledger rebuild is byte-identical");

    const readOne = await api(
      server.baseUrl,
      `${routes.assetsRead}?asset=${(first.body as AssetRecord).assetId}`,
      { token: server.token },
    );
    assert.equal(readOne.status, 200);
    assert.deepEqual(readOne.body, first.body, "read returns the landed record verbatim");
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("assets read fails closed on missing and malformed ids (#36 S1)", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, dir);

    const missing = await api(server.baseUrl, `${routes.assetsRead}?asset=00000000-0000-4000-8000-000000000000`, {
      token: server.token,
    });
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { code: string }).code, "asset_not_found");

    const malformed = await api(server.baseUrl, `${routes.assetsRead}?asset=../escape`, { token: server.token });
    assert.equal(malformed.status, 400);
    assert.equal((malformed.body as { code: string }).code, "asset_request_invalid");

    const absent = await api(server.baseUrl, routes.assetsRead, { token: server.token });
    assert.equal(absent.status, 400);
    assert.equal((absent.body as { code: string }).code, "asset_request_invalid");

    const closedServer = await startTestServer();
    try {
      const closed = await api(closedServer.baseUrl, routes.assetsList, { token: closedServer.token });
      assert.equal(closed.status, 422);
      assert.equal((closed.body as { code: string }).code, "workspace_not_open");
    } finally {
      await closedServer.close();
    }

    const emptyList = await api(server.baseUrl, routes.assetsList, { token: server.token });
    assert.equal(emptyList.status, 200, "listing a drive with no assets yet is a bounded empty result");
    assert.deepEqual((emptyList.body as AssetsListResponse).assets, []);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

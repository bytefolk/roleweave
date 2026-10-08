import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureService } from "../src/services/connections.js";
import { requestVaultRemote, syncWorkspaceVault } from "../src/vault/sync.js";
import { copyExampleWorkspace, startTestServer } from "./helpers.js";

const VAULT = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const connection = { kind: "mem" as const, apiUrl: "https://mem.example.test/prefix", webUrl: "https://mem.example.test", token: "fixture-token" };

test("Vault requests use only known routes and canonical UUID parameters on the configured origin", async t => {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  t.mock.method(globalThis, "fetch", async (target: URL | string, init?: RequestInit) => {
    seen.push({ url: String(target), init });
    return new Response("{}", { headers: { "content-type": "application/json" } });
  });
  try {
    await requestVaultRemote(connection, "/v1/vault/snapshot?vaultId=" + VAULT);
    assert.equal(seen[0]?.url, "https://mem.example.test/prefix/v1/vault/snapshot?vaultId=" + VAULT.toLowerCase());
    assert.equal(seen[0]?.init?.redirect, "error");
    assert.equal((seen[0]?.init?.headers as Record<string, string>).authorization, "Bearer fixture-token");
    for (const route of ["/v1/vault/snapshot?vaultId=" + VAULT + "&token=secret", "/v1/vault/../files", "/v1/vault/snapshot?vaultId=https://evil.example", "/v1/vault/list?file=secret"]) {
      await assert.rejects(requestVaultRemote(connection, route), { code: "vault_request_invalid" });
    }
    assert.equal(seen.length, 1, "invalid state cannot create any outbound request");
  } finally { t.mock.restoreAll(); }
});

test("a poisoned persisted remote identity fails before any network request", async t => {
  const dir = await copyExampleWorkspace(); const server = await startTestServer(); let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("Unexpected request"); });
  try {
    await server.ctx.workspace.openWorkspace(dir); configureService(server.ctx, connection);
    const sidecar = path.join(dir, ".roleweave", "vault"); await fs.mkdir(sidecar, { recursive: true });
    const remoteVaultId = VAULT + "&file=secret";
    await fs.writeFile(path.join(sidecar, "sync-state.json"), JSON.stringify({ schemaVersion: "vault-sync-state.v1", connection: "fixture", remoteVaultId, snapshot: { schemaVersion: "vault-snapshot.v1", vaultId: remoteVaultId, revision: 1, entries: [] } }));
    await assert.rejects(syncWorkspaceVault(server.ctx), { code: "vault_storage_failed" });
    assert.equal(requests, 0);
  } finally {
    t.mock.restoreAll(); await server.close();
    const absolute = path.resolve(dir); assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.match(path.basename(absolute), /^owb-workspace-/);
    await fs.rm(absolute, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { employeeModelConfig } from "../src/model-selection.js";
import { readPositionAgentBinding } from "../src/agent-binding.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

test("Office model cards use only the supervisor's local bridge configuration without querying the client", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rw-qwen-office-model-"));
  await fs.chmod(root, 0o700);
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\roleweave-qwen-office-${randomUUID()}` : path.join(root, "bridge.sock");
  let connections = 0;
  const broker = net.createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>((resolve, reject) => { broker.once("error", reject); broker.listen(endpoint, resolve); });
  if (process.platform !== "win32") await fs.chmod(endpoint, 0o600);
  try {
    const config = await employeeModelConfig("qwen-office-local", undefined, true, {
      ROLEWEAVE_QWEN_OFFICE_BRIDGE: endpoint, ROLEWEAVE_QWEN_OFFICE_BRIDGE_TOKEN: "a".repeat(64),
    });
    assert.equal(config.connection?.status, "configured");
    assert.equal(config.editable, false);
    assert.equal(config.selected, "provider-default");
    assert.equal(connections, 0);
    assert.doesNotMatch(JSON.stringify(config), /pipe|bridge\.sock|aaaa/);
  } finally {
    await new Promise<void>((resolve, reject) => broker.close(error => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Office follows its native client's current model and ignores foreign catalogs and saved selectors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qwen-office-model-"));
  try {
    await fs.writeFile(path.join(root, "models_cache.json"), JSON.stringify({ models: [{ slug: "foreign-codex", display_name: "Foreign account", visibility: "list" }] }));
    const env = { CODEX_HOME: root, OPENAI_API_KEY: "foreign-service-secret", OPENAI_MODEL: "foreign-api", OPENAI_BASE_URL: "https://foreign.example/v1" };
    for (const editable of [true, false]) {
      const config = await employeeModelConfig("qwen-office-local", "old-pinned-model", editable, env);
      assert.equal(config.editable, false);
      assert.equal(config.source, "default");
      assert.equal(config.selected, "provider-default");
      assert.equal(config.recommended, "provider-default");
      assert.deepEqual(config.options.map(option => option.id), ["provider-default"]);
      assert.equal(config.options[0]?.resolvedModel, undefined);
      assert.equal(config.allowCustomModel, undefined);
      assert.deepEqual(config.connection, editable ? { source: "official", kind: "official", billing: "unknown", status: "invalid" } : undefined);
      assert.doesNotMatch(JSON.stringify(config), /foreign|old-pinned|secret/);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Office binding is durable and locked, and model PATCH cannot change the native client model", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  server.ctx.config.bundledElectronEngine = true;
  const call = (url: string, body: unknown) => api(server.baseUrl, url, { method: "PATCH", token: server.token, body });
  try {
    assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } })).status, 200);
    const bound = await call("/positions/repo-owner/agent-engine", { engine: "qwen-office-local" });
    assert.equal(bound.status, 200);
    assert.equal((bound.body as { agentEngine: string }).agentEngine, "qwen-office-local");
    const before = await readPositionAgentBinding(server.ctx.workspace.requireOpen(), "repo-owner");
    assert.equal(before?.locked, true);
    for (const model of ["provider-default", "foreign-model"]) {
      assert.equal((await call("/positions/repo-owner/model", { model })).status, 400);
      assert.deepEqual(await readPositionAgentBinding(server.ctx.workspace.requireOpen(), "repo-owner"), before);
    }
    assert.equal((await call("/positions/repo-owner/agent-engine", { engine: "codex-local" })).status, 409);
    const card = await api(server.baseUrl, "/positions/repo-owner", { token: server.token });
    assert.equal((card.body as { agentEngine: string }).agentEngine, "qwen-office-local");
    assert.equal((card.body as { modelConfig: { editable: boolean } }).modelConfig.editable, false);
  } finally {
    await server.ctx.contextExporter.waitForIdle();
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

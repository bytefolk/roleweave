import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { RelationshipGraphResponse } from "@roleweave/shared";
import { configureService } from "../src/services/connections.js";
import { resolvePositionPackageDir } from "../src/context-sources.js";
import { projectRelationships } from "../src/relationships/project.js";
import { api, copyExampleWorkspace, startTestServer, type TestServer } from "./helpers.js";

async function graph(server: TestServer): Promise<RelationshipGraphResponse> {
  const response = await api(server.baseUrl, "/graph/relationships", { token: server.token });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body as RelationshipGraphResponse;
}
async function snapshot(root: string): Promise<unknown[]> {
  const records: unknown[] = [];
  const walk = async (directory: string) => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const stat = await fs.stat(filename);
        records.push([path.relative(root, filename), "directory", stat.mode, stat.mtimeMs]);
        await walk(filename);
      } else {
        const handle = await fs.open(filename, "r");
        try {
          const stat = await handle.stat();
          const bytes = await handle.readFile();
          records.push([path.relative(root, filename), stat.mode, stat.mtimeMs, crypto.createHash("sha256").update(bytes).digest("hex")]);
        } finally { await handle.close(); }
      }
    }
  };
  await walk(root);
  return records;
}

test("relationship graph requires the local operator and an open workspace", async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  assert.equal((await api(server.baseUrl, "/graph/relationships")).status, 401);
  assert.equal((await api(server.baseUrl, "/graph/relationships", { token: server.token })).status, 422);
});

test("graph GET is pure and stable, with declared policy and observed resource/task evidence", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  const opened = await server.ctx.workspace.openWorkspace(workspace);
  const owner = opened.organization.roles.find((role) => role.id === opened.organization.owner)!;
  owner.toolAllow.push(`Read(${workspace}/LOCAL_PRIVATE_RESOURCE)`, "Web https://account:PRIVATE_URL_CREDENTIAL@example.test", "tool token=PRIVATE_TOOL_TOKEN");
  const packageDir = resolvePositionPackageDir(workspace, owner);
  await fs.mkdir(path.join(packageDir, ".workbench"), { recursive: true });
  await fs.writeFile(path.join(packageDir, ".workbench", "agent-binding.v1.json"), JSON.stringify({ schemaVersion: "roleweave-agent-binding.v1", engine: "codex", locked: true }));
  await fs.writeFile(path.join(packageDir, "permissions.json"), JSON.stringify({
    schemaVersion: "workbench-permissions.v1", tools: ["Read"], skills: [{ id: "docs-review" }],
    mcpServers: [{ id: "repository", tools: ["read"] }], rules: [
      { scope: "position", resource: "./knowledge/**", actions: ["read"], effect: "allow" },
      { scope: "workspace", resource: "/private/secret-material", actions: ["read"], effect: "deny", approval: true },
      { scope: "project", resource: "https://user:credential@example.test/private?token=not-for-ui", actions: ["read"] },
    ],
  }));
  const task = await server.ctx.taskBoardStore.create(workspace, opened.organization, owner.id, { targetPositionId: "release-engineer", title: "Release plan" });
  const goal = await server.ctx.goalStore.create(workspace, { title: "Deliver graph", description: "PRIVATE_GOAL_BODY", acceptanceCriteria: [] });
  configureService(server.ctx, { kind: "mem", apiUrl: "https://mem.example.test", token: "PRIVATE_MEM_TOKEN" });
  const before = await snapshot(workspace);
  const result = await graph(server);
  const again = await graph(server);
  assert.equal(result.schemaVersion, "relationship-graph.v1");
  assert.equal(result.revision, again.revision);
  assert.deepEqual(result.nodes.map((node) => node.id), again.nodes.map((node) => node.id));
  assert.deepEqual(await snapshot(workspace), before, "reading the graph must not create identities, chmod files, or update goals");
  const all = JSON.stringify(result);
  for (const forbidden of [workspace, packageDir, "PRIVATE_MEM_TOKEN", "PRIVATE_GOAL_BODY", "secret-material", "credential", "not-for-ui", "LOCAL_PRIVATE_RESOURCE", "PRIVATE_URL_CREDENTIAL", "PRIVATE_TOOL_TOKEN"]) assert.ok(!all.includes(forbidden), forbidden);
  assert.match(result.workspaceId, /^workspace:local-[a-f0-9]+$/);
  assert.ok(result.nodes.some((node) => node.kind === "host" && node.label === "codex"));
  assert.ok(result.edges.some((edge) => edge.kind === "reports_to"));
  const taskNode = result.nodes.find((node) => node.kind === "task" && node.evidence.locator === `task:${task.taskId}`)!;
  assert.equal(taskNode.evidence.basis, "observed");
  assert.ok(result.edges.some((edge) => edge.source === taskNode.id && edge.kind === "assigned_to"));
  assert.ok(result.nodes.some((node) => node.kind === "goal" && node.evidence.locator === `goal:${goal.goalId}`));
  const deny = result.edges.find((edge) => edge.kind === "declares_deny" && result.nodes.find((node) => node.id === edge.target)?.kind === "resource")!;
  assert.equal(deny.permission, "declaration_only");
  assert.equal(deny.evidence.basis, "declared");
  const mcp = result.nodes.find((node) => node.facts?.some((fact) => fact.key === "kind" && fact.value === "mcp"))!;
  assert.ok(mcp.facts?.some((fact) => fact.key === "runtimeSupported" && fact.value === "false"));
  const mem = result.nodes.find((node) => node.facts?.some((fact) => fact.key === "kind" && fact.value === "mem_drive"))!;
  assert.equal(mem.state, "available");
  assert.ok(!result.edges.some((edge) => edge.target === mem.id && edge.kind === "bound_to"));
  assert.equal(result.coverage.find((coverage) => coverage.source === "mem")?.state, "partial");
  assert.ok(result.nodes.filter((node) => node.resourcePath).every((node) => node.evidence.basis === "observed"));
  const ids = new Set(result.nodes.map((node) => node.id));
  assert.ok(result.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)));
});

test("existing workspace identity is reused; corrupt records remain explicit coverage gaps", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  await server.ctx.workspace.openWorkspace(workspace);
  const session = await server.ctx.sessionStore.create(workspace, "repo-owner");
  await fs.mkdir(path.join(workspace, ".roleweave", "tasks"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".roleweave", "tasks", "bad.json"), "{ invalid JSON");
  const result = await graph(server);
  assert.equal(result.workspaceId, `workspace:${session.workspaceInstanceId}`);
  assert.equal(result.coverage.find((item) => item.source === "tasks")?.state, "partial");
  assert.equal(result.coverage.find((item) => item.source === "execution_lineage")?.state, "unsupported");
  assert.ok(result.nodes.some((node) => node.kind === "agent"));
});

test("graph enforces entity and document bounds without dangling edges", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  const opened = await server.ctx.workspace.openWorkspace(workspace);
  const template = opened.organization.roles[0]!;
  opened.organization.roles = Array.from({ length: 105 }, (_, index) => ({ ...template,
    id: `agent-${String(index).padStart(3, "0")}`, name: `Agent ${index}`, reportTo: index === 0 ? null : "agent-000",
    toolAllow: Array.from({ length: 32 }, (_, i) => `Tool${i}`),
    package: { ...template.package, localReference: path.join(workspace, "positions", `agent-${String(index).padStart(3, "0")}`) },
  }));
  opened.organization.owner = "agent-000";
  for (const role of opened.organization.roles.slice(0, 10)) {
    const dir = role.package.localReference;
    await fs.mkdir(path.join(dir, "knowledge"), { recursive: true });
    await fs.writeFile(path.join(dir, "employee.json"), "{}");
    for (let i = 0; i < 22; i += 1) await fs.writeFile(path.join(dir, "knowledge", `${String(i).padStart(2, "0")}.md`), "data");
  }
  const result = await graph(server);
  assert.equal(result.truncated, true);
  assert.equal(result.nodes.length, 400);
  assert.equal(result.edges.length, 800);
  assert.equal(result.nodes.filter((node) => node.kind === "agent").length, 100);
  const ids = new Set(result.nodes.map((node) => node.id));
  assert.ok(result.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)));
  for (const role of opened.organization.roles) assert.ok(result.nodes.filter((node) => node.positionId === role.id && node.resourcePath).length <= 20);
  assert.ok(result.coverage.some((item) => item.reason === "document_limit"));
  assert.equal((await graph(server)).revision, result.revision);
});

test("graph refuses stale workspace requests and a workspace switch during reading", async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  const other = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); await fs.rm(other, { recursive: true, force: true }); });
  await server.ctx.workspace.openWorkspace(workspace);
  const stale = await api(server.baseUrl, `/graph/relationships?expectedWorkspacePath=${encodeURIComponent(other)}`, { token: server.token });
  assert.equal(stale.status, 409);
  assert.ok(!JSON.stringify(stale.body).includes(other));
  const original = fs.realpath;
  let entered!: () => void;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const proceed = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => { release(); });
  t.mock.method(fs, "realpath", async (filename: string) => {
    if (filename === workspace) { entered(); await proceed; }
    return original(filename);
  });
  const pending = projectRelationships(server.ctx);
  await blocked;
  await server.ctx.workspace.openWorkspace(other);
  release();
  await assert.rejects(pending, { code: "graph_snapshot_stale", status: 409 });
});

test("symlinked metadata cannot become graph resources", { skip: process.platform === "win32" }, async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  const other = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); await fs.rm(other, { recursive: true, force: true }); });
  const opened = await server.ctx.workspace.openWorkspace(workspace);
  const role = opened.organization.roles[0]!;
  const dir = resolvePositionPackageDir(workspace, role);
  await fs.rm(path.join(dir, "permissions.json"), { force: true });
  const outside = path.join(other, "secret-policy.json");
  await fs.writeFile(outside, JSON.stringify({ schemaVersion: "workbench-permissions.v1", tools: ["SECRET_OUTSIDE_CAPABILITY"], rules: [] }));
  await fs.symlink(outside, path.join(dir, "permissions.json"));
  const result = await graph(server);
  assert.ok(!JSON.stringify(result).includes("SECRET_OUTSIDE_CAPABILITY"));
  assert.equal(result.coverage.find((item) => item.source === `permissions:${role.id}`)?.state, "error");
});

for (const restoreBeforeValidation of [false, true]) {
  test(`graph rejects an ancestor swapped during metadata reading${restoreBeforeValidation ? " and restored before validation" : ""}`, { skip: process.platform === "win32" }, async (t) => {
    const server = await startTestServer();
    const workspace = await copyExampleWorkspace();
    const other = await copyExampleWorkspace();
    t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); await fs.rm(other, { recursive: true, force: true }); });
    const opened = await server.ctx.workspace.openWorkspace(workspace);
    const role = opened.organization.roles[0]!;
    const dir = resolvePositionPackageDir(workspace, role);
    const previous = await fs.lstat(dir, { bigint: true });
    const backup = `${dir}.previous`;
    await fs.writeFile(path.join(other, "permissions.json"), JSON.stringify({ schemaVersion: "workbench-permissions.v1", tools: ["OUTSIDE_CONFIDENTIAL_CAPABILITY"], rules: [] }));
    const originalOpen = fs.open;
    let swapped = false;
    let restored = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (!swapped && args[0] === path.join(dir, "permissions.json")) {
        swapped = true;
        await fs.rename(dir, backup);
        await fs.symlink(other, dir, "dir");
        const handle = await originalOpen(...args);
        if (restoreBeforeValidation) {
          const close = handle.close.bind(handle);
          t.mock.method(handle, "close", async () => {
            await close();
            await fs.unlink(dir);
            await fs.rename(backup, dir);
            restored = true;
          });
        }
        return handle;
      }
      return originalOpen(...args);
    });
    const result = await graph(server);
    assert.equal(swapped, true);
    assert.equal(restored, restoreBeforeValidation);
    if (restored) assert.equal((await fs.lstat(dir, { bigint: true })).ino, previous.ino, "the restored directory has its original inode");
    assert.ok(!JSON.stringify(result).includes("OUTSIDE_CONFIDENTIAL_CAPABILITY"));
    assert.equal(result.coverage.find((item) => item.source === `permissions:${role.id}`)?.state, "error");
  });
}

test("graph discards the document source if its directory changes during enumeration", { skip: process.platform === "win32" }, async (t) => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  const other = await copyExampleWorkspace();
  t.after(async () => { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); await fs.rm(other, { recursive: true, force: true }); });
  const opened = await server.ctx.workspace.openWorkspace(workspace);
  const role = opened.organization.roles[0]!;
  const packageDir = resolvePositionPackageDir(workspace, role);
  const knowledge = path.join(packageDir, "knowledge");
  await fs.mkdir(knowledge, { recursive: true });
  await fs.writeFile(path.join(other, "OUTSIDE_CONFIDENTIAL_DOCUMENT.md"), "private");
  const originalOpen = fs.opendir;
  let swapped = false;
  t.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
    if (!swapped && args[0] === knowledge) {
      swapped = true;
      await fs.rename(knowledge, `${knowledge}.previous`);
      await fs.symlink(other, knowledge, "dir");
    }
    return originalOpen(...args);
  });
  const result = await graph(server);
  assert.equal(swapped, true);
  assert.ok(!JSON.stringify(result).includes("OUTSIDE_CONFIDENTIAL_DOCUMENT"));
  assert.ok(!result.nodes.some((node) => node.positionId === role.id && node.resourcePath), "all resources from the changed document source are discarded");
  assert.equal(result.coverage.find((item) => item.source === `documents:${role.id}`)?.state, "error");
});

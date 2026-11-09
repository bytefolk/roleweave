import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claudeReadPlan, createClaudeReadTools } from "../src/claude-workspace-tools.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-claude-tools-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const position = path.join(root, "positions", "owner");
  await fs.mkdir(path.join(position, "knowledge"), { recursive: true });
  await fs.writeFile(path.join(position, "knowledge", "README.md"), "第一行\nunique-evidence-4729\nlast line");
  await fs.writeFile(path.join(root, "secret.txt"), "outside the grant");
  await fs.writeFile(path.join(position, "permissions.json"), JSON.stringify({ schemaVersion: "workbench-permissions.v1", tools: ["Read", "Glob", "Grep"], rules: [{ scope: "position", resource: "./knowledge/**", actions: ["read"] }] }));
  const plan = await claudeReadPlan(root, position);
  return { root, position, plan, tools: createClaudeReadTools(plan) };
}

test("read tools execute only the actual granted resource and return exact file evidence", async t => {
  const { tools } = await fixture(t);
  assert.deepEqual(tools.definitions.map((tool: { name: string }) => tool.name), ["Read", "Glob", "Grep"]);
  const read = await tools.call("Read", { file_path: "positions/owner/knowledge/README.md", offset: 2, limit: 1 });
  assert.equal(read.text, "unique-evidence-4729");
  assert.equal(read.totalLines, 3);
  assert.deepEqual((await tools.call("Glob", { pattern: "**/*.md" })).files, ["positions/owner/knowledge/README.md"]);
  assert.deepEqual((await tools.call("Glob", { pattern: "**/README.md" })).files, ["positions/owner/knowledge/README.md"]);
  assert.deepEqual((await tools.call("Grep", { pattern: "unique-evidence" })).matches, [{ path: "positions/owner/knowledge/README.md", line: 2, text: "unique-evidence-4729" }]);
  await assert.rejects(tools.call("Read", { file_path: "secret.txt" }));
  await assert.rejects(tools.call("Read", { file_path: "../secret.txt" }));
  await assert.rejects(tools.call("Bash", { command: "cat secret.txt" }));
  await assert.rejects(tools.call("Read", { file_path: "positions/owner/knowledge/README.md", command: "echo x" }));
});

test("explicit denials and approval-required grants never execute automatically", async t => {
  const { plan } = await fixture(t);
  for (const rule of [{ pattern: "**/README.md", effect: "deny", approval: false }, { pattern: "**/README.md", effect: "allow", approval: true }]) {
    const tools = createClaudeReadTools({ ...plan, rules: [...plan.rules, rule] });
    await assert.rejects(tools.call("Read", { file_path: "positions/owner/knowledge/README.md" }));
    assert.deepEqual((await tools.call("Glob", { pattern: "**/*.md" })).files, []);
  }
});

test("workspace grants still reject links, credentials, oversized and binary files", async t => {
  const { root, plan } = await fixture(t);
  const tools = createClaudeReadTools({ ...plan, rules: [{ pattern: "**", effect: "allow", approval: false }] });
  await fs.writeFile(path.join(root, ".env"), "secret");
  await fs.writeFile(path.join(root, "auth.json"), "secret");
  await fs.writeFile(path.join(root, "huge.txt"), Buffer.alloc(1024 * 1024 + 1));
  await fs.writeFile(path.join(root, "binary.txt"), Buffer.from([0, 255]));
  await fs.symlink(os.tmpdir(), path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  for (const file of [".env", "auth.json", "huge.txt", "binary.txt", "linked/anything"]) await assert.rejects(tools.call("Read", { file_path: file }));
  const list = await tools.call("Glob", { pattern: "**" });
  assert.ok(!list.files?.some(file => file.includes("linked") || file === ".env" || file === "auth.json"));
});

test("permission parsing refuses shell grants, global MCP and path escapes", async t => {
  const { root, position } = await fixture(t);
  for (const permissions of [
    { tools: ["Bash"], rules: [] },
    { tools: ["Read"], mcpServers: [{ id: "global" }], rules: [] },
    { tools: ["Read"], rules: [{ scope: "workspace", resource: "../**", actions: ["read"] }] },
  ]) {
    await fs.writeFile(path.join(position, "permissions.json"), JSON.stringify({ schemaVersion: "workbench-permissions.v1", ...permissions }));
    await assert.rejects(claudeReadPlan(root, position));
  }
});

test("recognized credential values in otherwise readable documents are redacted", async t => {
  const { position, tools } = await fixture(t);
  await fs.writeFile(path.join(position, "knowledge", "config.json"), '{"api_key":"secret-value-not-for-models","model":"deepseek-v4-pro"}');
  const result = await tools.call("Read", { file_path: "positions/owner/knowledge/config.json" });
  assert.doesNotMatch(result.text!, /secret-value-not-for-models/);
  assert.match(result.text!, /deepseek-v4-pro/);
});

test("the owned MCP transport exposes only granted tools and never accepts a shell invocation", async t => {
  const { plan } = await fixture(t);
  const helper = fileURLToPath(new URL("../../bin/claude-workspace-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [helper, JSON.stringify(plan)], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => errors += chunk);
  const stopped = new Promise<number | null>(resolve => child.once("close", resolve));
  for (const request of [
    { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "Read", arguments: { file_path: "positions/owner/knowledge/README.md" } } },
    { id: 4, method: "tools/call", params: { name: "Bash", arguments: { command: "cat secret.txt" } } },
  ]) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...request }) + "\n");
  child.stdin.end();
  assert.equal(await stopped, 0, errors);
  const replies = output.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(replies.find(row => row.id === 1).result.protocolVersion, "2025-06-18");
  assert.equal(replies.find(row => row.id === 2).result.tools.length, 3);
  assert.match(replies.find(row => row.id === 3).result.content[0].text, /unique-evidence-4729/);
  assert.equal(replies.find(row => row.id === 4).result.isError, true);
  assert.doesNotMatch(output, /outside the grant/);
});

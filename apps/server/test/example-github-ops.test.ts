/**
 * The committed `examples/github-ops` workspace must keep working.
 *
 * An example is a shipped artifact with no other guard: nothing else in the
 * repository reads it, so an upstream schema change could quietly turn it into
 * a directory that no longer applies or opens, and the first person to notice
 * would be a user. These tests run the real seams — the bundled engine's
 * `org apply` and the control plane — against a copy of the committed files.
 *
 * Everything operates on a copy: a verification that mutates the artifact it
 * verifies is worse than no verification.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DigitalEmployeeCliDriver } from "../src/engine/driver-cli.js";
import { api, startTestServer } from "./helpers.js";

const EXAMPLE = fileURLToPath(new URL("../../../../examples/github-ops", import.meta.url));
const QODER_ADAPTER = fileURLToPath(new URL("../../bin/qoder-engine.mjs", import.meta.url));
const QODER_ADAPTER_COMMAND = `${JSON.stringify(process.execPath)} ${JSON.stringify(QODER_ADAPTER)}`;

const EXPECTED_ROLES = {
  "pr-gatekeeper": { reportTo: null, name: "合并把关", tools: ["Read", "Grep", "Glob", "Bash"] },
  "issue-triage": { reportTo: "pr-gatekeeper", name: "问题调研", tools: ["Read", "Grep", "Glob", "Bash"] },
  "pr-author": { reportTo: "pr-gatekeeper", name: "PR 提交", tools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash"] },
};

async function copyExample(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "github-ops-"));
  await fs.cp(EXAMPLE, dir, { recursive: true });
  return dir;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

test("examples/github-ops: the committed declaration describes the committed packages", async () => {
  const organization = await readJson<{
    owner: string;
    roles: Array<{ id: string; reportTo: string | null; name: string; toolAllow: string[]; budget: { perTask: { tokens: number } }; package: { digest: string; localReference: string } }>;
  }>(path.join(EXAMPLE, "organization.v1alpha1.json"));

  assert.equal(organization.owner, "pr-gatekeeper");
  assert.deepEqual(Object.keys(Object.fromEntries(organization.roles.map((role) => [role.id, role]))).sort(), Object.keys(EXPECTED_ROLES).sort());

  for (const [id, expected] of Object.entries(EXPECTED_ROLES)) {
    const role = organization.roles.find((entry) => entry.id === id);
    assert.ok(role, `${id} must be declared`);
    assert.equal(role.reportTo, expected.reportTo, `${id} reporting line`);
    assert.equal(role.name, expected.name, `${id} display name`);
    assert.deepEqual(role.toolAllow, expected.tools, `${id} tool allowlist`);
    assert.ok(role.budget.perTask.tokens > 0, `${id} budget`);

    const packageDir = path.resolve(EXAMPLE, role.package.localReference);
    const employeeBytes = await fs.readFile(path.join(packageDir, "employee.json"));
    // Compare over LF-normalized bytes: the repository stores LF, while a
    // Windows checkout may hold CRLF, and the digest is over file bytes.
    const normalized = Buffer.from(employeeBytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
    const digest = "sha256:" + (await import("node:crypto")).createHash("sha256").update(normalized).digest("hex");
    assert.equal(
      role.package.digest,
      digest,
      `${id}: the declared package digest does not match employee.json — update organization.v1alpha1.json after editing the package`,
    );

    const permissions = await readJson<{ tools: string[]; mcpServers: unknown[] }>(path.join(packageDir, "permissions.json"));
    assert.deepEqual(permissions.tools, expected.tools, `${id}: permissions.json must agree with the declaration`);
    assert.deepEqual(
      permissions.mcpServers,
      [],
      `${id}: the bundled engine fails a turn on any MCP binding (qoder.mcp_binding_unsupported), so the example must not declare one`,
    );

    const skill = await fs.readFile(path.join(packageDir, "SKILL.md"), "utf8");
    assert.ok(skill.startsWith("---\n"), `${id}: SKILL.md must carry frontmatter`);
    assert.ok(Buffer.byteLength(skill, "utf8") < 128 * 1024, `${id}: SKILL.md must fit the prompt bound`);
  }
});

test("examples/github-ops: the bundled engine adjudicates the committed layout", async (t) => {
  const driver = new DigitalEmployeeCliDriver(QODER_ADAPTER_COMMAND);
  const dir = await copyExample();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const outcome = await driver.apply(dir);
  if (outcome.status !== "applied") {
    assert.fail(`the committed example must apply: ${JSON.stringify(outcome)}`);
  }

  const applied = await readJson<{ owner: string; roles: Array<{ id: string; reportTo: string | null; name: string; toolAllow: string[]; budget: unknown; package: { digest: string } }> }>(
    path.join(dir, ".digital-employee", "org.json"),
  );
  assert.equal(applied.owner, "pr-gatekeeper");
  assert.equal(applied.roles.length, 3);
  for (const [id, expected] of Object.entries(EXPECTED_ROLES)) {
    const role = applied.roles.find((entry) => entry.id === id);
    assert.ok(role, `${id} must be published`);
    assert.equal(role.reportTo, expected.reportTo, `${id}: directory nesting is the reporting line`);
    assert.equal(role.name, expected.name, `${id}: the declaration supplies the display name`);
    assert.deepEqual(role.toolAllow, expected.tools);
    assert.match(role.package.digest, /^sha256:[0-9a-f]{64}$/, `${id}: the engine recomputes the package digest`);
  }
});

test("examples/github-ops: the control plane opens it and serves every position card", async (t) => {
  const dir = await copyExample();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const server = await startTestServer();
  try {
    const opened = await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    assert.equal(opened.status, 200, `workspace open failed: ${JSON.stringify(opened.body)}`);

    const tree = await api(server.baseUrl, "/org/tree", { token: server.token });
    assert.equal(tree.status, 200);
    const snapshot = tree.body as { owner: string; positionCount: number; depth: number; tree: Array<{ id: string; children: Array<{ id: string }> }> };
    assert.equal(snapshot.owner, "pr-gatekeeper");
    assert.equal(snapshot.positionCount, 3);
    assert.equal(snapshot.depth, 2);
    const root = snapshot.tree.find((node) => node.id === "pr-gatekeeper");
    assert.ok(root, "the gatekeeper must be the tree root");
    assert.deepEqual(root.children.map((child) => child.id).sort(), ["issue-triage", "pr-author"]);

    for (const [id, expected] of Object.entries(EXPECTED_ROLES)) {
      const card = await api(server.baseUrl, `/positions/${id}`, { token: server.token });
      assert.equal(card.status, 200, `${id} card must load`);
      const position = (card.body as { position: { name: string; reportTo: string | null; mode: string; permissionPolicy?: { tools: string[] } } }).position;
      assert.equal(position.name, expected.name);
      assert.equal(position.reportTo, expected.reportTo);
      assert.equal(position.mode, "approval_required", `${id}: every position acts externally, so none is read-only`);
      // The profile surface (#292) needs this projection to prefill an editor.
      assert.deepEqual(position.permissionPolicy?.tools, expected.tools, `${id}: the editable projection must be served`);
    }
  } finally {
    await server.close();
  }
});

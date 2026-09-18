/**
 * PATCH /positions/:id/profile — editing an employee that already exists.
 *
 * The two end-to-end tests deliberately run the REAL bundled adapter
 * (apps/server/bin/qoder-engine.mjs) for both gates, because the defect this
 * surface fixes is a cross-store one: the display name and the grant list live
 * in the package, but the applied model is rebuilt by the engine, and the
 * engine prefers the workspace's init *declaration* over the package for any
 * position it declares. A fake engine would happily agree with a wrong
 * assumption here.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  HireValidateDriver,
  OrgApplyDriver,
  OrganizationFile,
  PositionProfileSuccess,
} from "@roleweave/shared";
import { DigitalEmployeeCliDriver } from "../src/engine/driver-cli.js";
import { api, connectSse, copyExampleWorkspace, startTestServer } from "./helpers.js";

const HIRE = {
  positionId: "docs-writer",
  name: "Docs Writer",
  description: "Keeps documentation current.",
  reportTo: "repo-owner",
  mode: "read_only",
  budget: {
    perTask: { tokens: 20000, iterations: 8 },
    perDay: { tokens: 200000, iterations: 64 },
  },
  permissions: {
    tools: ["Read", "Grep", "Glob"],
    rules: [{ scope: "position", resource: "./knowledge/**", actions: ["read"] }],
  },
} as const;

const PATCHED_PERMISSIONS = {
  tools: ["Read", "Grep", "Glob", "Edit"],
  rules: [
    { scope: "position", resource: "./knowledge/**", actions: ["read"] },
    { scope: "workspace", resource: "./reports/**", actions: ["read", "create", "update"], approval: true },
    { scope: "position", resource: "skill://docs-review", actions: ["execute"] },
  ],
  skills: [{ id: "docs-review" }],
  mcpServers: [],
};

const QODER_ADAPTER = fileURLToPath(new URL("../../bin/qoder-engine.mjs", import.meta.url));
const QODER_ADAPTER_COMMAND = `${JSON.stringify(process.execPath)} ${JSON.stringify(QODER_ADAPTER)}`;

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function readText(file: string): Promise<string> {
  return fs.readFile(file, "utf8");
}

async function readJsonIfPresent<T>(file: string): Promise<T | null> {
  try {
    return await readJson<T>(file);
  } catch {
    return null;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the SSE condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readApplied(dir: string): Promise<OrganizationFile> {
  return readJson<OrganizationFile>(path.join(dir, ".digital-employee", "org.json"));
}

async function seedAppliedState(dir: string): Promise<void> {
  const runtime = path.join(dir, ".digital-employee");
  const model = await readJson<OrganizationFile>(path.join(dir, "organization.v1alpha1.json"));
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(runtime, "org.json"), `${JSON.stringify(model, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(
    path.join(runtime, "org-audit.jsonl"),
    `${JSON.stringify({
      schemaVersion: "org-audit.v1",
      at: model.updatedAt,
      actor: "fixture",
      workspace: dir,
      bootstrapped: true,
      changes: { hired: [], moved: [], dismissed: [], budgetUpdated: [] },
      positionCount: model.roles.length,
    })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(runtime, "permissions.json"),
    `${JSON.stringify({ schemaVersion: "org-permissions.v1", positions: {} }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/**
 * Minimal deterministic engine double: publishes the staged package into the
 * applied model the way `org apply` does. Only the failure-path tests use it, so
 * it deliberately does not re-implement the engine's declaration precedence —
 * the real adapter covers that.
 */
async function emulateEngineApply(dir: string): Promise<void> {
  const model = await readApplied(dir);
  const staged = path.join(dir, "positions", "repo-owner", "docs-writer");
  if ((await exists(staged)) && !model.roles.some((role) => role.id === "docs-writer")) {
    const employee = await readJson<{ description?: string; policy?: { mode?: string } }>(path.join(staged, "employee.json"));
    const budget = await readJson<OrganizationFile["roles"][number]["budget"]>(path.join(staged, "budget.json"));
    model.roles.push({
      id: "docs-writer",
      name: "Docs Writer",
      description: employee.description ?? "",
      reportTo: "repo-owner",
      package: { name: "docs-writer", version: "0.1.0", digest: "sha256:fixture", localReference: staged },
      mode: employee.policy?.mode === "read_only" ? "read_only" : "approval_required",
      memoryScope: "/",
      toolAllow: [],
      toolDeny: [],
      budget,
      metadata: {},
    });
  }
  model.updatedAt = new Date(Date.now() + 1000).toISOString();
  const runtime = path.join(dir, ".digital-employee");
  await fs.writeFile(path.join(runtime, "org.json"), `${JSON.stringify(model, null, 2)}\n`, { mode: 0o600 });
  await fs.appendFile(
    path.join(runtime, "org-audit.jsonl"),
    `${JSON.stringify({
      schemaVersion: "org-audit.v1",
      at: model.updatedAt,
      actor: "emulated org apply",
      workspace: dir,
      bootstrapped: false,
      changes: { hired: ["docs-writer"], moved: [], dismissed: [], budgetUpdated: [] },
      positionCount: model.roles.length,
    })}\n`,
    { mode: 0o600 },
  );
}

/** Swappable org-apply outcome so one server can hire successfully and then
 * have the engine reject the profile edit. */
class MutableDriver implements OrgApplyDriver, HireValidateDriver {
  calls = 0;
  outcome: Awaited<ReturnType<OrgApplyDriver["apply"]>> = { status: "applied" };
  apply: OrgApplyDriver["apply"] = async (dir) => {
    this.calls += 1;
    if (this.outcome.status === "applied") await emulateEngineApply(dir);
    return this.outcome;
  };

  async hireValidate(): Promise<Awaited<ReturnType<HireValidateDriver["hireValidate"]>>> {
    return { status: "valid" };
  }
}

const packageFiles = [
  "employee.json",
  "permissions.json",
  "skills.json",
  "mcp.json",
  "SKILL.md",
  path.join(".workbench", "identity.v1.json"),
];

async function snapshotPackage(packageDir: string): Promise<Record<string, string | null>> {
  const snapshot: Record<string, string | null> = {};
  for (const relative of packageFiles) {
    try {
      snapshot[relative] = await fs.readFile(path.join(packageDir, relative), "utf8");
    } catch {
      snapshot[relative] = null;
    }
  }
  return snapshot;
}

test("PATCH /positions/:id/profile: the bundled engine re-applies a renamed, re-granted employee end to end", async (t) => {
  const driver = new DigitalEmployeeCliDriver(QODER_ADAPTER_COMMAND);
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  try {
    const opened = await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    assert.equal(opened.status, 200);
    const hired = await api(server.baseUrl, "/hire", { method: "POST", token: server.token, body: HIRE });
    assert.equal(hired.status, 200);

    const packageDir = path.join(dir, "positions", "repo-owner", "docs-writer");
    assert.equal((await readApplied(dir)).roles.find((role) => role.id === "docs-writer")?.name, "Docs Writer");

    const response = await api(server.baseUrl, "/positions/docs-writer/profile", {
      method: "PATCH",
      token: server.token,
      body: { name: "文档工程师", mode: "approval_required", permissions: PATCHED_PERMISSIONS },
    });
    assert.equal(response.status, 200);
    const body = response.body as PositionProfileSuccess;
    assert.equal(body.status, "updated");
    assert.equal(body.positionId, "docs-writer");
    assert.equal(body.name, "文档工程师");
    assert.equal(body.mode, "approval_required");
    assert.equal(typeof body.version.seq, "number");

    // 1. The applied model is the operator-visible truth and must carry the edit.
    const appliedRole = (await readApplied(dir)).roles.find((role) => role.id === "docs-writer");
    assert.ok(appliedRole);
    assert.equal(appliedRole.name, "文档工程师", "the engine re-derives the display name from the edited package");
    assert.equal(appliedRole.mode, "approval_required");
    assert.deepEqual(appliedRole.toolAllow, PATCHED_PERMISSIONS.tools, "the grant list reaches the applied model");

    // 2. The package carries it too, so a later org apply cannot revert it.
    assert.deepEqual(
      await readJson(path.join(packageDir, ".workbench", "identity.v1.json")),
      { schemaVersion: "workbench-position-identity.v1", name: "文档工程师" },
    );
    const employee = await readJson<{
      entrypoints: { mcp?: string };
      policy: { mode: string; filesystem: { read: string[]; write: string[] }; mcpTools: Array<{ name: string; requestedMode: string }> };
      assets: string[];
    }>(path.join(packageDir, "employee.json"));
    assert.equal(employee.policy.mode, "approval_required");
    assert.deepEqual(employee.policy.filesystem.read, ["./knowledge/**", "./reports/**"]);
    assert.deepEqual(employee.policy.filesystem.write, ["./reports/**"]);
    assert.deepEqual(employee.policy.mcpTools, [], "the edit grants no MCP tools while no engine supports them (#314)");
    assert.equal(employee.entrypoints.mcp, undefined, "a package with no MCP grant must not advertise the entrypoint");
    assert.ok(["./permissions.json", "./skills.json", "./mcp.json"].every((asset) => employee.assets.includes(asset)));
    assert.deepEqual(await readJson(path.join(packageDir, "permissions.json")), {
      schemaVersion: "workbench-permissions.v1",
      model: "chmod-inspired",
      defaultEffect: "deny",
      tools: PATCHED_PERMISSIONS.tools,
      rules: PATCHED_PERMISSIONS.rules,
      skills: PATCHED_PERMISSIONS.skills,
      mcpServers: PATCHED_PERMISSIONS.mcpServers,
    });
    assert.deepEqual(await readJson(path.join(packageDir, "skills.json")), {
      schemaVersion: "workbench-skills.v1",
      defaultEffect: "deny",
      skills: [{ id: "docs-review", name: "文档审校", description: "检查文档的准确性、结构和可执行性。" }],
    });
    assert.deepEqual(await readJson(path.join(packageDir, "mcp.json")), {
      schemaVersion: "workbench-mcp.v1",
      defaultEffect: "deny",
      servers: [],
    });
    const skill = await readText(path.join(packageDir, "SKILL.md"));
    assert.match(skill, /^# 文档工程师$/m, "the generated SKILL title follows the rename");
    assert.match(skill, /### 文档审校（docs-review）/);
    assert.match(skill, /- 暂无 MCP 连接器/, "the generated MCP prose follows the emptied grant list");
    assert.doesNotMatch(skill, /暂无附加 Skill/, "the stale capability prose is refreshed");

    // 3. The position card the renderer reads reflects it without a reload race.
    const card = await api(server.baseUrl, "/positions/docs-writer", { token: server.token });
    assert.equal(card.status, 200);
    const record = (card.body as { position: { name: string; mode: string; permissions: { toolAllow: string[] }; capabilities: { skills: Array<{ id: string }> } } }).position;
    assert.equal(record.name, "文档工程师");
    assert.equal(record.mode, "approval_required");
    assert.deepEqual(record.permissions.toolAllow, PATCHED_PERMISSIONS.tools);
    assert.deepEqual(record.capabilities.skills.map((entry) => entry.id), ["docs-review"]);
  } finally {
    await server.close();
  }
});

test("PATCH /positions/:id/profile updates the workspace declaration, because the engine prefers it over the package", async (t) => {
  const driver = new DigitalEmployeeCliDriver(QODER_ADAPTER_COMMAND);
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  try {
    const opened = await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    assert.equal(opened.status, 200);
    const declaredFile = path.join(dir, "organization.v1alpha1.json");
    const before = await readJson<OrganizationFile>(declaredFile);
    const beforeRole = before.roles.find((role) => role.id === "repo-owner");
    assert.equal(beforeRole?.name, "仓库负责人", "the example workspace declares every position, unlike a created project");

    const response = await api(server.baseUrl, "/positions/repo-owner/profile", {
      method: "PATCH",
      token: server.token,
      body: { name: "开源负责人", permissions: { tools: ["Read", "Grep", "Glob", "Write"], rules: [] } },
    });
    assert.equal(response.status, 200);
    assert.equal((response.body as PositionProfileSuccess).name, "开源负责人");

    const after = await readJson<OrganizationFile>(declaredFile);
    const afterRole = after.roles.find((role) => role.id === "repo-owner");
    assert.ok(afterRole && beforeRole);
    assert.equal(afterRole.name, "开源负责人");
    assert.deepEqual(afterRole.toolAllow, ["Read", "Grep", "Glob", "Write"]);
    // Only the declared fields this surface owns may move.
    assert.equal(afterRole.description, beforeRole.description);
    assert.equal(afterRole.memoryScope, beforeRole.memoryScope);
    assert.deepEqual(afterRole.budget, beforeRole.budget);
    assert.deepEqual(afterRole.package, beforeRole.package);
    assert.deepEqual(afterRole.toolDeny, beforeRole.toolDeny);

    const appliedRole = (await readApplied(dir)).roles.find((role) => role.id === "repo-owner");
    assert.equal(appliedRole?.name, "开源负责人", "without the declaration edit the engine would have kept the old name");
    assert.deepEqual(appliedRole?.toolAllow, ["Read", "Grep", "Glob", "Write"]);
    assert.equal(appliedRole?.mode, "read_only", "an omitted mode is left alone");

    // The hand-written example SKILL.md has no generated capability sections,
    // so the edit must not invent or mangle them.
    const skill = await readText(path.join(dir, "positions", "repo-owner", "SKILL.md"));
    assert.match(skill, /^# 开源负责人$/m);
    assert.match(skill, /^## 工作准则$/m, "hand-written sections survive untouched");
    const employee = await readJson<{ policy: { network: string; mode: string } }>(path.join(dir, "positions", "repo-owner", "employee.json"));
    assert.equal(employee.policy.mode, "read_only");
    assert.equal(employee.policy.network, "deny", "the package policy keeps fields this surface does not own");
  } finally {
    await server.close();
  }
});

test("PATCH /positions/:id/profile: an MCP grant is refused fail-closed while an explicit empty grant list stays allowed", async (t) => {
  const driver = new DigitalEmployeeCliDriver(QODER_ADAPTER_COMMAND);
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  try {
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    await api(server.baseUrl, "/hire", { method: "POST", token: server.token, body: HIRE });
    const packageDir = path.join(dir, "positions", "repo-owner", "docs-writer");
    assert.equal((await readJson<{ entrypoints: { mcp?: string } }>(path.join(packageDir, "employee.json"))).entrypoints.mcp, undefined);

    // A well-formed grant still fails closed: no bundled Host declares the
    // "mcp" capability, so accepting it would only move the failure to the
    // employee's first turn (#314).
    const employeeBefore = await readText(path.join(packageDir, "employee.json"));
    const refused = await api(server.baseUrl, "/positions/docs-writer/profile", {
      method: "PATCH",
      token: server.token,
      body: { permissions: { tools: ["Read"], rules: [], skills: [], mcpServers: [{ id: "issue-tracker", tools: ["search"] }] } },
    });
    assert.equal(refused.status, 400);
    assert.equal((refused.body as { code: string }).code, "position_profile_invalid");
    assert.equal(await readText(path.join(packageDir, "employee.json")), employeeBefore, "a refused grant never touches the package");

    // The clearing path stays open so pre-existing packages keep a manual
    // unbind workaround.
    const cleared = await api(server.baseUrl, "/positions/docs-writer/profile", {
      method: "PATCH",
      token: server.token,
      body: { permissions: { tools: ["Read"], rules: [], skills: [], mcpServers: [] } },
    });
    assert.equal(cleared.status, 200);
    const employee = await readJson<{ entrypoints: { mcp?: string }; policy: { mcpTools: unknown[] } }>(path.join(packageDir, "employee.json"));
    assert.equal(employee.entrypoints.mcp, undefined, "a package with no MCP grant must stop advertising the entrypoint");
    assert.deepEqual(employee.policy.mcpTools, []);
    assert.deepEqual((await readJson<{ servers: unknown[] }>(path.join(packageDir, "mcp.json"))).servers, []);
  } finally {
    await server.close();
  }
});

test("PATCH /positions/:id/profile: boundary matrix fails closed before any write or engine call", async () => {
  const driver = new MutableDriver();
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    const packageDir = path.join(dir, "positions", "repo-owner");
    const before = await snapshotPackage(packageDir);
    const declaredBefore = await readText(path.join(dir, "organization.v1alpha1.json"));
    const cases: Array<[string, Record<string, unknown>]> = [
      ["unknown field", { nickname: "x" }],
      ["empty patch", {}],
      ["empty name", { name: "   " }],
      ["oversized name", { name: "名".repeat(43) }],
      ["non-string name", { name: 7 }],
      ["invalid mode", { mode: "autonomous" }],
      ["non-object permissions", { permissions: [] }],
      ["empty tool list is allowed only as an array", { permissions: { tools: "Read", rules: [] } }],
      ["unregistered Skill grant", { permissions: { tools: ["Read"], rules: [], skills: [{ id: "ghost-skill" }] } }],
      ["unregistered MCP grant", { permissions: { tools: ["Read"], rules: [], mcpServers: [{ id: "ghost-server", tools: [] }] } }],
      ["MCP tool outside the catalog", { permissions: { tools: ["Read"], rules: [], mcpServers: [{ id: "issue-tracker", tools: ["delete"] }] } }],
      // #314: a well-formed grant still fails closed while no Host declares "mcp".
      ["MCP grant with no supporting engine", { permissions: { tools: ["Read"], rules: [], mcpServers: [{ id: "issue-tracker", tools: ["search"] }] } }],
      ["rule referencing an unregistered Skill", { permissions: { tools: ["Read"], rules: [{ scope: "position", resource: "skill://ghost", actions: ["execute"] }] } }],
      ["invalid rule scope", { permissions: { tools: ["Read"], rules: [{ scope: "galaxy", resource: "./x", actions: ["read"] }] } }],
      ["empty rule action list", { permissions: { tools: ["Read"], rules: [{ scope: "position", resource: "./x", actions: [] }] } }],
    ];
    for (const [label, body] of cases) {
      const res = await api(server.baseUrl, "/positions/repo-owner/profile", { method: "PATCH", token: server.token, body });
      assert.equal(res.status, 400, label);
      assert.equal((res.body as { code: string }).code, "position_profile_invalid", label);
    }
    assert.equal(driver.calls, 0, "a rejected patch never opens the org apply gate");
    assert.deepEqual(await snapshotPackage(packageDir), before, "a rejected patch never touches the package");
    assert.equal(await readText(path.join(dir, "organization.v1alpha1.json")), declaredBefore);
  } finally {
    await server.close();
  }
});

test("PATCH /positions/:id/profile: an unknown position 404s and a method mismatch 405s", async () => {
  const driver = new MutableDriver();
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    const missing = await api(server.baseUrl, "/positions/ghost-position/profile", {
      method: "PATCH",
      token: server.token,
      body: { name: "Nobody" },
    });
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { code: string }).code, "position_missing");

    const wrongMethod = await api(server.baseUrl, "/positions/repo-owner/profile", { token: server.token });
    assert.equal(wrongMethod.status, 405);
    assert.equal((wrongMethod.body as { code: string }).code, "method_not_allowed");
    assert.equal(driver.calls, 0);
  } finally {
    await server.close();
  }
});

test("PATCH /positions/:id/profile: an edit is refused while the employee has a turn in flight", async () => {
  const driver = new MutableDriver();
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    const packageDir = path.join(dir, "positions", "repo-owner");
    const before = await snapshotPackage(packageDir);

    const held = server.ctx.runningTurns.reserve(dir, "repo-owner", "turn-1");
    try {
      const res = await api(server.baseUrl, "/positions/repo-owner/profile", {
        method: "PATCH",
        token: server.token,
        body: { name: "Mid-flight rename" },
      });
      assert.equal(res.status, 409);
      assert.equal((res.body as { code: string }).code, "session_conflict");
    } finally {
      held.release();
    }
    assert.equal(driver.calls, 0);
    assert.deepEqual(await snapshotPackage(packageDir), before, "a permission change must never land under a running turn");

    const after = await api(server.baseUrl, "/positions/repo-owner/profile", {
      method: "PATCH",
      token: server.token,
      body: { name: "Repo Lead" },
    });
    assert.equal(after.status, 200, "the edit is accepted once the turn releases the employee");
  } finally {
    await server.close();
  }
});

test("PATCH /positions/:id/profile: an engine rejection restores every byte the edit had staged", async () => {
  const driver = new MutableDriver();
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  const sse = connectSse(server.baseUrl, server.token);
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    await api(server.baseUrl, "/hire", { method: "POST", token: server.token, body: HIRE });
    const packageDir = path.join(dir, "positions", "repo-owner", "docs-writer");
    const before = await snapshotPackage(packageDir);
    const declaredBefore = await readText(path.join(dir, "organization.v1alpha1.json"));
    const appliedBefore = await readText(path.join(dir, ".digital-employee", "org.json"));

    driver.outcome = {
      status: "failed",
      code: "workspace_org_budget_not_allocated",
      message: "budget not allocated",
      retryable: false,
    };
    const response = await api(server.baseUrl, "/positions/docs-writer/profile", {
      method: "PATCH",
      token: server.token,
      body: { name: "文档工程师", mode: "approval_required", permissions: PATCHED_PERMISSIONS },
    });
    assert.equal(response.status, 422);
    assert.equal((response.body as { code: string }).code, "workspace_org_budget_not_allocated");

    // The engine is the only validator of the applied model: if its rejection
    // left the edited bytes behind, the package would disagree with org.json and
    // the next unrelated org mutation would silently publish them.
    assert.deepEqual(await snapshotPackage(packageDir), before, "the rejected package must be restored byte for byte");
    assert.equal(await readText(path.join(dir, "organization.v1alpha1.json")), declaredBefore);
    assert.equal(await readText(path.join(dir, ".digital-employee", "org.json")), appliedBefore);
    assert.equal(
      (await readApplied(dir)).roles.find((role) => role.id === "docs-writer")?.name,
      "Docs Writer",
      "the applied model still shows the pre-edit name",
    );
    assert.equal(
      sse.events.some((frame) => frame.event === "org.updated" && frame.data.includes("\"update\"")),
      false,
      "a rejected edit never broadcasts org.updated",
    );
  } finally {
    sse.close();
    await server.close();
  }
});

test("PATCH /positions/:id/profile: a successful edit broadcasts one org.updated carrying the position id", async () => {
  const driver = new MutableDriver();
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  const sse = connectSse(server.baseUrl, server.token);
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    await api(server.baseUrl, "/hire", { method: "POST", token: server.token, body: HIRE });
    // `POST /workspace/open` also broadcasts org.updated (with an empty change
    // list), so match the frame that carries this edit rather than the first.
    const before = sse.events.filter((frame) => frame.event === "org.updated").length;

    const response = await api(server.baseUrl, "/positions/docs-writer/profile", {
      method: "PATCH",
      token: server.token,
      body: { mode: "approval_required" },
    });
    assert.equal(response.status, 200);
    await waitFor(() => sse.events.some(
      (frame) => frame.event === "org.updated" && frame.data.includes("\"update\""),
    ));

    const edits = sse.events
      .filter((frame) => frame.event === "org.updated")
      .slice(before)
      .map((frame) => JSON.parse(frame.data) as { payload: { changes: Array<{ op: string; id: string }> } })
      .filter((frame) => frame.payload.changes.some((change) => change.op === "update"));
    assert.equal(edits.length, 1, "one edit produces exactly one updatable org.updated");
    assert.deepEqual(edits[0]!.payload.changes, [{ op: "update", id: "docs-writer" }]);
    assert.deepEqual(
      await readJson(path.join(dir, "positions", "repo-owner", "docs-writer", ".workbench", "identity.v1.json")),
      { schemaVersion: "workbench-position-identity.v1", name: HIRE.name },
      "a mode-only patch leaves the display name alone",
    );
    assert.equal(
      (await readJson<{ policy: { mode: string } }>(path.join(dir, "positions", "repo-owner", "docs-writer", "employee.json"))).policy.mode,
      "approval_required",
    );
  } finally {
    sse.close();
    await server.close();
  }
});

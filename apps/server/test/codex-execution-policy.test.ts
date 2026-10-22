import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { codexExecutionPlan, applyCodexExecutionPlan } from "../src/codex-execution-policy.js";
import { derivePermissionArtifacts, permissionsFromPackage } from "../src/org/permission-artifacts.js";
import { validatePermissions } from "../src/org/permissions.js";
import { OrgApiError } from "@roleweave/shared";

async function fixture(t: TestContext) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-policy-")));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const position = path.join(workspace, "positions", "engineer");
  const root = path.join(workspace, "repos", "project");
  await fs.mkdir(position, { recursive: true });
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  const permissions = { schemaVersion: "workbench-permissions.v1", nativeExecution: true, network: "deny", tools: ["Read", "Write", "Edit", "Delete", "Exec"], rules: [{ scope: "workspace", resource: "./repos/project/**", actions: ["read", "create", "update", "delete", "execute"], approval: false, effect: "allow" }], mcpServers: [] as unknown[] };
  const employee = { name: "engineer", policy: { mode: "approval_required", network: "deny", filesystem: { read: ["./repos/project/**"], write: ["./repos/project/**"] } } };
  const organization = { roles: [{ id: "engineer", mode: "approval_required" }] };
  const save = async () => { await fs.writeFile(path.join(position, "permissions.json"), JSON.stringify(permissions)); await fs.writeFile(path.join(position, "employee.json"), JSON.stringify(employee)); await fs.writeFile(path.join(workspace, "organization.v1alpha1.json"), JSON.stringify(organization)); };
  await save();
  return { workspace, position, root, permissions, employee, organization, save, read: () => codexExecutionPlan(workspace, position, "engineer") };
}

test("native execution requires consent and revocation is read on the next turn", async t => {
  const f = await fixture(t);
  const plan = await f.read(); assert.ok(plan); assert.deepEqual(plan.roots, [f.root]); assert.deepEqual(plan.gitRoots, [path.join(f.root, ".git")]); assert.equal(plan.network, false);
  f.permissions.nativeExecution = false; await f.save(); assert.equal(await f.read(), null);
  f.permissions.nativeExecution = true; f.employee.policy.mode = "read_only"; await f.save(); assert.equal(await f.read(), null);
  f.employee.policy.mode = "approval_required"; f.organization.roles[0]!.mode = "read_only"; await f.save(); assert.equal(await f.read(), null);
});

test("network requires matching explicit UI and employee consent, never WebFetch alone", async t => {
  const f = await fixture(t); f.permissions.tools.push("WebFetch"); assert.equal((await f.read())?.network, false);
  f.permissions.network = "host_policy"; await f.save(); assert.equal((await f.read())?.network, false);
  f.employee.policy.network = "host_policy"; await f.save(); assert.equal((await f.read())?.network, true);
  f.permissions.network = "deny"; await f.save(); assert.equal((await f.read())?.network, false);
});

for (const [label, change] of [
  ["revoked employee write projection", (f: Awaited<ReturnType<typeof fixture>>) => { f.employee.policy.filesystem.write = []; }],
  ["missing Exec", (f: Awaited<ReturnType<typeof fixture>>) => { f.permissions.tools.pop(); }],
  ["per-action approval", (f: Awaited<ReturnType<typeof fixture>>) => { f.permissions.rules[0]!.approval = true; }],
  ["deny override", (f: Awaited<ReturnType<typeof fixture>>) => { f.permissions.rules.push({ ...f.permissions.rules[0]!, effect: "deny" }); }],
  ["partial actions", (f: Awaited<ReturnType<typeof fixture>>) => { f.permissions.rules[0]!.actions = ["read", "execute"]; }],
  ["MCP binding", (f: Awaited<ReturnType<typeof fixture>>) => { f.permissions.mcpServers.push({ id: "repository" }); }],
] as const) test(`unsupported ${label} fails closed`, async t => { const f = await fixture(t); change(f); await f.save(); await assert.rejects(f.read()); });

for (const resource of ["./**", "./../outside/**", "./positions/**", "./.roleweave/**", "./repos/*/**", "./repos/project/../project/**", "./repos/project / **", "C:/repo/**", "./repos/missing/**"])
  test(`reject unsafe directory grant ${resource}`, async t => { const f = await fixture(t); f.permissions.rules[0]!.resource = resource; f.employee.policy.filesystem = {read: [resource], write: [resource]}; await f.save(); await assert.rejects(f.read()); });

test("reject symlink root and external Git metadata", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await fs.symlink(f.root, path.join(f.workspace, "repos", "alias"));
  f.permissions.rules[0]!.resource = "./repos/alias/**"; f.employee.policy.filesystem = {read: ["./repos/alias/**"], write: ["./repos/alias/**"]}; await f.save(); await assert.rejects(f.read());
  f.permissions.rules[0]!.resource = "./repos/project/**"; f.employee.policy.filesystem = {read: ["./repos/project/**"], write: ["./repos/project/**"]}; await f.save();
  await fs.rm(path.join(f.root, ".git"), { recursive: true }); await fs.writeFile(path.join(f.root, ".git"), "gitdir: /outside"); await assert.rejects(f.read());
});

test("named profile retains isolation and makes only authorized directories writable", async t => {
  const f = await fixture(t); const plan = await f.read(); assert.ok(plan);
  const base = ["exec", "--strict-config", "--ignore-user-config", "--sandbox", "read-only", "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "plugins", "--ephemeral", "--json"];
  assert.equal(applyCodexExecutionPlan(base, null), base);
  const args = applyCodexExecutionPlan(base, plan, "win32");
  assert.ok(!args.includes("--sandbox")); assert.ok(!args.includes("danger-full-access"));
  assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('--strict-config')); assert.ok(args.includes('approval_policy="never"')); assert.ok(args.includes('--ignore-rules'));
  assert.deepEqual(args.filter((_, index) => args[index - 1] === "--disable"), ["plugins"]);
  assert.deepEqual(args.filter((_, index) => args[index - 1] === "--enable"), ["shell_tool", "unified_exec"]);
  const profile = args.find(arg => arg.startsWith("permissions.roleweave-employee.filesystem="))!;
  assert.ok(profile.includes(`${JSON.stringify(f.root)}="write"`)); assert.ok(profile.includes(`${JSON.stringify(path.join(f.root, ".git"))}="write"`)); assert.ok(profile.includes('":root"="read"'));
  assert.ok(!profile.includes(`${JSON.stringify(f.workspace)}="write"`));
  assert.ok(args.includes('windows.sandbox="elevated"'));
  assert.ok(applyCodexExecutionPlan(base, { ...plan, network: true }, 'win32').includes('windows.sandbox="unelevated"')); assert.ok(args.includes("permissions.roleweave-employee.network.enabled=false")); assert.ok(args.includes("features.network_proxy=false"));
});

test("grant validation and package readback preserve execution/network intent", () => {
  const invalid = (message: string) => new OrgApiError("position_profile_invalid", 400, message);
  const permissions = validatePermissions({ tools: ["Exec"], rules: [], nativeExecution: true, network: "host_policy" }, invalid);
  const artifacts = derivePermissionArtifacts(permissions);
  assert.deepEqual(permissionsFromPackage(artifacts.permissionsFile, []), permissions);
  for (const value of [{ nativeExecution: "true" }, { network: "allow" }]) assert.throws(() => validatePermissions({ tools: [], rules: [], ...value }, invalid));
  const revoked = validatePermissions({ tools: [], rules: [], nativeExecution: false, network: "deny" }, invalid);
  assert.deepEqual(permissionsFromPackage(derivePermissionArtifacts(revoked).permissionsFile, []), revoked);
});

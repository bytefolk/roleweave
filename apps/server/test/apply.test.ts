import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { OrgApplyFailure, OrganizationFile } from "@roleweave/shared";
import { buildPositionSkeletonFiles } from "../src/org/apply.js";
import { FakeDriver, api, copyExampleWorkspace, startTestServer } from "./helpers.js";

const STATE_FILES = ["org.json", "org-audit.jsonl", "permissions.json"] as const;

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function readApplied(dir: string): Promise<OrganizationFile> {
  return readJson(path.join(dir, ".digital-employee", "org.json"));
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
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

/** Deterministic test double for the external engine: consumes the proposal
 * tree and writes only the applied model/audit artifacts the server reloads. */
async function emulateEngineApply(dir: string): Promise<void> {
  const model = await readApplied(dir);
  const declared = await readJson<OrganizationFile>(path.join(dir, "organization.v1alpha1.json"));
  const root = path.join(dir, "positions", "repo-owner");
  const docsPath = path.join(root, "docs-writer");
  const docs = model.roles.find((role) => role.id === "docs-writer");
  const hired: OrganizationFile["roles"] = [];
  const moved: Array<{ id: string; from: string | null; to: string | null }> = [];
  const dismissed: OrganizationFile["roles"] = [];
  if ((await exists(docsPath)) && !docs) {
    const employee = await readJson<{ description?: string; policy?: { mode?: string } }>(path.join(docsPath, "employee.json"));
    const budget = await readJson<OrganizationFile["roles"][number]["budget"]>(path.join(docsPath, "budget.json"));
    const role: OrganizationFile["roles"][number] = {
      id: "docs-writer",
      name: "Docs Writer",
      description: employee.description ?? "",
      reportTo: "repo-owner",
      package: {
        name: "docs-writer",
        version: "0.1.0",
        digest: "sha256:fixture",
        localReference: docsPath,
      },
      mode: employee.policy?.mode === "read_only" ? "read_only" : "approval_required",
      memoryScope: "/",
      toolAllow: [],
      toolDeny: [],
      budget,
      metadata: {},
    };
    model.roles.push(role);
    hired.push(role);
  }
  const issue = model.roles.find((role) => role.id === "issue-researcher");
  if (issue) {
    const candidates: Array<{ file: string; reportTo: string | null }> = [
      { file: path.join(docsPath, "issue-researcher"), reportTo: "docs-writer" },
      { file: path.join(dir, "positions", "issue-researcher"), reportTo: null },
      { file: path.join(root, "issue-researcher"), reportTo: "repo-owner" },
    ];
    for (const candidate of candidates) {
      if (!(await exists(candidate.file))) continue;
      if (issue.reportTo !== candidate.reportTo) {
        moved.push({ id: issue.id, from: issue.reportTo, to: candidate.reportTo });
      }
      issue.reportTo = candidate.reportTo;
      issue.package.localReference = candidate.file;
      break;
    }
  }
  if (!(await exists(path.join(root, "community-operator")))) {
    const index = model.roles.findIndex((role) => role.id === "community-operator");
    if (index >= 0) dismissed.push(...model.roles.splice(index, 1));
  } else if (!model.roles.some((role) => role.id === "community-operator")) {
    const restored = declared.roles.find((role) => role.id === "community-operator");
    if (restored) {
      const hydrated = structuredClone(restored);
      hydrated.package.localReference = path.join(root, "community-operator");
      model.roles.push(hydrated);
      hired.push(hydrated);
    }
  }
  model.updatedAt = new Date(Date.now() + 1000).toISOString();
  const runtime = path.join(dir, ".digital-employee");
  await fs.writeFile(path.join(runtime, "org.json"), `${JSON.stringify(model, null, 2)}\n`, { mode: 0o600 });
  await fs.appendFile(
    path.join(runtime, "org-audit.jsonl"),
    `${JSON.stringify({
      schemaVersion: "org-audit.v1",
      at: model.updatedAt,
      actor: "digital-employee org apply",
      workspace: dir,
      bootstrapped: false,
      changes: { hired, moved, dismissed, budgetUpdated: [] },
      positionCount: model.roles.length,
    })}\n`,
    { mode: 0o600 },
  );
}

async function appliedBytes(dir: string): Promise<Map<string, Buffer>> {
  return new Map(
    await Promise.all(STATE_FILES.map(async (file) => [file, await fs.readFile(path.join(dir, ".digital-employee", file))] as const)),
  );
}

async function assertAppliedBytes(dir: string, expected: Map<string, Buffer>): Promise<void> {
  for (const file of STATE_FILES) {
    assert.deepEqual(await fs.readFile(path.join(dir, ".digital-employee", file)), expected.get(file), file);
  }
}

test("org apply: rejection keeps the proposal tree and applied state is byte-identical", async () => {
  const driver = new FakeDriver({
    status: "failed",
    code: "workspace_org_budget_missing",
    message: "position budget missing",
    retryable: false,
  });
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    const before = await appliedBytes(dir);
    const res = await api(server.baseUrl, "/org/apply", {
      method: "POST", token: server.token,
      body: { schemaVersion: "change-manifest.v1", changes: [{ op: "delete", id: "community-operator" }] },
    });
    assert.equal(res.status, 422);
    const body = res.body as OrgApplyFailure;
    assert.equal(body.code, "workspace_org_budget_missing");
    assert.deepEqual(driver.calls, [dir], "engine receives workspace, not staging");
    await assertAppliedBytes(dir, before);
    const backups = await fs.readdir(path.join(dir, ".digital-employee", "backup"));
    assert.ok(
      backups.some((entry) => entry.startsWith("community-operator-")),
      "rejected dismiss retains the package in the backup tray (no automatic rollback)",
    );
    assert.ok(
      (await fs.stat(path.join(dir, ".digital-employee", "backup", backups.find((entry) => entry.startsWith("community-operator-"))!, "employee.json"))).isFile(),
    );
    await assert.rejects(fs.stat(path.join(dir, ".digital-employee", "staging")));
    await assert.rejects(fs.stat(path.join(dir, ".digital-employee", "apply-log.ndjson")));
    assert.equal("rejectedStaging" in (body as unknown as Record<string, unknown>), false);
  } finally {
    await server.close();
  }
});

test("org apply: hire/move/dismiss materialize the proposal, reload applied org, and retain backup", async () => {
  const driver = new FakeDriver({ status: "applied" }, emulateEngineApply);
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    const hire = await api(server.baseUrl, "/hire", {
      method: "POST", token: server.token,
      body: {
        positionId: "docs-writer",
        name: "Docs Writer",
        description: "Keeps documentation current.",
        reportTo: "repo-owner",
        mode: "read_only",
        budget: { perTask: { tokens: 20000, iterations: 8 }, perDay: { tokens: 200000, iterations: 64 } },
      },
    });
    assert.equal(hire.status, 200);
    const hired = hire.body as { status: string; version: { updatedAt: string } };
    assert.equal(hired.status, "hired");
    assert.ok((await readApplied(dir)).roles.some((role) => role.id === "docs-writer"));
    assert.equal((await api(server.baseUrl, "/org/tree", { token: server.token }).then((res) => res.body) as { updatedAt: string }).updatedAt, hired.version.updatedAt);

    const move = await api(server.baseUrl, "/org/apply", {
      method: "POST", token: server.token,
      body: { schemaVersion: "change-manifest.v1", changes: [{ op: "move", id: "issue-researcher", reportTo: "docs-writer" }] },
    });
    assert.equal(move.status, 200);
    assert.equal((await readApplied(dir)).roles.find((role) => role.id === "issue-researcher")?.reportTo, "docs-writer");
    assert.ok(await exists(path.join(dir, "positions", "repo-owner", "docs-writer", "issue-researcher")));

    const disband = await api(server.baseUrl, "/org/apply", {
      method: "POST", token: server.token,
      body: { schemaVersion: "change-manifest.v1", changes: [{ op: "delete", id: "community-operator" }] },
    });
    assert.equal(disband.status, 200);
    assert.equal((await readApplied(dir)).roles.some((role) => role.id === "community-operator"), false);
    const backups = await fs.readdir(path.join(dir, ".digital-employee", "backup"));
    assert.ok(backups.some((entry) => entry.startsWith("community-operator-")));
    assert.deepEqual(driver.calls, [dir, dir, dir]);
    await assert.rejects(fs.stat(path.join(dir, ".digital-employee", "apply-log.ndjson")));

    const reports = await api(server.baseUrl, "/reports", { token: server.token });
    const audits = (reports.body as { streams: { audits: Array<{ schemaVersion: string }> } }).streams.audits;
    assert.equal(audits[0]?.schemaVersion, "org-audit.v1");
    assert.equal(audits.length, 4);
  } finally {
    await server.close();
  }
});

test("org restore: lists auditable backups, restores once, and makes a repeated request idempotent", async () => {
  const driver = new FakeDriver({ status: "applied" }, emulateEngineApply);
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    const disband = await api(server.baseUrl, "/org/apply", {
      method: "POST", token: server.token,
      body: { schemaVersion: "change-manifest.v1", changes: [{ op: "delete", id: "community-operator" }] },
    });
    assert.equal(disband.status, 200);

    const listed = await api(server.baseUrl, "/org/backups", { token: server.token });
    assert.equal(listed.status, 200);
    const backups = (listed.body as { backups: Array<{ backupId: string; positionId: string; reportTo: string | null }> }).backups;
    assert.equal(backups.length, 1);
    assert.equal(backups[0]?.positionId, "community-operator");
    assert.equal(backups[0]?.reportTo, "repo-owner");

    const first = await api(server.baseUrl, "/org/restore", {
      method: "POST", token: server.token, body: { backupId: backups[0]!.backupId },
    });
    assert.equal(first.status, 200);
    assert.equal((first.body as { restored: boolean }).restored, true);
    assert.ok((await readApplied(dir)).roles.some((role) => role.id === "community-operator"));

    const repeated = await api(server.baseUrl, "/org/restore", {
      method: "POST", token: server.token, body: { backupId: backups[0]!.backupId },
    });
    assert.equal(repeated.status, 200);
    assert.equal((repeated.body as { restored: boolean }).restored, false);
    assert.equal(driver.calls.length, 2, "repeat does not call the engine after readback proves the position applied");
  } finally {
    await server.close();
  }
});

test("org restore: rejects a conflicting proposal and preserves the backup", async () => {
  const driver = new FakeDriver({ status: "applied" }, emulateEngineApply);
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    await api(server.baseUrl, "/org/apply", {
      method: "POST", token: server.token,
      body: { schemaVersion: "change-manifest.v1", changes: [{ op: "delete", id: "community-operator" }] },
    });
    const listed = await api(server.baseUrl, "/org/backups", { token: server.token });
    const backupId = (listed.body as { backups: Array<{ backupId: string }> }).backups[0]!.backupId;
    const conflicting = path.join(dir, "positions", "repo-owner", "community-operator");
    await fs.cp(path.join(dir, ".digital-employee", "backup", backupId), conflicting, { recursive: true });

    const restored = await api(server.baseUrl, "/org/restore", {
      method: "POST", token: server.token, body: { backupId },
    });
    assert.equal(restored.status, 409);
    assert.equal((restored.body as { code: string }).code, "restore_conflict");
    assert.ok(await exists(path.join(dir, ".digital-employee", "backup", backupId)));
    assert.equal(driver.calls.length, 1);
  } finally {
    await server.close();
  }
});

test("org restore: engine refusal preserves applied bytes and the restored proposal for explicit retry", async () => {
  let refuse = false;
  const driver = new FakeDriver({ status: "applied" }, async (dir) => {
    if (!refuse) await emulateEngineApply(dir);
  });
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    await api(server.baseUrl, "/org/apply", {
      method: "POST", token: server.token,
      body: { schemaVersion: "change-manifest.v1", changes: [{ op: "delete", id: "community-operator" }] },
    });
    const listed = await api(server.baseUrl, "/org/backups", { token: server.token });
    const backupId = (listed.body as { backups: Array<{ backupId: string }> }).backups[0]!.backupId;
    const before = await appliedBytes(dir);
    refuse = true;
    driver.outcome = {
      status: "failed",
      code: "workspace_org_budget_not_allocated",
      message: "restored position budget is not allocated",
      retryable: false,
    };

    const restored = await api(server.baseUrl, "/org/restore", {
      method: "POST", token: server.token, body: { backupId },
    });
    assert.equal(restored.status, 422);
    assert.equal((restored.body as { code: string }).code, "workspace_org_budget_not_allocated");
    await assertAppliedBytes(dir, before);
    assert.ok(await exists(path.join(dir, "positions", "repo-owner", "community-operator")), "restore proposal remains available for correction/retry");
    assert.equal(await exists(path.join(dir, ".digital-employee", "backup", backupId)), false);
  } finally {
    await server.close();
  }
});

test("org apply: reportTo=null moves a position to the positions root", async () => {
  const driver = new FakeDriver({ status: "applied" }, emulateEngineApply);
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    const res = await api(server.baseUrl, "/org/apply", {
      method: "POST", token: server.token,
      body: { schemaVersion: "change-manifest.v1", changes: [{ op: "move", id: "issue-researcher", reportTo: null }] },
    });
    assert.equal(res.status, 200);
    assert.ok(await exists(path.join(dir, "positions", "issue-researcher")));
  } finally {
    await server.close();
  }
});

test("org apply: shape/conflict failures do not mutate proposal tree or call engine", async () => {
  const driver = new FakeDriver({ status: "applied" });
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    // The former `add` op is gone: employee creation flows only through POST /hire.
    const legacyAdd = {
      schemaVersion: "change-manifest.v1",
      changes: [{ op: "add", position: {
        id: "no-budget", name: "No Budget", description: "x", reportTo: "repo-owner",
        mode: "read_only", budget: { perTask: { tokens: 1 }, perDay: { tokens: 2 } },
      } }],
    };
    const legacyRes = await api(server.baseUrl, "/org/apply", { method: "POST", token: server.token, body: legacyAdd });
    assert.equal(legacyRes.status, 400);
    assert.equal((legacyRes.body as { code: string }).code, "manifest_invalid");
    const ownerRes = await api(server.baseUrl, "/org/apply", {
      method: "POST", token: server.token,
      body: { schemaVersion: "change-manifest.v1", changes: [{ op: "delete", id: "repo-owner" }] },
    });
    assert.equal((ownerRes.body as { code: string }).code, "org_apply_owner_delete");
    assert.equal(driver.calls.length, 0);
    await assert.rejects(fs.stat(path.join(dir, "positions", "repo-owner", "no-budget")));
  } finally {
    await server.close();
  }
});

test("org apply: position ids use the digital-employee authority pattern", async () => {
  const driver = new FakeDriver({
    status: "failed",
    code: "fixture_rejected_after_manifest_validation",
    message: "fixture stops after the D2 boundary",
    retryable: false,
  });
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", {
      method: "POST", token: server.token, body: { path: dir },
    });
    const hireBody = (positionId: string) => ({
      positionId,
      name: "Docs Writer",
      description: "Keeps documentation current.",
      reportTo: "repo-owner",
      mode: "read_only",
      budget: { perTask: { tokens: 20000 }, perDay: { tokens: 200000 } },
    });
    const accepted = await api(server.baseUrl, "/hire", {
      method: "POST", token: server.token, body: hireBody("7x"),
    });
    assert.equal(accepted.status, 422);
    assert.equal((accepted.body as { code: string }).code, "fixture_rejected_after_manifest_validation");
    assert.deepEqual(driver.calls, [dir]);

    for (const id of ["a--b", "a-"]) {
      const rejected = await api(server.baseUrl, "/hire", {
        method: "POST",
        token: server.token,
        body: hireBody(id),
      });
      assert.equal(rejected.status, 400);
      assert.equal((rejected.body as { code: string }).code, "hire_request_invalid");
    }
    assert.deepEqual(driver.calls, [dir]);
  } finally {
    await server.close();
  }
});

test("org apply: maxDepth=8 rejects before mutating the proposal", async () => {
  const driver = new FakeDriver({ status: "applied" });
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    const packageSource = path.join(dir, "positions", "repo-owner", "release-engineer");
    let parent = path.join(dir, "positions", "repo-owner", "issue-researcher");
    for (let depth = 3; depth <= 8; depth += 1) {
      const child = path.join(parent, `level-${depth}`);
      await fs.cp(packageSource, child, { recursive: true });
      parent = child;
    }
    await api(server.baseUrl, "/workspace/open", {
      method: "POST", token: server.token, body: { path: dir },
    });
    const community = path.join(dir, "positions", "repo-owner", "community-operator");
    const res = await api(server.baseUrl, "/org/apply", {
      method: "POST", token: server.token,
      body: {
        schemaVersion: "change-manifest.v1",
        changes: [{ op: "move", id: "community-operator", reportTo: "level-8" }],
      },
    });
    assert.equal(res.status, 422);
    assert.equal((res.body as { code: string }).code, "org_apply_max_depth");
    assert.ok(await exists(community), "preflight rejection leaves the source directory in place");
    assert.equal(driver.calls.length, 0);
  } finally {
    await server.close();
  }
});

test("buildPositionSkeletonFiles: numeric position ids stay quoted in SKILL.md frontmatter", () => {
  const files = buildPositionSkeletonFiles({
    id: "1234",
    name: "Numeric Id",
    description: "Regression test for employee_skill_name_mismatch (#86).",
    mode: "read_only",
    budget: { perTask: { tokens: 1000 }, perDay: { tokens: 2000 } },
  });
  const employee = JSON.parse(files.get("employee.json")!) as { name: unknown };
  const frontmatterName = files.get("SKILL.md")!.match(/^name: (.+)$/m)?.[1];
  // An unquoted all-digit YAML scalar parses as a number, not the string
  // digital-employee compares it against — the frontmatter must carry the
  // same JSON-quoted form as employee.json's `name` field.
  assert.equal(frontmatterName, JSON.stringify(employee.name));
});

/**
 * #92: the invariant that matters is not a constant but a relationship — the
 * longest description POST /hire accepts must still satisfy every upstream
 * bound the staged package is validated against. Asserting a hardcoded number
 * here would neither have caught the original 2048-byte/1024-character
 * mismatch nor prevent the next drift.
 *
 * Upstream bounds mirrored (digital-employee):
 *   - SKILL.md frontmatter: `description.length > 1_024` → employee_skill_description_required
 *     (apps/cli/employee-package.ts, validateSkillFrontmatter)
 *   - employee.json: requireString default maxLength 2_000 → employee_package_invalid_field:description
 *     (packages/core/src/employee-package.ts)
 */
const UPSTREAM_FRONTMATTER_DESCRIPTION_MAX = 1_024;
const UPSTREAM_MANIFEST_DESCRIPTION_MAX = 2_000;

test("hire gate: the longest accepted description survives every upstream description bound (#92)", async () => {
  const server = await startTestServer(new FakeDriver({ status: "applied" }));
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    const hireBody = (description: string) => ({
      positionId: "docs-writer",
      name: "Docs Writer",
      description,
      reportTo: "repo-owner",
      mode: "read_only",
      budget: { perTask: { tokens: 20000 }, perDay: { tokens: 200000 } },
    });
    // Binary-search the true accepted maximum through the real request gate,
    // rather than trusting the constant the gate happens to declare.
    let accepted = 0;
    let low = 1;
    let high = 4096;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const res = await api(server.baseUrl, "/hire", {
        method: "POST", token: server.token, body: hireBody("a".repeat(middle)),
      });
      if (res.status === 400 && (res.body as { code: string }).code === "hire_request_invalid") {
        high = middle - 1;
      } else {
        accepted = middle;
        low = middle + 1;
      }
    }
    assert.ok(accepted > 0, "the gate must accept some description");

    // The bytes that reach upstream come from the skeleton builder, so assert
    // against the generated artifacts rather than the request payload.
    const files = buildPositionSkeletonFiles({
      id: "docs-writer",
      name: "Docs Writer",
      description: "a".repeat(accepted),
      mode: "read_only",
      budget: { perTask: { tokens: 20000 }, perDay: { tokens: 200000 } },
    });
    const frontmatter = files.get("SKILL.md")!.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1]!;
    const frontmatterDescription = JSON.parse(frontmatter.match(/^description: (.+)$/m)![1]!) as string;
    assert.ok(
      frontmatterDescription.length <= UPSTREAM_FRONTMATTER_DESCRIPTION_MAX,
      `accepted description of ${accepted} chars yields ${frontmatterDescription.length} in SKILL.md frontmatter, over the upstream ${UPSTREAM_FRONTMATTER_DESCRIPTION_MAX} bound`,
    );
    const employee = JSON.parse(files.get("employee.json")!) as { description: string };
    assert.ok(
      employee.description.length <= UPSTREAM_MANIFEST_DESCRIPTION_MAX,
      `accepted description exceeds the upstream employee.json bound of ${UPSTREAM_MANIFEST_DESCRIPTION_MAX}`,
    );
  } finally {
    await server.close();
  }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { OrgApplySuccess, OrgTreeSnapshot, OrgUndoSuccess, OrganizationFile } from "@roleweave/shared";
import { FakeDriver, api, assertPosixMode, connectSse, copyExampleWorkspace, startTestServer } from "./helpers.js";

const LAYOUT_FILE = path.join(".digital-employee", "org-layout.v1.json");
const UNDO_FILE = path.join(".digital-employee", "org-undo.v1.json");
const APPLIED_MODEL = path.join(".digital-employee", "org.json");

const REORDER_REPO_OWNER = {
  schemaVersion: "change-manifest.v1",
  changes: [
    {
      op: "reorder",
      parentId: "repo-owner",
      order: ["release-engineer", "community-operator", "issue-researcher"],
    },
  ],
};

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
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

/** Deterministic engine stub: reportTo follows the proposal directory tree. */
async function emulateEngineFromProposalTree(dir: string): Promise<void> {
  const parents = new Map<string, string | null>();
  const scan = async (current: string, parent: string | null): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const childDir = path.join(current, entry.name);
      let isPosition = false;
      try {
        isPosition = (await fs.stat(path.join(childDir, "employee.json"))).isFile();
      } catch {
        isPosition = false;
      }
      if (!isPosition) continue;
      parents.set(entry.name, parent);
      await scan(childDir, entry.name);
    }
  };
  await scan(path.join(dir, "positions"), null);
  const modelFile = path.join(dir, APPLIED_MODEL);
  const model = await readJson<OrganizationFile>(modelFile);
  for (const role of model.roles) {
    if (parents.has(role.id)) role.reportTo = parents.get(role.id) ?? null;
  }
  model.roles = model.roles.filter((role) => parents.has(role.id));
  model.updatedAt = new Date(Date.now() + 1000).toISOString();
  await fs.writeFile(modelFile, `${JSON.stringify(model, null, 2)}\n`, { mode: 0o600 });
}

function treeChildIds(snapshot: OrgTreeSnapshot, parentId: string | null): string[] {
  const walk = (nodes: OrgTreeSnapshot["tree"]): OrgTreeSnapshot["tree"] | null => {
    for (const node of nodes) {
      if (parentId === null) return snapshot.tree;
      if (node.id === parentId) return node.children;
      const found = walk(node.children);
      if (found) return found;
    }
    return null;
  };
  if (parentId === null) return snapshot.tree.map((node) => node.id);
  const children = walk(snapshot.tree);
  return (children ?? []).map((node) => node.id);
}

async function treeSnapshot(baseUrl: string, token: string): Promise<OrgTreeSnapshot> {
  const res = await api(baseUrl, "/org/tree", { token });
  assert.equal(res.status, 200);
  return res.body as OrgTreeSnapshot;
}

test("org reorder: overlay persists without engine, snapshot reorders, org.updated published", async () => {
  const driver = new FakeDriver({ status: "applied" });
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  const sse = connectSse(server.baseUrl, server.token);
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    const before = await treeSnapshot(server.baseUrl, server.token);
    assert.deepEqual(treeChildIds(before, "repo-owner"), [
      "community-operator",
      "issue-researcher",
      "release-engineer",
    ]);

    const res = await api(server.baseUrl, "/org/apply", {
      method: "POST",
      token: server.token,
      body: REORDER_REPO_OWNER,
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as OrgApplySuccess).changesApplied, 1);
    assert.deepEqual(driver.calls, [], "reorder-only manifests never reach the engine");

    const overlay = await readJson<{ schemaVersion: string; order: Record<string, string[]> }>(
      path.join(dir, LAYOUT_FILE),
    );
    assert.equal(overlay.schemaVersion, "org-layout.v1");
    assert.deepEqual(overlay.order["repo-owner"], ["release-engineer", "community-operator", "issue-researcher"]);
    await assertPosixMode(path.join(dir, LAYOUT_FILE), 0o600);

    const after = await treeSnapshot(server.baseUrl, server.token);
    assert.deepEqual(treeChildIds(after, "repo-owner"), ["release-engineer", "community-operator", "issue-researcher"]);
    assert.ok(await exists(path.join(dir, UNDO_FILE)), "reorder saves an undo entry");

    const deadline = Date.now() + 5000;
    let reorderEvent: { payload: { changes: Array<{ op: string; id: string }> } } | undefined;
    while (!reorderEvent && Date.now() < deadline) {
      const frame = sse.events.find((candidate) => {
        if (candidate.event !== "org.updated") return false;
        const parsed = JSON.parse(candidate.data) as { payload: { changes: Array<{ op: string }> } };
        return parsed.payload.changes.some((change) => change.op === "reorder");
      });
      reorderEvent = frame ? (JSON.parse(frame.data) as typeof reorderEvent) : undefined;
      if (!reorderEvent) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(reorderEvent, "org.updated with the reorder digest must be published");
    assert.deepEqual(reorderEvent!.payload.changes, [{ op: "reorder", id: "repo-owner" }]);
  } finally {
    sse.close();
    await server.close();
  }
});

test("org reorder: shape and set violations are rejected before touching the overlay", async () => {
  const server = await startTestServer(new FakeDriver({ status: "applied" }));
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    const applyReorder = (changes: unknown[]) =>
      api(server.baseUrl, "/org/apply", {
        method: "POST",
        token: server.token,
        body: { schemaVersion: "change-manifest.v1", changes },
      });

    const empty = await applyReorder([{ op: "reorder", parentId: "repo-owner", order: [] }]);
    assert.equal(empty.status, 400);
    assert.equal((empty.body as { code: string }).code, "manifest_invalid");

    const duplicateEntry = await applyReorder([
      { op: "reorder", parentId: "repo-owner", order: ["issue-researcher", "issue-researcher"] },
    ]);
    assert.equal(duplicateEntry.status, 400);

    const duplicateParent = await applyReorder([
      { op: "reorder", parentId: "repo-owner", order: ["release-engineer", "community-operator", "issue-researcher"] },
      { op: "reorder", parentId: "repo-owner", order: ["issue-researcher", "community-operator", "release-engineer"] },
    ]);
    assert.equal(duplicateParent.status, 400);

    const setMismatch = await applyReorder([
      { op: "reorder", parentId: "repo-owner", order: ["issue-researcher", "release-engineer", "docs-writer"] },
    ]);
    assert.equal(setMismatch.status, 422);
    assert.equal((setMismatch.body as { code: string }).code, "org_reorder_set_mismatch");

    const subset = await applyReorder([
      { op: "reorder", parentId: "repo-owner", order: ["issue-researcher", "release-engineer"] },
    ]);
    assert.equal(subset.status, 422);
    assert.equal((subset.body as { code: string }).code, "org_reorder_set_mismatch");

    const parentMissing = await applyReorder([
      { op: "reorder", parentId: "docs-writer", order: ["issue-researcher"] },
    ]);
    assert.equal(parentMissing.status, 422);
    assert.equal((parentMissing.body as { code: string }).code, "org_apply_position_missing");

    const overlay = await readJson<{ order: Record<string, string[]> }>(path.join(dir, LAYOUT_FILE));
    assert.deepEqual(
      overlay.order["repo-owner"],
      ["community-operator", "issue-researcher", "release-engineer"],
      "rejected reorders leave the open-time overlay untouched",
    );
    assert.equal(await exists(path.join(dir, UNDO_FILE)), false);
  } finally {
    await server.close();
  }
});

test("org apply: mixed move+reorder stays atomic; undo reverses both, second undo is 404", async () => {
  const driver = new FakeDriver({ status: "applied" }, emulateEngineFromProposalTree);
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });

    const mixed = await api(server.baseUrl, "/org/apply", {
      method: "POST",
      token: server.token,
      body: {
        schemaVersion: "change-manifest.v1",
        changes: [
          { op: "move", id: "issue-researcher", reportTo: null },
          { op: "reorder", parentId: "repo-owner", order: ["release-engineer", "community-operator"] },
        ],
      },
    });
    assert.equal(mixed.status, 200);
    assert.deepEqual(driver.calls, [dir]);
    const afterApply = await treeSnapshot(server.baseUrl, server.token);
    assert.deepEqual(treeChildIds(afterApply, null), ["repo-owner", "issue-researcher"]);
    assert.deepEqual(treeChildIds(afterApply, "repo-owner"), ["release-engineer", "community-operator"]);

    const undone = await api(server.baseUrl, "/org/undo", { method: "POST", token: server.token, body: {} });
    assert.equal(undone.status, 200);
    assert.equal((undone.body as OrgUndoSuccess).status, "undone");
    assert.equal(driver.calls.length, 2, "undo replays the inverse move through the engine");
    const afterUndo = await treeSnapshot(server.baseUrl, server.token);
    assert.deepEqual(treeChildIds(afterUndo, null), ["repo-owner"]);
    assert.deepEqual(treeChildIds(afterUndo, "repo-owner"), [
      "community-operator",
      "issue-researcher",
      "release-engineer",
    ]);
    assert.equal(await exists(path.join(dir, UNDO_FILE)), false, "undo entry consumed");
    const model = await readJson<OrganizationFile>(path.join(dir, APPLIED_MODEL));
    assert.equal(model.roles.find((role) => role.id === "issue-researcher")?.reportTo, "repo-owner");

    const second = await api(server.baseUrl, "/org/undo", { method: "POST", token: server.token, body: {} });
    assert.equal(second.status, 404);
    assert.equal((second.body as { code: string }).code, "not_found");
  } finally {
    await server.close();
  }
});

test("org undo: a reorder-only entry restores the previous order without the engine", async () => {
  const driver = new FakeDriver({ status: "applied" });
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    await api(server.baseUrl, "/org/apply", { method: "POST", token: server.token, body: REORDER_REPO_OWNER });

    const undone = await api(server.baseUrl, "/org/undo", { method: "POST", token: server.token, body: {} });
    assert.equal(undone.status, 200);
    assert.deepEqual(driver.calls, []);
    const after = await treeSnapshot(server.baseUrl, server.token);
    assert.deepEqual(treeChildIds(after, "repo-owner"), [
      "community-operator",
      "issue-researcher",
      "release-engineer",
    ]);

    const second = await api(server.baseUrl, "/org/undo", { method: "POST", token: server.token, body: {} });
    assert.equal(second.status, 404);
  } finally {
    await server.close();
  }
});

test("org apply: structural hire/delete clears the undo entry (restore stays with backups)", async () => {
  const driver = new FakeDriver({ status: "applied" }, emulateEngineFromProposalTree);
  const server = await startTestServer(driver);
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    await api(server.baseUrl, "/org/apply", { method: "POST", token: server.token, body: REORDER_REPO_OWNER });
    assert.ok(await exists(path.join(dir, UNDO_FILE)));

    const disband = await api(server.baseUrl, "/org/apply", {
      method: "POST",
      token: server.token,
      body: { schemaVersion: "change-manifest.v1", changes: [{ op: "delete", id: "community-operator" }] },
    });
    assert.equal(disband.status, 200);
    assert.equal(await exists(path.join(dir, UNDO_FILE)), false, "delete clears the single-step undo entry");

    const undo = await api(server.baseUrl, "/org/undo", { method: "POST", token: server.token, body: {} });
    assert.equal(undo.status, 404);
  } finally {
    await server.close();
  }
});

test("org layout: manual order survives reopen and reconciles added/removed roles (D-32-3)", async () => {
  const server = await startTestServer(new FakeDriver({ status: "applied" }));
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    await api(server.baseUrl, "/org/apply", { method: "POST", token: server.token, body: REORDER_REPO_OWNER });

    // Simulate an out-of-band sync: one role removed, one role added.
    const modelFile = path.join(dir, APPLIED_MODEL);
    const model = await readJson<OrganizationFile>(modelFile);
    model.roles = model.roles.filter((role) => role.id !== "community-operator");
    const donor = model.roles.find((role) => role.id === "release-engineer")!;
    model.roles.push({
      ...structuredClone(donor),
      id: "new-hire",
      name: "New Hire",
      reportTo: "repo-owner",
    });
    await fs.writeFile(modelFile, `${JSON.stringify(model, null, 2)}\n`, { mode: 0o600 });
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });

    const snapshot = await treeSnapshot(server.baseUrl, server.token);
    assert.deepEqual(
      treeChildIds(snapshot, "repo-owner"),
      ["release-engineer", "issue-researcher", "new-hire"],
      "removed ids drop, manual order kept, new ids append",
    );
    const overlay = await readJson<{ order: Record<string, string[]> }>(path.join(dir, LAYOUT_FILE));
    assert.deepEqual(overlay.order["repo-owner"], ["release-engineer", "issue-researcher", "new-hire"]);
  } finally {
    await server.close();
  }
});

test("org layout: missing or corrupt overlay falls back to alphabetical ordering", async () => {
  const server = await startTestServer(new FakeDriver({ status: "applied" }));
  const dir = await copyExampleWorkspace();
  try {
    await seedAppliedState(dir);
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    const fresh = await treeSnapshot(server.baseUrl, server.token);
    assert.deepEqual(treeChildIds(fresh, "repo-owner"), [
      "community-operator",
      "issue-researcher",
      "release-engineer",
    ]);

    await fs.writeFile(path.join(dir, LAYOUT_FILE), "{not json", "utf8");
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    const recovered = await treeSnapshot(server.baseUrl, server.token);
    assert.deepEqual(treeChildIds(recovered, "repo-owner"), [
      "community-operator",
      "issue-researcher",
      "release-engineer",
    ]);
    const overlay = await readJson<{ schemaVersion: string }>(path.join(dir, LAYOUT_FILE));
    assert.equal(overlay.schemaVersion, "org-layout.v1", "corrupt overlay is rewritten on reconcile");
  } finally {
    await server.close();
  }
});

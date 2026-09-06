import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { OrgTreeSnapshot } from "@roleweave/shared";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

test("workspace: open example, org-tree.v1 snapshot, invalid skeleton rejected", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    const open = await api(server.baseUrl, "/workspace/open", {
      method: "POST",
      token: server.token,
      body: { path: dir },
    });
    assert.equal(open.status, 200);
    assert.equal((open.body as { open: boolean }).open, true);

    const tree = await api(server.baseUrl, "/org/tree", { token: server.token });
    assert.equal(tree.status, 200);
    const snapshot = tree.body as OrgTreeSnapshot;
    assert.equal(snapshot.schemaVersion, "org-tree.v1");
    assert.equal(snapshot.owner, "repo-owner");
    assert.equal(snapshot.business, "oss-maintainer");
    assert.equal(snapshot.positionCount, 4, "oss-maintainer is 1 owner + 3 positions");
    assert.equal(snapshot.depth, 2);
    assert.equal(typeof snapshot.updatedAt, "string");
    assert.equal(snapshot.tree.length, 1);
    const root = snapshot.tree[0];
    assert.ok(root, "root node present");
    assert.equal(root.id, "repo-owner");
    assert.equal(root.reportTo, null);
    assert.ok(root.budget, "root budget declared");
    assert.equal(root.children.length, 3);
    for (const child of root.children) {
      assert.ok(child.budget, `position ${child.id} must carry a budget declaration`);
    }

    const position = await api(server.baseUrl, "/positions/repo-owner", { token: server.token });
    assert.equal(position.status, 200);
    const card = position.body as {
      position: {
        budget: unknown;
        contextScope: string;
        contextSources: Array<{
          kind: string;
          name: string;
          locator: string;
          binding: string;
          state: string;
          itemCount?: number;
        }>;
      };
    };
    assert.ok(card.position.budget);
    assert.equal(typeof card.position.contextScope, "string");
    assert.deepEqual(
      card.position.contextSources.map((source) => source.kind),
      ["workspace_docs", "mem_drive", "context_provider"],
    );
    assert.equal(card.position.contextSources[0]?.name, "岗位知识库");
    assert.equal(card.position.contextSources[0]?.binding, "bound");
    assert.equal(card.position.contextSources[0]?.state, "ready");
    assert.ok((card.position.contextSources[0]?.itemCount ?? 0) > 0);
    assert.equal(card.position.contextSources[1]?.name, "统一网盘");
    assert.equal(card.position.contextSources[1]?.binding, "available");
    assert.ok(["ready", "not_configured"].includes(card.position.contextSources[1]?.state ?? ""));
    assert.equal(card.position.contextSources[2]?.locator, "context://position/repo-owner");

    const missing = await api(server.baseUrl, "/positions/does-not-exist", { token: server.token });
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { code: string }).code, "position_missing");

    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-invalid-"));
    const invalid = await api(server.baseUrl, "/workspace/open", {
      method: "POST",
      token: server.token,
      body: { path: emptyDir },
    });
    assert.equal(invalid.status, 422);
    assert.equal((invalid.body as { code: string }).code, "workspace_invalid");
  } finally {
    await server.close();
  }
});

test("workspace: create a blank project with a generated owner and never overwrite an existing directory", async () => {
  const server = await startTestServer();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "owb-project-parent-"));
  try {
    const created = await api(server.baseUrl, "/workspace/create", {
      method: "POST",
      token: server.token,
      body: {
        parentPath: parent,
        projectId: "content-ops",
        business: "内容运营",
        description: "把项目目标拆成可执行的员工任务。",
      },
    });
    assert.equal(created.status, 201);
    const createdBody = created.body as { open: boolean; created: boolean; next: string; path: string; owner: string; business: string };
    assert.equal(createdBody.open, true);
    assert.equal(createdBody.created, true);
    assert.equal(createdBody.next, "create_employee");
    assert.equal(createdBody.owner, "content-ops-owner");
    assert.equal(createdBody.business, "内容运营");

    const project = path.join(parent, "content-ops");
    assert.equal(createdBody.path, path.join(await fs.realpath(parent), "content-ops"));
    for (const file of [
      "workspace.json",
      "organization.v1alpha1.json",
      "positions/content-ops-owner/employee.json",
      "positions/content-ops-owner/SKILL.md",
      "positions/content-ops-owner/budget.json",
      "context/README.md",
    ]) {
      await fs.stat(path.join(project, file));
    }
    const owner = JSON.parse(await fs.readFile(path.join(project, "organization.v1alpha1.json"), "utf8")) as { owner: string; roles: Array<{ id: string; reportTo: string | null }> };
    assert.equal(owner.owner, "content-ops-owner");
    assert.equal(owner.roles.length, 1);
    assert.equal(owner.roles[0]?.id, "content-ops-owner");
    assert.equal(owner.roles[0]?.reportTo, null);

    const conflict = await api(server.baseUrl, "/workspace/create", {
      method: "POST",
      token: server.token,
      body: {
        parentPath: parent,
        projectId: "content-ops",
        business: "另一个项目",
        description: "不能覆盖已有目录。",
      },
    });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body as { code: string }).code, "workspace_exists");
  } finally {
    await server.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

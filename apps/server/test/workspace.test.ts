import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_BINDING_RELATIVE_PATH,
  AGENT_BINDING_SCHEMA_VERSION,
} from "@roleweave/shared";
import type { OrgTreeSnapshot } from "@roleweave/shared";
import { FakeDriver, api, copyExampleWorkspace, startTestServer } from "./helpers.js";

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

    const emptyOrganizationDir = await copyExampleWorkspace();
    try {
      const organizationFile = path.join(emptyOrganizationDir, "organization.v1alpha1.json");
      const organization = JSON.parse(await fs.readFile(organizationFile, "utf8")) as { roles: unknown[] };
      organization.roles = [];
      await fs.writeFile(organizationFile, `${JSON.stringify(organization)}\n`, "utf8");
      const emptyOrganization = await api(server.baseUrl, "/workspace/open", {
        method: "POST",
        token: server.token,
        body: { path: emptyOrganizationDir },
      });
      assert.equal(emptyOrganization.status, 422);
      assert.match((emptyOrganization.body as { message: string }).message, /no employees/);
    } finally {
      await fs.rm(emptyOrganizationDir, { recursive: true, force: true });
    }
  } finally {
    await server.close();
  }
});

test("workspace: migrates legacy RoleWeave state into one hidden workspace directory", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  const legacy = path.join(dir, ".digital-employee", "workbench");
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, "migration-proof.txt"), "preserved", "utf8");
  try {
    const open = await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    assert.equal(open.status, 200);
    assert.equal(await fs.readFile(path.join(dir, ".roleweave", "migration-proof.txt"), "utf8"), "preserved");
    await assert.rejects(fs.access(legacy), { code: "ENOENT" });
  } finally {
    await server.close();
  }
});

test("workspace: initialize an existing source directory without overwriting its files", async () => {
  const server = await startTestServer();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-source-tree-"));
  const sourceFile = path.join(dir, "README.md");
  try {
    await fs.writeFile(sourceFile, "# Existing source\n", "utf8");
    const initialized = await api(server.baseUrl, "/workspace/initialize", {
      method: "POST",
      token: server.token,
      body: {
        path: dir,
        projectId: "source-tree",
        business: "源代码项目",
        description: "在已有目录中启用 RoleWeave。",
        agentEngine: "codex-local",
      },
    });
    assert.equal(initialized.status, 201);
    const body = initialized.body as { open: boolean; created: boolean; owner: string; path: string; agentEngine: string };
    assert.equal(body.open, true);
    assert.equal(body.created, true);
    assert.equal(body.owner, "source-tree-owner");
    assert.equal(body.agentEngine, "codex-local");
    assert.equal(body.path, await fs.realpath(dir));
    assert.equal(await fs.readFile(sourceFile, "utf8"), "# Existing source\n");
    for (const file of [
      "workspace.json",
      "organization.v1alpha1.json",
      "positions/source-tree-owner/employee.json",
      "positions/source-tree-owner/SKILL.md",
      "positions/source-tree-owner/budget.json",
      "context/README.md",
    ]) await fs.stat(path.join(dir, file));

    const conflict = await api(server.baseUrl, "/workspace/initialize", {
      method: "POST",
      token: server.token,
      body: {
        path: dir,
        projectId: "another-project",
        business: "不能二次初始化",
        description: "",
      },
    });
    assert.equal(conflict.status, 422);
    assert.match((conflict.body as { message: string }).message, /already contains RoleWeave/);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("workspace: failed in-place initialization rolls back generated metadata only", async () => {
  const server = await startTestServer(new FakeDriver({
    status: "failed",
    code: "workspace_org_invalid",
    message: "invalid organization",
    retryable: false,
  }));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-source-tree-failed-"));
  const sourceFile = path.join(dir, "README.md");
  try {
    await fs.writeFile(sourceFile, "# Existing source\n", "utf8");
    const failed = await api(server.baseUrl, "/workspace/initialize", {
      method: "POST",
      token: server.token,
      body: { path: dir, projectId: "source-tree", business: "源代码项目", description: "" },
    });
    assert.equal(failed.status, 422);
    assert.equal(await fs.readFile(sourceFile, "utf8"), "# Existing source\n");
    for (const file of ["workspace.json", "organization.v1alpha1.json", "positions", "context", ".digital-employee"]) {
      await assert.rejects(fs.lstat(path.join(dir, file)), { code: "ENOENT" });
    }
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
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
    const createdBody = created.body as { open: boolean; created: boolean; next: string; path: string; owner: string; business: string; agentEngine: string };
    assert.equal(createdBody.open, true);
    assert.equal(createdBody.created, true);
    assert.equal(createdBody.next, "create_employee");
    assert.equal(createdBody.owner, "content-ops-owner");
    assert.equal(createdBody.business, "内容运营");
    assert.equal(createdBody.agentEngine, "qoder", "older clients without a choice retain the Qoder default");

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
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(project, "positions", "content-ops-owner", ...AGENT_BINDING_RELATIVE_PATH.split("/")), "utf8")),
      { schemaVersion: AGENT_BINDING_SCHEMA_VERSION, engine: "qoder", locked: true },
      "the generated project owner gets the same durable default Agent binding as a hired employee",
    );

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

test("workspace: persist the selected Agent for the generated project owner", async () => {
  const server = await startTestServer();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "owb-project-agent-parent-"));
  try {
    const created = await api(server.baseUrl, "/workspace/create", {
      method: "POST",
      token: server.token,
      body: {
        parentPath: parent,
        projectId: "release-notes",
        business: "发布说明",
        description: "维护发布公告和版本摘要。",
        agentEngine: "codex-local",
      },
    });
    assert.equal(created.status, 201);
    const body = created.body as { owner: string; agentEngine: string };
    assert.equal(body.owner, "release-notes-owner");
    assert.equal(body.agentEngine, "codex-local");
    assert.deepEqual(
      JSON.parse(await fs.readFile(
        path.join(parent, "release-notes", "positions", body.owner, ...AGENT_BINDING_RELATIVE_PATH.split("/")),
        "utf8",
      )),
      { schemaVersion: AGENT_BINDING_SCHEMA_VERSION, engine: "codex-local", locked: true },
    );
  } finally {
    await server.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

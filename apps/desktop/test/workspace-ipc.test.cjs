const assert = require("node:assert/strict");
const test = require("node:test");
const { validateWorkspaceCreateRequest } = require("../src/workspace-ipc.cjs");

test("project bootstrap IPC accepts the exact bounded request", () => {
  const result = validateWorkspaceCreateRequest({
    parentPath: "/tmp/projects",
    projectId: "content-ops",
    business: "内容运营",
    description: "把项目目标拆成可执行的员工任务。",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.request, {
    parentPath: "/tmp/projects",
    projectId: "content-ops",
    business: "内容运营",
    description: "把项目目标拆成可执行的员工任务。",
  });
});

test("project bootstrap IPC rejects traversal-shaped ids and unknown fields", () => {
  for (const projectId of ["../escape", "Content Ops", "a/child", ""]) {
    const result = validateWorkspaceCreateRequest({
      parentPath: "/tmp/projects",
      projectId,
      business: "内容运营",
      description: "",
    });
    assert.equal(result.ok, false, `project id ${projectId} must be rejected`);
    assert.equal(result.response.status, 400);
  }
  const unknown = validateWorkspaceCreateRequest({
    parentPath: "/tmp/projects",
    projectId: "content-ops",
    business: "内容运营",
    description: "",
    owner: "me",
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.response.status, 400);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateWorkspaceCreateRequest, openWorkspaceWithPicker, createWorkspaceWithPicker } = require("../src/workspace-ipc.cjs");
const { readLastWorkspacePath } = require("../src/last-workspace.cjs");
const { runtimeEnvironment } = require("../src/runtime-settings.cjs");
const { openDefaultWorkspace } = require("../src/auto-open-workspace.cjs");

test("project bootstrap IPC accepts the exact bounded request", () => {
  const result = validateWorkspaceCreateRequest({
    projectId: "content-ops",
    business: "内容运营",
    description: "把项目目标拆成可执行的员工任务。",
    agentEngine: "codex-local",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.request, {
    projectId: "content-ops",
    business: "内容运营",
    description: "把项目目标拆成可执行的员工任务。",
    agentEngine: "codex-local",
  });
});

test("project bootstrap IPC accepts the renderer request and carries one concrete owner Agent", () => {
  const result = validateWorkspaceCreateRequest({
    projectId: "content-ops",
    business: "内容运营",
    description: "",
    agentEngine: "claude-local",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.request, {
    projectId: "content-ops",
    business: "内容运营",
    description: "",
    agentEngine: "claude-local",
  });

  const invalidEngine = validateWorkspaceCreateRequest({
    projectId: "content-ops",
    business: "内容运营",
    description: "",
    agentEngine: "not-an-agent",
  });
  assert.equal(invalidEngine.ok, false);
  assert.equal(invalidEngine.response.status, 400);
});

test("project bootstrap IPC rejects traversal-shaped ids and unknown fields", () => {
  for (const projectId of ["../escape", "Content Ops", "a/child", ""]) {
    const result = validateWorkspaceCreateRequest({
      projectId,
      business: "内容运营",
      description: "",
    });
    assert.equal(result.ok, false, `project id ${projectId} must be rejected`);
    assert.equal(result.response.status, 400);
  }
  const unknown = validateWorkspaceCreateRequest({
    projectId: "content-ops",
    business: "内容运营",
    description: "",
    owner: "me",
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.response.status, 400);
});

function fixture(t, nativePath, { wsl = true, status = 201 } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "rw-workspace-ipc-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (wsl) {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    t.after(() => Object.defineProperty(process, "platform", descriptor));
  }
  const calls = [];
  const dialogs = [];
  return {
    calls, dialogs, userDataPath,
    request: { projectId: "local-team", business: "本地项目", description: "" },
    env: wsl ? { ROLEWEAVE_CONTROL_PLANE_MODE: "wsl", ROLEWEAVE_WSL_DISTRO: "Ubuntu-22.04", ROLEWEAVE_WSL_HOME: "/home/tester" } : {},
    pickDirectory: async (options) => { dialogs.push(options); return { canceled: !nativePath, filePaths: nativePath ? [nativePath] : [] }; },
    apiRequest: async (route, options) => {
      calls.push({ route, ...options });
      return { status, body: { path: "/home/tester/projects/local-team" } };
    },
  };
}

test("four-field renderer creation carries agentEngine through the WSL picker and remembers its distribution", async (t) => {
  const parent = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\tester\\projects";
  const f = fixture(t, parent);
  f.request.agentEngine = "codex-local";
  const res = await createWorkspaceWithPicker(f);
  assert.equal(res.status, 201);
  assert.equal(f.dialogs[0].defaultPath, "\\\\wsl.localhost\\Ubuntu-22.04\\home\\tester");
  assert.deepEqual(f.dialogs[0].properties, ["openDirectory", "createDirectory"]);
  assert.deepEqual(f.calls, [{ route: "/workspace/create", method: "POST", body: { ...f.request, parentPath: "/home/tester/projects" } }]);
  assert.equal(readLastWorkspacePath(f.userDataPath), parent + "\\local-team");
});

test("stored distribution roundtrips from runtime preferences through creation and restart", async (t) => {
  const parent = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\tester\\projects";
  const f = fixture(t, parent);
  fs.writeFileSync(path.join(f.userDataPath, "runtime-settings.json"), JSON.stringify({
    mode: "wsl", distro: "Ubuntu-22.04", homePath: "/home/tester",
  }));
  f.env = runtimeEnvironment({}, f.userDataPath, "win32");
  await createWorkspaceWithPicker(f);
  assert.equal(readLastWorkspacePath(f.userDataPath), parent + "\\local-team");
  const reopened = [];
  const result = await openDefaultWorkspace({
    env: runtimeEnvironment({}, f.userDataPath, "win32"),
    userDataPath: f.userDataPath,
    apiRequest: async (route, request) => { reopened.push({ route, ...request }); return { status: 200 }; },
  });
  assert.deepEqual(result, { fallbackNoticePath: null });
  assert.deepEqual(reopened, [{ route: "/workspace/open", method: "POST", body: { path: "/home/tester/projects/local-team" } }]);
  const crossDistroCalls = [];
  const changed = await openDefaultWorkspace({
    env: runtimeEnvironment({ ROLEWEAVE_WSL_DISTRO: "Debian" }, f.userDataPath, "win32"),
    userDataPath: f.userDataPath,
    apiRequest: async (...args) => { crossDistroCalls.push(args); return { status: 200 }; },
    writeStderr: () => {},
  });
  assert.deepEqual(changed, { fallbackNoticePath: parent + "\\local-team" });
  assert.deepEqual(crossDistroCalls, [], "a saved Ubuntu workspace must not reopen in Debian");
});

test("opening a WSL directory posts Linux path and persists picker path", async (t) => {
  const dir = "\\\\wsl$\\Ubuntu-22.04\\home\\tester\\team";
  const f = fixture(t, dir, { status: 200 });
  assert.equal((await openWorkspaceWithPicker(f)).status, 200);
  assert.deepEqual(f.calls, [{ route: "/workspace/open", method: "POST", body: { path: "/home/tester/team" } }]);
  assert.equal(readLastWorkspacePath(f.userDataPath), dir);
});

test("create converts Windows disk paths when the server runs in WSL", async (t) => {
  const f = fixture(t, "D:\\projects");
  await createWorkspaceWithPicker(f);
  assert.equal(f.calls[0].body.parentPath, "/mnt/d/projects");
  assert.equal(readLastWorkspacePath(f.userDataPath), "D:\\projects\\local-team");
});

test("native creation retains native POSIX paths", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX path behavior");
  const f = fixture(t, "/tmp/projects", { wsl: false });
  await createWorkspaceWithPicker(f);
  assert.equal(f.calls[0].body.parentPath, "/tmp/projects");
  assert.equal(readLastWorkspacePath(f.userDataPath), "/tmp/projects/local-team");
});

test("only the native picker owns parentPath, even for a valid four-field renderer request", async (t) => {
  const f = fixture(t, "/tmp/projects");
  for (const parentPath of ["/injected", "C:\\projects", "\\\\wsl.localhost\\Ubuntu-22.04\\home\\tester", "", null, undefined]) {
    const request = { ...f.request, agentEngine: "claude-local", parentPath };
    const validated = validateWorkspaceCreateRequest(request);
    assert.equal(validated.ok, false);
    assert.match(validated.response.body.message, /folder picker/);
    assert.equal((await createWorkspaceWithPicker({ ...f, request })).status, 400);
  }
  assert.deepEqual(f.dialogs, []);
  assert.deepEqual(f.calls, []);
  assert.equal(readLastWorkspacePath(f.userDataPath), null);
});

test("optional agentEngine stays absent and invalid engines never reach the picker", async (t) => {
  const f = fixture(t, "D:\\projects");
  const result = validateWorkspaceCreateRequest({ ...f.request, business: "  Team  ", description: "  Goal  " });
  assert.deepEqual(result, { ok: true, request: { projectId: "local-team", business: "Team", description: "Goal" } });
  for (const agentEngine of ["not-an-agent", "", null, 123, {}]) {
    assert.equal((await createWorkspaceWithPicker({ ...f, request: { ...f.request, agentEngine } })).status, 400);
  }
  assert.deepEqual(f.dialogs, []);
  assert.deepEqual(f.calls, []);
});

test("cancelling the picker never creates or remembers a workspace", async (t) => {
  const f = fixture(t, null);
  assert.deepEqual(await createWorkspaceWithPicker(f), { canceled: true });
  assert.deepEqual(f.calls, []);
  assert.equal(readLastWorkspacePath(f.userDataPath), null);
});

test("an inaccessible workspace never replaces the saved selection", async (t) => {
  const f = fixture(t, "D:\\projects", { status: 422 });
  fs.writeFileSync(path.join(f.userDataPath, "last-workspace.json"), JSON.stringify({ path: "D:\\previous" }));
  await createWorkspaceWithPicker(f);
  assert.equal(readLastWorkspacePath(f.userDataPath), "D:\\previous");
});

test("a different WSL distribution is rejected before a workspace request", async (t) => {
  const f = fixture(t, "\\\\wsl.localhost\\Debian\\home\\tester");
  assert.equal((await openWorkspaceWithPicker(f)).status, 400);
  assert.deepEqual(f.calls, []);
  assert.equal(readLastWorkspacePath(f.userDataPath), null);
});

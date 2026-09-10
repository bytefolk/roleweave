const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openDefaultWorkspace } = require("../src/auto-open-workspace.cjs");

function captureStderr() {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    output: () => chunks.join(""),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

function makeTempWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-auto-open-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}

function makeApiRequestStub({ status = 200, body = { open: true }, shouldReject = false, rejectMessage = "control plane is not running" } = {}) {
  const calls = [];
  const fn = async (pathname, options) => {
    calls.push({ pathname, options });
    if (shouldReject) throw new Error(rejectMessage);
    return { status, body };
  };
  fn.calls = calls;
  return fn;
}

function autoOpenFixture(t, platform, existingPaths = []) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const moduleIds = [
    require.resolve("../src/auto-open-workspace.cjs"),
    require.resolve("../src/control-plane-launch.cjs"),
  ];
  const cachedModules = moduleIds.map((id) => require.cache[id]);
  t.after(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    moduleIds.forEach((id, index) => {
      if (cachedModules[index]) require.cache[id] = cachedModules[index];
      else delete require.cache[id];
    });
  });
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
  moduleIds.forEach((id) => { delete require.cache[id]; });
  const { openDefaultWorkspace } = require("../src/auto-open-workspace.cjs");
  const checkedPaths = [];
  // Only the mode is emulated; fs and API fixtures never touch a live Windows/WSL host.
  t.mock.method(fs, "existsSync", (filePath) => {
    checkedPaths.push(filePath);
    return existingPaths.includes(filePath);
  });
  const messages = [];
  return {
    openDefaultWorkspace,
    checkedPaths,
    messages,
    writeStderr: (message) => { messages.push(message); },
  };
}

test("AC-001: non-2xx response is recorded with status and code", async (t) => {
  const workspaceDir = makeTempWorkspace(t);
  fs.writeFileSync(path.join(workspaceDir, "workspace.json"), "{}");
  const capture = captureStderr();
  t.after(() => capture.restore());

  const apiRequest = makeApiRequestStub({
    status: 422,
    body: { code: "workspace_invalid", message: "not a valid workspace" },
  });

  await openDefaultWorkspace({
    apiRequest,
    env: { ORG_WORKBENCH_DEFAULT_WORKSPACE: workspaceDir },
    userDataPath: makeTempWorkspace(t),
  });

  const stderr = capture.output();
  assert.match(stderr, /auto-open workspace failed/);
  assert.match(stderr, /422/);
  assert.match(stderr, /workspace_invalid/);
  assert.equal(apiRequest.calls.length, 1);
  assert.equal(apiRequest.calls[0].pathname, "/workspace/open");
});

test("AC-002: early return when workspace.json is missing is recorded with directory", async (t) => {
  const workspaceDir = makeTempWorkspace(t);
  const capture = captureStderr();
  t.after(() => capture.restore());

  const apiRequest = makeApiRequestStub();

  await openDefaultWorkspace({
    apiRequest,
    env: { ORG_WORKBENCH_DEFAULT_WORKSPACE: workspaceDir },
    userDataPath: makeTempWorkspace(t),
  });

  const stderr = capture.output();
  assert.match(stderr, /auto-open skipped: workspace\.json not found at/);
  assert.match(stderr, new RegExp(workspaceDir.replace(/[\\/]/g, "[\\\\/]")));
  assert.equal(apiRequest.calls.length, 0, "no POST should be made when workspace.json is missing");
});

test("AC-003: catch block records the error message", async (t) => {
  const workspaceDir = makeTempWorkspace(t);
  fs.writeFileSync(path.join(workspaceDir, "workspace.json"), "{}");
  const capture = captureStderr();
  t.after(() => capture.restore());

  const apiRequest = makeApiRequestStub({
    shouldReject: true,
    rejectMessage: "control plane is not running",
  });

  await openDefaultWorkspace({
    apiRequest,
    env: { ORG_WORKBENCH_DEFAULT_WORKSPACE: workspaceDir },
    userDataPath: makeTempWorkspace(t),
  });

  const stderr = capture.output();
  assert.match(stderr, /auto-open workspace failed/);
  assert.match(stderr, /control plane is not running/);
});

test("AC-004: success path stays silent and three failure messages are distinguishable", async (t) => {
  const workspaceDir = makeTempWorkspace(t);
  fs.writeFileSync(path.join(workspaceDir, "workspace.json"), "{}");
  const capture = captureStderr();
  t.after(() => capture.restore());

  const apiRequest = makeApiRequestStub({ status: 200, body: { open: true } });

  await openDefaultWorkspace({
    apiRequest,
    env: { ORG_WORKBENCH_DEFAULT_WORKSPACE: workspaceDir },
    userDataPath: makeTempWorkspace(t),
  });

  assert.equal(capture.output(), "", "success path should produce no stderr");
});

test("AC-004: the three failure exits produce distinguishable messages", async (t) => {
  const messages = [];

  for (const scenario of [
    {
      label: "non-2xx",
      setup: (dir) => fs.writeFileSync(path.join(dir, "workspace.json"), "{}"),
      apiRequestOpts: { status: 422, body: { code: "workspace_invalid" } },
      pattern: /auto-open workspace failed.*422.*workspace_invalid/s,
    },
    {
      label: "missing workspace.json",
      setup: () => {},
      apiRequestOpts: { status: 200 },
      pattern: /auto-open skipped: workspace\.json not found/,
    },
    {
      label: "catch",
      setup: (dir) => fs.writeFileSync(path.join(dir, "workspace.json"), "{}"),
      apiRequestOpts: { shouldReject: true, rejectMessage: "connection refused" },
      pattern: /auto-open workspace failed.*connection refused/s,
    },
  ]) {
    const dir = makeTempWorkspace(t);
    scenario.setup(dir);
    const capture = captureStderr();

    await openDefaultWorkspace({
      apiRequest: makeApiRequestStub(scenario.apiRequestOpts),
      env: { ORG_WORKBENCH_DEFAULT_WORKSPACE: dir },
      userDataPath: makeTempWorkspace(t),
    });

    capture.restore();
    const stderr = capture.output();
    assert.match(stderr, scenario.pattern, `${scenario.label} should produce its distinct message`);
    messages.push(stderr);
  }

  for (let i = 0; i < messages.length; i++) {
    for (let j = i + 1; j < messages.length; j++) {
      assert.notEqual(messages[i], messages[j], `messages ${i} and ${j} should differ`);
    }
  }
});

test("AC-006: auto-open stays best-effort — no throw on any failure path", async (t) => {
  const workspaceDir = makeTempWorkspace(t);
  fs.writeFileSync(path.join(workspaceDir, "workspace.json"), "{}");
  const capture = captureStderr();
  t.after(() => capture.restore());

  const apiRequest = makeApiRequestStub({ shouldReject: true });

  await assert.doesNotReject(() => openDefaultWorkspace({
    apiRequest,
    env: { ORG_WORKBENCH_DEFAULT_WORKSPACE: workspaceDir },
    userDataPath: makeTempWorkspace(t),
  }));
});

test("AC-006: unavailable stderr never turns diagnostics into a failed startup", async (t) => {
  const writeStderr = () => {
    throw new Error("EPIPE: stderr unavailable");
  };
  const missingDir = makeTempWorkspace(t);
  await assert.doesNotReject(
    () => openDefaultWorkspace({
      apiRequest: makeApiRequestStub(),
      env: { ORG_WORKBENCH_DEFAULT_WORKSPACE: missingDir },
      userDataPath: makeTempWorkspace(t),
      writeStderr,
    }),
    "missing override workspace",
  );

  const workspaceDir = makeTempWorkspace(t);
  fs.writeFileSync(path.join(workspaceDir, "workspace.json"), "{}");
  for (const apiRequest of [
    makeApiRequestStub({ status: 422 }),
    makeApiRequestStub({ shouldReject: true }),
  ]) {
    await assert.doesNotReject(
      () => openDefaultWorkspace({
        apiRequest,
        env: { ORG_WORKBENCH_DEFAULT_WORKSPACE: workspaceDir },
        userDataPath: makeTempWorkspace(t),
        writeStderr,
      }),
      "override request diagnostic",
    );
  }

  const lastDir = makeTempWorkspace(t);
  fs.writeFileSync(path.join(lastDir, "workspace.json"), "{}");
  const userDataPath = makeTempWorkspace(t);
  fs.writeFileSync(
    path.join(userDataPath, "last-workspace.json"),
    JSON.stringify({ path: lastDir }),
  );
  const fakeHome = makeTempWorkspace(t);
  const realHomedir = os.homedir;
  os.homedir = () => fakeHome;
  t.after(() => { os.homedir = realHomedir; });
  await assert.doesNotReject(
    () => openDefaultWorkspace({
      apiRequest: makeApiRequestStub({ status: 503 }),
      env: {},
      userDataPath,
      writeStderr,
    }),
    "last-workspace and demo diagnostics",
  );
});

test("last-workspace path: non-2xx falls through to demo with fallback notice", async (t) => {
  const lastDir = makeTempWorkspace(t);
  fs.writeFileSync(path.join(lastDir, "workspace.json"), "{}");
  const userDataPath = makeTempWorkspace(t);
  fs.writeFileSync(
    path.join(userDataPath, "last-workspace.json"),
    JSON.stringify({ path: lastDir }),
  );

  const fakeHome = makeTempWorkspace(t);
  const realHomedir = os.homedir;
  os.homedir = () => fakeHome;
  t.after(() => { os.homedir = realHomedir; });

  const capture = captureStderr();
  t.after(() => capture.restore());

  const calls = [];
  const apiRequest = async (_pathname, options) => {
    calls.push({ pathname: _pathname, bodyPath: options?.body?.path });
    if (options?.body?.path === lastDir) {
      return { status: 500, body: { code: "internal_error" } };
    }
    return { status: 503, body: { code: "service_unavailable" } };
  };

  const result = await openDefaultWorkspace({
    apiRequest,
    env: {},
    userDataPath,
  });

  const stderr = capture.output();
  assert.match(stderr, new RegExp(`dir=${lastDir}[^\\n]*500`), "last-workspace failure must report 500");
  assert.match(stderr, /503/, "demo fallback failure must report 503");
  assert.equal(calls.length, 2, "both last-workspace and demo paths must POST");
  assert.equal(result.fallbackNoticePath, lastDir);
});

test("last-workspace path: successful open returns no fallback notice", async (t) => {
  const lastDir = makeTempWorkspace(t);
  fs.writeFileSync(path.join(lastDir, "workspace.json"), "{}");
  const userDataPath = makeTempWorkspace(t);
  fs.writeFileSync(
    path.join(userDataPath, "last-workspace.json"),
    JSON.stringify({ path: lastDir }),
  );

  const capture = captureStderr();
  t.after(() => capture.restore());

  const apiRequest = makeApiRequestStub({ status: 200, body: { open: true } });

  const result = await openDefaultWorkspace({
    apiRequest,
    env: {},
    userDataPath,
  });

  assert.equal(capture.output(), "");
  assert.equal(result.fallbackNoticePath, null);
});

test("demo fallback: prefers the existing legacy .org-workbench workspace when the canonical demo is absent", async (t) => {
  const fakeHome = makeTempWorkspace(t);
  const userDataPath = makeTempWorkspace(t);
  const legacyDir = path.join(fakeHome, ".org-workbench", "demo-workspace");
  const canonicalDir = path.join(fakeHome, ".roleweave", "demo-workspace");
  const manifest = path.join(legacyDir, "workspace.json");
  const fixture = autoOpenFixture(t, "darwin", [manifest]);
  t.mock.method(os, "homedir", () => fakeHome);
  const apiRequest = makeApiRequestStub();

  const result = await fixture.openDefaultWorkspace({
    apiRequest,
    env: {},
    userDataPath,
    writeStderr: fixture.writeStderr,
  });

  assert.deepEqual(result, { fallbackNoticePath: null });
  assert.deepEqual(fixture.checkedPaths, [path.join(canonicalDir, "workspace.json"), manifest, manifest]);
  assert.deepEqual(apiRequest.calls, [{
    pathname: "/workspace/open",
    options: { method: "POST", body: { path: legacyDir } },
  }]);
  assert.deepEqual(fixture.messages, []);
});

for (const alias of ["ROLEWEAVE_DEFAULT_WORKSPACE", "ORG_WORKBENCH_DEFAULT_WORKSPACE"]) {
  for (const { platform, controlPlane } of [
    { platform: "linux", controlPlane: "wsl" },
    { platform: "darwin", controlPlane: "wsl" },
    { platform: "win32", controlPlane: undefined },
    { platform: "win32", controlPlane: "native" },
  ]) {
    for (const exists of [false, true]) {
      test(`native override: ${platform} env=${controlPlane ?? "unset"} ${alias} exists=${exists} (#156 AC-003/004/005)`, async (t) => {
        const dir = platform === "win32" ? "C:\\projects\\workspace" : "/home/test/workspace";
        const manifest = path.join(dir, "workspace.json");
        const fixture = autoOpenFixture(t, platform, exists ? [manifest] : []);
        const apiRequest = makeApiRequestStub({ status: 422, body: { code: "workspace_invalid" } });
        const env = { [alias]: dir };
        if (controlPlane !== undefined) env.ORG_WORKBENCH_CONTROL_PLANE = controlPlane;

        const result = await fixture.openDefaultWorkspace({
          apiRequest,
          env,
          userDataPath: "/unused/user-data",
          writeStderr: fixture.writeStderr,
        });

        assert.deepEqual(result, { fallbackNoticePath: null });
        assert.deepEqual(apiRequest.calls, exists ? [{
          pathname: "/workspace/open",
          options: { method: "POST", body: { path: dir } },
        }] : [], "native mode must validate locally before POST and preserve the path");
        assert.deepEqual(fixture.checkedPaths, [manifest]);
        assert.equal(fixture.messages.length, 1);
        if (exists) {
          assert.ok(fixture.messages[0].includes(`[mode=native, dir=${dir}]`));
          assert.match(fixture.messages[0], /422.*workspace_invalid/);
        } else {
          assert.equal(fixture.messages[0], `auto-open skipped: workspace.json not found at ${dir}\n`);
        }
      });
    }
  }

  for (const [dir, serverPath] of [
    ["/mnt/c/some/workspace", "/mnt/c/some/workspace"],
    ["/home/test/workspace", "/home/test/workspace"],
    ["C:\\projects\\workspace", "/mnt/c/projects/workspace"],
  ]) {
    for (const outcome of ["success", "non-2xx", "rejection"]) {
      test(`WSL override: win32 ${alias} ${dir} ${outcome} (#156 AC-003/004/005)`, async (t) => {
        const fixture = autoOpenFixture(t, "win32");
        const apiRequest = makeApiRequestStub({
          status: outcome === "non-2xx" ? 422 : 200,
          body: { code: "workspace_invalid" },
          shouldReject: outcome === "rejection",
        });

        const result = await fixture.openDefaultWorkspace({
          apiRequest,
          env: { [alias]: dir, ORG_WORKBENCH_CONTROL_PLANE: "wsl" },
          userDataPath: "/unused/user-data",
          writeStderr: fixture.writeStderr,
        });

        assert.deepEqual(result, { fallbackNoticePath: null });
        assert.deepEqual(fixture.checkedPaths, [], "WSL overrides must be validated by the server");
        assert.deepEqual(apiRequest.calls, [{
          pathname: "/workspace/open",
          options: { method: "POST", body: { path: serverPath } },
        }]);
        if (outcome === "success") {
          assert.deepEqual(fixture.messages, [], "success must stay silent");
        } else {
          assert.equal(fixture.messages.length, 1);
          assert.ok(fixture.messages[0].includes(`[mode=wsl, dir=${dir}]`));
          assert.match(fixture.messages[0], outcome === "non-2xx"
            ? /422.*workspace_invalid/ : /control plane is not running/);
        }
      });
    }
  }
}

test("WSL override: win32 ROLEWEAVE_CONTROL_PLANE_MODE=wsl alias activates the #224 guard", async (t) => {
  const fixture = autoOpenFixture(t, "win32");
  const apiRequest = makeApiRequestStub({ status: 200, body: { open: true } });

  const result = await fixture.openDefaultWorkspace({
    apiRequest,
    env: {
      ROLEWEAVE_DEFAULT_WORKSPACE: "C:\\projects\\workspace",
      ROLEWEAVE_CONTROL_PLANE_MODE: "wsl",
    },
    userDataPath: "/unused/user-data",
    writeStderr: fixture.writeStderr,
  });

  assert.deepEqual(result, { fallbackNoticePath: null });
  assert.deepEqual(fixture.checkedPaths, [], "the alias must skip the Windows-side existsSync");
  assert.deepEqual(apiRequest.calls, [{
    pathname: "/workspace/open",
    options: { method: "POST", body: { path: "/mnt/c/projects/workspace" } },
  }]);
  assert.deepEqual(fixture.messages, [], "success must stay silent");
});

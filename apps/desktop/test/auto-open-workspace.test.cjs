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

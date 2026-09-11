// #224 Windows acceptance — runs on a REAL win32 host in the staging-windows-x64
// leg (.github/workflows/verify.yml). Unlike auto-open-workspace.test.cjs, which
// emulates process.platform and fs so it can run on POSIX CI, this file mocks
// NEITHER: it exercises the production control-plane / auto-open modules against
// the runner's genuine `process.platform === "win32"` and a real, non-existent
// Windows path, proving the ROLEWEAVE_CONTROL_PLANE_MODE=wsl alias activates the
// guard and the override reaches the server as a /mnt/<drive>/... path.
//
// Named without `.test.` so the POSIX `test:desktop-main` glob
// (apps/desktop/test/*.test.cjs) never picks it up; the Windows leg invokes it
// explicitly. Off-win32 it skips rather than fails.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  controlPlaneMode,
  serverPathForWorkspace,
  winToWslPath,
} = require("../src/control-plane-launch.cjs");
const { openDefaultWorkspace } = require("../src/auto-open-workspace.cjs");

const skipReason = process.platform === "win32"
  ? false
  : `requires a real win32 host (this is ${process.platform}); runs in the staging-windows-x64 leg`;

// A drive-letter path that cannot exist on a fresh runner. The pid nonce keeps it
// disjoint from anything the job stages.
const missingDir = `C:\\owb-wsl-acceptance-${process.pid}\\workspace`;
const expectedWslPath = `/mnt/c/owb-wsl-acceptance-${process.pid}/workspace`;

test("controlPlaneMode: real win32 honors the alias and the legacy name", { skip: skipReason }, () => {
  assert.equal(process.platform, "win32");
  assert.equal(controlPlaneMode({}), "native", "default must stay native on real Windows");
  assert.equal(controlPlaneMode({ ROLEWEAVE_CONTROL_PLANE_MODE: "wsl" }), "wsl");
  assert.equal(controlPlaneMode({ ROLEWEAVE_CONTROL_PLANE_MODE: "WSL" }), "wsl", "case-insensitive");
  assert.equal(controlPlaneMode({ ROLEWEAVE_CONTROL_PLANE_MODE: "native" }), "native");
  assert.equal(controlPlaneMode({ ORG_WORKBENCH_CONTROL_PLANE: "wsl" }), "wsl", "legacy name still honored");
  assert.equal(
    controlPlaneMode({ ROLEWEAVE_CONTROL_PLANE_MODE: "wsl", ORG_WORKBENCH_CONTROL_PLANE: "native" }),
    "wsl",
    "the RoleWeave name wins when both are set",
  );
});

test("serverPathForWorkspace: real win32 converts the override to a WSL path", { skip: skipReason }, () => {
  assert.equal(
    serverPathForWorkspace(missingDir, { ROLEWEAVE_CONTROL_PLANE_MODE: "wsl" }),
    expectedWslPath,
  );
  assert.equal(winToWslPath(missingDir), expectedWslPath);
  assert.equal(serverPathForWorkspace(missingDir, {}), missingDir, "native mode leaves the path untouched");
});

test("auto-open: real win32 + alias skips the Windows-side stat and POSTs the WSL path", { skip: skipReason }, async () => {
  // Asserted, not assumed: the override must not exist, so a POST below can only
  // mean the existsSync guard was bypassed by the WSL mode.
  assert.equal(
    fs.existsSync(path.join(missingDir, "workspace.json")),
    false,
    "fixture path unexpectedly exists on this runner",
  );

  const calls = [];
  const apiRequest = async (pathname, options) => {
    calls.push({ pathname, options });
    return { status: 200, body: { open: true } };
  };
  const messages = [];
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "owb-wsl-acceptance-"));

  const result = await openDefaultWorkspace({
    apiRequest,
    env: { ROLEWEAVE_DEFAULT_WORKSPACE: missingDir, ROLEWEAVE_CONTROL_PLANE_MODE: "wsl" },
    userDataPath,
    writeStderr: (message) => { messages.push(message); },
  });

  fs.rmSync(userDataPath, { force: true, recursive: true });

  assert.deepEqual(result, { fallbackNoticePath: null });
  assert.deepEqual(calls, [{
    pathname: "/workspace/open",
    options: { method: "POST", body: { path: expectedWslPath } },
  }], "the alias must skip the Windows-side existsSync and POST the converted path");
  assert.deepEqual(messages, [], "success must stay silent");
});

test("auto-open: real win32 native mode still validates locally (negative control)", { skip: skipReason }, async () => {
  const calls = [];
  const apiRequest = async (pathname, options) => {
    calls.push({ pathname, options });
    return { status: 200, body: { open: true } };
  };
  const messages = [];
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "owb-wsl-acceptance-"));

  const result = await openDefaultWorkspace({
    apiRequest,
    env: { ROLEWEAVE_DEFAULT_WORKSPACE: missingDir }, // no control-plane opt-in -> native
    userDataPath,
    writeStderr: (message) => { messages.push(message); },
  });

  fs.rmSync(userDataPath, { force: true, recursive: true });

  assert.deepEqual(result, { fallbackNoticePath: null });
  assert.deepEqual(calls, [], "native mode must keep the local existsSync guard and skip the POST");
  assert.equal(messages.length, 1);
  assert.match(messages[0], /auto-open skipped: workspace\.json not found at/);
});

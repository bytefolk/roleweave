const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runtimeEnvironment, validateRuntimeSettings } = require("../src/runtime-settings.cjs");

function settingsDirectory(t, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (settings) fs.writeFileSync(path.join(dir, "runtime-settings.json"), JSON.stringify(settings));
  return dir;
}

test("a machine without preferences keeps its original runtime", (t) => {
  assert.deepEqual(runtimeEnvironment({ PATH: "original" }, settingsDirectory(t), "win32"), { PATH: "original" });
});

test("a local Windows preference chooses WSL without changing user environment", (t) => {
  const dir = settingsDirectory(t, { mode: "wsl", distro: "Ubuntu-22.04", nodePath: "/opt/node/bin/node", homePath: "/home/tester" });
  const original = { PATH: "windows-path", HOME: "unchanged" };
  assert.deepEqual(runtimeEnvironment(original, dir, "win32"), {
    ...original, ROLEWEAVE_CONTROL_PLANE_MODE: "wsl", ROLEWEAVE_WSL_DISTRO: "Ubuntu-22.04",
    ROLEWEAVE_WSL_NODE: "/opt/node/bin/node", ROLEWEAVE_WSL_HOME: "/home/tester",
  });
  assert.deepEqual(original, { PATH: "windows-path", HOME: "unchanged" });
  assert.deepEqual(runtimeEnvironment(original, dir, "linux"), original);
});

test("explicit environment overrides a stored default", (t) => {
  const dir = settingsDirectory(t, { mode: "wsl", distro: "Ubuntu" });
  const env = runtimeEnvironment({ ORG_WORKBENCH_CONTROL_PLANE: "native", ROLEWEAVE_WSL_DISTRO: "Debian" }, dir, "win32");
  assert.equal(env.ROLEWEAVE_CONTROL_PLANE_MODE, "native");
  assert.equal(env.ROLEWEAVE_WSL_DISTRO, "Debian");
});

test("invalid configuration fails explicitly instead of switching environments", (t) => {
  for (const settings of [{ mode: "other" }, { mode: "wsl", distro: "../Ubuntu" },
    { mode: "wsl", nodePath: "node --eval bad" }, { mode: "wsl", homePath: "C:\\Users" },
    { mode: "wsl", distro: "Ubuntu\nargument" }, { mode: "wsl", token: "not-a-setting" }]) {
    assert.throws(() => validateRuntimeSettings(settings));
    assert.throws(() => runtimeEnvironment({}, settingsDirectory(t, settings), "win32"));
  }
});

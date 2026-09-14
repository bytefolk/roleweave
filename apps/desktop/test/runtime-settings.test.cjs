const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runtimeSettingsEnvironment } = require("../src/runtime-settings.cjs");
const { bundledEngineCommand, wslControlPlaneSpec, winToWslPath, serverPathForWorkspace } = require("../src/control-plane-launch.cjs");

function fixture(t, settings) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roleweave-runtime-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (settings !== undefined) fs.writeFileSync(path.join(directory, "runtime-settings.json"), JSON.stringify(settings));
  return directory;
}

test("saved WSL selection survives an installed-app restart, explicit environment wins", (t) => {
  const directory = fixture(t, { mode: "wsl", distro: "Ubuntu-22.04", nodePath: "/home/demo/.nvm/bin/node", homePath: "/home/demo" });
  assert.deepEqual(runtimeSettingsEnvironment(directory, {}), {
    ROLEWEAVE_CONTROL_PLANE_MODE: "wsl",
    ROLEWEAVE_WSL_DISTRO: "Ubuntu-22.04",
    ROLEWEAVE_WSL_NODE_PATH: "/home/demo/.nvm/bin/node",
    ROLEWEAVE_WSL_HOME: "/home/demo",
  });
  const overrides = runtimeSettingsEnvironment(directory, { ORG_WORKBENCH_CONTROL_PLANE: "native", ROLEWEAVE_WSL_DISTRO: "Ubuntu" });
  assert.equal(overrides.ROLEWEAVE_CONTROL_PLANE_MODE, undefined);
  assert.equal(overrides.ROLEWEAVE_WSL_DISTRO, undefined);
  assert.deepEqual(runtimeSettingsEnvironment(fixture(t), {}), {});
});

test("invalid persisted runtime selection is explained, not silently replaced by native", (t) => {
  assert.throws(() => runtimeSettingsEnvironment(fixture(t, { mode: "unknown" }), {}), /mode/);
  assert.throws(() => runtimeSettingsEnvironment(fixture(t, { mode: "wsl", nodePath: "node" }), {}), /nodePath/);
});

test("WSL launch preserves arguments and transfers configured provider variables without secrets in argv", () => {
  const secret = "fixture-secret-never-in-argv";
  const spec = wslControlPlaneSpec("C:\\Program Files\\RoleWeave\\server.js", {
    ROLEWEAVE_WSL_DISTRO: "Ubuntu-22.04",
    ROLEWEAVE_WSL_NODE_PATH: "/home/demo/node dir/node",
    ROLEWEAVE_WSL_HOME: "/home/demo",
    ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI: '"/home/demo/node dir/node" "/mnt/c/Program Files/RoleWeave/qoder-engine.mjs"',
    ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE: "1",
    OPENAI_API_KEY: secret,
    WSLENV: "EXISTING/u",
  });
  assert.equal(spec.command, "wsl.exe");
  assert.deepEqual(spec.args.slice(0, 5), ["--distribution", "Ubuntu-22.04", "--exec", "bash", "-lc"]);
  assert.deepEqual(spec.args.slice(-3), ["/home/demo/node dir/node", "/mnt/c/Program Files/RoleWeave/server.js", "/home/demo"]);
  assert.ok(!spec.args.some((arg) => arg.includes(secret)));
  assert.ok(spec.env.WSLENV.split(":").includes("OPENAI_API_KEY"));
  assert.ok(spec.env.WSLENV.split(":").includes("ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI"));
  assert.ok(spec.env.WSLENV.split(":").includes("EXISTING/u"));
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, "1");
});

test("WSL bundled adapter uses Linux Node and handles Windows and WSL workspace paths", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  assert.equal(bundledEngineCommand("C:\\Program Files\\RoleWeave\\qoder-engine.mjs", {
    ROLEWEAVE_CONTROL_PLANE_MODE: "wsl", ROLEWEAVE_WSL_NODE_PATH: "/home/demo/node/bin/node",
  }), '"/home/demo/node/bin/node" "/mnt/c/Program Files/RoleWeave/qoder-engine.mjs"');
  assert.equal(winToWslPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\demo\\workspace"), "/home/demo/workspace");
  assert.equal(winToWslPath("\\\\wsl$\\Ubuntu-22.04\\home\\demo\\workspace"), "/home/demo/workspace");
});

test("WSL paths cannot silently cross the configured Linux distribution", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  const env = { ROLEWEAVE_CONTROL_PLANE_MODE: "wsl", ROLEWEAVE_WSL_DISTRO: "Ubuntu-22.04" };
  for (const prefix of ["\\\\wsl.localhost", "\\\\wsl$"]) {
    const matching = `${prefix}\\ubuntu-22.04\\home\\demo\\workspace`;
    const other = `${prefix}\\Debian\\home\\demo\\workspace`;
    assert.equal(serverPathForWorkspace(matching, env), "/home/demo/workspace");
    assert.throws(() => serverPathForWorkspace(other, env), /Debian.*Ubuntu-22\.04/);
    assert.throws(() => bundledEngineCommand(other, env), /Debian.*Ubuntu-22\.04/);
    assert.throws(() => wslControlPlaneSpec(other, env), /Debian.*Ubuntu-22\.04/);
    assert.equal(serverPathForWorkspace(other, { ROLEWEAVE_CONTROL_PLANE_MODE: "native" }), other);
  }
  assert.equal(serverPathForWorkspace("C:\\Users\\demo\\workspace", env), "/mnt/c/Users/demo/workspace");
});

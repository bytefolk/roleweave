const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runtimeEnvironment, runtimeDescription, validateRuntimeSettings, workspaceDialogOptions } = require("../src/runtime-settings.cjs");
const { bundledEngineCommand, wslLaunchSpec, winToWslPath, serverPathForWorkspace } = require("../src/control-plane-launch.cjs");

function settingsDirectory(t, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (settings !== undefined) fs.writeFileSync(path.join(dir, "runtime-settings.json"), JSON.stringify(settings));
  return dir;
}

function windowsPlatform(t) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
}

test("a machine without preferences keeps an independent clone of its original runtime", (t) => {
  const original = { PATH: "original" };
  const env = runtimeEnvironment(original, settingsDirectory(t), "win32");
  assert.deepEqual(env, original);
  assert.notEqual(env, original);
});

test("a local Windows preference survives restart without changing user environment", (t) => {
  const dir = settingsDirectory(t, { mode: "wsl", distro: "Ubuntu-22.04", nodePath: "/opt/node/bin/node", homePath: "/home/tester" });
  const original = { PATH: "windows-path", HOME: "unchanged" };
  const expected = {
    ...original, ROLEWEAVE_CONTROL_PLANE_MODE: "wsl", ROLEWEAVE_WSL_DISTRO: "Ubuntu-22.04",
    ROLEWEAVE_WSL_NODE_PATH: "/opt/node/bin/node", ROLEWEAVE_WSL_HOME: "/home/tester",
  };
  assert.deepEqual(runtimeEnvironment(original, dir, "win32"), expected);
  assert.deepEqual(runtimeEnvironment(original, dir, "win32"), expected);
  assert.deepEqual(original, { PATH: "windows-path", HOME: "unchanged" });
  for (const platform of ["linux", "darwin"]) {
    const env = runtimeEnvironment(original, dir, platform);
    assert.deepEqual(env, original);
    assert.notEqual(env, original);
  }
});

test("empty and partial preferences keep mode optional", (t) => {
  const original = { PATH: "unchanged" };
  for (const [settings, additions] of [
    [{}, {}],
    [{ distro: "Ubuntu" }, { ROLEWEAVE_WSL_DISTRO: "Ubuntu" }],
    [{ homePath: "/home/tester" }, { ROLEWEAVE_WSL_HOME: "/home/tester" }],
    [{ distro: "Ubuntu", homePath: "/home/tester" }, { ROLEWEAVE_WSL_DISTRO: "Ubuntu", ROLEWEAVE_WSL_HOME: "/home/tester" }],
    [{ nodePath: "/opt/node/bin/node" }, { ROLEWEAVE_WSL_NODE_PATH: "/opt/node/bin/node" }],
  ]) {
    assert.deepEqual(validateRuntimeSettings(settings), settings);
    const env = runtimeEnvironment(original, settingsDirectory(t, settings), "win32");
    assert.deepEqual(env, { ...original, ...additions });
    assert.equal(Object.hasOwn(env, "ROLEWEAVE_CONTROL_PLANE_MODE"), false);
  }
});

test("explicit modern and legacy mode selections override a stored default", (t) => {
  const dir = settingsDirectory(t, { mode: "wsl", distro: "Ubuntu", homePath: "/home/saved" });
  const original = { ORG_WORKBENCH_CONTROL_PLANE: "native", ROLEWEAVE_WSL_DISTRO: "Debian", ROLEWEAVE_WSL_HOME: "/home/operator" };
  const env = runtimeEnvironment(original, dir, "win32");
  assert.deepEqual(env, { ...original, ROLEWEAVE_CONTROL_PLANE_MODE: "native" });
  assert.equal(runtimeEnvironment({ ...original, ROLEWEAVE_CONTROL_PLANE_MODE: "wsl" }, dir, "win32").ROLEWEAVE_CONTROL_PLANE_MODE, "wsl");
});

test("public WSL Node path overrides saved preferences through bundled command and launch", (t) => {
  windowsPlatform(t);
  const dir = settingsDirectory(t, { mode: "wsl", distro: "Ubuntu", nodePath: "/opt/saved node/bin/node" });
  const enginePath = "C:\\Program Files\\RoleWeave\\qoder-engine.mjs";
  for (const override of [undefined, "/opt/operator node/bin/node", ""]) {
    const original = override === undefined ? {} : { ROLEWEAVE_WSL_NODE_PATH: override };
    const before = { ...original };
    const env = runtimeEnvironment(original, dir, "win32");
    const nodePath = override ?? "/opt/saved node/bin/node";
    assert.equal(env.ROLEWEAVE_WSL_NODE_PATH, nodePath);
    assert.equal(bundledEngineCommand(enginePath, env), `"${nodePath || "node"}" "/mnt/c/Program Files/RoleWeave/qoder-engine.mjs"`);
    const spec = wslLaunchSpec({ serverEntry: "C:\\RoleWeave\\server.js", bootstrapEntry: "C:\\RoleWeave\\wsl-bootstrap.cjs", env });
    assert.equal(spec.args.at(-2), nodePath);
    assert.deepEqual(original, before);
  }
});

test("invalid persisted settings fail explicitly instead of switching environments", (t) => {
  for (const settings of [null, [], "wsl", { mode: "other" }, { mode: null }, { mode: 1 },
    { mode: "wsl", distro: "../Ubuntu" }, { distro: "Ubuntu\\Other" },
    { mode: "wsl", nodePath: "node --eval bad" }, { mode: "wsl", homePath: "C:\\Users" },
    { mode: "wsl", distro: "Ubuntu\nargument" }, { mode: "wsl", token: "not-a-setting" }]) {
    assert.throws(() => validateRuntimeSettings(settings));
    assert.throws(() => runtimeEnvironment({}, settingsDirectory(t, settings), "win32"));
  }
  for (const field of ["distro", "nodePath", "homePath"]) {
    for (const value of [null, 1, [], {}, "", "  ", "/bad\0path", "/bad\tpath", "/bad\x7fpath", "/" + "a".repeat(4096)]) {
      assert.throws(() => validateRuntimeSettings({ [field]: value }), new RegExp(field));
    }
  }
  assert.throws(() => runtimeEnvironment({}, settingsDirectory(t, { mode: "unknown" }), "win32"), /mode/);
  assert.throws(() => runtimeEnvironment({}, settingsDirectory(t, { nodePath: "node" }), "win32"), /nodePath/);
});

test("malformed settings are explained on Windows and ignored on other platforms", (t) => {
  const dir = settingsDirectory(t);
  fs.writeFileSync(path.join(dir, "runtime-settings.json"), "{invalid");
  assert.throws(() => runtimeEnvironment({}, dir, "win32"), /Cannot read local runtime settings/);
  assert.deepEqual(runtimeEnvironment({ PATH: "native" }, dir, "linux"), { PATH: "native" });
  assert.deepEqual(runtimeEnvironment({ PATH: "native" }, dir, "darwin"), { PATH: "native" });
});

test("WSL launch preserves arguments and sends provider variables over stdin, never argv or WSLENV", () => {
  const secret = "fixture-secret-never-in-argv";
  const spec = wslLaunchSpec({
    serverEntry: "C:\\Program Files\\RoleWeave\\server.js",
    bootstrapEntry: "C:\\Program Files\\RoleWeave\\wsl-bootstrap.cjs",
    env: {
      ROLEWEAVE_WSL_DISTRO: "Ubuntu-22.04",
      ROLEWEAVE_WSL_NODE_PATH: "/home/demo/node dir/node",
      ROLEWEAVE_WSL_HOME: "/home/demo",
      ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI: '"/home/demo/node dir/node" "/mnt/c/Program Files/RoleWeave/qoder-engine.mjs"',
      ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE: "1",
      OPENAI_API_KEY: secret,
      WSLENV: "EXISTING/u",
      PATH: "C:\\Windows",
      HOME: "C:\\Users\\demo",
      HTTPS_PROXY: "http://windows-proxy.invalid",
      NODE_EXTRA_CA_CERTS: "C:\\Windows\\ca.pem",
    },
  });
  assert.equal(spec.command, "wsl.exe");
  assert.deepEqual(spec.args.slice(0, 5), ["--distribution", "Ubuntu-22.04", "--exec", "/bin/sh", "-c"]);
  assert.deepEqual(spec.args.slice(-2), ["/home/demo/node dir/node", "/mnt/c/Program Files/RoleWeave/wsl-bootstrap.cjs"]);
  assert.ok(!spec.args.some((arg) => arg.includes(secret)));
  assert.equal(spec.env.WSLENV, "");
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.deepEqual(JSON.parse(spec.input), {
    version: 1,
    serverEntry: "/mnt/c/Program Files/RoleWeave/server.js",
    engineCommand: null,
    environment: { OPENAI_API_KEY: secret },
  });
  const operatorCommand = `custom-engine --token ${secret}`;
  const operatorSpec = wslLaunchSpec({ serverEntry: "/app/server.js", env: { ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI: operatorCommand } });
  assert.equal(JSON.parse(operatorSpec.input).engineCommand, operatorCommand);
  assert.ok(!operatorSpec.args.some((arg) => arg.includes(secret)));
});

test("WSL bundled adapter uses Linux Node and translates only configured UNC shares", (t) => {
  windowsPlatform(t);
  assert.equal(bundledEngineCommand("C:\\Program Files\\RoleWeave\\qoder-engine.mjs", {
    ROLEWEAVE_CONTROL_PLANE_MODE: "wsl", ROLEWEAVE_WSL_NODE_PATH: "/home/demo/node/bin/node",
  }), '"/home/demo/node/bin/node" "/mnt/c/Program Files/RoleWeave/qoder-engine.mjs"');
  for (const prefix of ["\\\\wsl.localhost", "\\\\wsl$"]) {
    const workspace = `${prefix}\\Ubuntu-22.04\\home\\demo\\workspace`;
    assert.equal(winToWslPath(workspace, "Ubuntu-22.04"), "/home/demo/workspace");
    assert.throws(() => winToWslPath(workspace), { code: "wsl_distribution_mismatch" });
  }
});

test("native bundled adapter quotes both executable and engine path", (t) => {
  windowsPlatform(t);
  assert.equal(bundledEngineCommand("C:\\Program Files\\RoleWeave\\qoder-engine.mjs", {
    ROLEWEAVE_CONTROL_PLANE_MODE: "native", ROLEWEAVE_WSL_NODE_PATH: "/unused/node",
  }, "C:\\Program Files\\RoleWeave\\RoleWeave.exe"),
  '"C:\\\\Program Files\\\\RoleWeave\\\\RoleWeave.exe" "C:\\\\Program Files\\\\RoleWeave\\\\qoder-engine.mjs"');
});

test("WSL paths cannot silently cross or omit the configured Linux distribution", (t) => {
  windowsPlatform(t);
  const env = { ROLEWEAVE_CONTROL_PLANE_MODE: "wsl", ROLEWEAVE_WSL_DISTRO: "Ubuntu-22.04" };
  for (const prefix of ["\\\\wsl.localhost", "\\\\wsl$"]) {
    const matching = `${prefix}\\ubuntu-22.04\\home\\demo\\workspace`;
    const other = `${prefix}\\Debian\\home\\demo\\workspace`;
    assert.equal(serverPathForWorkspace(matching, env), "/home/demo/workspace");
    for (const selectedEnv of [env, { ROLEWEAVE_CONTROL_PLANE_MODE: "wsl" }]) {
      assert.throws(() => serverPathForWorkspace(other, selectedEnv), { code: "wsl_distribution_mismatch" });
      assert.throws(() => bundledEngineCommand(other, selectedEnv), { code: "wsl_distribution_mismatch" });
      assert.throws(() => wslLaunchSpec({ serverEntry: other, env: selectedEnv }), { code: "wsl_distribution_mismatch" });
    }
    assert.equal(serverPathForWorkspace(other, { ROLEWEAVE_CONTROL_PLANE_MODE: "native" }), other);
  }
  assert.equal(serverPathForWorkspace("C:\\Users\\demo\\workspace", env), "/mnt/c/Users/demo/workspace");
});

test("runtime description and native dialogs use the saved Windows distribution", (t) => {
  windowsPlatform(t);
  const env = runtimeEnvironment({}, settingsDirectory(t, { mode: "wsl", distro: "Ubuntu-22.04", homePath: "/home/tester" }), "win32");
  assert.deepEqual(runtimeDescription(env), { mode: "wsl", distro: "Ubuntu-22.04" });
  assert.equal(workspaceDialogOptions(env).defaultPath, "\\\\wsl.localhost\\Ubuntu-22.04\\home\\tester");
  assert.deepEqual(workspaceDialogOptions(env, true).properties, ["openDirectory", "createDirectory"]);
  assert.deepEqual(runtimeDescription({ ROLEWEAVE_CONTROL_PLANE_MODE: "wsl" }), { mode: "wsl", distro: null });
  assert.equal(workspaceDialogOptions({ ROLEWEAVE_CONTROL_PLANE_MODE: "wsl" }).defaultPath, "\\\\wsl.localhost");
  assert.deepEqual(runtimeDescription({ ROLEWEAVE_CONTROL_PLANE_MODE: "native", ROLEWEAVE_WSL_DISTRO: "Ubuntu" }), { mode: "native", distro: null });
  assert.equal(workspaceDialogOptions({}).defaultPath, undefined);
});

test("main uses one cloned desktop environment and retains service startup wiring", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  assert.equal((source.match(/desktopEnv = configurationStore\(\)\.runtimeEnvironment\(process\.env\)/g) ?? []).length, 1);
  assert.match(source, /const configurationStore = \(\) => configuration \?\?= createConfigurationStore\(\{ userDataPath: app\.getPath\("userData"\), safeStorage \}\)/);
  assert.doesNotMatch(source, /runtimeEnvironment\(process\.env, app\.getPath/);
  assert.match(source, /const env = configurationStore\(\)\.hostEnvironment\(\{\s*\.\.\.desktopEnv,/);
  assert.match(source, /return bundledEngineCommand\(enginePath, desktopEnv\)/);
  assert.doesNotMatch(source, /Object\.assign\(process\.env/);
  assert.match(source, /readyTimeoutMs: controlPlaneMode\(desktopEnv\) === "wsl" \? 45000 : DEFAULT_READY_TIMEOUT_MS/);
  assert.match(source, /const serviceConnections = createServiceConnections\(/);
  assert.match(source, /read: \(\) => configurationStore\(\)\.readServices\(\)/);
  assert.match(source, /write: \(connections\) => configurationStore\(\)\.writeServices\(connections\)/);
  assert.match(source, /registerServiceIpc\(\{\s*ipcMain, manager: serviceConnections/);
  assert.match(source, /controlPlane = await startControlPlane\(\);[\s\S]*await serviceConnections\.initialize\(\);[\s\S]*await openDefaultWorkspace\(/);
});

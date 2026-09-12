const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const vm = require("node:vm");
const {
  controlPlaneMode,
  createControlPlaneChild,
  engineRuntimeEnvironment,
  serverPathForWorkspace,
  stripPackagedSmokeControls,
  winToWslPath,
  wslLaunchSpec,
} = require("../src/control-plane-launch.cjs");
const { parseConfiguration, serverEnvironment } = require("../src/wsl-bootstrap.cjs");

test("winToWslPath converts drive paths to /mnt/<drive>/...", () => {
  assert.equal(winToWslPath("C:\\Users\\a\\server.js"), "/mnt/c/Users/a/server.js");
  assert.equal(winToWslPath("D:/x/y.js"), "/mnt/d/x/y.js");
  assert.equal(winToWslPath("/already/wsl.js"), "/already/wsl.js"); // unchanged
});

test("controlPlaneMode: native off-win32, wsl only on explicit opt-in", () => {
  // On the CI (linux) this is always native regardless of env.
  if (process.platform !== "win32") {
    assert.equal(controlPlaneMode({ ORG_WORKBENCH_CONTROL_PLANE: "wsl" }), "native");
    assert.equal(controlPlaneMode({}), "native");
    return;
  }
  assert.equal(controlPlaneMode({}), "native");
  assert.equal(controlPlaneMode({ ORG_WORKBENCH_CONTROL_PLANE: "wsl" }), "wsl");
  assert.equal(controlPlaneMode({ ORG_WORKBENCH_CONTROL_PLANE: "native" }), "native");
});

test("controlPlaneMode: win32 honors ROLEWEAVE_CONTROL_PLANE_MODE alias and legacy name", (t) => {
  // Mock the platform so the win32 opt-in branch runs on linux/mac CI too.
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));

  assert.equal(controlPlaneMode({}), "native");
  assert.equal(controlPlaneMode({ ROLEWEAVE_CONTROL_PLANE_MODE: "wsl" }), "wsl");
  assert.equal(controlPlaneMode({ ROLEWEAVE_CONTROL_PLANE_MODE: "WSL" }), "wsl");
  assert.equal(controlPlaneMode({ ROLEWEAVE_CONTROL_PLANE_MODE: "native" }), "native");
  assert.equal(controlPlaneMode({ ORG_WORKBENCH_CONTROL_PLANE: "wsl" }), "wsl");
  // The RoleWeave name wins when both are set, mirroring workspaceOverride.
  assert.equal(
    controlPlaneMode({ ROLEWEAVE_CONTROL_PLANE_MODE: "wsl", ORG_WORKBENCH_CONTROL_PLANE: "native" }),
    "wsl",
  );
});

test("engine runtime marks only the desktop default as the bundled Electron engine", () => {
  assert.deepEqual(engineRuntimeEnvironment({}, '"/Applications/RoleWeave" "qoder-engine.mjs"'), {
    ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI: '"/Applications/RoleWeave" "qoder-engine.mjs"',
    ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE: "1",
  });
  assert.deepEqual(
    engineRuntimeEnvironment(
      { ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI: "/opt/digital-employee" },
      '"/Applications/RoleWeave" "qoder-engine.mjs"',
    ),
    {
      ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI: "/opt/digital-employee",
      ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE: "0",
    },
  );
});

test("control-plane child cannot inherit or forge packaged smoke controls", async (t) => {
  const env = {
    PATH: process.env.PATH,
    ORG_WORKBENCH_CONTROL_PLANE: "native",
    ORG_WORKBENCH_PACKAGED_SMOKE_ROOT: "/forged/root",
    ORG_WORKBENCH_PACKAGED_SMOKE_REPORT: "/forged/report.json",
    ORG_WORKBENCH_PACKAGED_SMOKE_NONCE: "a".repeat(64),
    ORG_WORKBENCH_PACKAGED_BEHAVIOR_SMOKE_ROOT: "/forged/behavior-root",
    ORG_WORKBENCH_PACKAGED_BEHAVIOR_SMOKE_REPORT: "/forged/behavior-report.json",
    ORG_WORKBENCH_PACKAGED_BEHAVIOR_SMOKE_NONCE: "b".repeat(64),
    SAFE_SENTINEL: "retained",
  };
  assert.deepEqual(stripPackagedSmokeControls(env), {
    PATH: process.env.PATH,
    ORG_WORKBENCH_CONTROL_PLANE: "native",
    SAFE_SENTINEL: "retained",
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-control-env-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const fixture = path.join(root, "inspect-env.cjs");
  fs.writeFileSync(
    fixture,
    "process.stdout.write(JSON.stringify({smoke:Object.keys(process.env).filter(k=>k.startsWith('ORG_WORKBENCH_PACKAGED_SMOKE_')),safe:process.env.SAFE_SENTINEL}))",
  );
  const child = createControlPlaneChild({ serverEntry: fixture, env });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output), { smoke: [], safe: "retained" });
});

test("control-plane child strips lower and mixed-case smoke controls", async (t) => {
  const env = {
    PATH: process.env.PATH,
    Org_Workbench_Packaged_Smoke_Root: "/forged/static-root",
    org_workbench_packaged_smoke_report: "/forged/static-report.json",
    ORG_WORKBENCH_PACKAGED_SMOKE_NONCE: "a".repeat(64),
    Org_Workbench_Packaged_Behavior_Smoke_Root: "/forged/behavior-root",
    org_workbench_packaged_behavior_smoke_report: "/forged/behavior-report.json",
    ORG_WORKBENCH_PACKAGED_BEHAVIOR_SMOKE_NONCE: "b".repeat(64),
    SAFE_SENTINEL: "retained",
  };
  assert.deepEqual(stripPackagedSmokeControls(env), {
    PATH: process.env.PATH,
    SAFE_SENTINEL: "retained",
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-control-env-case-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const fixture = path.join(root, "inspect-env.cjs");
  fs.writeFileSync(
    fixture,
    [
      "const upper=(value)=>value.replace(/[a-z]/g,(c)=>String.fromCharCode(c.charCodeAt(0)-32))",
      "const controls=Object.keys(process.env).filter((key)=>upper(key).startsWith('ORG_WORKBENCH_PACKAGED_SMOKE_')||upper(key).startsWith('ORG_WORKBENCH_PACKAGED_BEHAVIOR_SMOKE_'))",
      "process.stdout.write(JSON.stringify({controls,safe:process.env.SAFE_SENTINEL}))",
    ].join(";"),
  );
  const child = createControlPlaneChild({ serverEntry: fixture, env });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output), { controls: [], safe: "retained" });
});

test("serverPathForWorkspace converts Windows paths in WSL mode on win32", () => {
  if (process.platform !== "win32") {
    // controlPlaneMode is always native off-win32, so no conversion happens.
    assert.equal(
      serverPathForWorkspace("C:\\Users\\me\\.org-workbench\\demo-workspace", { ORG_WORKBENCH_CONTROL_PLANE: "wsl" }),
      "C:\\Users\\me\\.org-workbench\\demo-workspace",
    );
    return;
  }
  assert.equal(
    serverPathForWorkspace("C:\\Users\\me\\.org-workbench\\demo-workspace", { ORG_WORKBENCH_CONTROL_PLANE: "wsl" }),
    "/mnt/c/Users/me/.org-workbench/demo-workspace",
  );
  assert.equal(
    serverPathForWorkspace("D:/projects/ws", { ORG_WORKBENCH_CONTROL_PLANE: "wsl" }),
    "/mnt/d/projects/ws",
  );
});

test("serverPathForWorkspace passes paths through in native mode", () => {
  assert.equal(
    serverPathForWorkspace("C:\\Users\\me\\workspace", {}),
    "C:\\Users\\me\\workspace",
  );
  assert.equal(
    serverPathForWorkspace("/home/user/workspace", {}),
    "/home/user/workspace",
  );
});

test("serverPathForWorkspace always passes through on non-win32 regardless of env", () => {
  if (process.platform === "win32") return;
  assert.equal(
    serverPathForWorkspace("/home/user/workspace", { ORG_WORKBENCH_CONTROL_PLANE: "wsl" }),
    "/home/user/workspace",
  );
});

test("every workspace-open POST routes paths through the runtime boundary", () => {
  const sources = [
    fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8"),
    fs.readFileSync(
      path.join(__dirname, "..", "src", "auto-open-workspace.cjs"),
      "utf8",
    ),
    fs.readFileSync(path.join(__dirname, "..", "src", "workspace-ipc.cjs"), "utf8"),
  ];
  let totalOpenSites = 0;
  for (const source of sources) {
    const lines = source.split("\n");
    const openCallLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("/workspace/open")) {
        openCallLines.push(i);
      }
    }
    totalOpenSites += openCallLines.length;
    for (const idx of openCallLines) {
      const block = lines.slice(Math.max(0, idx - 2), idx + 8).join("\n");
      if (!block.includes("POST")) continue;
      assert.match(
        block,
        /serverPathForWorkspace\(/,
        `/workspace/open POST block at line ${idx + 1} missing serverPathForWorkspace`,
      );
    }
  }
  assert.ok(totalOpenSites >= 2, `expected at least 2 /workspace/open sites, found ${totalOpenSites}`);
});

test("main.js awaits best-effort auto-open inside the startup failure boundary", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "main.js"),
    "utf8",
  );
  const call = "const autoOpenResult = await openDefaultWorkspace({";
  const callIndex = source.indexOf(call);
  assert.notEqual(callIndex, -1, "main.js must await openDefaultWorkspace");
  const tryIndex = source.lastIndexOf("try {", callIndex);
  const catchIndex = source.indexOf("} catch (err) {", callIndex);
  assert.ok(tryIndex >= 0 && catchIndex > callIndex, "auto-open must stay inside startup try/catch");
  const block = source.slice(callIndex, catchIndex);
  assert.match(block, /apiRequest,/, "auto-open must use the control-plane request function");
  assert.match(block, /env: (?:process\.env|desktopEnv),/, "auto-open must use the selected desktop runtime environment");
  assert.match(block, /userDataPath: app\.getPath\("userData"\)/, "auto-open must use app userData");
});

test("workspace persistence keeps a Windows-browsable path", () => {
  const mainSource = ["main.js", "workspace-ipc.cjs"].map((name) =>
    fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8")).join("\n");
  const lines = mainSource.split("\n");
  const persistLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("writeLastWorkspacePath(")) {
      persistLines.push(i);
    }
  }
  assert.ok(persistLines.length >= 1, "expected at least 1 writeLastWorkspacePath call");
  for (const idx of persistLines) {
    const block = lines.slice(Math.max(0, idx - 4), idx + 3).join("\n");
    assert.doesNotMatch(
      block,
      /serverPathForWorkspace\(/,
      `writeLastWorkspacePath at line ${idx + 1} must store the raw path: `
      + "the boot-time reopen checks fs.existsSync from the Windows side, "
      + "where a /mnt/c/... value can never resolve",
    );
  }
});

test("WSL UNC paths support both aliases and reject another distribution", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  const env = { ROLEWEAVE_CONTROL_PLANE_MODE: "wsl", ROLEWEAVE_WSL_DISTRO: "Ubuntu-22.04" };
  for (const host of ["wsl$", "wsl.localhost"]) {
    assert.equal(serverPathForWorkspace(`\\\\${host}\\Ubuntu-22.04\\home\\me\\中文 project`, env), "/home/me/中文 project");
    assert.equal(serverPathForWorkspace(`\\\\${host}\\ubuntu-22.04`, env), "/");
    assert.throws(() => serverPathForWorkspace(`\\\\${host}\\Debian\\home\\me`, env), { code: "wsl_distribution_mismatch" });
    assert.throws(() => serverPathForWorkspace(`\\\\${host}\\Ubuntu-22.04\\..\\other`, env), { code: "wsl_path_invalid" });
  }
  assert.throws(() => serverPathForWorkspace("\\\\server\\share", env), { code: "wsl_path_invalid" });
  assert.throws(() => serverPathForWorkspace("\\\\wsl$\\Ubuntu-22.04\\home", { ROLEWEAVE_CONTROL_PLANE_MODE: "wsl" }), { code: "wsl_distribution_mismatch" });
  assert.equal(serverPathForWorkspace("D:\\my project", env), "/mnt/d/my project");
  assert.equal(serverPathForWorkspace("/home/me/project", env), "/home/me/project");
  assert.equal(serverPathForWorkspace("\\\\wsl$\\Debian\\home", {}), "\\\\wsl$\\Debian\\home");
});

test("WSL launch has fixed shell source, literal argv paths, and credentials only in bounded stdin JSON", () => {
  const spec = wslLaunchSpec({
    serverEntry: "D:\\RoleWeave $() `literal`\\apps\\server\\dist\\src\\index.js",
    bootstrapEntry: "D:\\RoleWeave $() `literal`\\apps\\desktop\\src\\wsl-bootstrap.cjs",
    env: {
      ROLEWEAVE_WSL_DISTRO: "Ubuntu-22.04",
      ROLEWEAVE_WSL_NODE: "/home/me/node $(literal)/bin/node",
      ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE: "1",
      ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI: '"D:\\RoleWeave\\RoleWeave.exe" "D:\\engine.mjs"',
      OPENAI_API_KEY: "dummy-secret-only-for-stdin",
      PATH: "C:\\Windows",
      HOME: "C:\\Users\\me",
      HTTP_PROXY: "http://windows-proxy.invalid",
      NODE_EXTRA_CA_CERTS: "C:\\windows-ca.pem",
      WSLENV: "HOME/p:HTTP_PROXY:NODE_EXTRA_CA_CERTS/p",
    },
  });
  assert.equal(spec.command, "wsl.exe");
  assert.deepEqual(spec.args.slice(0, 5), ["--distribution", "Ubuntu-22.04", "--exec", "bash", "-lc"]);
  assert.deepEqual(spec.args.slice(-3), ["roleweave-wsl", "/home/me/node $(literal)/bin/node", "/mnt/d/RoleWeave $() `literal`/apps/desktop/src/wsl-bootstrap.cjs"]);
  assert.ok(!spec.args.join(" ").includes("dummy-secret"));
  assert.ok(!spec.args[5].includes("/mnt/d"), "user paths must never be inserted into shell source");
  const config = parseConfiguration(spec.input);
  assert.equal(config.engineCommand, null, "the Windows bundled Electron command must be discarded");
  assert.equal(config.serverEntry, "/mnt/d/RoleWeave $() `literal`/apps/server/dist/src/index.js");
  assert.deepEqual(config.environment, { OPENAI_API_KEY: "dummy-secret-only-for-stdin" });
  assert.equal(spec.env.WSLENV, "");
});

test("WSL launch rejects invalid distribution, node path, and oversized configuration", () => {
  const base = { serverEntry: "/app/server/dist/src/index.js", bootstrapEntry: "/app/desktop/src/wsl-bootstrap.cjs" };
  assert.throws(() => wslLaunchSpec({ ...base, env: { ROLEWEAVE_WSL_DISTRO: "--exec" } }), { code: "wsl_distribution_invalid" });
  for (const nodePath of ["C:\\node.exe", "node --eval code", "/usr/bin/node\n--eval"]) {
    assert.throws(() => wslLaunchSpec({ ...base, env: { ROLEWEAVE_WSL_NODE: nodePath } }), { code: "wsl_node_invalid" });
  }
  assert.throws(() => wslLaunchSpec({ ...base, env: { OPENAI_API_KEY: "x".repeat(128 * 1024) } }), { code: "wsl_config_invalid" });
});

test("Windows WSL child keeps its stdin lease open and graceful kill closes that lease", () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  const killed = [];
  child.kill = (signal) => { killed.push(signal); return true; };
  let received = "";
  child.stdin.on("data", (chunk) => { received += String(chunk); });
  let invocation;
  const sandbox = {
    module: { exports: {} }, Buffer, __dirname: "C:\\RoleWeave\\apps\\desktop\\src",
    process: { platform: "win32", execPath: "C:\\RoleWeave\\RoleWeave.exe" },
    require: (name) => {
      if (name === "node:child_process") return { spawn: (...args) => { invocation = args; return child; } };
      if (name === "node:path") return path.win32;
      if (name === "./wsl-bootstrap.cjs") return require("../src/wsl-bootstrap.cjs");
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/control-plane-launch.cjs"), "utf8"), sandbox);
  const actual = sandbox.module.exports.createControlPlaneChild({
    serverEntry: "C:\\RoleWeave\\apps\\server\\dist\\src\\index.js",
    env: { ROLEWEAVE_CONTROL_PLANE_MODE: "wsl", ROLEWEAVE_WSL_DISTRO: "Ubuntu-22.04" },
  });
  assert.equal(actual, child);
  assert.deepEqual(Array.from(invocation[2].stdio), ["pipe", "pipe", "pipe"]);
  assert.equal(parseConfiguration(received).serverEntry, "/mnt/c/RoleWeave/apps/server/dist/src/index.js");
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(child.kill("SIGTERM"), true);
  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(killed, [], "graceful shutdown must let the Linux supervisor clean its children first");
  child.kill("SIGKILL");
  assert.deepEqual(killed, ["SIGKILL"], "forced escalation must still reach wsl.exe");
});

test("Linux environment preserves local CLI login, proxy, and CA settings while pinning the Linux bundled engine", () => {
  const config = parseConfiguration(JSON.stringify({ version: 1, serverEntry: "/mnt/d/My App/apps/server/dist/src/index.js", engineCommand: null, environment: { OPENAI_MODEL: "example-model" } }));
  const source = {
    PATH: "/usr/bin:/bin", HOME: "/home/me", CODEX_HOME: "/home/me/.codex",
    DIGITAL_EMPLOYEE_CODEX_COMMAND: "/home/me/bin/codex", HTTPS_PROXY: "http://linux-proxy.invalid",
    NODE_EXTRA_CA_CERTS: "/home/me/ca.pem", ELECTRON_RUN_AS_NODE: "1",
    ORG_WORKBENCH_PACKAGED_SMOKE_ROOT: "/forged",
  };
  const env = serverEnvironment(config, source, "/home/me/Node 24/bin/node");
  assert.equal(env.ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI, '"/home/me/Node 24/bin/node" "/mnt/d/My App/apps/server/bin/qoder-engine.mjs"');
  assert.equal(env.ORG_WORKBENCH_INTERNAL_BUNDLED_NODE_ENGINE, "1");
  assert.equal(env.ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE, "0");
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.PATH, "/home/me/Node 24/bin:/usr/bin:/bin");
  for (const key of ["HOME", "CODEX_HOME", "DIGITAL_EMPLOYEE_CODEX_COMMAND", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"]) assert.equal(env[key], source[key]);
  assert.equal(env.ORG_WORKBENCH_PACKAGED_SMOKE_ROOT, undefined);
  const external = serverEnvironment({ ...config, engineCommand: "/opt/engine --local" }, source, "/usr/bin/node");
  assert.equal(external.ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI, "/opt/engine --local");
  assert.equal(external.ORG_WORKBENCH_INTERNAL_BUNDLED_NODE_ENGINE, "0");
  assert.throws(() => parseConfiguration(JSON.stringify({ ...config, environment: { HOME: "C:\\Users" } })), /environment is invalid/);
});

function waitForLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => { stream.removeListener("data", onData); reject(new Error("fixture output timed out")); }, 5000);
    const onData = (chunk) => {
      buffer += String(chunk);
      if (!buffer.includes("\n")) return;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      resolve(buffer.slice(0, buffer.indexOf("\n")));
    };
    stream.on("data", onData);
  });
}

function testRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleweave-wsl-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runningProcess(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
  } catch { return false; }
}

test("Linux supervisor EOF reaps the server and a detached Host that ignores TERM", { skip: process.platform !== "linux" }, async (t) => {
  const root = testRoot(t);
  const serverEntry = path.join(root, "server.cjs");
  fs.writeFileSync(serverEntry, [
    'const {spawn}=require("node:child_process");',
    'const child=spawn(process.execPath,["-e", "process.on(\'SIGTERM\',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});',
    'process.on("SIGTERM",()=>{});',
    'setTimeout(()=>console.log(JSON.stringify({server:process.pid,host:child.pid})),150);',
    'setInterval(()=>{},1000);',
  ].join("\n"));
  const child = spawn(process.execPath, [path.join(__dirname, "../src/wsl-bootstrap.cjs")], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.stdin.end());
  const output = waitForLine(child.stdout);
  child.stdin.write(JSON.stringify({ version: 1, serverEntry, engineCommand: null, environment: {} }) + "\n");
  const pids = JSON.parse(await output);
  assert.ok(runningProcess(pids.server));
  assert.ok(runningProcess(pids.host));
  const closed = once(child, "close");
  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 0);
  assert.equal(runningProcess(pids.server), false, "server must be reaped on parent disconnect");
  assert.equal(runningProcess(pids.host), false, "detached Host must not survive shutdown");
});

test("Linux supervisor rejects unexpected environment keys without echoing values or hanging", { skip: process.platform !== "linux" }, async () => {
  const child = spawn(process.execPath, [path.join(__dirname, "../src/wsl-bootstrap.cjs")], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const closed = once(child, "close");
  child.stdin.write(JSON.stringify({ version: 1, serverEntry: "/missing/server.js", engineCommand: null, environment: { NODE_OPTIONS: "dummy-secret-loader" } }) + "\n");
  assert.equal((await closed)[0], 1);
  assert.match(stderr, /configuration is invalid/);
  assert.doesNotMatch(stderr, /dummy-secret-loader/);
});

test("fixed WSL shell accepts literal special-character runtime paths and fails closed on a missing explicit Node", { skip: process.platform !== "linux" }, async (t) => {
  const root = testRoot(t);
  const literalDir = path.join(root, "literal $(no-command) `no-command` 中文");
  fs.mkdirSync(literalDir);
  const nodePath = path.join(literalDir, "node");
  fs.symlinkSync(process.execPath, nodePath);
  const bootstrapEntry = path.join(literalDir, "bootstrap.cjs");
  fs.writeFileSync(bootstrapEntry, 'console.log("LITERAL_PATH_OK")');
  const spec = wslLaunchSpec({ serverEntry: "/app/server/dist/src/index.js", bootstrapEntry, env: { ROLEWEAVE_WSL_NODE: nodePath } });
  const script = spec.args[3]; // No distribution: --exec bash -lc <script> ...
  const child = spawn("/bin/bash", ["-c", script, ...spec.args.slice(4)], { stdio: ["ignore", "pipe", "pipe"] });
  const output = waitForLine(child.stdout);
  const closed = once(child, "close");
  assert.equal(await output, "LITERAL_PATH_OK");
  assert.equal((await closed)[0], 0);
  const invalid = spawn("/bin/bash", ["-c", script, "roleweave-wsl", "/missing/node", bootstrapEntry], { stdio: ["ignore", "pipe", "pipe"] });
  assert.equal((await once(invalid, "close"))[0], 126);
});

test("WSL Node fallback uses a local nvm installation when login PATH has no Node", { skip: process.platform !== "linux" }, async (t) => {
  const root = testRoot(t);
  const nodeDir = path.join(root, "nvm-node", "bin");
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(nodeDir, "node"));
  const nvmDir = path.join(root, ".nvm");
  fs.mkdirSync(nvmDir);
  fs.writeFileSync(path.join(nvmDir, "nvm.sh"), 'nvm() { export PATH="$HOME/nvm-node/bin:$PATH"; }\n');
  const bootstrapEntry = path.join(root, "bootstrap.cjs");
  fs.writeFileSync(bootstrapEntry, 'console.log("NVM_FALLBACK_OK")');
  const spec = wslLaunchSpec({ serverEntry: "/app/server/dist/src/index.js", bootstrapEntry, env: {} });
  const child = spawn("/bin/bash", ["-c", spec.args[3], ...spec.args.slice(4)], {
    env: { HOME: root, PATH: "/no-node-path" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const output = waitForLine(child.stdout);
  const closed = once(child, "close");
  assert.equal(await output, "NVM_FALLBACK_OK");
  assert.equal((await closed)[0], 0);
});

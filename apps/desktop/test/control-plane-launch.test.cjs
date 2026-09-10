const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  controlPlaneMode,
  createControlPlaneChild,
  engineRuntimeEnvironment,
  serverPathForWorkspace,
  stripPackagedSmokeControls,
  winToWslPath,
} = require("../src/control-plane-launch.cjs");

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

test("every /workspace/open POST in main.js and auto-open-workspace.cjs routes path through serverPathForWorkspace", () => {
  const sources = [
    fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8"),
    fs.readFileSync(
      path.join(__dirname, "..", "src", "auto-open-workspace.cjs"),
      "utf8",
    ),
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
  assert.match(block, /env: process\.env,/, "auto-open must use the live process environment");
  assert.match(block, /userDataPath: app\.getPath\("userData"\)/, "auto-open must use app userData");
});

test("main.js persists the untranslated workspace path", () => {
  const mainSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "main.js"),
    "utf8",
  );
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

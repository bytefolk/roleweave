import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DigitalEmployeeCliDriver } from "../src/engine/driver-cli.js";
import { hostHealth, probeWorkbuddyBinary, type WorkbuddyBinaryState } from "../src/routes/health.js";

const credential = "fixture-workbuddy-service-key";
const provider = { CODEBUDDY_API_KEY: credential, CODEBUDDY_MODEL: "fixture-model" };
const binary = { installed: true, supported: true, version: "2.137.1" };
const envelope = { schemaVersion: "turn-envelope.v1" as const, workspaceRef: "/workspace", positionId: "owner", turnId: "workbuddy-turn", input: "hello", envelopeDigest: `sha256:${"a".repeat(64)}` };
const health = (env: NodeJS.ProcessEnv = provider, state: WorkbuddyBinaryState = binary, bundled = true, available = true) => hostHealth({ engineAvailable: available, bundledElectronEngine: bundled, env, workbuddy: state, platform: "darwin" }).workbuddy!;

for (const [label, env, expected] of [
  ["missing key", { CODEBUDDY_MODEL: "fixture-model" }, /CODEBUDDY_API_KEY/],
  ["blank key", { ...provider, CODEBUDDY_API_KEY: "  " }, /CODEBUDDY_API_KEY/],
  ["control character key", { ...provider, CODEBUDDY_API_KEY: "invalid\nkey" }, /CODEBUDDY_API_KEY/],
  ["oversized key", { ...provider, CODEBUDDY_API_KEY: "k".repeat(8193) }, /CODEBUDDY_API_KEY/],
  ["missing model", { CODEBUDDY_API_KEY: credential }, /CODEBUDDY_MODEL/],
  ["ambient per-turn model override", { CODEBUDDY_API_KEY: credential, ROLEWEAVE_TURN_MODEL: "ambient-model" }, /CODEBUDDY_MODEL/],
  ["invalid model", { ...provider, CODEBUDDY_MODEL: "--unsafe" }, /CODEBUDDY_MODEL/],
  ["invalid endpoint", { ...provider, CODEBUDDY_BASE_URL: "http://unsafe.example/private" }, /CODEBUDDY_BASE_URL/],
  ["invalid network environment", { ...provider, CODEBUDDY_INTERNET_ENVIRONMENT: "untrusted" }, /CODEBUDDY_INTERNET_ENVIRONMENT/],
] as const) {
  test(`WorkBuddy health fails closed for ${label} without reflecting secrets`, () => {
    const result = health(env);
    assert.equal(result.configured, false);
    assert.equal(result.ready, false);
    assert.match(result.nextStep ?? "", expected);
    assert.equal(JSON.stringify(result).includes(credential), false);
    assert.equal(JSON.stringify(result).includes("unsafe.example"), false);
  });
}

test("WorkBuddy health separates usable service configuration, missing binary, version and bundled adapter", () => {
  assert.equal(health().ready, true);
  assert.equal(health().model, "fixture-model");
  const absent = health(provider, { installed: false, supported: false, version: null });
  assert.equal(absent.ready, false);
  assert.match(absent.nextStep ?? "", /DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND/);
  assert.match(absent.nextStep ?? "", /app\.asar\.unpacked/);
  const unsupported = health(provider, { installed: true, supported: false, version: "/private/secret 2.999.1" });
  assert.equal(unsupported.ready, false);
  assert.match(unsupported.nextStep ?? "", /2\.106\.4.*2\.137\.1/);
  assert.equal(unsupported.nextStep?.includes("/private/secret"), false);
  assert.equal(health(provider, binary, false).ready, false);
  assert.match(health(provider, binary, false).nextStep ?? "", /bundled/);
  const unavailable = health(provider, binary, true, false);
  assert.equal(unavailable.configured, true);
  assert.equal(unavailable.ready, false);
  assert.match(unavailable.nextStep ?? "", /bundled/);
});


test("WorkBuddy health names the Windows process cleanup limitation", () => {
  const result = hostHealth({ engineAvailable: true, bundledElectronEngine: true, env: provider, workbuddy: binary, platform: "win32" }).workbuddy!;
  assert.equal(result.configured, true);
  assert.equal(result.ready, false);
  assert.match(result.nextStep ?? "", /Windows.*进程树/);
  assert.equal(JSON.stringify(result).includes(credential), false);
});

test("WorkBuddy version health probes accept only complete audited versions and isolate environment", { skip: process.platform === "win32" }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-health-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const command = path.join(dir, "codebuddy");
  const capture = path.join(dir, "probe-env.json");
  for (const [version, supported] of [["2.106.4", true], ["2.137.1", true], ["2.106.0", false], ["2.138.0", false], ["2.137.1-dev", false], ["prefix 2.137.1 secret", false]] as const) {
    await fs.writeFile(command, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.env));console.log(${JSON.stringify(version)});\n`, { mode: 0o700 });
    const result = probeWorkbuddyBinary({ PATH: path.dirname(process.execPath), DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND: command, ...provider, OPENAI_API_KEY: "foreign-key", NODE_OPTIONS: "--require=/private/untrusted.cjs", ELECTRON_RUN_AS_NODE: "1", ORG_WORKBENCH_BOOT_TOKEN: "boot-secret", CODEBUDDY_CONFIG_DIR: "/private/account", WORKBUDDY_CONFIG_DIR: "/private/account" });
    assert.equal(result.installed, true, version);
    assert.equal(result.supported, supported, version);
    const environment = JSON.parse(await fs.readFile(capture, "utf8")) as Record<string, string>;
    for (const name of ["CODEBUDDY_API_KEY", "OPENAI_API_KEY", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "ORG_WORKBENCH_BOOT_TOKEN"]) {
      assert.equal(environment[name], undefined, name);
    }
    for (const name of ["CODEBUDDY_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "HOME"]) {
      assert.notEqual(environment[name], "/private/account", name);
      assert.match(environment[name] ?? "", /roleweave-workbuddy-probe-/);
      await assert.rejects(fs.access(environment[name]!), { code: "ENOENT" });
    }
  }
});

test("WorkBuddy version health probe bounds timeout and output", { skip: process.platform === "win32" }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-probe-bounds-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const command = path.join(dir, "codebuddy");
  await fs.writeFile(command, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
  assert.equal(probeWorkbuddyBinary({ DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND: command }, 100).supported, false);
  await fs.writeFile(command, `#!${process.execPath}\nprocess.stdout.write('2.137.1\\n'+'x'.repeat(131072));\n`, { mode: 0o700 });
  assert.equal(probeWorkbuddyBinary({ DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND: command }, 1000).supported, false);
});

test("WorkBuddy external engine is refused before any process starts", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-driver-closed-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "spawned");
  const cli = path.join(dir, "external.mjs");
  await fs.writeFile(cli, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'spawned');\n`);
  const result = await new DigitalEmployeeCliDriver(`${JSON.stringify(process.execPath)} ${JSON.stringify(cli)}`, 1000, false).turnRun({ workspace: "/workspace", positionId: "owner", engine: "workbuddy", envelope });
  assert.equal(result.status, "indeterminate");
  assert.equal(result.code, "turn_engine_unavailable");
  await assert.rejects(fs.access(marker));
});

test("WorkBuddy driver preserves installation discovery only across its bundled boundary", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-driver-env-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cli = path.join(dir, "bundled.mjs");
  const capture = path.join(dir, "child-env.json");
  await fs.writeFile(cli, `import fs from 'node:fs';for await (const chunk of process.stdin) {}fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.env));const base={runId:'run-workbuddy',timestamp:'2026-09-15T00:00:00.000Z'};console.log(JSON.stringify({...base,type:'run.started'}));console.log(JSON.stringify({...base,type:'run.completed',output:'ok',terminalReason:'goal_met'}));\n`);
  const injected: NodeJS.ProcessEnv = { ...provider, CODEBUDDY_BASE_URL: "https://api.example", CODEBUDDY_INTERNET_ENVIRONMENT: "internal", DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND: "/fixture/codebuddy", ProgramFiles: "/fixture/program-files", PROGRAMFILES: "/fixture/program-files-upper", LOCALAPPDATA: "/fixture/local-appdata", PATHEXT: ".EXE;.CMD", SystemRoot: "/fixture/windows", WINDIR: "/fixture/windows", CODEBUDDY_CONFIG_DIR: "/private/login", WORKBUDDY_CONFIG_DIR: "/private/login", CODEBUDDY_AUTH_TOKEN: "local-account-token", OPENAI_API_KEY: "foreign-openai", ANTHROPIC_API_KEY: "foreign-anthropic", QODER_PERSONAL_ACCESS_TOKEN: "foreign-qoder", ORG_WORKBENCH_BOOT_TOKEN: "boot-token", NODE_OPTIONS: "--require=/private/untrusted.cjs" };
  const saved = Object.fromEntries(Object.keys(injected).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, injected);
    const result = await new DigitalEmployeeCliDriver(`${JSON.stringify(process.execPath)} ${JSON.stringify(cli)}`, 5000, true).turnRun({ workspace: "/workspace", positionId: "owner", engine: "workbuddy", envelope });
    assert.equal(result.status, "trusted", result.diagnostic);
    const environment = JSON.parse(await fs.readFile(capture, "utf8")) as Record<string, string>;
    for (const key of ["CODEBUDDY_API_KEY", "CODEBUDDY_MODEL", "CODEBUDDY_BASE_URL", "CODEBUDDY_INTERNET_ENVIRONMENT", "DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND", "ProgramFiles", "PROGRAMFILES", "LOCALAPPDATA", "PATHEXT", "SystemRoot", "WINDIR"]) assert.equal(environment[key], injected[key], key);
    for (const key of ["CODEBUDDY_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_AUTH_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "QODER_PERSONAL_ACCESS_TOKEN", "ORG_WORKBENCH_BOOT_TOKEN", "NODE_OPTIONS"]) assert.equal(environment[key], undefined, key);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CODEX_DISABLED_FEATURES } from "../src/codex-binary.js";
import { hostHealth, probeCodexBinary } from "../src/routes/health.js";

const HELP = "--strict-config --ignore-user-config --ephemeral --skip-git-repo-check --sandbox --json";
const FEATURES = CODEX_DISABLED_FEATURES.map((name) => `${name}\tunder development\tfalse`).join("\n");
type Invocation = { args: string[]; env: Record<string, string>; cwd: string };

async function fixture(t: test.TestContext, body = "", version = "0.159.2") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-health-test-"));
  const command = path.join(root, process.platform === "win32" ? "codex.cmd" : "codex");
  const script = path.join(root, "codex-fixture.cjs");
  const marker = path.join(root, "calls.jsonl");
  const descendant = path.join(root, "descendant.json");
  await fs.writeFile(script, `#!${process.execPath}\nconst fs=require('node:fs');const {spawn}=require('node:child_process');
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({args,env:process.env,cwd:process.cwd()})+'\\n');
const FEATURES=${JSON.stringify(FEATURES)};const HELP=${JSON.stringify(HELP)};const descendant=${JSON.stringify(descendant)};
${body}
if(args.includes('--version')){console.log(${JSON.stringify(version)});process.exit(0)}
if(args.includes('--help')){console.log(HELP);process.exit(0)}
const disabled=args.flatMap((arg,index)=>arg==='--disable'?[args[index+1]]:[]);
if(JSON.stringify(disabled)!==${JSON.stringify(JSON.stringify(CODEX_DISABLED_FEATURES))})process.exit(4);
if(args.slice(-2).join(' ')!=='features list')process.exit(5);
console.log(FEATURES);\n`, { mode: 0o755 });
  if (process.platform === "win32") await fs.writeFile(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  else await fs.symlink(script, command);
  t.after(async () => {
    try {
      const info = JSON.parse(await fs.readFile(descendant, "utf8"));
      for (const pid of [info.parent, info.child]) { try { process.kill(pid, "SIGKILL"); } catch {} }
    } catch {}
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });
  const calls = async (): Promise<Invocation[]> => fs.readFile(marker, "utf8").then((text) => text.trim().split("\n").map((line) => JSON.parse(line)), () => []);
  return { root, command, marker, descendant, calls };
}

test("Codex health qualifies the exact resolved CLI and complete feature-disable contract", async (t) => {
  const f = await fixture(t);
  const state = await probeCodexBinary({ DIGITAL_EMPLOYEE_CODEX_COMMAND: f.command, PATH: process.env.PATH }, 3000);
  assert.deepEqual(state, { installed: true, version: "0.159.2", supported: true });
  const calls = await f.calls();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]!.args, ["--version"]);
  assert.ok(calls[1]!.args.includes("--help"));
  assert.equal(calls[1]!.args[calls[1]!.args.indexOf("--sandbox") + 1], "read-only");
  assert.deepEqual(calls[2]!.args, [...CODEX_DISABLED_FEATURES.flatMap((name) => ["--disable", name]), "features", "list"]);
  const hosts = hostHealth({ engineAvailable: true, bundledElectronEngine: true, env: {}, codex: state });
  assert.equal(hosts["codex-local"].ready, true);
  assert.equal(hosts.codex.ready, false, "a compatible CLI does not provide an API credential");
});

test("Codex compatibility follows capabilities, not a guessed minimum version", async (t) => {
  const f = await fixture(t, "", "0.145.0");
  assert.equal((await probeCodexBinary({ DIGITAL_EMPLOYEE_CODEX_COMMAND: f.command, PATH: process.env.PATH }, 3000)).supported, true);
});

test("a compatible development CLI can report an unknown version without guessing it", async (t) => {
  const f = await fixture(t, "", "development-build");
  assert.deepEqual(await probeCodexBinary({ DIGITAL_EMPLOYEE_CODEX_COMMAND: f.command, PATH: process.env.PATH }, 3000), { installed: true, version: null, supported: true });
});

test("derived feature states do not falsely reject an accepted disable contract", async (t) => {
  const output = FEATURES.replace("unified_exec\tunder development\tfalse", "unified_exec\tstable\ttrue");
  const f = await fixture(t, `if(args.includes('features')){console.log(${JSON.stringify(output)});process.exit(0);}`);
  assert.deepEqual(await probeCodexBinary({ DIGITAL_EMPLOYEE_CODEX_COMMAND: f.command, PATH: process.env.PATH }, 3000), { installed: true, version: "0.159.2", supported: true });
  const args = (await f.calls())[2]!.args;
  assert.deepEqual(args, [...CODEX_DISABLED_FEATURES.flatMap((name) => ["--disable", name]), "features", "list"], "derived output never removes an adapter safety switch");
});

test("an installed CLI that rejects a required feature cannot be ready in either Codex mode", async (t) => {
  const f = await fixture(t, `if(args.includes('features')){console.error('Unknown feature flag: view_image private-account-detail');process.exit(2);}`);
  const state = await probeCodexBinary({ DIGITAL_EMPLOYEE_CODEX_COMMAND: f.command, PATH: process.env.PATH }, 3000);
  assert.deepEqual(state, { installed: true, version: "0.159.2", supported: false, failure: "codex.unsupported_cli" });
  assert.ok(!JSON.stringify(state).includes("private-account-detail"));
  const hosts = hostHealth({ engineAvailable: true, bundledElectronEngine: true, env: { OPENAI_API_KEY: "synthetic-provider-key" }, codex: state });
  assert.equal(hosts["codex-local"].ready, false);
  assert.equal(hosts.codex.ready, false);
  assert.match(hosts["codex-local"].nextStep!, /功能开关/);
});

test("a CLI that reports an ignored feature cannot qualify by returning a successful exit code", async (t) => {
  const f = await fixture(t, `if(args.includes('features')){console.error('Unknown feature flag: view_image');console.log(FEATURES);process.exit(0);}`);
  assert.equal((await probeCodexBinary({ DIGITAL_EMPLOYEE_CODEX_COMMAND: f.command, PATH: process.env.PATH }, 3000)).failure, "codex.unsupported_cli");
});

test("Codex probes use disposable directories and never receive account or provider settings", async (t) => {
  const f = await fixture(t);
  const foreign = path.join(f.root, "private-user-home");
  await fs.mkdir(foreign);
  const state = await probeCodexBinary({
    DIGITAL_EMPLOYEE_CODEX_COMMAND: f.command, PATH: process.env.PATH,
    HOME: foreign, USERPROFILE: foreign, CODEX_HOME: foreign, APPDATA: foreign, LOCALAPPDATA: foreign,
    XDG_CONFIG_HOME: foreign, XDG_CACHE_HOME: foreign,
    OPENAI_API_KEY: "synthetic-api-key", CODEX_ACCESS_TOKEN: "synthetic-access-token",
    OPENAI_BASE_URL: "https://foreign.example", OPENAI_MODEL: "foreign-model",
    CODEX_AUTH_TOKEN: "synthetic-auth-token", ORG_WORKBENCH_BOOT_TOKEN: "synthetic-boot-token",
    HTTP_PROXY: "http://private-proxy.example", NODE_OPTIONS: "--require=/private/untrusted.cjs", ELECTRON_RUN_AS_NODE: "1",
  }, 3000);
  assert.equal(state.supported, true);
  const calls = await f.calls();
  for (const call of calls) {
    assert.match(call.cwd, /roleweave-codex-probe-/);
    assert.equal(path.dirname(call.env.HOME!), call.cwd);
    for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]) {
      assert.equal(path.dirname(call.env[key]!), call.cwd, key);
    }
    for (const key of ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "OPENAI_MODEL", "CODEX_AUTH_TOKEN", "ORG_WORKBENCH_BOOT_TOKEN", "HTTP_PROXY", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]) assert.equal(call.env[key], undefined, key);
    await assert.rejects(fs.stat(call.cwd), { code: "ENOENT" });
  }
  assert.equal(JSON.stringify(calls).includes(foreign), false);
});

test("an invalid explicit binary never falls back to a healthy PATH installation", async (t) => {
  const f = await fixture(t);
  const state = await probeCodexBinary({ DIGITAL_EMPLOYEE_CODEX_COMMAND: path.join(f.root, "absent"), PATH: f.root }, 3000);
  assert.deepEqual(state, { installed: false, version: null, supported: false, failure: "codex.binary_unavailable" });
  assert.deepEqual(await f.calls(), []);
});

for (const output of [
  FEATURES + "\nview_image stable true",
  FEATURES + "\nview_image stable false",
  FEATURES.replace("view_image\tunder development\tfalse", "view_image\tunder development\tignored"),
  FEATURES.replace("view_image\tunder development\tfalse", "view_image\nunder development false"),
  FEATURES.replace("view_image\tunder development\tfalse", ""),
]) {
  test("missing, duplicate, malformed or split feature rows cannot qualify the CLI", async (t) => {
    const f = await fixture(t, `if(args.includes('features')){console.log(${JSON.stringify(output)});process.exit(0);}`);
    assert.equal((await probeCodexBinary({ DIGITAL_EMPLOYEE_CODEX_COMMAND: f.command, PATH: process.env.PATH }, 3000)).failure, "codex.unsupported_cli");
  });
}

test("an exec help response missing an isolation flag cannot qualify the CLI", async (t) => {
  const f = await fixture(t, `if(args.includes('--help')){console.log(${JSON.stringify(HELP.replace("--ignore-user-config", ""))});process.exit(0);}`);
  assert.equal((await probeCodexBinary({ DIGITAL_EMPLOYEE_CODEX_COMMAND: f.command, PATH: process.env.PATH }, 3000)).failure, "codex.unsupported_cli");
  assert.equal((await f.calls()).length, 2);
});

test("a similarly named help flag cannot substitute for required JSON output", async (t) => {
  const f = await fixture(t, `if(args.includes('--help')){console.log(${JSON.stringify(HELP.replace("--json", "--json-schema"))});process.exit(0);}`);
  assert.equal((await probeCodexBinary({ DIGITAL_EMPLOYEE_CODEX_COMMAND: f.command, PATH: process.env.PATH }, 3000)).failure, "codex.unsupported_cli");
});

test("a disabled-feature prefix cannot conceal excess output", async (t) => {
  const f = await fixture(t, `if(args.includes('features')){process.stdout.write(FEATURES+'\\n'+'x'.repeat(70*1024));setInterval(()=>{},1000);return;}`);
  assert.equal((await probeCodexBinary({ DIGITAL_EMPLOYEE_CODEX_COMMAND: f.command, PATH: process.env.PATH }, 3000)).failure, "codex.probe_output_limit");
});

test("the entire probe has one monotonic time budget even if wall-clock time rolls back", async (t) => {
  t.mock.method(Date, "now", () => 0);
  const f = await fixture(t, `const delay=new Int32Array(new SharedArrayBuffer(4));Atomics.wait(delay,0,0,180);`);
  const started = performance.now();
  assert.equal((await probeCodexBinary({ DIGITAL_EMPLOYEE_CODEX_COMMAND: f.command, PATH: process.env.PATH }, 500)).failure, "codex.probe_timed_out");
  assert.ok(performance.now() - started < 1800, "timeout plus bounded tree cleanup remains finite");
});

test("a timed-out real launcher reaps its owned descendant", async (t) => {
  const f = await fixture(t, `if(args.includes('features')){
const helper=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true});
fs.writeFileSync(descendant,JSON.stringify({parent:process.pid,child:helper.pid}));setInterval(()=>{},1000);return;}`);
  const state = await probeCodexBinary({ DIGITAL_EMPLOYEE_CODEX_COMMAND: f.command, PATH: process.env.PATH }, 2000);
  assert.equal(state.failure, "codex.probe_timed_out");
  const info = JSON.parse(await fs.readFile(f.descendant, "utf8"));
  for (const pid of [info.parent, info.child]) {
    const deadline = performance.now() + 1500;
    while (performance.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

test("a Windows exited launcher with explicitly unclosed streams is not reported ready", async (t) => {
  const f = await fixture(t);
  const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
  const originalSpawn = childProcess.spawn;
  const child = Object.assign(new EventEmitter(), {
    pid: 99999999, exitCode: null as number | null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(), kill: t.mock.fn(),
  });
  let spawns = 0;
  t.mock.method(childProcess, "spawn", () => {
    spawns += 1;
    queueMicrotask(() => {
      child.stdout.write("codex-cli 0.159.2\n");
      child.exitCode = 0;
      child.emit("exit", 0);
      // Deliberately keep both streams open and never emit child.close.
    });
    return child as unknown as ReturnType<typeof originalSpawn>;
  });
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); child.stdout.destroy(); child.stderr.destroy(); });
  const state = await probeCodexBinary({ DIGITAL_EMPLOYEE_CODEX_COMMAND: f.command, PATH: process.env.PATH }, 2000, "win32");
  assert.equal(state.failure, "codex.unsupported_cli");
  assert.equal(spawns, 1, "an incompatible launcher cannot proceed to help or feature probes");
  assert.equal(child.kill.mock.callCount(), 0, "a released Windows PID is never killed");
});

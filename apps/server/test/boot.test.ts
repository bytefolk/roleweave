import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { HealthResponse } from "@roleweave/shared";
import { api, startTestServer } from "./helpers.js";
import {
  __codexVersionProbeSpec,
  hostHealth,
  probeClaudeLocalBinary,
  probeCodexBinary,
  probeQoderLocalBinary,
  supportedClaudeVersion,
  supportedQoderVersion,
} from "../src/routes/health.js";
import { resolveQoderExecutable } from "../src/qoder-binary.js";

async function assertEventuallyReaped(pid: number, timeoutMs = 1000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    assert.ok(performance.now() < deadline, "probe descendant must be reaped before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("probe reaping assertion rejects a process that remains alive", async () => {
  // Signal 0 only observes this test process; the assertion must never kill it.
  await assert.rejects(assertEventuallyReaped(process.pid, 30), /must be reaped before the deadline/);
});

test("normal digital-employee Qoder readiness keeps the service-token gate and never returns credential values", () => {
  const secret = "qoder-secret-must-not-leak";
  const health = hostHealth({
    engineAvailable: true,
    engineVersion: "digital-employee 0.6.1",
    env: { QODER_PERSONAL_ACCESS_TOKEN: secret },
  });
  assert.deepEqual(health.qoder, { configured: true, ready: true });
  assert.equal(health["claude-code"].configured, false);
  assert.equal(health["claude-code"].ready, false);
  assert.doesNotMatch(JSON.stringify(health), new RegExp(secret));

  const cliUnavailable = hostHealth({
    engineAvailable: false,
    engineVersion: "digital-employee 0.6.1",
    env: {
      QODER_PERSONAL_ACCESS_TOKEN: secret,
      ANTHROPIC_API_KEY: "claude-secret-must-not-leak",
    },
  });
  assert.equal(cliUnavailable.qoder.configured, true);
  assert.equal(cliUnavailable.qoder.ready, false, "CLI reachability alone is not Host readiness");
  assert.equal(cliUnavailable["claude-code"].ready, false);
  assert.doesNotMatch(JSON.stringify(cliUnavailable), /secret-must-not-leak/);

  const withoutToken = hostHealth({
    engineAvailable: true,
    engineVersion: "digital-employee 0.6.1",
    env: {},
    qoderLocal: { installed: true, version: "1.1.31", supported: true },
  });
  assert.deepEqual(withoutToken.qoder, {
    configured: false,
    ready: false,
    nextStep: "设置 QODER_PERSONAL_ACCESS_TOKEN 后重启工作台",
  });
});

test("bundled qoder-engine readiness uses the local Qoder 1.1.x preflight without a service token", () => {
  const ready = hostHealth({
    engineAvailable: true,
    engineVersion: "qoder-engine 0.1.0",
    env: {},
    qoderLocal: { installed: true, version: "1.1.31", supported: true },
  });
  assert.deepEqual(ready.qoder, { configured: true, ready: true });

  const unsupported = hostHealth({
    engineAvailable: true,
    engineVersion: "qoder-engine 0.1.0",
    env: {},
    qoderLocal: {
      installed: true,
      version: "1.2.0",
      supported: false,
      failure: "unsupported_version",
    },
  });
  assert.equal(unsupported.qoder.configured, false);
  assert.equal(unsupported.qoder.ready, false);
  assert.match(unsupported.qoder.nextStep ?? "", /1\.2\.0/);
  assert.match(unsupported.qoder.nextStep ?? "", /1\.1\.x/);

  const missing = hostHealth({
    engineAvailable: true,
    engineVersion: "qoder-engine 0.1.0",
    env: { QODER_PERSONAL_ACCESS_TOKEN: "must-not-change-the-bundled-probe" },
    qoderLocal: {
      installed: false,
      version: null,
      supported: false,
      failure: "unavailable",
    },
  });
  assert.equal(missing.qoder.configured, false);
  assert.equal(missing.qoder.ready, false);
  assert.match(missing.qoder.nextStep ?? "", /ORG_WORKBENCH_QODER_BIN/);
  assert.match(missing.qoder.nextStep ?? "", /DIGITAL_EMPLOYEE_QODER_COMMAND/);
  assert.match(missing.qoder.nextStep ?? "", /qoderclicn/);
  assert.doesNotMatch(JSON.stringify(missing), /must-not-change/);
});

test("claude-local Host health is binary+version preflight, never a credential check", () => {
  const supported = { installed: true, version: "2.1.223", supported: true };
  const ready = hostHealth({ engineAvailable: true, env: {}, claudeLocal: supported });
  assert.deepEqual(ready["claude-local"], { configured: true, ready: true });

  const noCli = hostHealth({ engineAvailable: false, env: {}, claudeLocal: supported });
  assert.equal(noCli["claude-local"].configured, true);
  assert.equal(noCli["claude-local"].ready, false);
  assert.match(noCli["claude-local"].nextStep ?? "", /digital-employee CLI/);

  const outOfWindow = hostHealth({
    engineAvailable: true,
    env: {},
    claudeLocal: { installed: true, version: "2.2.0", supported: false },
  });
  assert.equal(outOfWindow["claude-local"].configured, false);
  assert.equal(outOfWindow["claude-local"].ready, false);
  assert.match(outOfWindow["claude-local"].nextStep ?? "", /2\.2\.0/);
  assert.match(outOfWindow["claude-local"].nextStep ?? "", /2\.1\.214/);

  const missing = hostHealth({
    engineAvailable: true,
    env: {},
    claudeLocal: { installed: false, version: null, supported: false },
  });
  assert.equal(missing["claude-local"].configured, false);
  assert.match(missing["claude-local"].nextStep ?? "", /PATH/);
  assert.doesNotMatch(missing["claude-local"].nextStep ?? "", /ANTHROPIC_API_KEY/);

  assert.equal(supportedClaudeVersion("2.1.214"), true);
  assert.equal(supportedClaudeVersion("2.1.223 (Claude Code)"), true);
  assert.equal(supportedClaudeVersion("2.1.213"), false);
  assert.equal(supportedClaudeVersion("2.2.0"), false);
  assert.equal(supportedClaudeVersion(null), false);
  assert.equal(supportedClaudeVersion("no-version-here"), false);
});

test("codex Host health in bundled mode requires the binary plus an explicit provider credential (#206)", () => {
  const installed = { installed: true, version: "0.153.4" };
  const ready = hostHealth({
    engineAvailable: true,
    bundledElectronEngine: true,
    env: { OPENAI_API_KEY: "service-key" },
    codex: installed,
  });
  assert.deepEqual(ready.codex, { configured: true, modelPinnable: true, ready: true });

  const noCli = hostHealth({
    engineAvailable: false,
    bundledElectronEngine: true,
    env: { OPENAI_API_KEY: "service-key" },
    codex: installed,
  });
  assert.equal(noCli.codex.configured, true);
  assert.equal(noCli.codex.ready, false);

  const noKey = hostHealth({ engineAvailable: true, bundledElectronEngine: true, env: {}, codex: installed });
  assert.equal(noKey.codex.configured, false);
  assert.equal(noKey.codex.ready, false);
  assert.match(noKey.codex.nextStep ?? "", /OPENAI_API_KEY/);
  assert.match(noKey.codex.nextStep ?? "", /OPENAI_BASE_URL/);

  const missing = hostHealth({
    engineAvailable: true,
    bundledElectronEngine: true,
    env: { OPENAI_API_KEY: "service-key" },
    codex: { installed: false, version: null },
  });
  assert.equal(missing.codex.configured, false);
  assert.match(missing.codex.nextStep ?? "", /PATH/);
  assert.match(missing.codex.nextStep ?? "", /DIGITAL_EMPLOYEE_CODEX_COMMAND/);

  // Unlike claude-local there is no supported-version window, because the
  // Codex engine makes no tier-1 qualification claim. An unknown version must
  // therefore not by itself block readiness.
  const unknownVersion = hostHealth({
    engineAvailable: true,
    bundledElectronEngine: true,
    env: { OPENAI_API_KEY: "service-key" },
    codex: { installed: true, version: null },
  });
  assert.deepEqual(unknownVersion.codex, { configured: true, modelPinnable: true, ready: true });

  // The health surface never echoes a credential value back.
  assert.doesNotMatch(JSON.stringify(ready), /service-key/);
});

test("codex-local Host readiness in bundled mode is the binary alone and never sees a credential (#206)", () => {
  const installed = { installed: true, version: "0.153.4" };

  // No credential anywhere: the credentialed Host stays Idle, the local-login
  // Host is ready. This is the whole point of splitting them.
  const noKey = hostHealth({ engineAvailable: true, bundledElectronEngine: true, env: {}, codex: installed });
  assert.deepEqual(noKey["codex-local"], { configured: true, modelPinnable: true, ready: true });
  assert.equal(noKey.codex.configured, false);
  assert.match(noKey.codex.nextStep ?? "", /本地登录/);

  const noCli = hostHealth({ engineAvailable: false, bundledElectronEngine: true, env: {}, codex: installed });
  assert.equal(noCli["codex-local"].configured, true);
  assert.equal(noCli["codex-local"].ready, false);

  const missing = hostHealth({
    engineAvailable: true,
    bundledElectronEngine: true,
    env: {},
    codex: { installed: false, version: null },
  });
  assert.equal(missing["codex-local"].configured, false);
  assert.match(missing["codex-local"].nextStep ?? "", /PATH/);
  // A local-login Host must never tell an operator to set a service key.
  assert.doesNotMatch(missing["codex-local"].nextStep ?? "", /OPENAI_API_KEY/);

  // An unrelated key present in the environment must not change its verdict.
  const withKey = hostHealth({
    engineAvailable: true,
    bundledElectronEngine: true,
    env: { OPENAI_API_KEY: "service-key" },
    codex: installed,
  });
  assert.deepEqual(withKey["codex-local"], { configured: true, modelPinnable: true, ready: true });
  assert.doesNotMatch(JSON.stringify(withKey["codex-local"]), /service-key/);
});

test("Codex Host health reports the pinned model, and claims none when OPENAI_MODEL is unset (#236)", () => {
  const installed = { installed: true, version: "0.154.0" };
  const base = { engineAvailable: true, bundledElectronEngine: true, codex: installed } as const;

  const pinned = hostHealth({ ...base, env: { OPENAI_API_KEY: "service-key", OPENAI_MODEL: "gpt-5.6-sol" } });
  assert.equal(pinned.codex.model, "gpt-5.6-sol");
  assert.equal(pinned["codex-local"].model, "gpt-5.6-sol");
  assert.equal(pinned.codex.ready, true);
  assert.equal(pinned["codex-local"].ready, true);

  // Unset and empty are the same state: the control plane passes no --model and
  // Codex chooses for itself. Absent must stay absent — an inferred default
  // would be a guess, and Codex reports its own choice to no caller.
  for (const env of [{}, { OPENAI_MODEL: "" }]) {
    const unpinned = hostHealth({ ...base, env });
    assert.equal("model" in unpinned.codex, false);
    assert.equal("model" in unpinned["codex-local"], false);
    assert.equal(unpinned["codex-local"].ready, true);
    // Still pinnable — the knob exists, the operator simply used none of it.
    assert.equal(unpinned.codex.modelPinnable, true);
    assert.equal(unpinned["codex-local"].modelPinnable, true);
  }

  // #238 review: "pinnable but unpinned" and "has no knob at all" must not both
  // be a bare missing `model`, or a client can only separate them by carrying
  // its own engine list. `modelPinnable` is the Host's property, so it holds
  // whether or not a model is pinned.
  assert.equal(pinned.codex.modelPinnable, true);
  assert.equal(pinned["codex-local"].modelPinnable, true);

  // No other Host has an LLM-model knob, so none of them may claim one.
  const others = hostHealth({
    engineAvailable: true,
    engineVersion: "qoder-engine 0.2.0",
    bundledElectronEngine: true,
    env: { OPENAI_MODEL: "gpt-5.6-sol", ANTHROPIC_API_KEY: "k", QODER_PERSONAL_ACCESS_TOKEN: "t" },
    codex: installed,
    qoderLocal: { installed: true, version: "1.1.0", supported: true },
    claudeLocal: { installed: true, version: "2.1.214", supported: true },
  });
  for (const host of ["qoder", "claude-code", "claude-local"] as const) {
    assert.equal("model" in others[host], false);
    // The distinguishing half: absent `modelPinnable` is what tells a client
    // this Host has no knob, rather than one left unset.
    assert.equal("modelPinnable" in others[host], false, `${host} must not claim a model knob`);
  }
});

test("an OPENAI_MODEL the engine would reject blocks the Codex Hosts instead of being displayed (#236)", () => {
  const installed = { installed: true, version: "0.154.0" };
  const base = { engineAvailable: true, bundledElectronEngine: true, codex: installed } as const;

  // Each of these fails the shared `validatedCodexModel`, so every turn would
  // die before spawn. Preflight is the place to say so.
  for (const value of [
    "--sandbox", "gpt 5", "gpt\n5", "-gpt-5", "x".repeat(257),
    "gpt 5", "gpt@1", "gpt+1", "gpt;1", "'gpt'", "模型",
  ]) {
    const rejected = hostHealth({ ...base, env: { OPENAI_API_KEY: "service-key", OPENAI_MODEL: value } });
    for (const host of ["codex", "codex-local"] as const) {
      assert.equal("model" in rejected[host], false, `${value} must not be echoed as a model`);
      assert.equal(rejected[host].configured, false, `${value} must not read as configured`);
      assert.equal(rejected[host].ready, false, `${value} must not read as ready`);
      assert.match(rejected[host].nextStep ?? "", /OPENAI_MODEL/);
    }
    // The local-login Host must still never point at a service credential.
    assert.doesNotMatch(rejected["codex-local"].nextStep ?? "", /OPENAI_API_KEY/);
  }
});

test("preflight never calls a legal OPENAI_MODEL illegal (#238 review)", () => {
  const installed = { installed: true, version: "0.154.0" };
  const base = { engineAvailable: true, bundledElectronEngine: true, codex: installed } as const;

  // The direction the original two-copy design could not see. Health shared no
  // implementation with the engine, so narrowing health's character class —
  // dropping `:` was the measured mutation — left every suite green while an
  // operator running `gpt-5:prod` was told their working config was illegal
  // and both Hosts went unavailable. `codex-binary.js` now owns the only
  // implementation, and these shapes pin the accepting side of it.
  for (const value of ["gpt-5.6-sol", "gpt-5:prod", "o3", "a", "ns/model-1.2_3", "x".repeat(256)]) {
    const accepted = hostHealth({ ...base, env: { OPENAI_API_KEY: "service-key", OPENAI_MODEL: value } });
    for (const host of ["codex", "codex-local"] as const) {
      assert.equal(accepted[host].model, value, `${value} is legal and must be reported verbatim`);
      assert.equal(accepted[host].configured, true, `${value} must not block the Host`);
      assert.equal(accepted[host].ready, true, `${value} must not block the Host`);
      assert.equal(accepted[host].nextStep, undefined, `${value} must not produce a next step`);
    }
  }
});

test("Codex Hosts stay unavailable for an external engine even with a binary and service key", () => {
  for (const engineVersion of ["digital-employee 0.6.1", "qoder-engine 0.2.0", undefined]) {
    const health = hostHealth({
      engineAvailable: true,
      ...(engineVersion !== undefined ? { engineVersion } : {}),
      env: { OPENAI_API_KEY: "service-key-must-not-leak" },
      codex: { installed: true, version: "0.153.4" },
    });
    for (const engine of ["codex", "codex-local"] as const) {
      assert.equal(health[engine].configured, true);
      assert.equal(health[engine].ready, false, `${engineVersion}: ${engine} needs the bundled boundary`);
      assert.match(health[engine].nextStep ?? "", /bundled qoder-engine/);
    }
    assert.doesNotMatch(health["codex-local"].nextStep ?? "", /OPENAI_API_KEY/);
    assert.doesNotMatch(JSON.stringify(health), /service-key-must-not-leak/);
  }
});

test("GET /health gates Codex Hosts on the configured bundled engine boundary", { skip: process.platform === "win32" ? "requires POSIX exec of a #!/bin/sh probe fixture" : false }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-codex-health-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const externalEngine = path.join(dir, "external-engine");
  const bundledEngine = path.join(dir, "bundled-engine");
  const codexBin = path.join(dir, "codex");
  await fs.writeFile(externalEngine, "#!/bin/sh\nprintf '%s\\n' 'digital-employee 0.6.1'\n", { mode: 0o755 });
  await fs.writeFile(bundledEngine, "#!/bin/sh\nprintf '%s\\n' 'qoder-engine 0.2.0'\n", { mode: 0o755 });
  await fs.writeFile(codexBin, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.153.4 probe-output-must-not-leak'\n", { mode: 0o755 });
  const overrides = {
    DIGITAL_EMPLOYEE_CODEX_COMMAND: codexBin,
    DIGITAL_EMPLOYEE_CLAUDE_COMMAND: path.join(dir, "claude-not-installed"),
    ORG_WORKBENCH_QODER_BIN: path.join(dir, "qoder-not-installed"),
    OPENAI_API_KEY: "service-key-must-not-leak",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, overrides);
  const server = await startTestServer();
  t.after(() => server.close());
  for (const command of [externalEngine, bundledEngine]) {
    server.ctx.config.cliCommand = command;
    server.ctx.config.bundledElectronEngine = false;
    const response = await api(server.baseUrl, "/health");
    assert.equal(response.status, 200);
    const health = response.body as HealthResponse;
    assert.equal(health.engine.available, true);
    for (const engine of ["codex", "codex-local"] as const) {
      assert.equal(health.hosts[engine].configured, true);
      assert.equal(health.hosts[engine].ready, false, `${engine} must reject the external engine`);
      assert.match(health.hosts[engine].nextStep ?? "", /bundled qoder-engine/);
    }
    assert.doesNotMatch(JSON.stringify(health), /service-key-must-not-leak|probe-output-must-not-leak/);
  }
  server.ctx.config.bundledElectronEngine = true;
  const bundled = await api(server.baseUrl, "/health");
  assert.equal(bundled.status, 200);
  const bundledHealth = bundled.body as HealthResponse;
  assert.deepEqual(bundledHealth.hosts.codex, { configured: true, modelPinnable: true, ready: true });
  assert.deepEqual(bundledHealth.hosts["codex-local"], { configured: true, modelPinnable: true, ready: true });
  delete process.env.OPENAI_API_KEY;
  const localLogin = (await api(server.baseUrl, "/health")).body as HealthResponse;
  assert.equal(localLogin.hosts.codex.ready, false);
  assert.deepEqual(localLogin.hosts["codex-local"], { configured: true, modelPinnable: true, ready: true });
});

/**
 * #221 review B4: the Codex probe used `shell: true` for Windows launchers on a
 * path derived from DIGITAL_EMPLOYEE_CODEX_COMMAND. #125 already settled that a
 * launcher goes through an explicitly escaped cmd.exe invocation with
 * shell: false, so a metacharacter in the path stays argv data.
 */
test("codex version probe never hands a Windows launcher path to a shell (#221 review B4)", () => {
  // POSIX: the resolved binary is executed directly, no shell involved.
  const posix = __codexVersionProbeSpec("/opt/codex/bin/codex", {}, "linux");
  assert.equal(posix.command, "/opt/codex/bin/codex");
  assert.deepEqual(posix.args, ["--version"]);
  assert.equal(posix.options.shell, false);
  // Windows, but not a launcher script: still direct.
  const exe = __codexVersionProbeSpec("C:\\tools\\codex.exe", {}, "win32");
  assert.equal(exe.command, "C:\\tools\\codex.exe");
  assert.equal(exe.options.shell, false);

  // A Windows launcher goes through cmd.exe explicitly.
  const launcher = __codexVersionProbeSpec("C:\\tools\\codex.cmd", { ComSpec: "C:\\Windows\\system32\\cmd.exe" }, "win32");
  assert.equal(launcher.command, "C:\\Windows\\system32\\cmd.exe");
  assert.deepEqual(launcher.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(launcher.options.shell, false);
  // Without this Node re-quotes the escaped command line, which is the bug a
  // hand-written second copy of this construction introduced.
  assert.equal(launcher.options.windowsVerbatimArguments, true);

  // The load-bearing case: cmd metacharacters in an operator-supplied path are
  // caret-escaped, so `&` cannot start a second command.
  const hostile = __codexVersionProbeSpec("C:\\a&calc\\codex.cmd", {}, "win32");
  assert.equal(hostile.command, "cmd.exe");
  const commandLine = hostile.args[3] ?? "";
  assert.match(commandLine, /\^&/, "an ampersand in the path must be escaped");
  assert.doesNotMatch(commandLine, /[^^]&/, "no unescaped ampersand may reach cmd.exe");
  // The shared construction escapes the argument too, which the hand-written
  // copy did not: `--version` arrives quoted and caret-escaped.
  assert.match(commandLine, /codex\.cmd \^"--version\^"/);
});

test("codex probe reports not-installed when the binary cannot be resolved", () => {
  assert.deepEqual(probeCodexBinary({ PATH: "" }), { installed: false, version: null });
  assert.deepEqual(
    probeCodexBinary({ PATH: "", DIGITAL_EMPLOYEE_CODEX_COMMAND: "/nonexistent/codex" }),
    { installed: false, version: null },
  );
});

test("claude-code Host health in bundled mode requires binary + version + API key", () => {
  const supportedClaude = { installed: true, version: "2.1.300", supported: true };
  const bundledQoderLocal = { installed: true, version: "1.1.0", supported: true };

  const fullyReady = hostHealth({
    engineAvailable: true,
    engineVersion: "qoder-engine 0.2.0",
    env: { ANTHROPIC_API_KEY: "test-key" },
    qoderLocal: bundledQoderLocal,
    claudeLocal: supportedClaude,
  });
  assert.equal(fullyReady["claude-code"].configured, true);
  assert.equal(fullyReady["claude-code"].ready, true);
  assert.equal(fullyReady["claude-code"].nextStep, undefined);

  const noApiKey = hostHealth({
    engineAvailable: true,
    engineVersion: "qoder-engine 0.2.0",
    env: {},
    qoderLocal: bundledQoderLocal,
    claudeLocal: supportedClaude,
  });
  assert.equal(noApiKey["claude-code"].configured, false);
  assert.equal(noApiKey["claude-code"].ready, false);
  assert.match(noApiKey["claude-code"].nextStep ?? "", /ANTHROPIC_API_KEY/);

  const noClaudeBinary = hostHealth({
    engineAvailable: true,
    engineVersion: "qoder-engine 0.2.0",
    env: { ANTHROPIC_API_KEY: "test-key" },
    qoderLocal: bundledQoderLocal,
    claudeLocal: { installed: false, version: null, supported: false },
  });
  assert.equal(noClaudeBinary["claude-code"].configured, false);
  assert.match(noClaudeBinary["claude-code"].nextStep ?? "", /PATH/);

  const unsupportedVersion = hostHealth({
    engineAvailable: true,
    engineVersion: "qoder-engine 0.2.0",
    env: { ANTHROPIC_API_KEY: "test-key" },
    qoderLocal: bundledQoderLocal,
    claudeLocal: { installed: true, version: "2.2.0", supported: false },
  });
  assert.equal(unsupportedVersion["claude-code"].configured, false);
  assert.match(unsupportedVersion["claude-code"].nextStep ?? "", /2\.2\.0/);
});

test("Qoder local probe accepts only the 1.1.x family and fails closed for missing, unsupported, and timed-out binaries", { skip: process.platform === "win32" ? "requires POSIX exec of a #!/bin/sh probe fixture" : false }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-probe-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const supportedBin = path.join(dir, "qoder-supported");
  const unsupportedBin = path.join(dir, "qoder-unsupported");
  const slowBin = path.join(dir, "qoder-slow");
  await fs.writeFile(supportedBin, "#!/bin/sh\nprintf '%s\\n' '1.1.31 local-account-data-must-not-leak'\n", { mode: 0o755 });
  await fs.writeFile(unsupportedBin, "#!/bin/sh\nprintf '%s\\n' '1.2.0'\n", { mode: 0o755 });
  await fs.writeFile(slowBin, "#!/bin/sh\nwhile :; do :; done\n", { mode: 0o755 });

  const supported = await probeQoderLocalBinary({ ORG_WORKBENCH_QODER_BIN: supportedBin });
  assert.deepEqual(supported, {
    installed: true,
    version: "1.1.31",
    supported: true,
  });
  assert.doesNotMatch(JSON.stringify(supported), /local-account-data-must-not-leak/);
  assert.deepEqual(await probeQoderLocalBinary({ ORG_WORKBENCH_QODER_BIN: unsupportedBin }), {
    installed: true,
    version: "1.2.0",
    supported: false,
    failure: "unsupported_version",
  });
  assert.deepEqual(await probeQoderLocalBinary({ ORG_WORKBENCH_QODER_BIN: path.join(dir, "missing") }), {
    installed: false,
    version: null,
    supported: false,
    failure: "unavailable",
  });
  const startedAt = Date.now();
  assert.deepEqual(await probeQoderLocalBinary({ ORG_WORKBENCH_QODER_BIN: slowBin }, 50), {
    installed: true,
    version: null,
    supported: false,
    failure: "timed_out",
  });
  assert.ok(Date.now() - startedAt < 1000, "the local-only version probe must stay bounded");

  assert.equal(supportedQoderVersion("1.1.0"), true);
  assert.equal(supportedQoderVersion("qodercli 1.1.31"), true);
  assert.equal(supportedQoderVersion("1.0.99"), false);
  assert.equal(supportedQoderVersion("1.2.0"), false);
  assert.equal(supportedQoderVersion(null), false);
});

test("Qoder local probe does not wait for a descendant that inherits stdio", { skip: process.platform === "win32" ? "requires POSIX process-group semantics" : false }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-orphan-"));
  const pidFile = path.join(dir, "descendant.pid");
  const qoderBin = path.join(dir, "qoder-forks-helper");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    qoderBin,
    `#!/bin/sh
(sleep 30) &
printf '%s' "$!" > ${JSON.stringify(pidFile)}
printf '%s\\n' '1.1.31'
exit 0
`,
    { mode: 0o755 },
  );

  const startedAt = Date.now();
  const result = await probeQoderLocalBinary({ ORG_WORKBENCH_QODER_BIN: qoderBin }, 3000);
  const elapsedMs = Date.now() - startedAt;
  assert.deepEqual(result, { installed: true, version: "1.1.31", supported: true });
  assert.ok(elapsedMs < 1500, `probe waited for descendant-held stdio: ${elapsedMs}ms`);
  const descendantPid = Number(await fs.readFile(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  // SIGKILL delivery and orphan reaping are asynchronous, especially on macOS.
  // The probe must return promptly (asserted above); separately require actual
  // PID disappearance within a bounded grace period, not in this exact tick.
  await assertEventuallyReaped(descendantPid);
});

test("Qoder local probe receives only the non-secret runtime environment allowlist", { skip: process.platform === "win32" ? "requires POSIX exec of a #!/bin/sh probe fixture" : false }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-probe-env-"));
  const qoderBin = path.join(dir, "qoder-no-electron-flag");
  const envFile = path.join(dir, "probe-env.txt");
  const home = path.join(dir, "home");
  const temp = path.join(dir, "tmp");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(home);
  await fs.mkdir(temp);
  await fs.writeFile(
    qoderBin,
    `#!/bin/sh
/usr/bin/env > ${JSON.stringify(envFile)}
printf '%s\\n' '1.1.31'
`,
    { mode: 0o755 },
  );

  assert.deepEqual(
    await probeQoderLocalBinary({
      ORG_WORKBENCH_QODER_BIN: qoderBin,
      PATH: "/usr/bin:/bin",
      HOME: home,
      USER: "probe-user",
      LOGNAME: "probe-logname",
      TMPDIR: temp,
      LANG: "C.UTF-8",
      LC_ALL: "C",
      SHELL: "/bin/sh",
      ELECTRON_RUN_AS_NODE: "1",
      ORG_WORKBENCH_BOOT_TOKEN: "boot-secret",
      ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE: "1",
      QODER_PERSONAL_ACCESS_TOKEN: "qoder-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      ARBITRARY_SECRET: "arbitrary-secret",
    }),
    { installed: true, version: "1.1.31", supported: true },
  );

  const childEnvironment = Object.fromEntries(
    (await fs.readFile(envFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  assert.equal(childEnvironment.PATH, "/usr/bin:/bin");
  assert.equal(childEnvironment.HOME, home);
  assert.equal(childEnvironment.USER, "probe-user");
  assert.equal(childEnvironment.LOGNAME, "probe-logname");
  assert.equal(childEnvironment.TMPDIR, temp);
  assert.equal(childEnvironment.LANG, "C.UTF-8");
  assert.equal(childEnvironment.LC_ALL, "C");
  assert.equal(childEnvironment.SHELL, "/bin/sh");
  for (const forbidden of [
    "ELECTRON_RUN_AS_NODE",
    "ORG_WORKBENCH_BOOT_TOKEN",
    "ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE",
    "ORG_WORKBENCH_QODER_BIN",
    "DIGITAL_EMPLOYEE_QODER_COMMAND",
    "QODER_PERSONAL_ACCESS_TOKEN",
    "ANTHROPIC_API_KEY",
    "ARBITRARY_SECRET",
  ]) {
    assert.equal(forbidden in childEnvironment, false, `${forbidden} reached the Qoder probe`);
  }
});

test("Qoder local probe forcibly reaps a version check that ignores SIGTERM", { skip: process.platform === "win32" ? "requires POSIX signal semantics and a #!/bin/sh fixture" : false }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-sigterm-"));
  const pidFile = path.join(dir, "probe.pid");
  const signalTrappingBin = path.join(dir, "qoder-ignore-sigterm");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    signalTrappingBin,
    `#!/bin/sh
trap '' TERM
printf '%s' "$$" > ${JSON.stringify(pidFile)}
counter=0
while [ "$counter" -lt 2000000 ]; do counter=$((counter + 1)); done
printf '1.1.31\\n'
`,
    { mode: 0o755 },
  );

  const timeoutMs = 1000;
  const startedAt = Date.now();
  const result = await probeQoderLocalBinary({ ORG_WORKBENCH_QODER_BIN: signalTrappingBin }, timeoutMs);
  const elapsedMs = Date.now() - startedAt;
  assert.deepEqual(result, {
    installed: true,
    version: null,
    supported: false,
    failure: "timed_out",
  });
  assert.ok(elapsedMs < timeoutMs + 1500, `SIGTERM-ignoring probe exceeded its bound: ${elapsedMs}ms`);
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "fixture must publish the child pid before timeout");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "timed-out Qoder probe must not remain alive");
});

test("Qoder binary resolution is explicit-first, shell-free, and Finder-safe on supported macOS locations", { skip: process.platform === "win32" ? "requires POSIX X_OK/symlink semantics and #!/bin/sh fixtures" : false }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-resolve-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const pathBin = path.join(dir, "path-bin");
  const explicitBin = path.join(dir, "explicit-qoder");
  const nonExecutableBin = path.join(dir, "non-executable-qoder");
  const pathQoder = path.join(pathBin, "qoder");
  const pathQoderCli = path.join(pathBin, "qodercli");
  const pathQoderCliCn = path.join(pathBin, "qoderclicn");
  const fixedQoderCli = path.join(home, ".local", "bin", "qodercli");
  const realFixedQoderCli = path.join(home, ".qoder", "bin", "qodercli", "qodercli-1.1.31");
  const unsafeHome = path.join(dir, "home\nattacker");
  const unsafeFixedQoderCli = path.join(unsafeHome, ".local", "bin", "qodercli");
  await fs.mkdir(pathBin, { recursive: true });
  await fs.mkdir(path.dirname(fixedQoderCli), { recursive: true });
  await fs.mkdir(path.dirname(realFixedQoderCli), { recursive: true });
  await fs.mkdir(path.dirname(unsafeFixedQoderCli), { recursive: true });
  for (const file of [explicitBin, pathQoder, pathQoderCli, pathQoderCliCn, realFixedQoderCli]) {
    await fs.writeFile(file, "#!/bin/sh\nprintf '1.1.31\\n'\n", { mode: 0o755 });
  }
  await fs.writeFile(unsafeFixedQoderCli, "#!/bin/sh\nprintf '1.1.31\\n'\n", { mode: 0o755 });
  await fs.writeFile(nonExecutableBin, "not executable\n", { mode: 0o644 });
  await fs.symlink(realFixedQoderCli, fixedQoderCli);

  assert.equal(
    resolveQoderExecutable({ ORG_WORKBENCH_QODER_BIN: explicitBin, PATH: pathBin, HOME: home }, "darwin"),
    await fs.realpath(explicitBin),
    "an explicit executable is authoritative",
  );
  assert.equal(
    resolveQoderExecutable({ DIGITAL_EMPLOYEE_QODER_COMMAND: explicitBin, PATH: pathBin, HOME: home }, "darwin"),
    await fs.realpath(explicitBin),
    "the digital-employee override is accepted when the workbench override is absent",
  );
  assert.equal(
    resolveQoderExecutable({ PATH: pathBin, HOME: home }, "darwin"),
    await fs.realpath(pathQoderCli),
    "the native qodercli PATH entry wins over its dispatcher wrapper",
  );
  await fs.rm(pathQoderCli);
  assert.equal(
    resolveQoderExecutable({ PATH: pathBin, HOME: home }, "darwin"),
    await fs.realpath(pathQoderCliCn),
    "the mainland qoderclicn entry is accepted when qodercli is absent",
  );
  assert.equal(
    resolveQoderExecutable({ PATH: "/usr/bin:/bin", HOME: home }, "darwin"),
    await fs.realpath(fixedQoderCli),
    "Finder-like PATH falls back to the known per-user macOS install",
  );
  assert.equal(
    resolveQoderExecutable({ ORG_WORKBENCH_QODER_BIN: path.dirname(explicitBin), PATH: pathBin, HOME: home }, "darwin"),
    null,
    "an invalid explicit override fails closed instead of silently choosing another binary",
  );
  assert.equal(
    resolveQoderExecutable({ ORG_WORKBENCH_QODER_BIN: nonExecutableBin, PATH: pathBin, HOME: home }, "darwin"),
    null,
    "a regular but non-executable explicit target fails closed",
  );
  const relativeHome = path.relative(process.cwd(), home);
  assert.equal(path.isAbsolute(relativeHome), false, "adversarial HOME fixture must be cwd-relative");
  assert.equal(
    resolveQoderExecutable({ PATH: path.join(dir, "empty-path"), HOME: relativeHome }, "darwin"),
    null,
    "a relative HOME must not turn the current working directory into an installer root",
  );
  assert.equal(
    resolveQoderExecutable({ PATH: path.join(dir, "empty-path"), HOME: unsafeHome }, "darwin"),
    null,
    "a newline-bearing HOME must not participate in known-path discovery",
  );
  assert.equal(
    resolveQoderExecutable({ PATH: path.join(dir, "empty-path"), HOME: `${home}\0suffix` }, "darwin"),
    null,
    "a NUL-bearing HOME must fail closed",
  );
  assert.equal(resolveQoderExecutable({ PATH: "/usr/bin:/bin", HOME: path.join(dir, "missing-home") }, "darwin"), null);

  const finderProbe = await probeQoderLocalBinary({ PATH: "/usr/bin:/bin", HOME: home }, 3000, "darwin");
  assert.deepEqual(finderProbe, { installed: true, version: "1.1.31", supported: true });
});

test("GET /health recognizes only the bundled qoder-engine local preflight and never exposes probe output", { skip: process.platform === "win32" ? "requires POSIX exec of a #!/bin/sh probe fixture" : false }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-health-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bundledEngine = path.join(dir, "qoder-engine-fixture");
  const normalEngine = path.join(dir, "digital-employee-fixture");
  const localQoder = path.join(dir, "qoder-fixture");
  const shouldNotProbeQoder = path.join(dir, "qoder-should-not-run");
  const probeMarker = path.join(dir, "unexpected-qoder-probe");
  await fs.writeFile(bundledEngine, "#!/bin/sh\nprintf '%s\\n' 'qoder-engine 0.1.0'\n", { mode: 0o755 });
  await fs.writeFile(normalEngine, "#!/bin/sh\nprintf '%s\\n' 'digital-employee 0.6.1'\n", { mode: 0o755 });
  await fs.writeFile(localQoder, "#!/bin/sh\nprintf '%s\\n' 'qodercli 1.1.31 private-status-must-not-leak'\n", { mode: 0o755 });
  await fs.writeFile(
    shouldNotProbeQoder,
    `#!/bin/sh\nprintf '%s' 'called' > ${JSON.stringify(probeMarker)}\nprintf '%s\\n' '1.1.31'\n`,
    { mode: 0o755 },
  );

  const previousQoderBin = process.env.ORG_WORKBENCH_QODER_BIN;
  const previousQoderToken = process.env.QODER_PERSONAL_ACCESS_TOKEN;
  const previousClaudeCommand = process.env.DIGITAL_EMPLOYEE_CLAUDE_COMMAND;
  delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
  process.env.ORG_WORKBENCH_QODER_BIN = localQoder;
  process.env.DIGITAL_EMPLOYEE_CLAUDE_COMMAND = path.join(dir, "claude-not-installed");
  const server = await startTestServer();
  try {
    server.ctx.config.cliCommand = bundledEngine;
    const bundled = await api(server.baseUrl, "/health");
    assert.equal(bundled.status, 200);
    const bundledBody = bundled.body as {
      engine: { available: boolean; version?: string };
      hosts: { qoder: { configured: boolean; ready: boolean; nextStep?: string } };
    };
    assert.deepEqual(bundledBody.hosts.qoder, { configured: true, ready: true });
    assert.equal(bundledBody.engine.available, true);
    assert.equal(bundledBody.engine.version, "qoder-engine 0.1.0");
    assert.doesNotMatch(JSON.stringify(bundledBody), /private-status-must-not-leak/);

    process.env.ORG_WORKBENCH_QODER_BIN = shouldNotProbeQoder;
    server.ctx.config.cliCommand = normalEngine;
    const normal = await api(server.baseUrl, "/health");
    assert.equal(normal.status, 200);
    const normalBody = normal.body as {
      hosts: { qoder: { configured: boolean; ready: boolean; nextStep?: string } };
    };
    assert.deepEqual(normalBody.hosts.qoder, {
      configured: false,
      ready: false,
      nextStep: "设置 QODER_PERSONAL_ACCESS_TOKEN 后重启工作台",
    });
    await assert.rejects(fs.access(probeMarker), { code: "ENOENT" });
  } finally {
    await server.close();
    if (previousQoderBin === undefined) delete process.env.ORG_WORKBENCH_QODER_BIN;
    else process.env.ORG_WORKBENCH_QODER_BIN = previousQoderBin;
    if (previousQoderToken === undefined) delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
    else process.env.QODER_PERSONAL_ACCESS_TOKEN = previousQoderToken;
    if (previousClaudeCommand === undefined) delete process.env.DIGITAL_EMPLOYEE_CLAUDE_COMMAND;
    else process.env.DIGITAL_EMPLOYEE_CLAUDE_COMMAND = previousClaudeCommand;
  }
});

test("claude-local probe reads the version with only non-secret runtime environment", { skip: process.platform === "win32" ? "requires POSIX exec of a #!/bin/sh probe fixture" : false }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-claude-probe-"));
  const bin = path.join(dir, "claude-fixture");
  const envFile = path.join(dir, "claude-env.txt");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    bin,
    `#!/bin/sh
/usr/bin/env > ${JSON.stringify(envFile)}
printf '%s\\n' '2.1.223 (Claude Code)'
`,
    { mode: 0o755 },
  );

  const found = probeClaudeLocalBinary({
    DIGITAL_EMPLOYEE_CLAUDE_COMMAND: bin,
    PATH: "/usr/bin:/bin",
    HOME: dir,
    USER: "claude-probe",
    ELECTRON_RUN_AS_NODE: "1",
    ORG_WORKBENCH_BOOT_TOKEN: "server-only-secret",
    ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE: "1",
    ANTHROPIC_API_KEY: "provider-secret",
    ARBITRARY_SECRET: "arbitrary-secret",
  });
  assert.equal(found.installed, true);
  assert.equal(found.version, "2.1.223");
  assert.equal(found.supported, true);
  const childEnvironment = Object.fromEntries(
    (await fs.readFile(envFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  assert.equal(childEnvironment.PATH, "/usr/bin:/bin");
  assert.equal(childEnvironment.HOME, dir);
  assert.equal(childEnvironment.USER, "claude-probe");
  for (const forbidden of [
    "DIGITAL_EMPLOYEE_CLAUDE_COMMAND",
    "ELECTRON_RUN_AS_NODE",
    "ORG_WORKBENCH_BOOT_TOKEN",
    "ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE",
    "ANTHROPIC_API_KEY",
    "ARBITRARY_SECRET",
  ]) {
    assert.equal(forbidden in childEnvironment, false, `${forbidden} reached the Claude probe`);
  }

  const gone = probeClaudeLocalBinary({ DIGITAL_EMPLOYEE_CLAUDE_COMMAND: path.join(dir, "no-such-binary") });
  assert.deepEqual(gone, { installed: false, version: null, supported: false });
});

test("boot: loopback bind, boot-token auth, /health exemption, version header", async () => {
  const server = await startTestServer();
  try {
    assert.equal(server.boundAddress, "127.0.0.1", "control plane must bind loopback only");

    const health = await api(server.baseUrl, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.header("x-orgworkbench-api"), "v0");
    const healthBody = health.body as {
      status: string;
      api: string;
      engine: { command: string; available: boolean };
      hosts: {
        qoder: { configured: boolean; ready: boolean };
        "claude-code": { configured: boolean; ready: boolean };
        "claude-local": { configured: boolean; ready: boolean };
      };
      workspace: { open: boolean };
    };
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.api, "v0");
    assert.equal(typeof healthBody.engine.available, "boolean");
    assert.equal(typeof healthBody.hosts.qoder.configured, "boolean");
    assert.equal(typeof healthBody.hosts.qoder.ready, "boolean");
    assert.equal(typeof healthBody.hosts["claude-code"].configured, "boolean");
    assert.equal(typeof healthBody.hosts["claude-code"].ready, "boolean");
    assert.equal(typeof healthBody.hosts["claude-local"].configured, "boolean");
    assert.equal(typeof healthBody.hosts["claude-local"].ready, "boolean");
    assert.equal(healthBody.workspace.open, false);

    const noToken = await api(server.baseUrl, "/workspace");
    assert.equal(noToken.status, 401);
    assert.equal((noToken.body as { code: string }).code, "unauthorized");

    const badToken = await api(server.baseUrl, "/workspace", { token: "wrong-token" });
    assert.equal(badToken.status, 401);

    const withToken = await api(server.baseUrl, "/workspace", { token: server.token });
    assert.equal(withToken.status, 200);
    assert.equal((withToken.body as { open: boolean }).open, false);
  } finally {
    await server.close();
  }
});

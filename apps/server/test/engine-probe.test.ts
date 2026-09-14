import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveServerConfig } from "../src/config.js";
import { probeEngine, splitCommand } from "../src/engine/probe.js";
import { hostHealth } from "../src/routes/health.js";

// #78 REQ-001 — splitCommand must survive absolute paths containing spaces
// (Windows default installs under `C:\Program Files\...`, macOS OneDrive
// folders, Linux `~/My Projects/...`). It must remain bit-for-bit compatible
// with the previous whitespace-only behaviour when no quoting is present.

test("splitCommand keeps the naive whitespace split when no quoting is present", () => {
  const { bin, prefix } = splitCommand("node /repo/bin.js --flag value");
  assert.equal(bin, "node");
  assert.deepEqual(prefix, ["/repo/bin.js", "--flag", "value"]);
});

test("splitCommand preserves a double-quoted Windows path that contains spaces", () => {
  const command = '"C:\\Program Files\\Node\\node.exe" "C:\\my path\\bin.js" --flag';
  const { bin, prefix } = splitCommand(command);
  assert.equal(bin, "C:\\Program Files\\Node\\node.exe");
  assert.deepEqual(prefix, ["C:\\my path\\bin.js", "--flag"]);
});

test("splitCommand preserves a POSIX path with spaces inside single quotes", () => {
  const { bin, prefix } = splitCommand("/usr/local/bin/node '/home/me/My Projects/bin.js'");
  assert.equal(bin, "/usr/local/bin/node");
  assert.deepEqual(prefix, ["/home/me/My Projects/bin.js"]);
});

test("splitCommand honours backslash-escaped quotes inside a double-quoted token", () => {
  const { bin, prefix } = splitCommand('node "quote-\\"in\\"-token"');
  assert.equal(bin, "node");
  assert.deepEqual(prefix, ['quote-"in"-token']);
});

test("splitCommand collapses runs of whitespace and empty commands stay stable", () => {
  const collapsed = splitCommand("node    bin.js");
  assert.equal(collapsed.bin, "node");
  assert.deepEqual(collapsed.prefix, ["bin.js"]);
  const empty = splitCommand("");
  assert.equal(empty.bin, "");
  assert.deepEqual(empty.prefix, []);
});

test("server config freezes the bundled boundary only for both exact internal signals", () => {
  assert.equal(resolveServerConfig({
    ELECTRON_RUN_AS_NODE: "1",
    ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE: "1",
  }, []).bundledElectronEngine, true);
  for (const env of [
    { ELECTRON_RUN_AS_NODE: "true", ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE: "1" },
    { ELECTRON_RUN_AS_NODE: "1", ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE: "0" },
    { ELECTRON_RUN_AS_NODE: "1" },
  ]) {
    assert.equal(resolveServerConfig(env, []).bundledElectronEngine, false);
  }
});

test("Linux Node bundled adapter is ready without an Electron runtime flag", { skip: process.platform !== "linux" }, async () => {
  const adapter = fileURLToPath(new URL("../../bin/qoder-engine.mjs", import.meta.url));
  const env = {
    ORG_WORKBENCH_INTERNAL_BUNDLED_NODE_ENGINE: "1",
    ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI: `"${process.execPath}" "${adapter}"`,
  };
  const config = resolveServerConfig(env, []);
  assert.equal(config.bundledElectronEngine, true);
  const probe = await probeEngine(config.cliCommand, 5000, {
    bundledElectronEngine: config.bundledElectronEngine,
    sourceEnvironment: env,
  });
  assert.deepEqual(probe, { available: true, version: "qoder-engine 0.2.0" });
  const hosts = hostHealth({
    env,
    engineAvailable: probe.available,
    engineVersion: probe.version,
    bundledElectronEngine: config.bundledElectronEngine,
    codex: { installed: true, version: "0.147.0" },
  });
  assert.equal(hosts["codex-local"].ready, true);
});

test("a Node marker cannot qualify an external engine, other runtime, or injected Node options", () => {
  const adapter = fileURLToPath(new URL("../../bin/qoder-engine.mjs", import.meta.url));
  for (const command of [
    "digital-employee",
    `"${process.execPath}" "${fileURLToPath(import.meta.url)}"`,
    `"${process.execPath}" --import arbitrary-hook "${adapter}"`,
    `"${process.execPath}" "${adapter}" extra`,
    `"/missing/node" "${adapter}"`,
    `node "${adapter}"`,
  ]) {
    const env = {
      ORG_WORKBENCH_INTERNAL_BUNDLED_NODE_ENGINE: "1",
      ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI: command,
    };
    const config = resolveServerConfig(env, []);
    assert.equal(config.bundledElectronEngine, false, command);
    assert.equal(hostHealth({
      env, engineAvailable: true, engineVersion: "qoder-engine 0.2.0",
      bundledElectronEngine: config.bundledElectronEngine,
      codex: { installed: true, version: "0.147.0" },
    })["codex-local"].ready, false, command);
  }
  for (const marker of [undefined, "0", "true"]) {
    assert.equal(resolveServerConfig({
      ORG_WORKBENCH_INTERNAL_BUNDLED_NODE_ENGINE: marker,
      ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI: `"${process.execPath}" "${adapter}"`,
    }, []).bundledElectronEngine, false);
  }
});

// #78 REQ-002 — probeEngine's nextStep must distinguish the three failure
// modes an operator sees (OS refused to launch, spawned but broken, timed out)
// so a "not reachable" message no longer collapses "the file does not exist"
// with "the CLI crashed".

test("probeEngine flags an OS-side launch failure with an ENOENT explanation", async () => {
  const command = "/tmp/definitely-not-a-binary-8973b2bd";
  const probe = await probeEngine(command, 500);
  assert.equal(probe.available, false);
  assert.ok(probe.nextStep);
  assert.ok(
    probe.nextStep!.includes("ENOENT"),
    `expected ENOENT hint, got: ${probe.nextStep}`,
  );
});

test("probeEngine reports the spawn-then-broken case distinctly from ENOENT", async () => {
  if (process.platform === "win32") return; // POSIX shim is enough evidence
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engine-probe-"));
  const shim = path.join(root, "broken-cli.sh");
  await fs.writeFile(shim, "#!/bin/sh\necho unusable output >&2\nexit 3\n", { mode: 0o755 });
  try {
    const probe = await probeEngine(shim, 1000);
    assert.equal(probe.available, false);
    assert.ok(probe.nextStep);
    assert.ok(
      !probe.nextStep!.includes("ENOENT"),
      `unexpected ENOENT hint for a broken-but-launched binary: ${probe.nextStep}`,
    );
    assert.ok(
      /non-zero|did not respond/.test(probe.nextStep!),
      `expected a launched-but-broken hint, got: ${probe.nextStep}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("health engine probe isolates operator commands and marks only the bundled Electron adapter", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engine-probe-env-"));
  const fixture = path.join(root, "probe-env.mjs");
  const log = path.join(root, "probe-env.jsonl");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    fixture,
    `import fs from "node:fs";
const argv = process.argv.slice(2);
const log = argv.shift();
fs.appendFileSync(log, JSON.stringify({ argv, environment: process.env }) + "\\n");
if (argv[0] === "--version") process.exit(3);
process.stdout.write("digital-employee 1.2.3\\n");
`,
    "utf8",
  );
  const sourceEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    ORG_WORKBENCH_BOOT_TOKEN: "server-only-secret",
    ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE: "1",
    ORG_WORKBENCH_INTERNAL_BUNDLED_NODE_ENGINE: "1",
    OWB_OPERATOR_SETTING: "must-not-cross",
    QODER_PERSONAL_ACCESS_TOKEN: "provider-secret",
    CONTEXT_RUNTIME_TOKEN: "context-secret",
    ARBITRARY_SECRET: "arbitrary-secret",
  };
  const command = `${process.execPath} ${fixture} ${log}`;

  const readRecords = async (): Promise<Array<{ argv: string[]; environment: Record<string, string> }>> =>
    (await fs.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; environment: Record<string, string> });

  const operator = await probeEngine(command, 30_000, { sourceEnvironment });
  assert.deepEqual(operator, { available: true, version: "1.2.3" });
  let records = await readRecords();
  assert.equal(records.length, 2, "version and help probes use the isolated environment");
  for (const record of records) {
    assert.equal("ELECTRON_RUN_AS_NODE" in record.environment, false);
    assert.equal("ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE" in record.environment, false);
    assert.equal("ORG_WORKBENCH_INTERNAL_BUNDLED_NODE_ENGINE" in record.environment, false);
    assert.equal("ORG_WORKBENCH_BOOT_TOKEN" in record.environment, false);
    assert.equal("OWB_OPERATOR_SETTING" in record.environment, false);
    assert.equal("QODER_PERSONAL_ACCESS_TOKEN" in record.environment, false);
    assert.equal("CONTEXT_RUNTIME_TOKEN" in record.environment, false);
    assert.equal("ARBITRARY_SECRET" in record.environment, false);
    assert.equal(record.environment.HOME, sourceEnvironment.HOME);
  }

  await fs.writeFile(log, "", "utf8");
  const bundled = await probeEngine(command, 30_000, {
    bundledElectronEngine: true,
    sourceEnvironment,
  });
  assert.deepEqual(bundled, { available: true, version: "1.2.3" });
  records = await readRecords();
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.environment.ELECTRON_RUN_AS_NODE, "1");
    assert.equal("ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE" in record.environment, false);
    assert.equal("ORG_WORKBENCH_INTERNAL_BUNDLED_NODE_ENGINE" in record.environment, false);
    assert.equal("ORG_WORKBENCH_BOOT_TOKEN" in record.environment, false);
    assert.equal("OWB_OPERATOR_SETTING" in record.environment, false);
    assert.equal("QODER_PERSONAL_ACCESS_TOKEN" in record.environment, false);
    assert.equal("CONTEXT_RUNTIME_TOKEN" in record.environment, false);
    assert.equal("ARBITRARY_SECRET" in record.environment, false);
    assert.equal(record.environment.HOME, sourceEnvironment.HOME);
  }
});

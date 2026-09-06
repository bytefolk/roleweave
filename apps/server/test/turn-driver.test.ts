import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DigitalEmployeeCliDriver } from "../src/engine/driver-cli.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

const ENVELOPE = {
  schemaVersion: "turn-envelope.v1" as const,
  workspaceRef: "/workspace",
  positionId: "repo-owner",
  turnId: "turn-1",
  input: "hello",
  envelopeDigest: `sha256:${"a".repeat(64)}`,
};

const FIXTURE_TMPDIR = os.tmpdir();

async function fixtureCli(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(FIXTURE_TMPDIR, "owb-turn-driver-"));
  const file = path.join(dir, "fixture.mjs");
  await fs.writeFile(file, source, { mode: 0o600 });
  return `${process.execPath} ${file}`;
}

async function waitForFixtureReady(file: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await delay(10);
    }
  }
  throw new Error(`fixture did not become ready within ${timeoutMs}ms`);
}

test("turn driver uses stdin, exact turn argv, and the selected engine environment", async () => {
  const command = await fixtureCli(`
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    if (process.argv.slice(2).join("|") !== "turn|run|/workspace|--position|repo-owner|--stdin") process.exit(9);
    if (process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL !== "qoder") process.exit(8);
    if (JSON.parse(input).envelopeDigest !== ${JSON.stringify(ENVELOPE.envelopeDigest)}) process.exit(7);
    const base = { runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" };
    console.log(JSON.stringify({ ...base, type: "run.started" }));
    console.log(JSON.stringify({ ...base, type: "run.completed", output: "ok", terminalReason: "goal_met" }));
  `);
  const driver = new DigitalEmployeeCliDriver(command);
  const result = await driver.turnRun({
    workspace: "/workspace",
    positionId: "repo-owner",
    engine: "qoder",
    envelope: ENVELOPE,
  });
  assert.equal(result.status, "trusted");
  assert.equal(result.events.length, 2);
});

test("run-as-node crosses only the exact packaged bundled-engine boundary", async () => {
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  try {
    const cases: Array<{
      source: string | undefined;
      bundled: boolean;
      expected: string | undefined;
      label: string;
    }> = [
      { source: "1", bundled: true, expected: "1", label: "packaged bundled engine" },
      { source: "true", bundled: true, expected: undefined, label: "non-exact source true" },
      { source: "0", bundled: true, expected: undefined, label: "non-exact source 0" },
      { source: undefined, bundled: true, expected: undefined, label: "missing source" },
      { source: "1", bundled: false, expected: undefined, label: "normal CLI override" },
    ];
    for (const { source, bundled, expected, label } of cases) {
      if (source === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = source;
      const command = await fixtureCli(`
        let input = "";
        process.stdin.setEncoding("utf8");
        for await (const chunk of process.stdin) input += chunk;
        if (process.env.ELECTRON_RUN_AS_NODE !== ${JSON.stringify(expected)}) process.exit(6);
        const base = { runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" };
        console.log(JSON.stringify({ ...base, type: "run.started" }));
        console.log(JSON.stringify({ ...base, type: "run.completed", output: "ok", terminalReason: "goal_met" }));
      `);
      const result = await new DigitalEmployeeCliDriver(command, 120_000, bundled).turnRun({
        workspace: "/workspace",
        positionId: "repo-owner",
        engine: "qoder",
        envelope: ENVELOPE,
      });
      assert.equal(result.status, "trusted", label);
    }
  } finally {
    if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = saved;
  }
});

test("Qoder runtime reaches only selected Qoder while adapter controls require the bundled boundary", async () => {
  const qoderRuntimeEnvironment = {
    LOGNAME: "qoder-user",
    TMP: "/tmp/qoder-tmp",
    TEMP: "/tmp/qoder-temp",
    LC_CTYPE: "en_US.UTF-8",
    XDG_CONFIG_HOME: "/tmp/qoder-config",
    XDG_CACHE_HOME: "/tmp/qoder-cache",
    HTTP_PROXY: "http://127.0.0.1:9001",
    HTTPS_PROXY: "http://127.0.0.1:9002",
    NO_PROXY: "localhost,127.0.0.1",
    http_proxy: "http://127.0.0.1:9003",
    https_proxy: "http://127.0.0.1:9004",
    no_proxy: "localhost",
    NODE_EXTRA_CA_CERTS: "",
    SSL_CERT_FILE: "/tmp/qoder-ca.pem",
    SSL_CERT_DIR: "/tmp/qoder-certs",
  } as const;
  const saved = {
    bin: process.env.ORG_WORKBENCH_QODER_BIN,
    permissionMode: process.env.ORG_WORKBENCH_QODER_PERMISSION_MODE,
    qoderCommand: process.env.DIGITAL_EMPLOYEE_QODER_COMMAND,
    runtime: Object.fromEntries(
      Object.keys(qoderRuntimeEnvironment).map((key) => [key, process.env[key]]),
    ) as NodeJS.ProcessEnv,
  };
  try {
    const cases: Array<{
      engine: "qoder" | "claude-code";
      bundled: boolean;
      permissionMode: string;
      expectedBin: string | undefined;
      expectedPermissionMode: string | undefined;
      expectedQoderCommand: string | undefined;
      expectQoderRuntime: boolean;
      label: string;
    }> = [
      {
        engine: "qoder",
        bundled: true,
        permissionMode: "auto",
      expectedBin: "/opt/qoder/bin/qodercli",
      expectedPermissionMode: "auto",
      expectedQoderCommand: "/opt/qoder-cn/bin/qoderclicn",
        expectQoderRuntime: true,
        label: "bundled adapter receives supported controls",
      },
      {
        engine: "qoder",
        bundled: false,
        permissionMode: "auto",
      expectedBin: undefined,
      expectedPermissionMode: undefined,
      expectedQoderCommand: "/opt/qoder-cn/bin/qoderclicn",
        expectQoderRuntime: true,
        label: "ordinary operator command receives no adapter controls",
      },
      {
        engine: "qoder",
        bundled: true,
        permissionMode: "anything-goes",
      expectedBin: "/opt/qoder/bin/qodercli",
      expectedPermissionMode: "anything-goes",
      expectedQoderCommand: "/opt/qoder-cn/bin/qoderclicn",
        expectQoderRuntime: true,
        label: "bundled adapter receives invalid input for single-point validation",
      },
      {
        engine: "claude-code",
        bundled: true,
        permissionMode: "auto",
      expectedBin: undefined,
      expectedPermissionMode: undefined,
      expectedQoderCommand: undefined,
        expectQoderRuntime: false,
        label: "a non-Qoder turn receives neither adapter controls nor Qoder runtime",
      },
    ];
    for (const testCase of cases) {
      process.env.ORG_WORKBENCH_QODER_BIN = "/opt/qoder/bin/qodercli";
      process.env.ORG_WORKBENCH_QODER_PERMISSION_MODE = testCase.permissionMode;
      process.env.DIGITAL_EMPLOYEE_QODER_COMMAND = "/opt/qoder-cn/bin/qoderclicn";
      Object.assign(process.env, qoderRuntimeEnvironment);
      const command = await fixtureCli(`
        let input = "";
        process.stdin.setEncoding("utf8");
        for await (const chunk of process.stdin) input += chunk;
        if (process.env.ORG_WORKBENCH_QODER_BIN !== ${JSON.stringify(testCase.expectedBin)}) process.exit(6);
        if (process.env.ORG_WORKBENCH_QODER_PERMISSION_MODE !== ${JSON.stringify(testCase.expectedPermissionMode)}) process.exit(5);
        if (process.env.DIGITAL_EMPLOYEE_QODER_COMMAND !== ${JSON.stringify(testCase.expectedQoderCommand)}) process.exit(7);
        const expectedRuntime = ${JSON.stringify(qoderRuntimeEnvironment)};
        for (const [key, value] of Object.entries(expectedRuntime)) {
          const expected = ${JSON.stringify(testCase.expectQoderRuntime)} ? value : undefined;
          if (process.env[key] !== expected) process.exit(4);
        }
        const base = { runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" };
        console.log(JSON.stringify({ ...base, type: "run.started" }));
        console.log(JSON.stringify({ ...base, type: "run.completed", output: "ok", terminalReason: "goal_met" }));
      `);
      const result = await new DigitalEmployeeCliDriver(command, 120_000, testCase.bundled).turnRun({
        workspace: "/workspace",
        positionId: "repo-owner",
        engine: testCase.engine,
        envelope: ENVELOPE,
      });
      assert.equal(result.status, "trusted", testCase.label);
    }
  } finally {
    if (saved.bin === undefined) delete process.env.ORG_WORKBENCH_QODER_BIN;
    else process.env.ORG_WORKBENCH_QODER_BIN = saved.bin;
    if (saved.permissionMode === undefined) delete process.env.ORG_WORKBENCH_QODER_PERMISSION_MODE;
    else process.env.ORG_WORKBENCH_QODER_PERMISSION_MODE = saved.permissionMode;
    if (saved.qoderCommand === undefined) delete process.env.DIGITAL_EMPLOYEE_QODER_COMMAND;
    else process.env.DIGITAL_EMPLOYEE_QODER_COMMAND = saved.qoderCommand;
    for (const [key, value] of Object.entries(saved.runtime)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("an invalid bundled Qoder permission mode reaches the adapter and fails without defaulting", async () => {
  const adapter = fileURLToPath(new URL("../../bin/qoder-engine.mjs", import.meta.url));
  const saved = {
    bin: process.env.ORG_WORKBENCH_QODER_BIN,
    permissionMode: process.env.ORG_WORKBENCH_QODER_PERMISSION_MODE,
  };
  try {
    process.env.ORG_WORKBENCH_QODER_BIN = process.execPath;
    process.env.ORG_WORKBENCH_QODER_PERMISSION_MODE = "unrestricted";
    const result = await new DigitalEmployeeCliDriver(
      `${process.execPath} ${adapter}`,
      120_000,
      true,
    ).turnRun({
      workspace: "/workspace",
      positionId: "repo-owner",
      engine: "qoder",
      envelope: ENVELOPE,
    });
    assert.equal(result.status, "trusted", "a valid engine.v1 failure terminal remains trusted evidence");
    const terminal = result.events.at(-1);
    assert.equal(terminal?.type, "run.failed");
    if (terminal?.type === "run.failed") {
      assert.equal(terminal.error.code, "qoder.permission_mode_invalid");
      assert.equal(terminal.error.retryable, false);
    }
    assert.equal(result.events.some((event) => event.type === "run.completed"), false);
  } finally {
    if (saved.bin === undefined) delete process.env.ORG_WORKBENCH_QODER_BIN;
    else process.env.ORG_WORKBENCH_QODER_BIN = saved.bin;
    if (saved.permissionMode === undefined) delete process.env.ORG_WORKBENCH_QODER_PERMISSION_MODE;
    else process.env.ORG_WORKBENCH_QODER_PERMISSION_MODE = saved.permissionMode;
  }
});

test("claude-local turn env forwards the binary override and never a service credential", async () => {
  const saved = {
    model: process.env.DIGITAL_EMPLOYEE_CLAUDE_COMMAND,
    anthropic: process.env.ANTHROPIC_API_KEY,
    qoder: process.env.QODER_PERSONAL_ACCESS_TOKEN,
  };
  process.env.DIGITAL_EMPLOYEE_CLAUDE_COMMAND = "/opt/claude-local/bin";
  process.env.ANTHROPIC_API_KEY = "sk-must-not-leak";
  process.env.QODER_PERSONAL_ACCESS_TOKEN = "qoder-must-not-leak";
  try {
    const command = await fixtureCli(`
      let input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) input += chunk;
      if (process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL !== "claude-local") process.exit(8);
      if (process.env.ANTHROPIC_API_KEY !== undefined) process.exit(6);
      if (process.env.QODER_PERSONAL_ACCESS_TOKEN !== undefined) process.exit(5);
      if (process.env.DIGITAL_EMPLOYEE_CLAUDE_COMMAND !== "/opt/claude-local/bin") process.exit(4);
      const base = { runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" };
      console.log(JSON.stringify({ ...base, type: "run.started" }));
      console.log(JSON.stringify({ ...base, type: "run.completed", output: "ok", terminalReason: "goal_met" }));
    `);
    const driver = new DigitalEmployeeCliDriver(command);
    const result = await driver.turnRun({
      workspace: "/workspace",
      positionId: "repo-owner",
      engine: "claude-local",
      envelope: ENVELOPE,
    });
    assert.equal(result.status, "trusted");
  } finally {
    if (saved.model === undefined) delete process.env.DIGITAL_EMPLOYEE_CLAUDE_COMMAND;
    else process.env.DIGITAL_EMPLOYEE_CLAUDE_COMMAND = saved.model;
    if (saved.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.anthropic;
    if (saved.qoder === undefined) delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
    else process.env.QODER_PERSONAL_ACCESS_TOKEN = saved.qoder;
  }
});

test("claude-code turn env forwards ANTHROPIC_BASE_URL when set (#81)", async () => {
  const saved = {
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.ANTHROPIC_API_KEY,
  };
  process.env.ANTHROPIC_BASE_URL = "https://gateway.internal.example/anthropic";
  process.env.ANTHROPIC_API_KEY = "sk-only-inside-service";
  try {
    const command = await fixtureCli(`
      let input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) input += chunk;
      if (process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL !== "claude-code") process.exit(8);
      if (process.env.ANTHROPIC_BASE_URL !== "https://gateway.internal.example/anthropic") process.exit(7);
      if (process.env.ANTHROPIC_API_KEY !== "sk-only-inside-service") process.exit(6);
      const base = { runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" };
      console.log(JSON.stringify({ ...base, type: "run.started" }));
      console.log(JSON.stringify({ ...base, type: "run.completed", output: "ok", terminalReason: "goal_met" }));
    `);
    const driver = new DigitalEmployeeCliDriver(command);
    const result = await driver.turnRun({
      workspace: "/workspace",
      positionId: "repo-owner",
      engine: "claude-code",
      envelope: ENVELOPE,
    });
    assert.equal(result.status, "trusted");
  } finally {
    if (saved.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved.baseUrl;
    if (saved.apiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.apiKey;
  }
});

test("claude-code turn env leaves ANTHROPIC_BASE_URL unset when the operator did not set it (#81)", async () => {
  const saved = { baseUrl: process.env.ANTHROPIC_BASE_URL };
  delete process.env.ANTHROPIC_BASE_URL;
  try {
    const command = await fixtureCli(`
      let input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) input += chunk;
      if (process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL !== "claude-code") process.exit(8);
      if (typeof process.env.ANTHROPIC_BASE_URL !== "undefined") process.exit(7);
      const base = { runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" };
      console.log(JSON.stringify({ ...base, type: "run.started" }));
      console.log(JSON.stringify({ ...base, type: "run.completed", output: "ok", terminalReason: "goal_met" }));
    `);
    const driver = new DigitalEmployeeCliDriver(command);
    const result = await driver.turnRun({
      workspace: "/workspace",
      positionId: "repo-owner",
      engine: "claude-code",
      envelope: ENVELOPE,
    });
    assert.equal(result.status, "trusted");
  } finally {
    if (saved.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved.baseUrl;
  }
});

test("claude-local turn env still rejects ANTHROPIC_BASE_URL leakage (#81)", async () => {
  const saved = {
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.ANTHROPIC_API_KEY,
  };
  process.env.ANTHROPIC_BASE_URL = "https://gateway.internal.example/anthropic";
  process.env.ANTHROPIC_API_KEY = "sk-must-not-leak";
  try {
    const command = await fixtureCli(`
      let input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) input += chunk;
      if (process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL !== "claude-local") process.exit(8);
      if (typeof process.env.ANTHROPIC_BASE_URL !== "undefined") process.exit(7);
      if (typeof process.env.ANTHROPIC_API_KEY !== "undefined") process.exit(6);
      const base = { runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" };
      console.log(JSON.stringify({ ...base, type: "run.started" }));
      console.log(JSON.stringify({ ...base, type: "run.completed", output: "ok", terminalReason: "goal_met" }));
    `);
    const driver = new DigitalEmployeeCliDriver(command);
    const result = await driver.turnRun({
      workspace: "/workspace",
      positionId: "repo-owner",
      engine: "claude-local",
      envelope: ENVELOPE,
    });
    assert.equal(result.status, "trusted");
  } finally {
    if (saved.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved.baseUrl;
    if (saved.apiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.apiKey;
  }
});

test("claude-code turn actually reaches ANTHROPIC_BASE_URL via a loopback HTTP mock (#81)", async () => {
  const http = await import("node:http");
  const server = http.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const gateway = `http://127.0.0.1:${(address as import("node:net").AddressInfo).port}`;
  const saved = { baseUrl: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_BASE_URL = gateway;
  try {
    const command = await fixtureCli(`
      let input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) input += chunk;
      if (process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL !== "claude-code") process.exit(8);
      if (process.env.ANTHROPIC_BASE_URL !== ${JSON.stringify(gateway)}) process.exit(7);
      const base = { runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" };
      console.log(JSON.stringify({ ...base, type: "run.started" }));
      console.log(JSON.stringify({ ...base, type: "run.completed", output: "ok", terminalReason: "goal_met" }));
    `);
    const driver = new DigitalEmployeeCliDriver(command);
    const result = await driver.turnRun({
      workspace: "/workspace",
      positionId: "repo-owner",
      engine: "claude-code",
      envelope: ENVELOPE,
    });
    assert.equal(result.status, "trusted");
  } finally {
    if (saved.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved.baseUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("turn driver rejects malformed or multi-terminal engine.v1 streams", async () => {
  const command = await fixtureCli(`
    process.stdin.resume();
    const base = { runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" };
    console.log(JSON.stringify({ ...base, type: "run.started", extra: true }));
    console.log(JSON.stringify({ ...base, type: "run.completed", output: "one", terminalReason: "goal_met" }));
    console.log(JSON.stringify({ ...base, type: "run.completed", output: "two", terminalReason: "goal_met" }));
  `);
  const driver = new DigitalEmployeeCliDriver(command);
  const result = await driver.turnRun({
    workspace: "/workspace",
    positionId: "repo-owner",
    engine: "claude-code",
    envelope: ENVELOPE,
  });
  assert.equal(result.status, "indeterminate");
  assert.equal(result.code, "turn_protocol_invalid");
});

test("turn driver classifies exit 1 as indeterminate without retrying", async () => {
  const counterDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-turn-counter-"));
  const counter = path.join(counterDir, "count");
  const command = await fixtureCli(`
    import fs from "node:fs";
    const counter = ${JSON.stringify(counter)};
    let count = 0;
    try { count = Number(fs.readFileSync(counter, "utf8")); } catch {}
    fs.writeFileSync(counter, String(count + 1));
    console.error("engine.model_unavailable: no credential");
    process.exit(1);
  `);
  const driver = new DigitalEmployeeCliDriver(command);
  const result = await driver.turnRun({
    workspace: "/workspace",
    positionId: "repo-owner",
    engine: "qoder",
    envelope: ENVELOPE,
  });
  assert.equal(result.status, "indeterminate");
  assert.equal(result.code, "engine.model_unavailable");
  assert.equal(await fs.readFile(counter, "utf8"), "1");
  assert.ok(result.diagnostic.length <= 8 * 1024);
});

test("turn driver does not promote an unrecognized stderr token to a stable code", async () => {
  const command = await fixtureCli(`
    console.error("vendor.secret: must-not-become-a-result-code");
    process.exit(1);
  `);
  const driver = new DigitalEmployeeCliDriver(command);
  const result = await driver.turnRun({
    workspace: "/workspace",
    positionId: "repo-owner",
    engine: "qoder",
    envelope: ENVELOPE,
  });
  assert.equal(result.status, "indeterminate");
  assert.equal(result.code, "turn_process_exit_1");
});

test("turn driver preserves UTF-8 characters split across stdout chunks", async () => {
  const command = await fixtureCli(`
    const base = { runId: "run-utf8", timestamp: "2026-08-24T00:00:00.000Z" };
    const payload = [
      JSON.stringify({ ...base, type: "run.started" }),
      JSON.stringify({ ...base, type: "run.completed", output: "中文输出", terminalReason: "goal_met" }),
      "",
    ].join("\\n");
    const bytes = Buffer.from(payload, "utf8");
    const splitAt = bytes.indexOf(Buffer.from("中", "utf8")) + 1;
    process.stdout.write(bytes.subarray(0, splitAt));
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.stdout.write(bytes.subarray(splitAt));
  `);
  const driver = new DigitalEmployeeCliDriver(command);
  const result = await driver.turnRun({
    workspace: "/workspace",
    positionId: "repo-owner",
    engine: "qoder",
    envelope: ENVELOPE,
  });
  assert.equal(result.status, "trusted");
  const terminal = result.events.at(-1);
  assert.equal(terminal?.type, "run.completed");
  assert.equal(terminal?.type === "run.completed" ? terminal.output : undefined, "中文输出");
});

test("turn driver accepts the 0c4cd54 one-megachar model output boundary", async () => {
  const command = await fixtureCli(`
    const base = { runId: "run-large", timestamp: "2026-08-24T00:00:00.000Z" };
    const output = "a".repeat(1_048_576);
    console.log(JSON.stringify({ ...base, type: "run.started" }));
    console.log(JSON.stringify({ ...base, type: "model.delta", text: output }));
    console.log(JSON.stringify({ ...base, type: "run.completed", output, terminalReason: "goal_met" }));
  `);
  const driver = new DigitalEmployeeCliDriver(command);
  const result = await driver.turnRun({
    workspace: "/workspace",
    positionId: "repo-owner",
    engine: "qoder",
    envelope: ENVELOPE,
  });
  assert.equal(result.status, "trusted");
  const terminal = result.events.at(-1);
  assert.equal(terminal?.type, "run.completed");
  assert.equal(
    terminal?.type === "run.completed" && typeof terminal.output === "string"
      ? terminal.output.length
      : 0,
    1_048_576,
  );
});

test("turn timeout freezes events and reaps a child that ignores SIGTERM", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-turn-timeout-"));
  const pidFile = path.join(stateDir, "pid");
  const command = await fixtureCli(`
    import fs from "node:fs";
    process.on("SIGTERM", () => {});
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    const base = { runId: "run-late", timestamp: "2026-08-24T00:00:00.000Z" };
    setTimeout(() => {
      console.log(JSON.stringify({ ...base, type: "run.started" }));
      console.log(JSON.stringify({ ...base, type: "run.completed", output: "late", terminalReason: "goal_met" }));
    }, 5_600);
    setTimeout(() => process.exit(0), 6_200);
  `);
  const published: string[] = [];
  const driver = new DigitalEmployeeCliDriver(command, 5_000);
  const resultPromise = driver.turnRun({
    workspace: "/workspace",
    positionId: "repo-owner",
    engine: "qoder",
    envelope: ENVELOPE,
    onEvent: (event) => published.push(event.type),
  });
  const pid = Number(await waitForFixtureReady(pidFile, 15_000));
  const result = await resultPromise;
  assert.equal(result.status, "indeterminate");
  assert.equal(result.code, "turn_timeout");
  assert.deepEqual(result.events, []);
  assert.throws(() => process.kill(pid, 0), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  });
  await delay(700);
  assert.deepEqual(result.events, []);
  assert.deepEqual(published, []);
});

test("an exit-1 child cannot publish its apparent terminal as trusted SSE", async () => {
  const command = await fixtureCli(`
    process.stdin.resume();
    const base = { runId: "run-1", timestamp: "2026-08-24T00:00:00.000Z" };
    console.log(JSON.stringify({ ...base, type: "run.started" }));
    console.log(JSON.stringify({ ...base, type: "run.completed", output: "not trusted", terminalReason: "goal_met" }));
    process.exitCode = 1;
  `);
  const driver = new DigitalEmployeeCliDriver(command);
  const published: string[] = [];
  const result = await driver.turnRun({
    workspace: "/workspace",
    positionId: "repo-owner",
    engine: "qoder",
    envelope: ENVELOPE,
    onEvent: (event) => published.push(event.type),
  });
  assert.equal(result.status, "indeterminate");
  assert.deepEqual(published, ["run.started"]);
});

test("HTTP control plane completes and reads back a turn through the real spawn driver seam", async () => {
  const command = await fixtureCli(`
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    const envelope = JSON.parse(input);
    if (process.argv[2] !== "turn" || process.argv[3] !== "run") process.exit(9);
    if (process.argv[5] !== "--position" || process.argv[6] !== "repo-owner" || process.argv[7] !== "--stdin") process.exit(8);
    if (!/^sha256:[a-f0-9]{64}$/.test(envelope.envelopeDigest)) process.exit(7);
    const base = { runId: "e3-run", timestamp: "2026-08-24T00:00:00.000Z" };
    console.log(JSON.stringify({ ...base, type: "run.started" }));
    console.log(JSON.stringify({ ...base, type: "run.completed", output: "e3-ok", terminalReason: "goal_met" }));
  `);
  const server = await startTestServer(undefined, new DigitalEmployeeCliDriver(command));
  const workspace = await copyExampleWorkspace();
  try {
    const opened = await api(server.baseUrl, "/workspace/open", {
      method: "POST",
      token: server.token,
      body: { path: workspace },
    });
    assert.equal(opened.status, 200);
    const posted = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner", input: "hello", engine: "qoder" },
    });
    assert.equal(posted.status, 200);
    assert.equal((posted.body as { status: string; output: string }).status, "completed");
    assert.equal((posted.body as { output: string }).output, "e3-ok");
    const history = await api(server.baseUrl, "/turns?positionId=repo-owner", {
      token: server.token,
    });
    assert.equal((history.body as { turns: unknown[] }).turns.length, 1);
  } finally {
    await server.close();
  }
});

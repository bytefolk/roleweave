import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  executeCli,
  parseArgs,
  runDoctor,
} from "../dev.mjs";

function healthyOptions(overrides = {}) {
  const rootDir = "/fixture/org-workbench";
  const existingPaths = new Set([
    path.resolve(rootDir, "node_modules/electron/package.json"),
    path.resolve(rootDir, "../design-system/dist"),
  ]);
  const calls = [];
  const fileSystem = {
    existsSync(file) {
      return existingPaths.has(file);
    },
    readFileSync(file) {
      assert.equal(file, path.resolve(rootDir, "node_modules/electron/package.json"));
      return JSON.stringify({ version: "43.4.1" });
    },
  };
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      stdout: command === "npm" ? "11.19.0\n" : "git version 2.39.5\n",
      stderr: "",
    };
  };

  return {
    rootDir,
    environment: { PATH: "/bin", LANG: "C" },
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "22.10.0",
    fileSystem,
    spawnSyncImpl,
    calls,
    existingPaths,
    ...overrides,
  };
}

test("doctor reports the local toolchain and workspace dependencies as JSON data", () => {
  const result = executeCli(["doctor"], healthyOptions());

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.schemaVersion, "org-workbench-dev-orchestrator.v1");
  assert.equal(result.report.ok, true);
  assert.deepEqual(result.report.platform, { name: "darwin", arch: "arm64" });
  assert.deepEqual(
    result.report.checks.map((check) => check.id),
    ["node", "npm", "git", "electron", "design-system-dist"],
  );
  assert.equal(result.report.safety.readOnly, true);
  assert.equal(result.report.safety.network, false);
});

test("doctor fails closed when Electron or design-system dist is missing", () => {
  const options = healthyOptions();
  options.existingPaths.clear();

  const result = executeCli(["doctor"], options);

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.ok, false);
  assert.equal(result.report.checks.find((check) => check.id === "electron").status, "missing");
  assert.equal(result.report.checks.find((check) => check.id === "design-system-dist").status, "missing");
});

test("quick preview is a plan only and does not include long-running server or desktop steps", () => {
  const options = healthyOptions();
  const result = executeCli(["preview", "--mode", "quick"], options);

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.dryRun, true);
  assert.equal(result.report.plan.dryRun, true);
  assert.equal(result.report.plan.status, "ready");
  assert.deepEqual(
    result.report.plan.steps.map((step) => step.id),
    ["build-control-plane", "build-renderer"],
  );
  assert.equal(result.report.plan.steps.some((step) => step.longRunning), false);
  assert.equal(options.calls.length, 2, "only bounded npm/git version probes should run");
});

test("full preview adds server and desktop steps while remaining dry-run", () => {
  const result = executeCli(["preview", "--mode=full"], healthyOptions());

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.dryRun, true);
  assert.deepEqual(
    result.report.plan.steps.map((step) => step.id),
    ["build-control-plane", "build-renderer", "server", "desktop"],
  );
  assert.deepEqual(
    result.report.plan.steps.filter((step) => step.longRunning).map((step) => step.id),
    ["server", "desktop"],
  );
});

test("unknown command and mode are rejected before any process probe runs", () => {
  const options = healthyOptions();
  assert.throws(() => parseArgs(["preview", "--mode", "unsafe"]), /未知 preview 模式|未知命令或参数/);

  const commandResult = executeCli(["start"], options);
  const modeResult = executeCli(["preview", "--mode", "unsafe"], options);

  assert.equal(commandResult.exitCode, 2);
  assert.equal(modeResult.exitCode, 2);
  assert.equal(options.calls.length, 0);
  assert.equal(commandResult.report.ok, false);
});

test("sensitive environment variables are neither reported nor passed to probes", () => {
  const options = healthyOptions({
    environment: {
      PATH: "/bin",
      GITHUB_TOKEN: "github-secret-value",
      DIGITAL_EMPLOYEE_API_KEY: "api-secret-value",
      MACOS_CERTIFICATE_PASSWORD: "password-secret-value",
    },
  });

  const result = executeCli(["doctor"], options);
  const serialized = JSON.stringify(result.report);

  assert.doesNotMatch(serialized, /github-secret-value|api-secret-value|password-secret-value/);
  for (const call of options.calls) {
    assert.equal(Object.hasOwn(call.options.env, "GITHUB_TOKEN"), false);
    assert.equal(Object.hasOwn(call.options.env, "DIGITAL_EMPLOYEE_API_KEY"), false);
    assert.equal(Object.hasOwn(call.options.env, "MACOS_CERTIFICATE_PASSWORD"), false);
    assert.deepEqual(call.options.env, { PATH: "/bin" });
  }
});

test("a non-zero tool exit is visible and makes doctor/preview non-zero", () => {
  const options = healthyOptions({
    spawnSyncImpl(command, args, spawnOptions) {
      options.calls.push({ command, args, options: spawnOptions });
      if (command === "git") return { status: 7, stdout: "", stderr: "git failed" };
      return { status: 0, stdout: "11.19.0\n", stderr: "" };
    },
  });

  const doctor = executeCli(["doctor"], options);
  const preview = executeCli(["preview", "--mode", "quick"], options);

  assert.equal(doctor.exitCode, 1);
  assert.equal(doctor.report.checks.find((check) => check.id === "git").status, "non-zero");
  assert.equal(doctor.report.checks.find((check) => check.id === "git").exitCode, 7);
  assert.equal(preview.exitCode, 1);
  assert.equal(preview.report.plan.status, "blocked-by-doctor");
});

test("doctor's probe options are bounded, non-shell, and read-only", () => {
  const options = healthyOptions();
  executeCli(["doctor"], options);

  for (const call of options.calls) {
    assert.deepEqual(call.args, ["--version"]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.timeout, 2_000);
    assert.equal(call.options.cwd, "/fixture/org-workbench");
  }
});

test("runDoctor preserves a non-zero result without exposing stderr", () => {
  const result = runDoctor(healthyOptions({
    spawnSyncImpl(command) {
      return command === "npm"
        ? { status: 0, stdout: "11.19.0", stderr: "" }
        : { status: 3, stdout: "", stderr: "private diagnostic that must not escape" };
    },
  }));

  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /private diagnostic/);
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanupSmokeStaging,
  createBehaviorFixtures,
  createBehaviorLaunchEnvironment,
  createExternalStagingRoot,
  awaitStagedAppExit,
  launchApp,
  parseSmokeArgs,
  smokePackagedApp,
  waitForReport,
} from "../smoke-packaged-app.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("behavior qualification is macOS-only and its fixtures preserve the PATH boundary", async (t) => {
  await assert.rejects(
    smokePackagedApp("windows", undefined, { mode: "behavior" }),
    /qualified only on native macOS/,
  );

  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "owb-behavior-fixture-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const fixture = await createBehaviorFixtures(root);
  const loginShell = await fs.readFile(fixture.loginShell, "utf8");
  const qoder = await fs.readFile(path.join(root, "login-bin", "qodercli"), "utf8");
  assert.match(loginShell, /__ORG_WORKBENCH_LOGIN_PATH__=/);
  assert.match(loginShell, /OWB_LOGIN_ONLY_SECRET='must-not-cross'/);
  assert.match(qoder, /printf '%s\\n' "\$\$"/);
  assert.match(qoder, /owb-mcp-smoke/);
  assert.doesNotMatch(qoder, /must-not-cross/);

  const launchEnvironment = createBehaviorLaunchEnvironment({
    stagingRoot: root,
    workspace: path.join(root, "workspace"),
    report: path.join(root, "behavior-report.json"),
    nonce: "a".repeat(64),
    fixtures: fixture,
  });
  assert.equal(
    await fs.realpath(launchEnvironment.TMPDIR),
    await fs.realpath(path.dirname(root)),
    "behavior launch TMPDIR must keep hardened report validation anchored to the native temp parent",
  );
});

test("report polling tolerates the reserved empty inode and a partial write", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owb-smoke-poll-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const report = path.join(root, "report.json");
  await fs.writeFile(report, "");
  const writer = (async () => {
    await delay(30);
    await fs.writeFile(report, '{"ok":');
    await delay(30);
    await fs.writeFile(report, '{"ok":true}\n');
  })();

  const result = await waitForReport(report, new Promise(() => {}), 1000);
  await writer;
  assert.deepEqual(result, { ok: true });
});

test("report polling surfaces a final malformed report after app exit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owb-smoke-poll-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const report = path.join(root, "report.json");
  await fs.writeFile(report, '{"ok":');

  await assert.rejects(
    waitForReport(
      report,
      Promise.resolve({ code: 1, signal: null, output: "" }),
      1000,
    ),
    /exited with a malformed smoke report/,
  );
});

test("report polling promptly settles launch errors and rejected close promises", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owb-smoke-launch-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const started = Date.now();
  const launch = launchApp(path.join(root, "does-not-exist"), root, {});
  await assert.rejects(
    waitForReport(path.join(root, "missing.json"), launch.closed, 5000),
    /staged app launch failed/,
  );
  assert.equal(Date.now() - started < 1000, true, "spawn failure should not wait for the report timeout");

  await assert.rejects(
    waitForReport(
      path.join(root, "also-missing.json"),
      Promise.reject(new Error("closed promise rejected")),
      5000,
    ),
    /closed promise rejected/,
  );
});

test("smoke temp base must be canonical and disjoint from the source tree", async (t) => {
  const fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "owb-source-fixture-"));
  const source = path.join(fixture, "source");
  const insideSource = path.join(source, "tmp");
  const externalWithSpaces = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "OWB External Space "));
  await fs.mkdir(insideSource, { recursive: true });
  t.after(() => fs.rm(fixture, { force: true, recursive: true }));
  t.after(() => fs.rm(externalWithSpaces, { force: true, recursive: true }));

  await assert.rejects(
    createExternalStagingRoot({ tempBase: insideSource, sourceRoot: source }),
    /disjoint from the source tree/,
  );
  assert.deepEqual(await fs.readdir(insideSource), [], "rejected in-repo base must not be staged or launched");

  const created = await createExternalStagingRoot({
    tempBase: externalWithSpaces,
    sourceRoot: source,
  });
  assert.equal(created.stagingRoot.includes(" "), true);
  assert.equal(created.stagingRoot.startsWith(source), false);
  await fs.rm(created.stagingRoot, { force: true, recursive: true });
});

test("cleanup always attempts directory removal and preserves both failures", async () => {
  const calls = [];
  await assert.rejects(
    cleanupSmokeStaging({
      rootIdentity: { pid: 10, startTime: "bound", executable: "/app" },
      stagingRoot: "/staging",
      terminate: async () => {
        calls.push("terminate");
        throw new Error("terminate failed");
      },
      remove: async () => {
        calls.push("remove");
        throw new Error("remove failed");
      },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(error.errors.map(({ message }) => message), ["terminate failed", "remove failed"]);
      return true;
    },
  );
  assert.deepEqual(calls, ["terminate", "remove"]);
});

test("fast-exit detached leader provenance reaps its orphan group without touching a sentinel", {
  timeout: 10000,
}, async (t) => {
  if (process.platform === "win32") {
    t.skip("same-PGID orphan fixture is POSIX-specific; Windows keeps origin/creation identity and is native-CI evidence");
    return;
  }
  const stagingRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "owb-fast-leader-"));
  const childPidFile = path.join(stagingRoot, "orphan.pid");
  let originPid = null;
  let orphanPid = null;
  t.after(() => fs.rm(stagingRoot, { force: true, recursive: true }));
  t.after(() => {
    if (Number.isInteger(originPid)) {
      try { process.kill(-originPid, "SIGKILL"); } catch {}
    }
    if (Number.isInteger(orphanPid)) {
      try { process.kill(orphanPid, "SIGKILL"); } catch {}
    }
  });

  const sentinel = spawn(process.execPath, [
    "-e",
    "setInterval(()=>{},1000)",
    stagingRoot,
  ], {
    detached: true,
    stdio: "ignore",
  });
  t.after(() => {
    try { sentinel.kill("SIGKILL"); } catch {}
  });

  const leader = spawn(process.execPath, [
    "-e",
    [
      "const {spawn}=require('node:child_process'),fs=require('node:fs')",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
      "fs.writeFileSync(process.env.CHILD_PID_FILE,String(child.pid))",
      "child.unref()",
    ].join(";"),
  ], {
    cwd: stagingRoot,
    detached: true,
    env: { ...process.env, CHILD_PID_FILE: childPidFile },
    stdio: "ignore",
  });
  originPid = leader.pid;
  await once(leader, "close");
  orphanPid = Number(await fs.readFile(childPidFile, "utf8"));
  assert.equal(Number.isInteger(orphanPid), true);
  assert.doesNotThrow(() => process.kill(orphanPid, 0));
  assert.doesNotThrow(() => process.kill(sentinel.pid, 0));

  await cleanupSmokeStaging({
    rootIdentity: null,
    spawnProvenance: { originPid, processGroup: originPid },
    stagingRoot,
  });

  assert.throws(() => process.kill(orphanPid, 0), { code: "ESRCH" });
  assert.doesNotThrow(() => process.kill(sentinel.pid, 0), "unrelated group sentinel must remain alive");
  assert.equal(await fs.stat(stagingRoot).then(() => true, () => false), false);
});

// #181: the CLI dropped its platform argument whenever `--mode` was absent, so
// the two legs the workflow actually runs failed on `unsupported staging
// platform: undefined` before staging anything -- while the `--mode` variants
// kept working, which is why it went unnoticed for six merged pull requests.
// These are the four real invocations from package.json, plus the two shapes
// that made the previous filter wrong.
test("#181 CLI parsing keeps the platform for every real invocation", () => {
  assert.deepEqual(parseSmokeArgs(["macos"]), { positional: ["macos"], mode: undefined });
  assert.deepEqual(parseSmokeArgs(["windows"]), { positional: ["windows"], mode: undefined });
  assert.deepEqual(parseSmokeArgs(["macos", "--mode", "layout"]), {
    positional: ["macos"],
    mode: "layout",
  });
  assert.deepEqual(parseSmokeArgs(["windows", "--mode", "layout"]), {
    positional: ["windows"],
    mode: "layout",
  });
  assert.deepEqual(parseSmokeArgs(["macos", "--mode", "behavior"]), {
    positional: ["macos"],
    mode: "behavior",
  });

  // A candidate path is the second positional and must survive both shapes.
  assert.deepEqual(parseSmokeArgs(["macos", "/tmp/Some App.app"]), {
    positional: ["macos", "/tmp/Some App.app"],
    mode: undefined,
  });
  assert.deepEqual(parseSmokeArgs(["macos", "/tmp/Some App.app", "--mode", "layout"]), {
    positional: ["macos", "/tmp/Some App.app"],
    mode: "layout",
  });

  // A dangling flag leaves the mode unset rather than eating the platform; the
  // caller then falls back to the default static mode.
  assert.deepEqual(parseSmokeArgs(["macos", "--mode"]), { positional: ["macos"], mode: undefined });

  assert.deepEqual(parseSmokeArgs([]), { positional: [], mode: undefined });
});

// #186: layout mode declared the run complete straight after reading the
// report and went on to remove the staging tree, on the strength of a comment
// saying the app "exits right after writing its report". Nothing enforced it,
// so on Windows `fs.rm` raced the exiting Electron tree and failed with
// `EBUSY: resource busy or locked, rmdir`. macOS and Linux allow unlinking an
// open file, which is why the same job passed there.
test("#186 the staged-app exit wait is bounded and rejects an unclean exit", async (t) => {
  await t.test("a clean close resolves with the exit state", async () => {
    const exit = await awaitStagedAppExit(
      Promise.resolve({ kind: "close", code: 0, output: "" }),
    );
    assert.equal(exit.code, 0);
  });

  await t.test("a non-zero exit fails the smoke instead of being cleaned up quietly", async () => {
    await assert.rejects(
      awaitStagedAppExit(Promise.resolve({ kind: "close", code: 3, output: "boom" })),
      /staged app exited 3/,
    );
  });

  await t.test("a launch error is surfaced, not swallowed", async () => {
    await assert.rejects(
      awaitStagedAppExit(Promise.resolve({ kind: "error", error: new Error("spawn failed") })),
      /spawn failed/,
    );
  });

  await t.test("an app that never closes fails on its own timeout, not in cleanup", async () => {
    // The point of the bound: a hung app must produce this message rather than
    // an EBUSY from a directory removal nobody expected to be racing.
    await assert.rejects(
      awaitStagedAppExit(new Promise(() => {}), { timeoutMs: 30 }),
      /did not close within 30ms/,
    );
  });
});

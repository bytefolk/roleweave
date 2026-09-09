import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { cleanPackageOutput } from "../clean-package-output.mjs";
import { probeControlPlane } from "../smoke-packaged-app.mjs";
import {
  WINDOWS_SIGNATURE_TARGET_ENV,
  classifyMacSignature,
  validateResourceCandidate,
  windowsSignatureInspection,
} from "../verify-packaged-app.mjs";

function makeResourceFixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "owb-package-safety-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const sourceRoot = path.join(root, "source");
  const outputRoot = path.join(sourceRoot, "release", "staging");
  const candidate = path.join(outputRoot, "candidate");
  const resources = path.join(candidate, "resources", "app");
  const expected = path.join(sourceRoot, "expected.js");
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(expected, "expected runtime\n");
  fs.writeFileSync(path.join(resources, "runtime.js"), "expected runtime\n");
  const manifest = new Map([
    ["runtime.js", { kind: "byte-exact", source: expected }],
  ]);
  const validate = (overrides = {}) => validateResourceCandidate({
    sourceRoot,
    outputRoot,
    candidate,
    resources,
    manifest,
    ...overrides,
  });
  return { root, sourceRoot, outputRoot, candidate, resources, expected, manifest, validate };
}

test("resource verifier rejects missing, extra, forbidden, and byte-tampered files", (t) => {
  const fixture = makeResourceFixture(t);
  assert.deepEqual(fixture.validate().packagedFiles, ["runtime.js"]);

  fs.rmSync(path.join(fixture.resources, "runtime.js"));
  assert.throws(() => fixture.validate(), /explicit runtime allowlist/);
  fs.writeFileSync(path.join(fixture.resources, "runtime.js"), "expected runtime\n");

  fs.writeFileSync(path.join(fixture.resources, "extra.txt"), "benign-looking\n");
  assert.throws(() => fixture.validate(), /explicit runtime allowlist/);
  fs.rmSync(path.join(fixture.resources, "extra.txt"));

  for (const forbidden of [".env", "runtime.js.map", "runtime.test.js", "private.key"]) {
    fs.writeFileSync(path.join(fixture.resources, forbidden), "must reject\n");
    assert.throws(() => fixture.validate(), /forbidden packaged runtime path/);
    fs.rmSync(path.join(fixture.resources, forbidden));
  }

  fs.writeFileSync(path.join(fixture.resources, "runtime.js"), "expected runtimf\n");
  assert.throws(() => fixture.validate(), /runtime bytes differ/);
});

test("production verifier rejects a package missing the stable-read runtime module", (t) => {
  const fixture = makeResourceFixture(t);
  const stableReadRelative = "apps/server/dist/src/stable-read.js";
  const packagedStableRead = path.join(fixture.resources, stableReadRelative);
  fs.mkdirSync(path.dirname(packagedStableRead), { recursive: true });
  fs.writeFileSync(packagedStableRead, "expected runtime\n");
  fixture.manifest.set(stableReadRelative, {
    kind: "byte-exact",
    source: fixture.expected,
  });

  assert.deepEqual(
    fixture.validate().packagedFiles,
    [stableReadRelative, "runtime.js"].sort(),
  );
  fs.rmSync(packagedStableRead);
  assert.throws(
    () => fixture.validate(),
    /packaged resources differ from the explicit runtime allowlist/,
  );
});

test("resource verifier rejects linked roots, linked parents, and file symlinks", (t) => {
  if (process.platform === "win32") {
    t.skip("creating test symlinks/junctions requires Windows developer-mode or elevation; native tree verification still rejects them");
    return;
  }
  const fixture = makeResourceFixture(t);
  const external = path.join(fixture.root, "external");
  fs.mkdirSync(external);

  const fileLink = path.join(fixture.resources, "linked.js");
  fs.symlinkSync(fixture.expected, fileLink);
  assert.throws(() => fixture.validate(), /must not contain symlinks/);
  fs.rmSync(fileLink);

  const originalResources = `${fixture.resources}-original`;
  fs.renameSync(fixture.resources, originalResources);
  fs.symlinkSync(originalResources, fixture.resources, "dir");
  assert.throws(() => fixture.validate(), /symlink or junction/);
  fs.rmSync(fixture.resources);
  fs.renameSync(originalResources, fixture.resources);

  const externalCandidate = path.join(external, "candidate");
  const externalResources = path.join(externalCandidate, "resources", "app");
  fs.mkdirSync(externalResources, { recursive: true });
  fs.writeFileSync(path.join(externalResources, "runtime.js"), "expected runtime\n");
  const linkedParent = path.join(fixture.outputRoot, "linked-parent");
  fs.symlinkSync(external, linkedParent, "dir");
  assert.throws(() => fixture.validate({
    candidate: path.join(linkedParent, "candidate"),
    resources: path.join(linkedParent, "candidate", "resources", "app"),
  }), /symlink or junction/);
});

test("resource verifier rejects FIFO and other non-regular nodes", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows has no mkfifo fixture; native walker rejects every non-file/non-directory Dirent kind");
    return;
  }
  const fixture = makeResourceFixture(t);
  const fifo = path.join(fixture.resources, "runtime.pipe");
  const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  assert.throws(() => fixture.validate(), /non-regular filesystem node/);
});

test("package cleaner deletes stale output but refuses a symlink escape", (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "owb-clean-safety-"));
  const stale = path.join(root, "release", "staging", "stale.txt");
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, "stale\n");
  cleanPackageOutput(root);
  assert.equal(fs.existsSync(stale), false);
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  if (process.platform === "win32") {
    t.diagnostic("symlink escape fixture skipped: Windows symlink creation may require elevation");
    return;
  }
  const guardedRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "owb-clean-guard-"));
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "owb-clean-outside-"));
  const sentinel = path.join(outside, "staging", "sentinel.txt");
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, "preserve\n");
  fs.symlinkSync(outside, path.join(guardedRoot, "release"), "dir");
  t.after(() => fs.rmSync(guardedRoot, { force: true, recursive: true }));
  t.after(() => fs.rmSync(outside, { force: true, recursive: true }));

  assert.throws(() => cleanPackageOutput(guardedRoot), /symbolic link or junction/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve\n");
});

test("windows signature inspection keeps the target path out of the PowerShell script text", () => {
  const executable = "D:\\a\\org-workbench\\release\\staging\\win-unpacked\\RoleWeave.exe";
  const { command, args, env } = windowsSignatureInspection(executable, { PATH: "C:\\Windows" });

  assert.equal(command, "powershell.exe");
  assert.equal(env[WINDOWS_SIGNATURE_TARGET_ENV], executable);
  assert.equal(env.PATH, "C:\\Windows");

  // A path carried in argv would either be appended to the `-Command` script text
  // or need shell quoting; both broke on the space in "RoleWeave.exe".
  for (const argument of args) {
    assert.ok(!argument.includes(executable), `argv leaked the target path: ${argument}`);
    assert.ok(!argument.includes("param("), "`-Command` cannot bind a param() block");
  }
  assert.ok(args.at(-1).includes(`$env:${WINDOWS_SIGNATURE_TARGET_ENV}`));
});

test("windows signature inspection pins the Windows PowerShell module path", () => {
  // The CI step runs under pwsh 7, whose PSModulePath omits the Windows PowerShell
  // system modules; inheriting it makes Get-AuthenticodeSignature unresolvable.
  const inherited = "C:\\Program Files\\PowerShell\\7\\Modules";
  const { env } = windowsSignatureInspection("C:\\app\\RoleWeave.exe", {
    SystemRoot: "C:\\Windows",
    PSModulePath: inherited,
  });

  assert.equal(env.PSModulePath, "C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules");
  assert.ok(!env.PSModulePath.includes(inherited));

  const { env: fallback } = windowsSignatureInspection("C:\\app\\x.exe", {});
  assert.equal(fallback.PSModulePath, "C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules");
});

test("mac signature classifier accepts only the observed unsealed linker ad-hoc state", () => {
  const verification = {
    status: 1,
    signal: null,
    error: undefined,
    stderr: "/staged/RoleWeave.app: code has no resources but signature indicates they must be present\n",
  };
  const details = {
    status: 0,
    signal: null,
    error: undefined,
    stdout: "",
    stderr: [
      "CodeDirectory v=20400 flags=0x20002(adhoc,linker-signed)",
      "Signature=adhoc",
      "TeamIdentifier=not set",
      "Sealed Resources=none",
    ].join("\n"),
  };
  assert.equal(
    classifyMacSignature({ verification, details, codeResourcesExists: false }),
    "unsealed-linker-adhoc",
  );
  assert.throws(() => classifyMacSignature({
    verification,
    details: { ...details, stderr: `${details.stderr}\nAuthority=Unexpected` },
    codeResourcesExists: false,
  }), /signing authority/);
  assert.throws(() => classifyMacSignature({
    verification: { ...verification, stderr: "malformed bundle" },
    details,
    codeResourcesExists: false,
  }), /expected unsealed linker-signature/);
  assert.throws(() => classifyMacSignature({
    verification: { ...verification, error: new Error("tool missing"), status: null },
    details,
    codeResourcesExists: false,
  }), /could not be executed/);
});

test("control plane probe accepts only a live server that owns the reported pid", async () => {
  const never = new Promise(() => {});
  const serve = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

  const healthy = await serve((req, res) => {
    assert.equal(req.url, "/health");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: { version: "0.0.0", pid: 4242 } }));
  });
  const healthyPort = healthy.address().port;
  const body = await probeControlPlane(
    { serverPort: healthyPort, serverPid: 4242 },
    never,
    { timeoutMs: 3000, intervalMs: 20 },
  );
  assert.equal(body.server.pid, 4242);
  healthy.close();

  // A different process answering that port is rejected outright, not retried:
  // this is the case the old process-table binding existed to catch.
  const impostor = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: { pid: 9999 } }));
  });
  await assert.rejects(
    probeControlPlane(
      { serverPort: impostor.address().port, serverPid: 4242 },
      never,
      { timeoutMs: 3000, intervalMs: 20 },
    ),
    /reports pid 9999, app reported 4242/,
  );
  impostor.close();

  // A degraded control plane is a timeout, not a pass.
  const degraded = await serve((_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "starting" }));
  });
  await assert.rejects(
    probeControlPlane(
      { serverPort: degraded.address().port, serverPid: 4242 },
      never,
      { timeoutMs: 200, intervalMs: 20 },
    ),
    /did not answer within 200ms: health returned HTTP 503/,
  );
  degraded.close();
});

test("control plane probe fails fast when the staged app has already exited", async () => {
  const exited = Promise.resolve({ kind: "close", code: 1, output: "" });
  await assert.rejects(
    probeControlPlane({ serverPort: 1, serverPid: 4242 }, exited, { timeoutMs: 5000, intervalMs: 10 }),
    /staged app exited before its control plane answered/,
  );
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { ARCHIVE_LIMITS, createServiceManager, deploymentInstructions, main, parseArguments, prepareSourceArchive, resolveSource, runProcess, verifyArchiveIntegrity } from "../services.mjs";

const FIRST = "a".repeat(40);
const SECOND = "b".repeat(40);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "roleweave-service-test-"));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const calls = [];
  const resolutions = [];
  const state = { sha: FIRST, badCheckout: false, failFetch: false, dirty: false };
  const run = async (command, args) => {
    calls.push({ command, args });
    assert.equal(command, "git", "preparing or selecting source must never start a service");
    if (args.includes("init")) return "Initialized";
    const directory = args[1];
    if (args.includes("fetch")) {
      if (state.failFetch) throw new Error("fetch failed");
      return "Fetched";
    }
    if (args.includes("checkout")) {
      const sha = state.badCheckout ? SECOND : args.at(-1);
      await fs.writeFile(path.join(directory, ".fixture-sha"), sha);
      await fs.writeFile(path.join(directory, "docker-compose.yml"), "services: {}\n");
      await fs.mkdir(path.join(directory, "deploy", "compose"), { recursive: true });
      await fs.writeFile(path.join(directory, "deploy", "compose", "compose.yaml"), "services: {}\n");
    }
    if (args.includes("rev-parse")) return fs.readFile(path.join(directory, ".fixture-sha"), "utf8");
    if (args.includes("status")) return state.dirty ? " M docker-compose.yml" : "";
    return "";
  };
  const resolve = async (service, ref) => {
    resolutions.push({ service, ref });
    return { service, repository: `bytefolk/${service}`, ref, sha: state.sha, sourceUrl: `https://github.com/bytefolk/${service}/commit/${state.sha}` };
  };
  const options = { root, run, resolve, now: () => new Date("2026-09-13T00:00:00Z") };
  return { root, calls, resolutions, state, options, manager: createServiceManager(options) };
}

test("status does not create directories, contact upstream, or claim service readiness", async (t) => {
  const f = await fixture(t);
  const result = await f.manager.status("doc");
  assert.equal(result.preparedSource, null);
  assert.equal(result.deployment.state, "not-managed");
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.equal(f.calls.length + f.resolutions.length, 0);
});

test("plan reports the exact candidate SHA without preparing or starting it", async (t) => {
  const f = await fixture(t);
  const result = await f.manager.plan("doc");
  assert.equal(result.candidate.sha, FIRST);
  assert.equal(result.channel, "main-preview");
  assert.equal(result.sourceChangeAvailable, true);
  assert.ok(result.candidateDeployment.projectName.startsWith("roleweave-doc-"));
  assert.equal(result.candidateDeployment.envFile, path.join(f.root, "doc", "runtime", ".env"));
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.equal(f.calls.length, 0);
});

test("prepare pins the fetched commit and keeps deployment configuration outside the source", async (t) => {
  const f = await fixture(t);
  const result = await f.manager.prepare("doc", "main");
  assert.equal(result.preparedSource.sha, FIRST);
  assert.equal(result.preparedSource.ref, "main");
  assert.equal(result.preparedSource.fetchedAt, "2026-09-13T00:00:00.000Z");
  assert.equal(result.deployment.state, "not-managed");
  assert.equal(path.basename(result.preparedSource.path), FIRST);
  assert.deepEqual(f.calls.find((call) => call.args.includes("fetch")).args.slice(-5), ["fetch", "--no-tags", "--depth=1", "origin", FIRST]);
  assert.ok(f.calls.some((call) => call.args.includes("https://github.com/bytefolk/doc.git")));
  assert.ok(!result.nextSteps.envFile.startsWith(result.preparedSource.path));
  assert.ok(result.nextSteps.commands.find((entry) => entry.args.includes("up")).requiresDataBackup);
  const manifest = JSON.parse(await fs.readFile(path.join(f.root, "doc", "manifest.json"), "utf8"));
  assert.equal(manifest.selectedSha, FIRST);
  assert.equal(manifest.sources.length, 1);
  assert.deepEqual(await fs.readdir(path.join(f.root, "doc", "sources")), [FIRST]);
});

test("repreparing a SHA verifies and reuses the checkout without refetching", async (t) => {
  const f = await fixture(t);
  await f.manager.prepare("doc", FIRST);
  const count = f.calls.filter((call) => call.args.includes("fetch")).length;
  await f.manager.prepare("doc", FIRST);
  assert.equal(f.calls.filter((call) => call.args.includes("fetch")).length, count);
  assert.equal((await f.manager.status("doc")).sources.length, 1);
  f.state.dirty = true;
  await assert.rejects(f.manager.prepare("doc", FIRST), /tracked modifications/);
});

test("updates retain prior immutable source and source rollback never fetches or modifies data", async (t) => {
  const f = await fixture(t);
  const first = await f.manager.prepare("mem", FIRST);
  f.state.sha = SECOND;
  const second = await f.manager.prepare("mem", SECOND);
  assert.equal(first.nextSteps.projectName, second.nextSteps.projectName, "Compose identity must not change across source updates");
  assert.equal(first.nextSteps.envFile, second.nextSteps.envFile);
  assert.equal(second.sources.length, 2);
  const resolvedBefore = f.resolutions.length;
  const fetchesBefore = f.calls.filter((call) => call.args.includes("fetch")).length;
  const rollback = await f.manager.rollbackSource("mem", FIRST);
  assert.equal(rollback.preparedSource.sha, FIRST);
  assert.equal(rollback.sources.length, 2);
  assert.equal(rollback.deployment.state, "not-managed");
  assert.equal(f.resolutions.length, resolvedBefore);
  assert.equal(f.calls.filter((call) => call.args.includes("fetch")).length, fetchesBefore);
  await assert.rejects(f.manager.rollbackSource("mem", "c".repeat(40)), /has not been prepared/);
});

test("failed fetch and mismatched checkout never replace the selected source or leave a lock", async (t) => {
  const f = await fixture(t);
  await f.manager.prepare("doc", FIRST);
  const before = await fs.readFile(path.join(f.root, "doc", "manifest.json"), "utf8");
  f.state.sha = SECOND;
  f.state.failFetch = true;
  await assert.rejects(f.manager.prepare("doc", SECOND), /fetch failed/);
  assert.equal(await fs.readFile(path.join(f.root, "doc", "manifest.json"), "utf8"), before);
  assert.deepEqual(await fs.readdir(path.join(f.root, "doc", "sources")), [FIRST]);
  f.state.failFetch = false;
  f.state.sha = "c".repeat(40);
  f.state.badCheckout = true;
  await assert.rejects(f.manager.prepare("doc", f.state.sha), /does not match/);
  assert.equal(await fs.readFile(path.join(f.root, "doc", "manifest.json"), "utf8"), before);
  assert.ok(!(await fs.readdir(path.join(f.root, "doc"))).includes(".source-operation.lock"));
});

test("an atomic manifest write failure preserves the last selected source", async (t) => {
  const f = await fixture(t);
  await f.manager.prepare("doc", FIRST);
  f.state.sha = SECOND;
  const failingIo = { ...fs, rename: async (from, to) => {
    if (to.endsWith("manifest.json")) throw new Error("simulated disk failure");
    return fs.rename(from, to);
  } };
  await assert.rejects(createServiceManager({ ...f.options, io: failingIo }).prepare("doc", SECOND), /disk failure/);
  assert.equal((await f.manager.status("doc")).preparedSource.sha, FIRST);
  assert.ok(!(await fs.readdir(path.join(f.root, "doc"))).some((name) => name.endsWith(".tmp")));
});

test("a concurrent operation cannot take over the source manifest", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "doc", ".source-operation.lock"), { recursive: true });
  await assert.rejects(f.manager.prepare("doc", FIRST), /Another source operation is active/);
  assert.equal(f.calls.length, 0);
});

test("source manifests and service selection reject path injection", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.manager.status("../doc"), /Service must be/);
  await fs.mkdir(path.join(f.root, "doc"));
  await fs.writeFile(path.join(f.root, "doc", "manifest.json"), JSON.stringify({ schemaVersion: "roleweave-service-sources.v1", service: "doc", repository: "bytefolk/doc", selectedSha: "../../outside", sources: [{ sha: "../../outside", ref: "main", fetchedAt: "now" }] }));
  await assert.rejects(f.manager.status("doc"), /Invalid source entry/);
});

test("managed source directories cannot redirect operations through a symlink", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.root, "doc"));
  await assert.rejects(f.manager.prepare("doc", FIRST), /symbolic link/);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(f.calls.length, 0);
});

test("ref resolution is fixed to the official repository and refuses HTTP/JSON failures", async () => {
  let request;
  const result = await resolveSource("doc", "feature/docs", { fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ sha: FIRST }));
  } });
  assert.equal(request.url, "https://api.github.com/repos/bytefolk/doc/commits/feature%2Fdocs");
  assert.equal(request.options.redirect, "error");
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(result.sha, FIRST);
  await assert.rejects(resolveSource("doc", "main", { fetchImpl: async () => new Response("rate limited", { status: 403 }) }), /GitHub HTTP 403/);
  await assert.rejects(resolveSource("doc", "main", { fetchImpl: async () => new Response(JSON.stringify({ sha: "../../escape" })) }), /full commit SHA/);
});

test("source update is an explicit channel or ref choice and has no deployment command", () => {
  assert.throws(() => parseArguments(["prepare", "doc"]), /requires --ref/);
  assert.throws(() => parseArguments(["update-source", "mem", "--channel", "stable"]), /preview channel/);
  assert.throws(() => parseArguments(["deploy", "doc"]), /Unknown/);
  assert.throws(() => parseArguments(["status", "doc", "--ref", "main"]), /local metadata/);
  assert.throws(() => parseArguments(["prepare", "doc", "--ref", "-bad"]), /Git branch/);
  assert.throws(() => parseArguments(["prepare", "doc", "--ref", FIRST, "--channel", "main"]), /not both/);
  assert.equal(parseArguments(["update-source", "mem", "--channel", "main"]).channel, "main");
  assert.equal(parseArguments(["prepare", "doc", "--ref", FIRST]).ref, FIRST);
});

test("deployment instructions preserve project/data identity and quote user paths safely", () => {
  const root = path.resolve("a space'and$variable`name");
  const doc = deploymentInstructions("doc", root, FIRST, "linux");
  const mem = deploymentInstructions("mem", root, FIRST, "win32");
  assert.notEqual(doc.projectName, mem.projectName);
  assert.equal(doc.deploymentMode, "local-development");
  assert.equal(mem.deploymentMode, "private-self-hosting");
  assert.ok(doc.commands[0].display.includes("'\"'\"'"));
  assert.ok(mem.commands[0].display.includes("space''and$variable`name"));
  assert.ok(mem.commands[0].display.startsWith("& 'node' "));
  assert.deepEqual(doc.commands[0].args.slice(-4), ["init", "doc", "--root", root]);
  assert.ok(doc.notes.some((note) => note.includes("schema push")));
  assert.ok(mem.commands[1].args.includes(path.join(root, "mem", "sources", FIRST, "deploy/compose/compose.yaml")));
});

test("CLI update-source delegates only source preparation and emits reviewable JSON", async () => {
  const calls = [];
  const output = [];
  await main(["update-source", "mem", "--ref", FIRST], {
    output: (value) => output.push(value),
    managerFactory: () => ({ prepare: async (...args) => { calls.push(args); return { deployment: { state: "not-managed" } }; } }),
  });
  assert.deepEqual(calls, [["mem", FIRST]]);
  assert.equal(JSON.parse(output[0]).deployment.state, "not-managed");
});

test("process runner preserves literal arguments and bounds failed, noisy and stalled processes", async () => {
  const literal = "space ' $HOME `not-shell`";
  assert.equal(await runProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1])", literal]), literal);
  await assert.rejects(runProcess(process.execPath, ["-e", "process.exit(7)"]), /failed \(7\)/);
  await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('a'.repeat(10000)); setInterval(()=>{}, 1000)"], { maxOutputBytes: 100 }), /output exceeded/);
  await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { timeoutMs: 100 }), /timed out/);
});

function tarFixture(entries, { service = "doc", sha = FIRST } = {}) {
  const prefix = `${service}-${sha}`;
  const chunks = [];
  for (const entry of [{ path: `${prefix}/`, type: "5" }, ...entries]) {
    const header = Buffer.alloc(512);
    const body = Buffer.from(entry.body || "");
    const writeOctal = (value, offset, length) => header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
    header.write(entry.path.startsWith("!") ? entry.path.slice(1) : (entry.path === `${prefix}/` ? entry.path : `${prefix}/${entry.path}`), 0, 100);
    writeOctal(entry.mode ?? (entry.type === "5" ? 0o755 : 0o644), 100, 8);
    writeOctal(0, 108, 8);
    writeOctal(0, 116, 8);
    writeOctal(body.length, 124, 12);
    writeOctal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write(entry.type || "0", 156, 1);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

async function archiveFixture(t, entries = [{ path: "docker-compose.yml", body: "services: {}\n" }, { path: "run.sh", body: "#!/bin/sh\n", mode: 0o755 }], options = {}) {
  const f = await fixture(t);
  const staging = path.join(f.root, "archive-staging");
  const checkout = path.join(staging, "checkout");
  await fs.mkdir(checkout, { recursive: true });
  const archive = tarFixture(entries);
  const fetches = [];
  const fetchImpl = async (url, request) => { fetches.push({ url, request }); return new Response(archive); };
  return { ...f, staging, checkout, archive, fetches, fetchImpl, arguments: { service: "doc", sha: FIRST, staging, checkout, fetchImpl, ...options } };
}

test("archive transport records all file hashes, preserves executable bits and detects changes", async (t) => {
  const f = await archiveFixture(t);
  const source = await prepareSourceArchive(f.arguments);
  assert.equal(f.fetches[0].url, `https://codeload.github.com/bytefolk/doc/tar.gz/${FIRST}`);
  assert.equal(f.fetches[0].request.redirect, "error");
  assert.equal(source.transport, "archive");
  assert.match(source.archiveSha256, /^[a-f0-9]{64}$/);
  assert.equal(source.files.length, 2);
  assert.ok(source.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(f.checkout, "run.sh"))).mode & 0o111, 0o111);
  await verifyArchiveIntegrity(f.checkout, source);
  await fs.writeFile(path.join(f.checkout, "run.sh"), "#!/bin/xx\n");
  await assert.rejects(verifyArchiveIntegrity(f.checkout, source), /has changed/);
});

test("archive manager can prepare, reuse and roll back without any Git process", async (t) => {
  const f = await fixture(t);
  const options = { ...f.options, run: async () => { throw new Error("Git must not run"); }, fetchImpl: async () => new Response(tarFixture([{ path: "docker-compose.yml", body: "services: {}\n" }], { sha: f.state.sha })) };
  const manager = createServiceManager(options);
  const first = await manager.prepare("doc", FIRST, { transport: "archive" });
  assert.equal(first.preparedSource.transport, "archive");
  assert.equal(first.preparedSource.fileCount, 1);
  assert.equal(first.preparedSource.files, undefined, "large per-file evidence belongs in the persisted manifest");
  const manifest = JSON.parse(await fs.readFile(path.join(f.root, "doc", "manifest.json"), "utf8"));
  assert.match(manifest.sources[0].files[0].sha256, /^[a-f0-9]{64}$/);
  await manager.prepare("doc", FIRST, { transport: "archive" });
  f.state.sha = SECOND;
  await manager.prepare("doc", SECOND, { transport: "archive" });
  assert.equal((await manager.rollbackSource("doc", FIRST)).preparedSource.sha, FIRST);
  await fs.writeFile(path.join(first.preparedSource.path, "injected.js"), "added");
  await assert.rejects(manager.rollbackSource("doc", FIRST), /unexpected file/);
});

test("archive validation rejects traversal, absolute paths, Windows aliases, duplicate names and wrong roots before extraction", async (t) => {
  const variants = ["../escape", "!/absolute", "C:/device", "dir\\escape", "folder/./name", "folder/NUL", "name.", "!other-root/file"];
  for (const name of variants) {
    await t.test(name, async (subtest) => {
      const f = await archiveFixture(subtest, [{ path: name, body: "unsafe" }]);
      await assert.rejects(prepareSourceArchive(f.arguments), /Unsafe archive|pinned repository root/);
      assert.deepEqual(await fs.readdir(f.checkout), []);
    });
  }
  const f = await archiveFixture(t, [{ path: "duplicate", body: "first" }, { path: "DUPLICATE", body: "second" }]);
  await assert.rejects(prepareSourceArchive(f.arguments), /duplicate or platform-colliding/);
  assert.deepEqual(await fs.readdir(f.checkout), []);
});

test("archive validation rejects symbolic/hard links, devices, FIFOs and privileged modes", async (t) => {
  for (const type of ["1", "2", "3", "4", "6"]) {
    await t.test(`entry type ${type}`, async (subtest) => {
      const f = await archiveFixture(subtest, [{ path: "unsafe", type, link: type === "1" || type === "2" ? "../../outside" : undefined }]);
      await assert.rejects(prepareSourceArchive(f.arguments), /entry type is not allowed/);
      assert.deepEqual(await fs.readdir(f.checkout), []);
    });
  }
  const f = await archiveFixture(t, [{ path: "setuid.sh", body: "unsafe", mode: 0o4755 }]);
  await assert.rejects(prepareSourceArchive(f.arguments), /privileged permission/);
});

test("archive bounds reject compressed, decompressed, per-file and entry overflow", async (t) => {
  for (const [key, value, expected] of [["compressedBytes", 20, /Compressed archive/], ["unpackedBytes", 1024, /Unpacked archive/], ["fileBytes", 2, /entry is too large/], ["entries", 1, /too many entries/]]) {
    await t.test(key, async (subtest) => {
      const f = await archiveFixture(subtest, undefined, { limits: { ...ARCHIVE_LIMITS, [key]: value } });
      await assert.rejects(prepareSourceArchive(f.arguments), expected);
      assert.deepEqual(await fs.readdir(f.checkout), []);
    });
  }
});

test("archive integrity detects missing files, executable changes and links replacing files", async (t) => {
  const f = await archiveFixture(t);
  const source = await prepareSourceArchive(f.arguments);
  await fs.unlink(path.join(f.checkout, "docker-compose.yml"));
  await assert.rejects(verifyArchiveIntegrity(f.checkout, source), /missing a file/);
  await fs.writeFile(path.join(f.checkout, "docker-compose.yml"), "services: {}\n");
  if (process.platform !== "win32") {
    await fs.chmod(path.join(f.checkout, "run.sh"), 0o644);
    await assert.rejects(verifyArchiveIntegrity(f.checkout, source), /has changed/);
    await fs.chmod(path.join(f.checkout, "run.sh"), 0o755);
    await fs.unlink(path.join(f.checkout, "run.sh"));
    await fs.symlink("docker-compose.yml", path.join(f.checkout, "run.sh"));
    await assert.rejects(verifyArchiveIntegrity(f.checkout, source), /link or special file/);
  }
});

test("archive is an explicit optional transport rather than an automatic fallback", () => {
  assert.equal(parseArguments(["prepare", "doc", "--ref", FIRST, "--transport", "archive"]).transport, "archive");
  assert.throws(() => parseArguments(["prepare", "doc", "--ref", FIRST, "--transport", "zip"]), /--transport git\|archive/);
  assert.throws(() => parseArguments(["status", "doc", "--transport", "archive"]), /--transport git\|archive/);
});

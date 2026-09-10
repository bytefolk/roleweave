import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const notes = `# RoleWeave ${version}\n\nLiteral quotes: "double", 'single'.\n$(touch notes-executed) and \`touch notes-executed\` stay text.\nUnicode: 并发任务。\n\n`;

// Execute the workflow's actual shell bodies, not a duplicate publisher.
function step(name) {
  const start = source.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const lines = source.slice(start).split("\n");
  const run = lines.findIndex(line => /^        run:/.test(line));
  assert.ok(run >= 0, `${name} must have a run body`);
  if (lines[run] !== "        run: |") return lines[run].slice("        run: ".length);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

function fixture(t, content = notes, notesVersion = version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roleweave-release-notes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release-test@example.invalid");
  fs.mkdirSync(path.join(dir, "docs/releases"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
  if (content !== null) fs.writeFileSync(path.join(dir, `docs/releases/v${notesVersion}.md`), content);
  git("add", ".");
  git("commit", "-qm", "fixture release source");
  fs.mkdirSync(path.join(dir, "bin"));
  // Reproduce runners without coreutils even when the developer has it installed.
  // A fallback to another external digest utility must not hide the dependency.
  for (const command of ["sha256sum", "shasum", "coreutils"]) {
    fs.writeFileSync(path.join(dir, "bin", command), `#!/bin/sh\necho '${command}: command not found (fixture)' >&2\nexit 127\n`, { mode: 0o755 });
  }
  fs.mkdirSync(path.join(dir, "incoming"));
  const assets = [`roleweave-${version}-x64.exe`, "latest.yml"];
  for (const asset of assets) fs.writeFileSync(path.join(dir, "incoming", asset), "fixture asset");
  const log = path.join(dir, "gh.jsonl");
  fs.writeFileSync(path.join(dir, "bin/gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const entry = {args};
if (args[0] === 'release' && args[1] === 'create') {
  const index = args.indexOf('--notes-file');
  entry.notes = index < 0 ? args[args.indexOf('--notes') + 1] : fs.readFileSync(args[index + 1], 'utf8');
  entry.assets = args.slice(args.indexOf('--draft') + 1);
}
fs.appendFileSync(process.env.MOCK_GH_LOG, JSON.stringify(entry) + '\\n');
if (args[0] === 'api') {
  if (!args[1].includes('/assets')) process.stdout.write('17\\n');
  else {
    const assets = fs.readdirSync('incoming').map(name => ({name, size: 13, state: 'uploaded', digest: 'sha256:fixture'}));
    if (process.env.MOCK_BAD_ASSET === 'true') assets[0].size = 0;
    process.stdout.write(JSON.stringify(assets));
  }
}
`, { mode: 0o755 });
  return { dir, git, log, assets, calls: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [] };
}

function run(f, name, values = {}, extraEnv = {}) {
  const expressions = {
    "github.event_name": "push", "github.repository": "bytefolk/roleweave", "inputs.draft": "true",
    "needs.preflight.outputs.version": version, "steps.create.outputs.tag": `v${version}`, ...values,
  };
  const script = step(name).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
    assert.ok(key in expressions, `unhandled expression: ${key}`);
    return expressions[key];
  });
  return spawnSync("bash", ["-e", "-c", script], {
    cwd: f.dir, encoding: "utf8", timeout: 10000,
    env: { ...process.env, PATH: `${path.join(f.dir, "bin")}${path.delimiter}${process.env.PATH}`, MOCK_GH_LOG: f.log, GITHUB_OUTPUT: path.join(f.dir, "outputs"), ...extraEnv },
  });
}

function outputs(f) {
  return Object.fromEntries(fs.readFileSync(path.join(f.dir, "outputs"), "utf8").trim().split("\n").map(line => {
    const split = line.indexOf("=");
    return [line.slice(0, split), line.slice(split + 1)];
  }));
}

function prepare(f) {
  const result = run(f, "Read packaged version");
  assert.equal(result.status, 0, result.stderr);
  return outputs(f);
}

function create(f, prepared, event = "push", draft = "true") {
  return run(f, "Create the release as a draft", { "github.event_name": event, "inputs.draft": draft }, { NOTES_SHA256: prepared.notes_sha256 ?? "" });
}

test("#227 actual create command uses exact frozen notes without external digest utilities, evaluating shell text or uploading them", t => {
  const f = fixture(t);
  for (const command of ["sha256sum", "shasum", "coreutils"]) {
    assert.equal(spawnSync(path.join(f.dir, "bin", command)).status, 127);
  }
  const prepared = prepare(f);
  const result = create(f, prepared);
  assert.equal(result.status, 0, result.stderr);
  const created = f.calls().find(call => call.args[1] === "create");
  assert.equal(created.notes, notes, "versioned notes must reach gh byte-for-byte, not static workflow text");
  assert.deepEqual(created.assets, f.assets.slice().sort().map(name => `incoming/${name}`));
  assert.equal(fs.existsSync(path.join(f.dir, "notes-executed")), false);
  assert.equal(prepared.commit, f.git("rev-parse", "HEAD").trim());
});

test("#227 preflight reads notes and package version from the frozen commit, not local replacements", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, `docs/releases/v${version}.md`), "uncommitted replacement");
  fs.writeFileSync(path.join(f.dir, "package.json"), JSON.stringify({ version: "99.0.0" }));
  const prepared = prepare(f);
  assert.equal(prepared.value, version);
  assert.equal(create(f, prepared).status, 0);
  assert.equal(f.calls()[0].notes, notes);
});

for (const [label, content, notesVersion] of [
  ["missing", null, version],
  ["empty", "", version],
  ["whitespace-only", " \n\t\n", version],
  ["heading-only", `# RoleWeave ${version}\n\n`, version],
  ["wrong version heading", "# RoleWeave 99.0.0\n\nFuture work", version],
  ["only a future-version file", "# RoleWeave 99.0.0\n\nFuture work", "99.0.0"],
]) {
  test(`#227 preflight rejects ${label} notes before build or gh`, t => {
    const f = fixture(t, content, notesVersion);
    const result = run(f, "Read packaged version");
    assert.notEqual(result.status, 0, "invalid notes must stop preflight");
    assert.equal(f.calls().length, 0);
  });
}

for (const [label, replacement] of [["missing", null], ["empty", ""], ["wrong-version", "# RoleWeave 99.0.0\n\nFuture"], ["modified", notes + "changed"]]) {
  test(`#227 ${label} downloaded notes cannot create a draft`, t => {
    const f = fixture(t);
    const prepared = prepare(f);
    const file = path.join(f.dir, "publication-notes/notes.md");
    if (replacement === null) fs.rmSync(file, { force: true });
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, replacement); }
    const result = create(f, prepared);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr + result.stdout, replacement === null || replacement === ""
      ? /validated release notes are missing or empty/
      : /release notes digest does not match frozen preflight notes/);
    assert.equal(f.calls().length, 0);
  });
}

for (const [label, digest, error] of [
  ["empty", () => "", /must be exactly 64 hex characters/],
  ["non-hex", () => "g".repeat(64), /must be exactly 64 hex characters/],
  ["short", value => value.slice(1), /must be exactly 64 hex characters/],
  ["long", value => value + "0", /must be exactly 64 hex characters/],
  ["leading whitespace", value => " " + value, /must be exactly 64 hex characters/],
  ["trailing newline", value => value + "\n", /must be exactly 64 hex characters/],
  ["shell text", () => "$(touch notes-executed)", /must be exactly 64 hex characters/],
  ["wrong hash", () => "0".repeat(64), /does not match frozen preflight notes/],
]) {
  test(`#227 ${label} expected digest is refused before gh without external digest utilities`, t => {
    const f = fixture(t);
    const prepared = prepare(f);
    const result = create(f, { ...prepared, notes_sha256: digest(prepared.notes_sha256) });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, error);
    assert.equal(f.calls().length, 0);
    assert.equal(outputs(f).publish, undefined);
    assert.equal(fs.existsSync(path.join(f.dir, "notes-executed")), false);
  });
}

test("#227 uppercase hex expected digest binds the same frozen notes", t => {
  const f = fixture(t);
  const prepared = prepare(f);
  const result = create(f, { ...prepared, notes_sha256: prepared.notes_sha256.toUpperCase() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls()[0].notes, notes);
});

for (const [event, draft, publishes] of [["push", "true", true], ["workflow_dispatch", "true", false], ["workflow_dispatch", "false", true]]) {
  test(`#227 ${event} draft=${draft} retains inventory-before-publication semantics`, t => {
    const f = fixture(t);
    const prepared = prepare(f);
    assert.equal(create(f, prepared, event, draft).status, 0);
    assert.equal(outputs(f).publish, String(publishes));
    const readback = run(f, "Read back the asset inventory");
    assert.equal(readback.status, 0, readback.stderr + readback.stdout);
    if (publishes) assert.equal(run(f, "Publish the release").status, 0);
    const calls = f.calls();
    assert.equal(calls.filter(call => call.args[1] === "edit").length, Number(publishes));
    assert.ok(calls[0].args.includes("--draft"));
    if (publishes) assert.ok(calls.findIndex(call => call.args[1] === "edit") > calls.findIndex(call => call.args[0] === "api"));
  });
}

test("#227 invalid installer inventory still stops before leaving draft", t => {
  const f = fixture(t);
  assert.equal(create(f, prepare(f)).status, 0);
  const readback = run(f, "Read back the asset inventory", {}, { MOCK_BAD_ASSET: "true" });
  assert.notEqual(readback.status, 0);
  assert.equal(f.calls().some(call => call.args[1] === "edit"), false);
});

test("#227 artifact handoff excludes notes from the installer download glob and pins build source", () => {
  assert.match(source, /notes_sha256: \$\{\{ steps\.version\.outputs\.notes_sha256 \}\}/);
  assert.match(source, /commit: \$\{\{ steps\.version\.outputs\.commit \}\}/);
  assert.match(source, /uses: actions\/upload-artifact@v4\n\s+with:\n\s+name: publication-notes\n\s+path: publication-notes\/notes\.md\n\s+if-no-files-found: error/);
  assert.match(source, /uses: actions\/download-artifact@v4\n\s+with:\n\s+name: publication-notes\n\s+path: publication-notes/);
  assert.match(source, /pattern: release-\*/);
  assert.equal("publication-notes".startsWith("release-"), false);
  const build = source.slice(source.indexOf("  build:"), source.indexOf("  publish:"));
  assert.match(build, /ref: \$\{\{ needs\.preflight\.outputs\.commit \}\}/);
  assert.doesNotMatch(build, /publication-notes/);
  assert.match(source, /NOTES_SHA256: \$\{\{ needs\.preflight\.outputs\.notes_sha256 \}\}/);
});

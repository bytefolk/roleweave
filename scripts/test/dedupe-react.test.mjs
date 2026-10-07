// #49 regression: scripts/dedupe-react.mjs must locate the real
// design-system checkout even when it runs from a git worktree copy
// (ancestor-sibling probe + package identity check), must stay a no-op
// when no such checkout exists, and must not regress the classic
// sibling layout from the main clone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dedupe-react.mjs");

function removeFixturePath(root, target = root) {
  const fixtureRoot = resolve(root);
  assert.equal(dirname(fixtureRoot), realpathSync(tmpdir()), "fixture must be directly inside the temporary directory");
  const child = relative(fixtureRoot, resolve(target));
  assert.ok(!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`), "cleanup must stay within its fixture");
  rmSync(target, { recursive: true, force: true });
}

function createFixture(t, prefix) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  t.after(() => removeFixturePath(root));
  return root;
}

function writePackage(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "18.3.1", main: "index.js" }));
  writeFileSync(join(dir, "index.js"), "module.exports = {};");
}

function writeDesignSystem(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@fullstack-ai-infra/ui", version: "0.0.0" }));
  writePackage(join(dir, "node_modules", "react"), "react");
  writePackage(join(dir, "node_modules", "react-dom"), "react-dom");
}

function writeWorkspace(dir) {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(scriptPath, join(dir, "scripts", "dedupe-react.mjs"));
  writePackage(join(dir, "node_modules", "react"), "react");
  writePackage(join(dir, "node_modules", "react-dom"), "react-dom");
}

function runScript(workspace, preload) {
  const args = preload ? ["--require", preload] : [];
  return spawnSync(process.execPath, [...args, join(workspace, "scripts", "dedupe-react.mjs")], { encoding: "utf8" });
}

function assertConverged(designSystem, workspace, names) {
  for (const name of names) {
    const link = join(designSystem, "node_modules", name);
    assert.ok(lstatSync(link).isSymbolicLink(), `${name} should be a symlink`);
    assert.equal(realpathSync(link), realpathSync(join(workspace, "node_modules", name)));
  }
}

test("worktree copy finds design-system via ancestor sibling and rewrites links", (t) => {
  const root = createFixture(t, "owb-dedupe-worktree-");
  const designSystem = join(root, "design-system");
  const workspace = join(root, "org-workbench", ".worktrees", "issue-x");
  writeDesignSystem(designSystem);
  writeWorkspace(workspace);

  const first = runScript(workspace);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /design-system[/\\]node_modules[/\\]react -> /);
  assert.match(first.stdout, /react resolves from .* to the workspace copy/);
  assertConverged(designSystem, workspace, ["react", "react-dom"]);

  const second = runScript(workspace);
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stdout, / -> /, "idempotent rerun must not rewrite");
  assertConverged(designSystem, workspace, ["react", "react-dom"]);
});

test("classic sibling layout from the main clone still works", (t) => {
  const root = createFixture(t, "owb-dedupe-sibling-");
  const designSystem = join(root, "design-system");
  const workspace = join(root, "org-workbench");
  writeDesignSystem(designSystem);
  writeWorkspace(workspace);

  const result = runScript(workspace);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /react resolves from .* to the workspace copy/);
  assertConverged(designSystem, workspace, ["react", "react-dom"]);
});

test("dangling link in design-system gets rewritten instead of crashing", (t) => {
  const root = createFixture(t, "owb-dedupe-dangling-");
  const designSystem = join(root, "design-system");
  const workspace = join(root, "org-workbench", ".worktrees", "issue-y");
  writeDesignSystem(designSystem);
  writeWorkspace(workspace);
  removeFixturePath(root, join(designSystem, "node_modules", "react"));
  symlinkSync(join(root, "nowhere", "react"), join(designSystem, "node_modules", "react"),
    process.platform === "win32" ? "junction" : "dir");

  const result = runScript(workspace);
  assert.equal(result.status, 0, result.stderr);
  assertConverged(designSystem, workspace, ["react"]);
});

test("missing sibling packages are restored and reruns preserve the canonical copies", (t) => {
  const root = createFixture(t, "owb-dedupe-missing-");
  const designSystem = join(root, "design-system");
  const workspace = join(root, "org-workbench");
  writeDesignSystem(designSystem);
  writeWorkspace(workspace);
  const names = ["react", "react-dom"];
  for (const name of names) {
    removeFixturePath(root, join(designSystem, "node_modules", name));
    writeFileSync(join(workspace, "node_modules", name, "canonical.txt"), name);
  }

  const first = runScript(workspace);
  assert.equal(first.status, 0, first.stderr);
  assertConverged(designSystem, workspace, names);
  const second = runScript(workspace);
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stdout, / -> /, "idempotent rerun must not rewrite");
  assertConverged(designSystem, workspace, names);
  for (const name of names) {
    const canonical = join(workspace, "node_modules", name);
    assert.ok(lstatSync(canonical).isDirectory());
    assert.ok(!lstatSync(canonical).isSymbolicLink());
    assert.equal(readFileSync(join(canonical, "canonical.txt"), "utf8"), name);
  }
});

test("unexpected sibling lstat errors fail without deleting either package", (t) => {
  const root = createFixture(t, "owb-dedupe-lstat-");
  const designSystem = join(root, "design-system");
  const workspace = join(root, "org-workbench");
  writeDesignSystem(designSystem);
  writeWorkspace(workspace);
  const sibling = join(designSystem, "node_modules", "react");
  const preload = join(root, "deny-lstat.cjs");
  writeFileSync(preload, `const fs = require("node:fs");
const original = fs.lstatSync;
fs.lstatSync = function (target, ...args) {
  if (target === ${JSON.stringify(sibling)}) throw Object.assign(new Error("fixture lstat denied"), { code: "EACCES" });
  return original.call(this, target, ...args);
};
require("node:module").syncBuiltinESMExports();
`);
  const result = runScript(workspace, preload);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture lstat denied/);
  assert.ok(lstatSync(sibling).isDirectory());
  assert.ok(!lstatSync(sibling).isSymbolicLink());
  assert.equal(readFileSync(join(sibling, "index.js"), "utf8"), "module.exports = {};");
  assert.equal(readFileSync(join(workspace, "node_modules", "react", "index.js"), "utf8"), "module.exports = {};");
});

test("no design-system under any ancestor is an explicit no-op", (t) => {
  const root = createFixture(t, "owb-dedupe-absent-");
  const workspace = join(root, "lonely", "org-workbench");
  writeWorkspace(workspace);

  const result = runScript(workspace);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no design-system checkout found/);
  assert.doesNotMatch(result.stdout, / -> /);
});

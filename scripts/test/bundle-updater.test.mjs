import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { VENDOR_RELATIVE, bundleUpdater, bundledPackages, collectNotices } from "../bundle-updater.mjs";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function bundlePath() {
  return path.join(projectRoot, VENDOR_RELATIVE);
}

test("the manifest names the vendored bundle as one explicit entry", () => {
  const { RUNTIME_FILE_SETS } = require("../../apps/desktop/packaging/runtime-layout.cjs");
  const desktop = RUNTIME_FILE_SETS.find((set) => set.from === "apps/desktop");
  const relative = VENDOR_RELATIVE.replace("apps/desktop/", "");
  assert.ok(
    desktop.filter.includes(relative),
    `the manifest must name ${relative}; otherwise the packaged app fails at its require`,
  );

  // The point of bundling is that no third-party node_modules set is needed.
  const thirdParty = RUNTIME_FILE_SETS.filter((set) =>
    String(set.to).includes("node_modules") && !String(set.to).includes("@roleweave"));
  assert.deepEqual(thirdParty, [], "bundling exists so no third-party node_modules set is required");
});

test("the bundled dependency is not a production dependency", () => {
  // Bundling makes electron-updater a build-time input, and it has to be
  // declared as one. electron-builder includes the production dependency tree
  // from node_modules independently of the `files` sets -- those use the
  // from/to form, which appends rather than replacing the default patterns. With
  // electron-updater in `dependencies`, the staging verifier rejected
  // `node_modules/builder-util-runtime/out/CancellationToken.js.map` as a
  // forbidden packaged path: the bundle shipped and so did the tree it exists to
  // replace.
  const manifest = require("../../package.json");
  const production = Object.keys(manifest.dependencies ?? {});
  assert.deepEqual(
    production,
    [],
    `a production dependency drags its tree into the package regardless of the file sets: ${production.join(", ")}`,
  );
  assert.ok(
    "electron-updater" in (manifest.devDependencies ?? {}),
    "the bundler needs the package at build time, so it must still be declared",
  );
});

test("every bundled package's licence travels with its code", async () => {
  // MIT and ISC require their notice in all copies or substantial portions.
  // Bundling makes this one file such a copy, so shipping it without them would
  // be a licence violation, not an oversight. esbuild's legalComments does not
  // cover this: it preserves comments found in source, and these packages keep
  // their licence text in separate LICENSE files it never reads.
  const report = await bundleUpdater();
  const source = fs.readFileSync(bundlePath(), "utf8");

  const packages = bundledPackages(projectRoot);
  assert.ok(packages.length > 10, `expected a real closure, got ${packages.length}`);
  assert.equal(report.notices, packages.length, "every bundled package needs a section");

  for (const name of packages) {
    assert.match(
      source,
      new RegExp(`^ \\* ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@`, "m"),
      `${name} is bundled but its notice is absent`,
    );
  }

  // The notices must precede the code they cover, not trail it. esbuild's
  // prelude is the first thing that is not comment, so every notice has to sit
  // before it.
  const codeStarts = source.search(/^(?:"use strict";|var __)/m);
  assert.ok(codeStarts > 0, "expected to find where the bundled code begins");
  for (const name of packages) {
    const at = source.indexOf(` * ${name}@`);
    assert.ok(at >= 0 && at < codeStarts, `${name}'s notice must precede the bundled code`);
  }
});

test("a package with no licence file is recorded, not silently dropped", () => {
  const { sections, missing } = collectNotices(projectRoot, bundledPackages(projectRoot));
  assert.equal(sections.length, bundledPackages(projectRoot).length);
  // lazy-val publishes no licence file. Its declaration still has to appear, and
  // the gap has to be visible rather than passing as complete attribution.
  for (const name of missing) assert.match(name, /\(/, "a missing notice must record the declared licence");
});

test("the bundle is reproducible from the pinned dependency", async () => {
  const first = await bundleUpdater();
  const second = await bundleUpdater();
  assert.equal(first.sha256, second.sha256, "two runs must produce identical bytes");
  assert.equal(first.bytes, second.bytes);
  assert.ok(first.bytes > 0);
});

test("the bundle is self-contained: nothing but runtime-provided modules remain", async () => {
  await bundleUpdater();
  const source = fs.readFileSync(bundlePath(), "utf8");
  const provided = new Set([...builtinModules, "electron"]);

  const leftovers = new Set();
  for (const match of source.matchAll(/require\("([^".][^"]*)"\)/g)) {
    const specifier = match[1];
    if (specifier.startsWith(".")) continue;
    const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    if (!provided.has(bare)) leftovers.add(specifier);
  }
  assert.deepEqual(
    [...leftovers],
    [],
    "a leftover third-party require would fail in the packaged app, where node_modules is absent",
  );
});

test("bundling collapses the dependency tree the manifest would otherwise carry", async () => {
  // The reason this script exists. electron-updater declares eight direct
  // dependencies whose closure is sixteen packages; the manifest ships one file.
  const meta = require("../../node_modules/electron-updater/package.json");
  assert.ok(Object.keys(meta.dependencies).length >= 5, "expected a non-trivial dependency set");

  const report = await bundleUpdater();
  assert.equal(report.relative, VENDOR_RELATIVE);
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(bundlePath())).digest("hex"),
    report.sha256,
    "the reported digest must describe the file on disk",
  );
});

test("the bundle is generated, never committed", () => {
  const ignore = fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8");
  assert.match(ignore, /apps\/desktop\/src\/vendor/);

  const { CLEAN_RELATIVE_PATHS } = require("../clean-package-output.mjs");
  assert.ok(
    CLEAN_RELATIVE_PATHS.includes("apps/desktop/src/vendor"),
    "a stale bundle must be impossible: the package commands clean and regenerate it",
  );
});

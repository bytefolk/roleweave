import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function workflow() {
  return fs
    .readFileSync(path.join(projectRoot, ".github/workflows/release.yml"), "utf8")
    .replaceAll("\r\n", "\n");
}

test("write access is granted to exactly one job, and only to contents", () => {
  const source = workflow();
  // Default read, so a new job cannot inherit write by being added.
  assert.match(source, /^permissions:\n  contents: read$/m);

  const grants = [...source.matchAll(/^\s+permissions:\n\s+([a-z-]+): write$/gm)];
  assert.equal(grants.length, 1, "exactly one job may hold a write grant");
  assert.equal(grants[0][1], "contents");

  // The build legs run third-party-installed code; they must not be able to
  // publish, and the publish job must not be able to do anything else.
  assert.doesNotMatch(source, /packages: write|id-token: write|actions: write/);
});

test("free distribution mode never consumes Apple credentials", () => {
  const source = workflow();
  assert.match(source, /Declare free GitHub-signed update mode/);
  assert.doesNotMatch(source, /APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID|MACOS_CERTIFICATE/);
  assert.match(source, /OWB_UPDATE_SIGNING_PRIVATE_KEY/);
  assert.match(source, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test("a tag is refused unless it matches the packaged version", () => {
  const source = workflow();
  assert.match(source, /does not match the packaged version/);
  assert.match(source, /exit 1/);
});

test("an already-published release is refused rather than replaced", () => {
  const source = workflow();
  assert.match(source, /already published; bump the version instead/);
  // A draft may be replaced; a published release may not. Both branches must
  // exist, or the check collapses into one behaviour.
  assert.match(source, /true\)\s+echo "::warning::draft release/);
  assert.match(source, /false\)\s+echo "::error::release/);
});

test("update metadata is namespaced per leg and restored before publishing", () => {
  const source = workflow();
  // Without namespacing, both legs upload `latest.yml` and one silently wins.
  assert.match(source, /for file in latest\*\.yml/);
  assert.match(source, /--\$\{\{ matrix\.label \}\}\.yml/);
  // electron-updater looks for the original names, so the suffix has to come off.
  assert.match(source, /for file in latest\*--\*\.yml/);
  assert.ok(
    source.includes("sed -E 's/--[^.]+\\.yml$/.yml/'"),
    "the restore step must strip exactly the leg suffix, leaving the name electron-updater expects",
  );
});

test("a release publishes a free GitHub-signed macOS update channel without Apple membership", () => {
  const source = workflow();

  assert.match(source, /independent update signature/);
  assert.match(source, /latest-mac\.json/);
  assert.doesNotMatch(source, /mac_signed/);

  // Draft is unconditional at creation, not a flag that might be cleared. #187
  // moved publication into its own final step, so the release exists as a draft
  // before anything decides whether it may leave that state.
  const createStep = source.slice(source.indexOf("- name: Create the release as a draft"));
  assert.match(createStep.slice(0, createStep.indexOf("- name: Read back")), /^\s+--draft \\$/m);
  assert.match(
    createStep,
    /if \[ "\$\{\{ github\.event_name \}\}" = "push" \] \|\| \[ "\$\{\{ inputs\.draft \}\}" != "true" \]/,
    "tag pushes and explicit non-draft dispatches publish the install-only release",
  );

  // And the step that actually publishes runs only on that decision.
  assert.match(source, /- name: Publish the release\n\s+if: steps\.create\.outputs\.publish == 'true'/);
  // No other step may clear the draft.
  assert.equal([...source.matchAll(/--draft=false/g)].length, 1);
});

test("unsigned release mode is explicit and only uses the non-Apple update signing secret", () => {
  const source = workflow();
  assert.match(source, /Build unsigned macOS installers/);
  assert.doesNotMatch(source, /OWB_MAC_SIGNED_BUILD/);
  assert.doesNotMatch(source, /APPLE_APP_SPECIFIC_PASSWORD/);
  assert.match(source, /Sign macOS GitHub update manifest/);
});

test("release notes explain the unsigned Gatekeeper limitation and automatic update path", () => {
  const source = workflow();
  assert.match(source, /--notes "macOS artifacts are unsigned for Gatekeeper/);
  assert.match(source, /downloads updates in the background/);
  assert.match(source, /replaces the app on normal exit/);
});

test("the update feed is declared on the dist commands only, and agrees with package metadata", () => {
  const config = require("../../apps/desktop/electron-builder.config.cjs");
  // A provider in the shared config would make electron-builder write
  // app-update.yml into the staging resources, where the manifest asserts its
  // contents byte-exact against source. Staging must stay feed-free.
  assert.equal("publish" in config, false, "the shared config must not declare a feed");

  const { repository, scripts } = require("../../package.json");
  assert.ok(repository?.url, "package metadata must name the repository");
  const owner = /github\.com\/([^/]+)\/([^/.]+)/.exec(repository.url);
  assert.ok(owner, `unrecognised repository url: ${repository.url}`);

  for (const command of ["package:dist:macos", "package:dist:windows"]) {
    const value = scripts[command];
    assert.match(value, /-c\.publish\.provider=github/, `${command} must declare the feed`);
    assert.match(
      value,
      new RegExp(`-c\\.publish\\.owner=${owner[1]}\\b`),
      `${command} feed owner must agree with package metadata`,
    );
    assert.match(
      value,
      new RegExp(`-c\\.publish\\.repo=${owner[2]}\\b`),
      `${command} feed repo must agree with package metadata`,
    );
    // Declaring a feed is not authority to use it.
    assert.match(value, /--publish never/, `${command} must still refuse publish authority`);
  }

  for (const command of ["package:staging:macos", "package:staging:windows"]) {
    assert.doesNotMatch(scripts[command], /-c\.publish\./, `${command} must not declare a feed`);
  }
});

test("every build leg validates its asset set before anything is uploaded", () => {
  const source = workflow();
  const scripts = require("../../package.json").scripts;
  for (const command of ["verify:dist:macos", "verify:dist:windows"]) {
    assert.ok(scripts[command], `${command} must exist for the workflow to call it`);
    assert.match(source, new RegExp(command.replaceAll(":", "\\:")));
  }
  // The verify step has to precede the upload, or a bad asset set still ships.
  assert.ok(
    source.indexOf("Verify installer asset set") < source.indexOf("Upload release artifacts"),
    "asset-set validation must run before upload",
  );
});

// #187 / RELEASING.md Phase 4. Each of these was verified by hand for v0.1.0
// and gated by nothing; a hand proof does not run on the next release.
test("#187 a lightweight tag is refused before anything is built", () => {
  const source = workflow();
  const step = source.slice(source.indexOf("- name: Refuse a lightweight tag"));
  assert.match(step, /git cat-file -t "refs\/tags\/\$\{GITHUB_REF_NAME\}"/);
  assert.match(step, /!= "tag"/);
  assert.match(step, /must be annotated/);
  // Refusals belong in preflight: nothing may be built from a tag that cannot
  // be the release tag.
  const preflight = source.slice(source.indexOf("  preflight:"), source.indexOf("  build:"));
  assert.match(preflight, /- name: Refuse a lightweight tag/);
});

test("#187 a tag that is not reachable from main is refused before anything is built", () => {
  const source = workflow();
  const step = source.slice(source.indexOf("- name: Refuse a tag that is not reachable from main"));
  assert.match(step, /git merge-base --is-ancestor/);
  assert.match(step, /refs\/remotes\/origin\/main/);
  assert.match(step, /\^\{commit\}/);
  const preflight = source.slice(source.indexOf("  preflight:"), source.indexOf("  build:"));
  assert.match(preflight, /- name: Refuse a tag that is not reachable from main/);
  // Both checks need history the default shallow checkout does not fetch.
  assert.match(preflight, /fetch-depth: 0/);
});

test("#187 the asset inventory is read back, and publication is the last step", () => {
  const source = workflow();
  const readback = source.slice(
    source.indexOf("- name: Read back the asset inventory"),
    source.indexOf("- name: Publish the release"),
  );
  assert.ok(readback.length > 0, "the readback must sit before the publish step");
  // Read from the API, not from what the job believes it uploaded.
  assert.match(readback, /gh api "repos\/\$\{\{ github\.repository \}\}\/releases/);
  assert.match(readback, /reports no assets/);
  assert.match(readback, /does not match what was uploaded/);
  assert.match(readback, /select\(\.size == 0 or \.state != "uploaded" or \.digest == null\)/);

  // Publication last, in the literal ordering of the file.
  const steps = [...source.matchAll(/^      - name: (.+)$/gm)].map((match) => match[1]);
  assert.equal(steps[steps.length - 1], "Publish the release");
  assert.ok(
    steps.indexOf("Read back the asset inventory") > steps.indexOf("Create the release as a draft"),
  );
});

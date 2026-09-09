import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function walkFiles(root) {
  const result = [];
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relative);
      else if (entry.isFile()) result.push(relative);
    }
  };
  visit(root);
  return result.sort();
}

test("staging config is unpacked-only and cannot sign or publish", () => {
  const config = require("../../apps/desktop/electron-builder.config.cjs");
  const { RUNTIME_FILE_SETS } = require(
    "../../apps/desktop/packaging/runtime-layout.cjs",
  );

  assert.equal(config.appId, "org.fullstack-ai-infra.org-workbench");
  assert.equal(config.productName, "RoleWeave");
  for (const [platform, iconPath] of Object.entries({
    macos: config.mac.icon,
    windows: config.win.icon,
    linux: config.linux.icon,
  })) {
    assert.equal(path.isAbsolute(iconPath), true, `${platform} icon path must be absolute`);
    assert.equal(fs.existsSync(iconPath), true, `${platform} icon asset must exist: ${iconPath}`);
  }
  assert.equal(config.asar, false);
  assert.equal(config.electronDist, "node_modules/electron/dist");
  assert.equal(config.npmRebuild, false);
  assert.deepEqual(config.extraMetadata, {
    main: "apps/desktop/src/main.js",
  });
  assert.deepEqual(config.files, RUNTIME_FILE_SETS);
  assert.equal(config.mac.identity, null);
  assert.equal(config.win.signExecutable, false);
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.perMachine, false);
  assert.equal("allowToChangeInstallationDirectory" in config.nsis, false);
  assert.equal("target" in config.mac, false);
  assert.equal("target" in config.win, false);
  assert.equal("publish" in config, false);

  const oldCsc = process.env.CSC_LINK;
  const oldWinCsc = process.env.WIN_CSC_LINK;
  try {
    process.env.CSC_LINK = "file:///poison/should-not-be-read.p12";
    process.env.WIN_CSC_LINK = "file:///poison/should-not-be-read.p12";
    delete require.cache[require.resolve("../../apps/desktop/electron-builder.config.cjs")];
    const poisonedEnvironmentConfig = require("../../apps/desktop/electron-builder.config.cjs");
    assert.equal(poisonedEnvironmentConfig.win.signExecutable, false);
    assert.doesNotMatch(JSON.stringify(poisonedEnvironmentConfig), /poison|CSC_LINK/);
  } finally {
    if (oldCsc === undefined) delete process.env.CSC_LINK;
    else process.env.CSC_LINK = oldCsc;
    if (oldWinCsc === undefined) delete process.env.WIN_CSC_LINK;
    else process.env.WIN_CSC_LINK = oldWinCsc;
  }
});

test("runtime manifest is an explicit allowlist for every packaged consumer", () => {
  const {
    APP_RESOURCE_REQUIRED_ENTRIES,
    EXAMPLE_RUNTIME_FILES,
    isForbiddenRuntimePath,
    RUNTIME_FILE_SETS,
    SERVER_RUNTIME_FILES,
    SHARED_RUNTIME_FILES,
  } = require("../../apps/desktop/packaging/runtime-layout.cjs");
  const resources = new Set(APP_RESOURCE_REQUIRED_ENTRIES);

  for (const entry of [
    "package.json",
    "LICENSE",
    "apps/desktop/package.json",
    "apps/desktop/src/main.js",
    "apps/desktop/src/macos-login-path.cjs",
    "apps/desktop/src/preload.js",
    "apps/desktop/src/control-plane-lifecycle.cjs",
    "apps/desktop/src/control-plane-launch.cjs",
    "apps/desktop/src/packaged-behavior-smoke.cjs",
    "apps/desktop/src/packaged-smoke.cjs",
    "apps/desktop/dist/renderer/index.html",
    "apps/server/package.json",
    "apps/server/dist/src/index.js",
    "apps/server/dist/src/engine/process-environment.js",
    "apps/server/dist/src/stable-read.js",
    "apps/server/bin/qoder-engine.mjs",
    "apps/server/src/qoder-binary.js",
    "node_modules/@roleweave/shared/package.json",
    "node_modules/@roleweave/shared/dist/index.js",
    "examples/oss-maintainer/workspace.json",
  ]) {
    assert.equal(resources.has(entry), true, `missing runtime entry: ${entry}`);
  }

  const serialized = JSON.stringify(RUNTIME_FILE_SETS);
  for (const forbidden of [
    ".env",
    ".git",
    "**/node_modules",
    "apps/server/src/**/*",
    "apps/desktop/renderer/src",
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `runtime allowlist contains forbidden sweep: ${forbidden}`,
    );
  }
  assert.equal(
    RUNTIME_FILE_SETS.some((entry) => entry.from.includes("node_modules")),
    false,
  );
  assert.deepEqual(
    RUNTIME_FILE_SETS.flatMap(({ filter }) => filter).filter((entry) => entry.includes("*")),
    ["dist/renderer/**/*"],
    "only the clean generated renderer directory may use a packaging glob",
  );
  assert.equal(
    SERVER_RUNTIME_FILES.includes("dist/src/stable-read.js"),
    true,
    "stable bounded reads used by session and turn stores must be packaged explicitly",
  );

  const compiledServer = SERVER_RUNTIME_FILES
    .filter((entry) => entry.startsWith("dist/src/"))
    .map((entry) => entry.slice("dist/src/".length));
  assert.deepEqual(
    compiledServer,
    walkFiles(path.join(projectRoot, "apps/server/src"))
      .filter((entry) => /\.(?:js|ts)$/.test(entry))
      .map((entry) => entry.replace(/\.(?:js|ts)$/, ".js")),
    "compiled control-plane inventory must be updated explicitly when source modules change",
  );
  assert.deepEqual(
    SHARED_RUNTIME_FILES.filter((entry) => entry.startsWith("dist/"))
      .map((entry) => entry.slice("dist/".length)),
    walkFiles(path.join(projectRoot, "packages/shared/src"))
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => entry.replace(/\.ts$/, ".js")),
    "shared runtime inventory must be updated explicitly when source modules change",
  );
  assert.deepEqual(
    EXAMPLE_RUNTIME_FILES,
    walkFiles(path.join(projectRoot, "examples/oss-maintainer"))
      .filter((entry) => entry !== ".digital-employee" && !entry.startsWith(".digital-employee/")),
    "the packaged example must be an explicit file inventory",
  );
  for (const injected of [
    "apps/desktop/dist/renderer/.env.production",
    "apps/desktop/dist/renderer/assets/index.js.map",
    "apps/server/dist/src/routes/health.test.js",
    "examples/oss-maintainer/credentials.json",
    "node_modules/@roleweave/shared/private-key.pem",
    "scripts/package-helper.mjs",
  ]) {
    assert.equal(isForbiddenRuntimePath(injected), true, `denylist missed ${injected}`);
  }
  for (const allowed of APP_RESOURCE_REQUIRED_ENTRIES) {
    assert.equal(isForbiddenRuntimePath(allowed), false, `required entry is forbidden: ${allowed}`);
  }

  const { PLATFORM_LAYOUTS } = require("../../apps/desktop/packaging/runtime-layout.cjs");
  assert.deepEqual(PLATFORM_LAYOUTS.windows.bundleRequiredEntries, ["RoleWeave.exe"]);
  assert.equal(
    PLATFORM_LAYOUTS.windows.bundleRequiredEntries.some((entry) => /electron\.asar|default_app\.asar/.test(entry)),
    false,
    "Electron-internal asar names are not Workbench runtime contracts",
  );
});

test("root staging scripts clean, build, and request only native unpacked output", () => {
  const rootPackage = require("../../package.json");
  for (const platform of ["macos", "windows"]) {
    const packageCommand = rootPackage.scripts[`package:staging:${platform}`];
    assert.equal(typeof packageCommand, "string");
    assert.match(packageCommand, /clean:package:staging/);
    assert.match(packageCommand, /build:renderer/);
    assert.match(packageCommand, /prepare:electron:staging/);
    assert.match(packageCommand, /electron-builder/);
    assert.match(packageCommand, /--dir/);
    assert.match(packageCommand, /--publish never/);
    assert.doesNotMatch(packageCommand, /\b(?:dmg|zip|nsis|appx|msi)\b/i);
    assert.equal(
      rootPackage.scripts[`verify:package:${platform}`],
      `node scripts/verify-packaged-app.mjs ${platform}`,
    );
    assert.equal(
      rootPackage.scripts[`smoke:package:${platform}`],
      `node scripts/smoke-packaged-app.mjs ${platform}`,
    );
  }
  assert.match(rootPackage.scripts["package:staging:macos"], /--arm64/);
  assert.match(rootPackage.scripts["package:staging:windows"], /--x64/);
  assert.equal(
    rootPackage.scripts["prepare:electron:staging"],
    "node node_modules/electron/install.js",
  );
  assert.equal(
    rootPackage.scripts["prepare:electron:macos"],
    "npm run prepare:electron:staging",
  );
  assert.equal(
    rootPackage.scripts["package:macos:unsigned"],
    "npm run package:staging:macos && npm run verify:package:macos",
  );
  assert.equal(rootPackage.scripts["package:macos"], "npm run package:macos:unsigned");
  assert.equal(
    rootPackage.scripts["smoke:package:macos:behavior"],
    "node scripts/smoke-packaged-behavior.mjs",
  );
});

test("native staging jobs remain read-only and separate from required checks", () => {
  // Normalize line endings before matching. git checks this file out with CRLF on
  // Windows, and the assertions below anchor on `\n`; the required matrix now runs on
  // windows-latest, which is exactly how that mismatch surfaced.
  const workflow = fs
    .readFileSync(path.join(projectRoot, ".github/workflows/verify.yml"), "utf8")
    .replaceAll("\r\n", "\n");
  assert.match(workflow, /permissions:\n  contents: read/);
  // POSIX-only by decision, not by omission. A windows-latest leg was added and
  // reverted; see the rationale in the workflow. Windows is proved by the staging
  // job below, not by running a suite written against POSIX semantics.
  assert.match(workflow, /matrix:\n\s+os: \[ubuntu-latest, macos-14\]/);
  assert.match(workflow, /staging-macos-arm64:[\s\S]*?runs-on: macos-15/);
  assert.match(workflow, /staging-windows-x64:[\s\S]*?runs-on: windows-latest/);
  for (const command of [
    "package:staging:macos",
    "verify:package:macos",
    "smoke:package:macos",
    "smoke:package:macos:behavior",
    "package:staging:windows",
    "verify:package:windows",
    "smoke:package:windows",
  ]) {
    assert.match(workflow, new RegExp(`npm run ${command.replaceAll(":", "\\:")}`));
  }
  assert.doesNotMatch(workflow, /contents: write|pull_request_target|\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflow, /smoke:package:windows:behavior/);
});

test("a third-party runtime dependency is either packaged or not required", () => {
  // Scanning the generated vendor bundle is deliberate, not incidental: it is the
  // check that the bundle is self-contained. If esbuild ever left a third-party
  // require behind, the packaged app would fail at that require rather than here.
  //
  // The manifest maps only the workspace-local shared package into node_modules.
  // There is no third-party node_modules set, which is deliberate -- the packaged
  // tree is a boundary, and the layout comment forbids replacing these filters
  // with node_modules-wide globs. So a bare require in shipped desktop source is
  // a packaging claim, and it has to be backed by a file set that ships it.
  const { RUNTIME_FILE_SETS } = require("../../apps/desktop/packaging/runtime-layout.cjs");
  const shipped = new Set(
    RUNTIME_FILE_SETS.flatMap((set) => {
      const to = String(set.to);
      if (!to.includes("node_modules")) return [];
      const after = to.slice(to.indexOf("node_modules") + "node_modules/".length);
      return after.length > 0 ? [after] : [];
    }),
  );

  const desktop = RUNTIME_FILE_SETS.find((set) => set.from === "apps/desktop");
  // Node built-ins appear both bare and `node:`-prefixed -- esbuild output uses
  // the bare form. `electron` is provided by the runtime and never packaged.
  const runtimeProvided = new Set([...builtinModules, "electron"]);
  const unpackaged = [];

  const missing = [];
  for (const relative of desktop.filter.filter((file) => /^src\/.*\.(js|cjs)$/.test(file))) {
    const absolute = path.join(projectRoot, "apps", "desktop", relative);
    if (!fs.existsSync(absolute)) {
      // A manifest entry with no file is a packaging defect on its own -- the
      // build would ship an incomplete tree. Report it as that, rather than
      // failing with an unexplained ENOENT.
      missing.push(relative);
      continue;
    }
    const source = fs.readFileSync(absolute, "utf8");
    for (const match of source.matchAll(/require\("([^".][^"]*)"\)/g)) {
      const specifier = match[1];
      const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
      if (specifier.startsWith(".") || runtimeProvided.has(bare)) continue;
      const owner = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (!shipped.has(owner)) unpackaged.push(`${relative} requires ${specifier}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `the manifest names desktop sources that do not exist. Generated files need their build step to have run -- try \`npm run prepare:updater\`:\n  ${missing.join("\n  ")}`,
  );
  assert.deepEqual(
    unpackaged,
    [],
    `shipped desktop source requires packages the staging manifest does not ship:\n  ${unpackaged.join("\n  ")}`,
  );
});

test("installer jobs are additive and claim no signing or publish authority", () => {
  const workflow = fs
    .readFileSync(path.join(projectRoot, ".github/workflows/verify.yml"), "utf8")
    .replaceAll("\r\n", "\n");

  // Additive: the staging jobs keep their own commands. #132 adds artifacts, it
  // does not repurpose the lane that proves the unpacked tree.
  assert.match(workflow, /installers-macos-arm64:[\s\S]*?runs-on: macos-15/);
  assert.match(workflow, /installers-windows-x64:[\s\S]*?runs-on: windows-latest/);
  for (const command of ["package:dist:macos", "verify:dist:macos", "package:dist:windows", "verify:dist:windows"]) {
    assert.match(workflow, new RegExp(`npm run ${command.replaceAll(":", "\\:")}`));
  }
  for (const command of ["package:staging:macos", "smoke:package:windows"]) {
    assert.match(workflow, new RegExp(`npm run ${command.replaceAll(":", "\\:")}`));
  }

  // No release target may appear until its own slice. An installer is not a
  // release: producing an artifact and publishing it are separate authorities.
  assert.doesNotMatch(workflow, /--publish (?!never)/);
  assert.doesNotMatch(workflow, /softprops\/action-gh-release|gh release|actions\/upload-release/);
});

test("every package command refuses publish authority", () => {
  const scripts = require("../../package.json").scripts;
  const packaging = Object.entries(scripts).filter(([name]) => name.startsWith("package:"));
  assert.ok(packaging.length >= 4, "expected the staging and installer package commands");

  for (const [name, command] of packaging) {
    // A wrapper delegates to another package script rather than invoking the
    // builder itself, so the guarantee is inherited rather than restated.
    const delegates = /npm run package:/.test(command);
    const invokesBuilder = /electron-builder/.test(command);
    assert.equal(
      invokesBuilder ? command.includes("--publish never") : delegates,
      true,
      `${name} neither carries --publish never nor delegates to a command that does`,
    );
  }
});

test("every module the desktop entry requires is named in the runtime manifest", () => {
  // The compiled-inventory assertion above covers the control plane's dist tree, but
  // nothing tied the desktop allowlist to what `main.js` actually loads. main's drive
  // feature added `src/drive-ipc.cjs` and `main.js` requires it at module scope, so an
  // undeclared module here does not degrade a feature -- the packaged app fails to boot.
  const { RUNTIME_FILE_SETS } = require("../../apps/desktop/packaging/runtime-layout.cjs");
  const desktop = RUNTIME_FILE_SETS.find((set) => set.from === "apps/desktop");
  assert.ok(desktop, "runtime file sets must carry an apps/desktop entry");

  const entry = path.join(projectRoot, "apps", "desktop", "src", "main.js");
  const source = fs.readFileSync(entry, "utf8");
  const required = new Set(
    [...source.matchAll(/require\("\.\/([^"]+)"\)/g)].map((match) => `src/${match[1]}`),
  );
  assert.ok(required.size > 0, "found no relative requires in main.js — check the pattern");

  const undeclared = [...required].filter((file) => !desktop.filter.includes(file));
  assert.deepEqual(
    undeclared,
    [],
    `main.js requires modules the staging manifest does not ship: ${undeclared.join(", ")}`,
  );
});

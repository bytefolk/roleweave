import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  APP_RESOURCE_REQUIRED_ENTRIES,
  DESKTOP_RUNTIME_FILES,
  EXAMPLE_RUNTIME_FILES,
  SERVER_RUNTIME_FILES,
  SHARED_RUNTIME_FILES,
  isForbiddenRuntimePath,
  platformLayout,
} = require("../apps/desktop/packaging/runtime-layout.cjs");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "release", "staging");

function posix(relative) {
  return relative.split(path.sep).join("/");
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function inside(root, candidate) {
  const relation = path.relative(root, candidate);
  return relation.length === 0 || (
    relation !== ".." &&
    !relation.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relation)
  );
}

export function assertCanonicalDirectoryWithin(anchor, candidate, label = "directory") {
  const resolvedAnchor = path.resolve(anchor);
  const anchorStat = fs.lstatSync(resolvedAnchor);
  assert.equal(anchorStat.isSymbolicLink(), false, `${label} anchor must not be a symlink or junction`);
  assert.equal(anchorStat.isDirectory(), true, `${label} anchor must be a directory`);
  const realAnchor = fs.realpathSync(resolvedAnchor);
  assert.equal(samePath(realAnchor, resolvedAnchor), true, `${label} anchor must be canonical`);

  const resolvedCandidate = path.resolve(candidate);
  assert.equal(inside(realAnchor, resolvedCandidate), true, `${label} escapes its canonical anchor`);
  const relation = path.relative(realAnchor, resolvedCandidate);
  let current = realAnchor;
  for (const segment of relation === "" ? [] : relation.split(path.sep)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    assert.equal(stat.isSymbolicLink(), false, `${label} traverses a symlink or junction: ${current}`);
    assert.equal(stat.isDirectory(), true, `${label} path segment is not a directory: ${current}`);
    const realCurrent = fs.realpathSync(current);
    assert.equal(inside(realAnchor, realCurrent), true, `${label} resolves outside its anchor: ${current}`);
  }

  const finalAnchorStat = fs.lstatSync(realAnchor);
  assert.equal(
    sameFileIdentity(anchorStat, finalAnchorStat),
    true,
    `${label} anchor identity changed during validation`,
  );
  const realCandidate = fs.realpathSync(resolvedCandidate);
  assert.equal(samePath(realCandidate, resolvedCandidate), true, `${label} must be canonical`);
  return realCandidate;
}

function regularFileWithin(root, relative) {
  const parts = relative.split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    assert.equal(stat.isSymbolicLink(), false, `runtime entry must not traverse a symlink: ${current}`);
    if (index === parts.length - 1) {
      assert.equal(stat.isFile(), true, `runtime entry must be a regular file: ${current}`);
    } else {
      assert.equal(stat.isDirectory(), true, `runtime entry parent must be a directory: ${current}`);
    }
  }
  return current;
}

export function walkRegularFiles(root) {
  const rootStat = fs.lstatSync(root);
  assert.equal(rootStat.isSymbolicLink(), false, `runtime root must not be a symlink or junction: ${root}`);
  assert.equal(rootStat.isDirectory(), true, `runtime root must be a directory: ${root}`);
  const files = [];
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      const absolute = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `runtime tree must not contain symlinks: ${absolute}`);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) files.push(posix(relative));
      else throw new Error(`runtime tree contains a non-regular filesystem node: ${absolute}`);
    }
  };
  visit(root);
  const finalRootStat = fs.lstatSync(root);
  assert.equal(sameFileIdentity(rootStat, finalRootStat), true, "runtime root identity changed during traversal");
  return files.sort();
}

function expectedRootMetadata(sourceMetadata) {
  const expected = { ...sourceMetadata };
  delete expected.scripts;
  delete expected.devDependencies;
  expected.main = "apps/desktop/src/main.js";
  return expected;
}

function addSourceEntries(manifest, prefix, sourcePrefix, entries, sourceRoot) {
  for (const entry of entries) {
    manifest.set(`${prefix}/${posix(entry)}`, {
      kind: "byte-exact",
      source: path.join(sourceRoot, sourcePrefix, entry),
    });
  }
}

function assertAllowedRendererBuild(files) {
  for (const relative of files) {
    assert.match(
      relative,
      /^(?:index\.html|assets\/[A-Za-z0-9_-]+\.(?:css|js|png|woff2?))$/,
      `unexpected generated renderer entry: ${relative}`,
    );
  }
  assert.equal(files.includes("index.html"), true, "renderer build lacks index.html");
  assert.equal(files.some((entry) => entry.endsWith(".js")), true, "renderer build lacks JavaScript");
  assert.equal(files.some((entry) => entry.endsWith(".css")), true, "renderer build lacks CSS");
}

export function expectedResourceManifest(sourceRoot = projectRoot) {
  const sourceMetadata = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
  const manifest = new Map([
    ["LICENSE", { kind: "byte-exact", source: path.join(sourceRoot, "LICENSE") }],
    ["package.json", { kind: "root-package", expected: expectedRootMetadata(sourceMetadata) }],
  ]);
  addSourceEntries(
    manifest,
    "apps/desktop",
    "apps/desktop",
    DESKTOP_RUNTIME_FILES.filter((entry) => !entry.includes("*")),
    sourceRoot,
  );
  const rendererRoot = path.join(sourceRoot, "apps", "desktop", "dist", "renderer");
  const rendererFiles = walkRegularFiles(rendererRoot);
  assertAllowedRendererBuild(rendererFiles);
  addSourceEntries(
    manifest,
    "apps/desktop/dist/renderer",
    "apps/desktop/dist/renderer",
    rendererFiles,
    sourceRoot,
  );
  addSourceEntries(manifest, "apps/server", "apps/server", SERVER_RUNTIME_FILES, sourceRoot);
  addSourceEntries(
    manifest,
    "node_modules/@roleweave/shared",
    "packages/shared",
    SHARED_RUNTIME_FILES,
    sourceRoot,
  );
  addSourceEntries(
    manifest,
    "examples/oss-maintainer",
    "examples/oss-maintainer",
    EXAMPLE_RUNTIME_FILES,
    sourceRoot,
  );
  return manifest;
}

export function verifyResourceTree(resources, expectedManifest) {
  const packagedFiles = walkRegularFiles(resources);
  for (const relative of packagedFiles) {
    assert.equal(isForbiddenRuntimePath(relative), false, `forbidden packaged runtime path: ${relative}`);
  }
  assert.deepEqual(
    packagedFiles,
    [...expectedManifest.keys()].sort(),
    "packaged resources differ from the explicit runtime allowlist",
  );

  for (const [relative, expected] of expectedManifest) {
    const packaged = regularFileWithin(resources, relative);
    if (expected.kind === "root-package") {
      assert.deepEqual(
        JSON.parse(fs.readFileSync(packaged, "utf8")),
        expected.expected,
        "builder-rewritten root package metadata differs from the exact transform",
      );
      continue;
    }
    assert.equal(expected.kind, "byte-exact", `unknown runtime verification mode for ${relative}`);
    const actualBytes = fs.readFileSync(packaged);
    const sourceBytes = fs.readFileSync(expected.source);
    assert.equal(
      actualBytes.equals(sourceBytes),
      true,
      `packaged runtime bytes differ from source/build input: ${relative}`,
    );
  }
  return packagedFiles;
}

export function validateResourceCandidate({ sourceRoot, outputRoot, candidate, resources, manifest }) {
  const canonicalOutput = assertCanonicalDirectoryWithin(sourceRoot, outputRoot, "staging output");
  const canonicalCandidate = assertCanonicalDirectoryWithin(canonicalOutput, candidate, "staging candidate");
  const canonicalResources = assertCanonicalDirectoryWithin(canonicalCandidate, resources, "app resources");
  const packagedFiles = verifyResourceTree(canonicalResources, manifest);
  return { candidate: canonicalCandidate, resources: canonicalResources, packagedFiles };
}

function discoverCandidate(platform, canonicalOutputRoot) {
  const found = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`staging output contains a linked directory: ${entry.name}`);
      if (!entry.isDirectory()) continue;
      const absolute = path.join(directory, entry.name);
      if (platform === "macos" && entry.name === "RoleWeave.app") {
        found.push(absolute);
      } else if (
        platform === "windows" &&
        entry.name === "win-unpacked" &&
        fs.existsSync(path.join(absolute, "RoleWeave.exe"))
      ) {
        found.push(absolute);
      } else {
        visit(absolute);
      }
    }
  };
  visit(canonicalOutputRoot);
  assert.equal(found.length, 1, `expected exactly one ${platform} staging candidate, found ${found.length}`);
  return found[0];
}

function plistValue(plist, key) {
  return execFileSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], {
    encoding: "utf8",
  }).trim();
}

export function classifyMacSignature({ verification, details, codeResourcesExists }) {
  assert.equal(verification.error ?? null, null, "codesign strict verification could not be executed");
  assert.equal(details.error ?? null, null, "codesign signature inspection could not be executed");
  assert.equal(verification.signal ?? null, null, "codesign strict verification was terminated");
  assert.equal(details.signal ?? null, null, "codesign signature inspection was terminated");
  assert.equal(details.status, 0, details.stderr || "codesign signature inspection failed");
  assert.equal(verification.status, 1, "unsealed staging app must fail strict codesign verification with status 1");
  assert.match(
    verification.stderr ?? "",
    /code has no resources but signature indicates they must be present\s*$/,
    "strict codesign failure was not the expected unsealed linker-signature result",
  );
  const output = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
  assert.match(output, /CodeDirectory[^\n]*\(adhoc,linker-signed\)/);
  assert.match(output, /^Signature=adhoc$/m);
  assert.match(output, /^TeamIdentifier=not set$/m);
  assert.match(output, /^Sealed Resources=none$/m);
  assert.doesNotMatch(output, /^Authority=/m, "staging executable unexpectedly has a signing authority");
  assert.equal(codeResourcesExists, false, "staging app unexpectedly contains CodeResources");
  return "unsealed-linker-adhoc";
}

export const WINDOWS_SIGNATURE_TARGET_ENV = "VERIFY_SIGNATURE_TARGET";

/**
 * Builds the Authenticode inspection call. The target path travels through the
 * environment rather than argv: with `-Command`, PowerShell appends trailing argv
 * entries to the script text instead of binding them to a `param()` block, so an
 * inline path is parsed as source and breaks on the first space — and the packaged
 * executable is named "RoleWeave.exe".
 */
export function windowsSignatureInspection(executable, baseEnv = process.env) {
  // CI runs this step under pwsh 7, which exports its own PSModulePath. Inheriting it
  // leaves Windows PowerShell without its system module directory, so the built-in
  // Microsoft.PowerShell.Security module fails to autoload and the cmdlet resolves to
  // nothing. Pin the one directory the cmdlet actually needs.
  const systemRoot = baseEnv.SystemRoot ?? baseEnv.SYSTEMROOT ?? "C:\\Windows";
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-AuthenticodeSignature -LiteralPath $env:${WINDOWS_SIGNATURE_TARGET_ENV}).Status.ToString()`,
    ],
    env: {
      ...baseEnv,
      PSModulePath: path.win32.join(systemRoot, "system32", "WindowsPowerShell", "v1.0", "Modules"),
      [WINDOWS_SIGNATURE_TARGET_ENV]: executable,
    },
  };
}

function assertNoProductSignature(platform, appPath, executable) {
  if (platform === "macos") {
    const verification = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], {
      encoding: "utf8",
    });
    const details = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", executable], {
      encoding: "utf8",
    });
    return classifyMacSignature({
      verification,
      details,
      codeResourcesExists: fs.existsSync(path.join(appPath, "Contents", "_CodeSignature", "CodeResources")),
    });
  }

  const { command, args, env } = windowsSignatureInspection(executable);
  const inspection = spawnSync(command, args, { encoding: "utf8", windowsHide: true, env });
  assert.equal(inspection.error ?? null, null, "Authenticode inspection could not be executed");
  assert.equal(inspection.status, 0, inspection.stderr || "Authenticode inspection failed");
  assert.equal(inspection.stdout.trim(), "NotSigned", "staging executable unexpectedly carries Authenticode");
  return "authenticode-not-signed";
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function nativeArchitecture(platform, executable) {
  if (platform === "macos") {
    const architecture = execFileSync("/usr/bin/lipo", ["-archs", executable], {
      encoding: "utf8",
    }).trim();
    assert.equal(architecture, "arm64", `Lane A macOS staging expects native arm64, got ${architecture}`);
    return architecture;
  }
  const bytes = fs.readFileSync(executable);
  assert.equal(bytes.subarray(0, 2).toString("ascii"), "MZ", "Windows executable lacks DOS header");
  const peOffset = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.subarray(peOffset, peOffset + 4).toString("binary"), "PE\0\0", "Windows executable lacks PE header");
  const machine = bytes.readUInt16LE(peOffset + 4);
  assert.equal(machine, 0x8664, `Lane A Windows staging expects native x64 PE, got 0x${machine.toString(16)}`);
  return "x64";
}

export function verifyPackagedApp(platform, candidate) {
  const expectedHost = platform === "macos" ? "darwin" : platform === "windows" ? "win32" : null;
  assert.notEqual(expectedHost, null, `unsupported staging platform: ${platform}`);
  assert.equal(process.platform, expectedHost, `${platform} staging verification must run on its native host`);

  const canonicalOutput = assertCanonicalDirectoryWithin(projectRoot, outputRoot, "staging output");
  const layout = platformLayout(platform);
  const candidatePath = path.resolve(candidate ?? discoverCandidate(platform, canonicalOutput));
  const resourcesPath = path.join(candidatePath, layout.resourcesRelative);
  const validated = validateResourceCandidate({
    sourceRoot: projectRoot,
    outputRoot: canonicalOutput,
    candidate: candidatePath,
    resources: resourcesPath,
    manifest: expectedResourceManifest(projectRoot),
  });
  const appPath = validated.candidate;
  const resources = validated.resources;
  const packagedFiles = validated.packagedFiles;

  for (const relative of layout.bundleRequiredEntries) regularFileWithin(appPath, relative);
  for (const relative of APP_RESOURCE_REQUIRED_ENTRIES) regularFileWithin(resources, relative);

  const sourceMetadata = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const packagedMetadata = JSON.parse(fs.readFileSync(path.join(resources, "package.json"), "utf8"));
  assert.deepEqual(packagedMetadata, expectedRootMetadata(sourceMetadata));
  assert.equal(fs.existsSync(path.join(resources, "node_modules", "electron-builder")), false);

  const executable = path.join(appPath, layout.executableRelative);
  const signature = assertNoProductSignature(platform, appPath, executable);
  const architecture = nativeArchitecture(platform, executable);
  if (platform === "macos") {
    const plist = path.join(appPath, "Contents", "Info.plist");
    assert.equal(plistValue(plist, "CFBundleIdentifier"), "org.fullstack-ai-infra.org-workbench");
    assert.equal(plistValue(plist, "CFBundleExecutable"), "RoleWeave");
    assert.equal(plistValue(plist, "CFBundleShortVersionString"), sourceMetadata.version);
  }

  return {
    schemaVersion: "org-workbench-staging-manifest.v1",
    ok: true,
    platform,
    artifact: posix(path.relative(projectRoot, appPath)),
    version: sourceMetadata.version,
    architecture,
    unsigned: true,
    signature,
    requiredEntries: APP_RESOURCE_REQUIRED_ENTRIES.length + layout.bundleRequiredEntries.length,
    packagedFiles: packagedFiles.length,
    mainSha256: sha256(path.join(resources, "apps", "desktop", "src", "main.js")),
    rendererSha256: sha256(path.join(resources, "apps", "desktop", "dist", "renderer", "index.html")),
    serverSha256: sha256(path.join(resources, "apps", "server", "dist", "src", "index.js")),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = verifyPackagedApp(process.argv[2], process.argv[3]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

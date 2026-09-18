import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  choosePlatform,
  chooseSurface,
  detectPlatform,
  isMobileUserAgent,
  liveOrgSnapshot,
  loadWorkspaceSnapshot,
  previewOrgSnapshot,
  resolvePublicAsset,
} from "../../deploy/mobile-surface.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const productDir = path.resolve(here, "../..");
const deployDir = path.join(productDir, "deploy");
const noVncDir = path.join(deployDir, "node_modules", "@novnc", "novnc");
const exampleDir = path.join(productDir, "examples", "oss-maintainer");

test("splits phone platforms: iOS, Android, HarmonyOS", () => {
  assert.equal(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), "ios");
  assert.equal(detectPlatform("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"), "ios");
  assert.equal(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile"), "android");
  assert.equal(detectPlatform("Mozilla/5.0 (Linux; Android 12; HUAWEI) AppleWebKit/537.36 Mobile"), "android");
  assert.equal(detectPlatform("Mozilla/5.0 (Linux; Android 12; HarmonyOS) AppleWebKit/537.36 Mobile"), "harmony");
  assert.equal(detectPlatform("Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 ArkWeb/5.0.0.0"), "harmony");
  assert.equal(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "desktop");
});

test("platform query overrides user agent", () => {
  assert.equal(choosePlatform({ userAgent: "iPhone", searchParams: new URLSearchParams("platform=android") }), "android");
  assert.equal(choosePlatform({ userAgent: "Macintosh", searchParams: new URLSearchParams("platform=harmony") }), "harmony");
  assert.equal(choosePlatform({ userAgent: "iPhone", searchParams: new URLSearchParams("surface=desktop") }), "desktop");
});

test("classifies phone and ASteam app user agents as mobile", () => {
  assert.equal(isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), true);
  assert.equal(isMobileUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile"), true);
  assert.equal(isMobileUserAgent("Mozilla/5.0 ASteamApp/0.15"), true);
  assert.equal(isMobileUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), false);
  assert.equal(isMobileUserAgent(""), false);
  assert.equal(isMobileUserAgent(undefined), false);
});

test("surface query overrides user agent", () => {
  assert.equal(chooseSurface({ userAgent: "iPhone", searchParams: new URLSearchParams("surface=desktop") }), "desktop");
  assert.equal(chooseSurface({ userAgent: "Macintosh", searchParams: new URLSearchParams("surface=mobile") }), "mobile");
  assert.equal(chooseSurface({ userAgent: "iPhone", searchParams: new URLSearchParams() }), "mobile");
  assert.equal(chooseSurface({ userAgent: "Macintosh", searchParams: new URLSearchParams() }), "desktop");
});

test("phone home serves the matching platform shell instead of the VNC page", () => {
  const ios = resolvePublicAsset("/", {
    deployDir,
    noVncDir,
    userAgent: "Mozilla/5.0 (iPhone)",
    searchParams: new URLSearchParams(),
  });
  const android = resolvePublicAsset("/", {
    deployDir,
    noVncDir,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile",
    searchParams: new URLSearchParams(),
  });
  const harmony = resolvePublicAsset("/", {
    deployDir,
    noVncDir,
    userAgent: "Mozilla/5.0 (Phone; OpenHarmony 5.0) ArkWeb/5.0.0.0",
    searchParams: new URLSearchParams(),
  });
  const desktop = resolvePublicAsset("/", {
    deployDir,
    noVncDir,
    userAgent: "Mozilla/5.0 (Macintosh)",
    searchParams: new URLSearchParams(),
  });
  assert.equal(ios, path.join(deployDir, "mobile", "ios", "index.html"));
  assert.equal(android, path.join(deployDir, "mobile", "android", "index.html"));
  assert.equal(harmony, path.join(deployDir, "mobile", "harmony", "index.html"));
  assert.equal(desktop, path.join(deployDir, "index.html"));
});

test("explicit desktop and platform paths stay available", () => {
  assert.equal(
    resolvePublicAsset("/desktop", { deployDir, noVncDir, userAgent: "iPhone", searchParams: new URLSearchParams() }),
    path.join(deployDir, "index.html"),
  );
  assert.equal(
    resolvePublicAsset("/ios/app.css", { deployDir, noVncDir, userAgent: "Macintosh", searchParams: new URLSearchParams() }),
    path.join(deployDir, "mobile", "ios", "app.css"),
  );
  assert.equal(
    resolvePublicAsset("/android/app.mjs", { deployDir, noVncDir, userAgent: "iPhone", searchParams: new URLSearchParams() }),
    path.join(deployDir, "mobile", "android", "app.mjs"),
  );
  assert.equal(
    resolvePublicAsset("/harmony", { deployDir, noVncDir, userAgent: "iPhone", searchParams: new URLSearchParams() }),
    path.join(deployDir, "mobile", "harmony", "index.html"),
  );
});

test("workspace snapshot lists oss-maintainer roles without leaking host paths", () => {
  const snapshot = loadWorkspaceSnapshot(exampleDir);
  assert.equal(snapshot.name, "oss-maintainer");
  assert.equal(snapshot.owner, "repo-owner");
  const ids = snapshot.roles.map((role) => role.id);
  assert.deepEqual(ids.sort(), ["community-operator", "issue-researcher", "release-engineer", "repo-owner"]);
  const owner = snapshot.roles.find((role) => role.id === "repo-owner");
  assert.equal(owner.name, "仓库负责人");
  assert.match(owner.skillExcerpt, /路线图/);
  assert.equal(owner.reportTo, null);
  assert.equal(typeof owner.budget.perTask.tokens, "number");
  assert.equal(JSON.stringify(snapshot).includes("/workspace/positions"), false);
});

test("live snapshot refuses to embed the workspace path", () => {
  const snapshot = loadWorkspaceSnapshot(exampleDir);
  const live = liveOrgSnapshot(snapshot, exampleDir);
  assert.equal(live.source, "live");
  assert.equal(JSON.stringify(live).includes(exampleDir), false);
  assert.throws(() => liveOrgSnapshot({ name: exampleDir, roles: [] }, exampleDir), /snapshot_leaks_path/);
  assert.equal(previewOrgSnapshot(snapshot).source, "preview");
});

test("snapshot refuses a directory that is not a workspace", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "roleweave-mobile-"));
  try {
    assert.throws(() => loadWorkspaceSnapshot(root), /workspace/);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  choosePlatform,
  detectPlatform,
  loadWorkspaceSnapshot,
  resolvePublicAsset,
} from "../../apps/mobile-web/surface.mjs";

const productDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exampleDir = path.join(productDir, "examples", "oss-maintainer");

test("splits phone platforms: iOS, Android, HarmonyOS", () => {
  assert.equal(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), "ios");
  assert.equal(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile"), "android");
  assert.equal(detectPlatform("Mozilla/5.0 (Linux; Android 12; HarmonyOS) Mobile"), "harmony");
  assert.equal(detectPlatform("Mozilla/5.0 (Phone; OpenHarmony 5.0) ArkWeb/5.0.0.0"), "harmony");
  assert.equal(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "desktop");
});

test("platform query overrides user agent", () => {
  assert.equal(choosePlatform({ userAgent: "iPhone", searchParams: new URLSearchParams("platform=android") }), "android");
  assert.equal(choosePlatform({ userAgent: "iPhone", searchParams: new URLSearchParams("surface=desktop") }), "desktop");
});

test("desktop surface falls through instead of serving the mobile shell", () => {
  const asset = resolvePublicAsset("/", {
    webDir: path.join(productDir, "apps", "mobile-web"),
    userAgent: "iPhone",
    searchParams: new URLSearchParams("surface=desktop"),
  });
  assert.equal(asset, null);
});

test("workspace snapshot lists oss-maintainer roles without leaking host paths", () => {
  const snapshot = loadWorkspaceSnapshot(exampleDir);
  assert.equal(snapshot.name, "oss-maintainer");
  const ids = snapshot.roles.map((role) => role.id).sort();
  assert.deepEqual(ids, ["community-operator", "issue-researcher", "release-engineer", "repo-owner"]);
  assert.equal(JSON.stringify(snapshot).includes("/workspace/positions"), false);
});

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
    server.on("error", reject);
  });
}

test("each phone UA receives its own shell", async (t) => {
  const port = await unusedPort();
  const child = spawn(process.execPath, [path.join(productDir, "scripts", "mobile-web.mjs")], {
    cwd: productDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server did not start")), 8000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`exited ${code}`));
    });
  });
  const ios = await (await fetch(`http://127.0.0.1:${port}/`, { headers: { "user-agent": "Mozilla/5.0 (iPhone) Mobile" } })).text();
  const android = await (await fetch(`http://127.0.0.1:${port}/`, { headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14) Mobile" } })).text();
  const harmony = await (await fetch(`http://127.0.0.1:${port}/`, { headers: { "user-agent": "Mozilla/5.0 (Phone; OpenHarmony 5.0) ArkWeb/5.0.0.0" } })).text();
  assert.match(ios, /data-platform="ios"/);
  assert.match(android, /data-platform="android"/);
  assert.match(harmony, /data-platform="harmony"/);
});

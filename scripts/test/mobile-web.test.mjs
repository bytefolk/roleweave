import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  chooseSurface,
  isMobileUserAgent,
  loadWorkspaceSnapshot,
  resolvePublicAsset,
} from "../../apps/mobile-web/surface.mjs";

const productDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exampleDir = path.join(productDir, "examples", "oss-maintainer");

test("classifies phone and ASteam app user agents as mobile", () => {
  assert.equal(isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), true);
  assert.equal(isMobileUserAgent("Mozilla/5.0 ASteamApp/0.15"), true);
  assert.equal(isMobileUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), false);
});

test("surface query overrides user agent", () => {
  assert.equal(chooseSurface({ userAgent: "iPhone", searchParams: new URLSearchParams("surface=desktop") }), "desktop");
  assert.equal(chooseSurface({ userAgent: "Macintosh", searchParams: new URLSearchParams("surface=mobile") }), "mobile");
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

test("phone user agents receive the mobile shell", async (t) => {
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
  const phone = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { "user-agent": "Mozilla/5.0 (iPhone) Mobile" },
  });
  const html = await phone.text();
  assert.equal(phone.status, 200);
  assert.match(html, /data-surface="mobile"/);
  const workspace = await fetch(`http://127.0.0.1:${port}/api/mobile/workspace`);
  assert.equal(workspace.status, 200);
  const body = await workspace.json();
  assert.equal(body.roles.length, 4);
});

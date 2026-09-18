import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const productDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function startWebServer(t) {
  const port = await unusedPort();
  const vncPort = await unusedPort();
  const child = spawn(process.execPath, [path.join(productDir, "deploy", "web-server.mjs"), String(port), String(vncPort)], {
    cwd: productDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill("SIGTERM");
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("web server did not start")), 8000);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (chunk.includes("Error")) {
        clearTimeout(timeout);
        reject(new Error(chunk));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`web server exited ${code}`));
    });
  });
  return port;
}

async function request(port, pathname, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
  const text = await response.text();
  return { status: response.status, text, type: response.headers.get("content-type") };
}

test("phone user agents receive the matching platform shell at /", async (t) => {
  const port = await startWebServer(t);
  const ios = await request(port, "/", { "user-agent": "Mozilla/5.0 (iPhone) Mobile" });
  assert.equal(ios.status, 200);
  assert.match(ios.text, /data-platform="ios"/);
  assert.doesNotMatch(ios.text, /正在连接 RoleWeave/);

  const android = await request(port, "/", { "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile" });
  assert.equal(android.status, 200);
  assert.match(android.text, /data-platform="android"/);

  const harmony = await request(port, "/", { "user-agent": "Mozilla/5.0 (Phone; OpenHarmony 5.0) ArkWeb/5.0.0.0" });
  assert.equal(harmony.status, 200);
  assert.match(harmony.text, /data-platform="harmony"/);

  const desktop = await request(port, "/", { "user-agent": "Mozilla/5.0 (Macintosh)" });
  assert.equal(desktop.status, 200);
  assert.match(desktop.text, /正在连接 RoleWeave/);
});

test("phone-link status is discoverable without a host token", async (t) => {
  const port = await startWebServer(t);
  const response = await request(port, "/phone-link/v1/status");
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.schema, "phone-link.v1");
  assert.equal(body.hostOnline, false);
});

test("mobile workspace API returns the example org", async (t) => {
  const port = await startWebServer(t);
  const response = await request(port, "/api/mobile/workspace");
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.name, "oss-maintainer");
  assert.equal(body.source, "preview");
  assert.equal(body.roles.length, 4);
  assert.equal(body.roles.some((role) => role.id === "repo-owner"), true);
});

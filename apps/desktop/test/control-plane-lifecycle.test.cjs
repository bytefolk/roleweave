const assert = require("node:assert/strict");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  isControlPlaneAlive,
  parseReadyLine,
  startControlPlaneProcess,
  stopControlPlaneProcess,
} = require("../src/control-plane-lifecycle.cjs");

const token = "a".repeat(64);
const readyLine = `org-workbench-server ready ${JSON.stringify({ api: "v0", port: 43123, token })}\n`;
// Keep fixture data out of executable source; argv is passed without a shell.
const readyChildScript = `
if (process.argv[2] === "ignore-term") process.on("SIGTERM", () => {});
process.stdout.write(process.argv[1]);
setInterval(() => {}, 1000);
`;

test("READY fixture treats code-shaped arguments as literal data", async (t) => {
  const payload = "\"); process.exit(42); // </script>\n'`\\\u2028\u2029";
  const child = spawn(process.execPath, ["-e", readyChildScript, payload], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const closed = once(child, "close");
  t.after(async () => {
    child.kill("SIGKILL");
    await closed;
  });
  const [output] = await once(child.stdout, "data");
  assert.equal(output.toString(), payload);
  assert.equal(isControlPlaneAlive(child), true);
});

test("READY parsing is strict and keeps only the v0 control-plane contract", () => {
  assert.deepEqual(parseReadyLine(readyLine), { api: "v0", port: 43123, token });
  assert.equal(parseReadyLine("diagnostic output"), null);
  for (const payload of [
    { api: "v1", port: 43123, token },
    { api: "v0", port: 0, token },
    { api: "v0", port: 43123, token: "short" },
    { api: "v0", port: 43123, token, extra: true },
  ]) {
    assert.throws(
      () => parseReadyLine(`org-workbench-server ready ${JSON.stringify(payload)}`),
      (error) => error.code === "control_plane_ready_invalid",
    );
  }
});

test("control-plane lifecycle starts from READY and stops idempotently", async () => {
  const child = spawn(process.execPath, ["-e", readyChildScript, readyLine], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const handle = await startControlPlaneProcess({ createChild: () => child, readyTimeoutMs: 1000 });
  assert.equal(handle.state, "ready");
  assert.equal(handle.port, 43123);
  assert.equal(isControlPlaneAlive(child), true);
  const [first, second] = await Promise.all([
    stopControlPlaneProcess(handle, { termTimeoutMs: 500 }),
    stopControlPlaneProcess(handle, { termTimeoutMs: 500 }),
  ]);
  assert.deepEqual(second, first);
  assert.equal(first.state, "stopped");
  assert.equal(isControlPlaneAlive(child), false);
});

test("READY timeout terminates a child that never announces readiness", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await assert.rejects(
    startControlPlaneProcess({ createChild: () => child, readyTimeoutMs: 30 }),
    (error) => error.code === "control_plane_ready_timeout",
  );
  await once(child, "close");
  assert.equal(isControlPlaneAlive(child), false);
});

test("stop escalates to SIGKILL when the control plane ignores SIGTERM", async () => {
  const child = spawn(process.execPath, ["-e", readyChildScript, readyLine, "ignore-term"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const handle = await startControlPlaneProcess({ createChild: () => child, readyTimeoutMs: 1000 });
  const stopped = await stopControlPlaneProcess(handle, { termTimeoutMs: 30 });
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.forced, true);
  assert.equal(isControlPlaneAlive(child), false);
});

test("a real server completes READY → health → stop and releases its port", async (t) => {
  const serverEntry = path.join(__dirname, "..", "..", "server", "dist", "src", "index.js");
  assert.equal(fs.existsSync(serverEntry), true, "build the server before running the desktop lifecycle E2E");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-lifecycle-"));
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: home,
      ORG_WORKBENCH_SERVER_PORT: "0",
      // Pin every local version probe, not just the engine. Inheriting PATH
      // otherwise probes the developer's real Claude install under an empty
      // HOME, making this lifecycle test depend on that CLI's startup time.
      ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI: process.execPath,
      DIGITAL_EMPLOYEE_CLAUDE_COMMAND: process.execPath,
      DIGITAL_EMPLOYEE_QODER_COMMAND: process.execPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let handle;
  // Register cleanup before waiting for READY or /health. A failed assertion
  // must stop the child as well, otherwise node --test can hang indefinitely.
  t.after(async () => {
    try {
      await stopControlPlaneProcess(handle ?? { child }, { termTimeoutMs: 1000 });
      await closed;
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  child.stderr.resume();
  handle = await startControlPlaneProcess({ createChild: () => child, readyTimeoutMs: 3000 });
  assert.equal(handle.api, "v0");
  const response = await new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: handle.port, path: "/health" }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    request.setTimeout(2000, () => request.destroy(new Error("health request timed out")));
    request.on("error", reject);
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.api, "v0");
  assert.equal(response.body.hosts["claude-local"].configured, false, "Node's version cannot qualify as a Claude Host");

  const stopped = await stopControlPlaneProcess(handle, { termTimeoutMs: 1000 });
  assert.equal(stopped.state, "stopped");
  assert.equal(isControlPlaneAlive(child), false);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port: handle.port, path: "/health" }, resolve);
      request.on("error", reject);
    }),
  );
});

// Manual E3 qualification: the real CLI and bundled adapter talk to a local
// simulated provider. This does not authenticate a real provider account.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkbuddyExecutable } from "../apps/server/src/workbuddy-binary.js";
import { probeWorkbuddyExecutable } from "../apps/server/src/workbuddy-runtime.js";

const require = createRequire(import.meta.url);
const { terminateNativeProcessTree, waitForNoResidualProcesses } = require("../apps/desktop/packaging/process-tree.cjs");
const ADAPTER = fileURLToPath(new URL("../apps/server/bin/qoder-engine.mjs", import.meta.url));
const OUTPUT = "WORKBUDDY_LOOPBACK_OK";
const MODEL = "offline-model";

function verify(condition, code) {
  if (!condition) throw new Error(`verification.${code}`);
}

export async function verifyWorkbuddyCli(command, { timeoutMs = 45000 } = {}) {
  verify(process.platform !== "win32", "platform_not_verified");
  verify(typeof command === "string" && command.trim().length > 0, "command_required");
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "roleweave-cli-verifier-"));
  let child, timeout, forceTimeout;
  let stdout = "", outputLimited = false, timedOut = false;
  const requests = [];
  let requestFailure;
  const server = http.createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        verify(Buffer.byteLength(raw) <= 1024 * 1024, "request_limit");
      }
      verify(request.method === "POST" && request.url === "/chat/completions", "unexpected_endpoint");
      const body = JSON.parse(raw);
      // OpenAI-compatible requests may omit tools when none are exposed.
      // Reject every present value except an empty array; the adapter also
      // independently requires the CLI init tools/MCP arrays to be empty.
      const toolsPresent = Object.hasOwn(body, "tools");
      verify(!toolsPresent || (Array.isArray(body.tools) && body.tools.length === 0), "provider_tools_not_empty");
      verify(body.model === MODEL && body.stream === true, "provider_request_mismatch");
      requests.push({ model: body.model, toolsField: toolsPresent ? "empty-array" : "omitted" });
      verify(requests.length === 1, "unexpected_model_retry");
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const delta of [{ role: "assistant", content: "" }, { content: OUTPUT }, {}]) {
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl_loopback", object: "chat.completion.chunk", created: 1, model: MODEL,
          choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : "stop" }],
        })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      requestFailure = error;
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":{"message":"verification failed"}}');
      child?.kill("SIGTERM");
    }
  });
  try {
    const workspace = path.join(root, "workspace"), home = path.join(root, "home"), temp = path.join(root, "tmp");
    for (const directory of [workspace, home, temp]) await fs.mkdir(directory, { mode: 0o700 });
    // Only runtime discovery information is inherited. The sole credential is
    // a synthetic fixture key and the adapter owns its private settings/home.
    const env = {
      PATH: [path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin"].join(path.delimiter),
      HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp,
      LANG: "en_US.UTF-8", NO_PROXY: "*",
      DIGITAL_EMPLOYEE_ENGINE_MODEL: "workbuddy", DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND: command,
      CODEBUDDY_API_KEY: "synthetic-loopback-only", CODEBUDDY_MODEL: MODEL,
    };
    const executable = resolveWorkbuddyExecutable(env);
    verify(executable !== null, "binary_unresolved");
    const probe = probeWorkbuddyExecutable(executable, env);
    verify(probe.ready === true, "version_not_supported");
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    env.CODEBUDDY_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    child = spawn(process.execPath, [ADAPTER, "turn", "run", workspace, "--position", "verifier", "--stdin"], {
      cwd: workspace, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(stdout) + chunk.length > 1024 * 1024) {
        outputLimited = true;
        child.kill("SIGTERM");
      } else stdout += chunk;
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ input: `Return exactly ${OUTPUT}.` }));
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimeout = setTimeout(() => child.kill("SIGKILL"), 1500);
    }, timeoutMs);
    const [exitCode] = await closed;
    clearTimeout(timeout);
    clearTimeout(forceTimeout);
    if (requestFailure) throw requestFailure;
    verify(!timedOut, "timeout");
    verify(!outputLimited, "output_limit");
    verify(exitCode === 0, "adapter_exit");
    const events = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const failures = events.filter((event) => event.type === "run.failed");
    if (failures.length) {
      const code = failures[0].error?.code;
      throw new Error(typeof code === "string" && /^workbuddy\.[a-z_]+$/.test(code) ? code : "verification.adapter_failed");
    }
    const completed = events.filter((event) => event.type === "run.completed");
    const deltas = events.filter((event) => event.type === "model.delta");
    verify(completed.length === 1 && completed[0].output === OUTPUT, "terminal_mismatch");
    verify(deltas.map((event) => event.text).join("") === OUTPUT, "delta_mismatch");
    verify(requests.length === 1, "model_request_missing");
    await waitForNoResidualProcesses(root, [], { timeoutMs: 3000, processGroup: child.pid });
    return { ok: true, evidence: "E3 real CLI with simulated loopback provider", version: probe.version, modelRequests: 1, modelVisibleTools: 0, providerToolsField: requests[0].toolsField, deltaFrames: deltas.length, terminalEvents: 1, residualProcesses: 0 };
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceTimeout);
    try {
      if (child?.pid) await terminateNativeProcessTree(null, root, { originPid: child.pid, processGroup: child.pid });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(root, { force: true, recursive: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node scripts/verify-workbuddy-cli.mjs --command <CLI-path>\nAlternatively set DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND. Runs the bundled adapter against a simulated loopback provider; no real account qualification.");
  } else {
    try {
      assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--command"));
      console.log(JSON.stringify(await verifyWorkbuddyCli(args[1] ?? process.env.DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND), null, 2));
    } catch (error) {
      console.error(JSON.stringify({ ok: false, code: /^(?:verification|workbuddy)\.[a-z_]+$/.test(error?.message) ? error.message : "verification.failed" }));
      process.exitCode = 1;
    }
  }
}

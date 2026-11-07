import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { openAICompatibleConfiguration } from "../src/codex-binary.js";
import { employeeModelConfig } from "../src/model-selection.js";
import { hostHealth } from "../src/routes/health.js";

const provider = {
  OPENAI_API_KEY: "fixture-provider-key",
  OPENAI_BASE_URL: "https://relay.example.com/v1",
  OPENAI_MODEL: "provider/model-1",
};

test("OpenAI-compatible configuration requires one bounded, safe provider trio", () => {
  assert.deepEqual(openAICompatibleConfiguration(provider), {
    ready: true,
    apiKey: "fixture-provider-key",
    baseUrl: "https://relay.example.com/v1",
    model: "provider/model-1",
  });
  assert.equal(openAICompatibleConfiguration({ ...provider, OPENAI_API_KEY: " bad key " }).code, "openai.api_key_invalid");
  assert.equal(openAICompatibleConfiguration({ ...provider, OPENAI_BASE_URL: "http://relay.example.com/v1" }).code, "openai.base_url_invalid");
  assert.equal(openAICompatibleConfiguration({ ...provider, OPENAI_BASE_URL: "https://relay.example.com/v1?tenant=secret" }).code, "openai.base_url_invalid");
  assert.equal(openAICompatibleConfiguration({ ...provider, OPENAI_MODEL: undefined }).code, "openai.model_missing");
  assert.equal(openAICompatibleConfiguration({ ...provider, OPENAI_MODEL: "--inject" }).code, "openai.model_invalid");
  assert.equal(
    openAICompatibleConfiguration({ ...provider, OPENAI_BASE_URL: "http://127.0.0.1:4321/v1/" }).baseUrl,
    "http://127.0.0.1:4321/v1",
  );
});

test("OpenAI-compatible health depends on the bundled engine and the complete trio", () => {
  const ready = hostHealth({ engineAvailable: true, bundledElectronEngine: true, env: provider })["openai-compatible"];
  assert.equal(ready.configured, true);
  assert.equal(ready.ready, true);
  assert.equal(ready.model, "provider/model-1");

  const external = hostHealth({ engineAvailable: true, bundledElectronEngine: false, env: provider })["openai-compatible"];
  assert.equal(external.configured, true);
  assert.equal(external.ready, false);
  assert.match(external.nextStep ?? "", /bundled qoder-engine/);

  for (const env of [
    { ...provider, OPENAI_API_KEY: undefined },
    { ...provider, OPENAI_BASE_URL: undefined },
    { ...provider, OPENAI_MODEL: undefined },
    { ...provider, OPENAI_BASE_URL: "https://user:secret@relay.example/v1" },
  ]) {
    const health = hostHealth({ engineAvailable: true, bundledElectronEngine: true, env })["openai-compatible"];
    assert.equal(health.configured, false);
    assert.equal(health.ready, false);
  }
});

test("OpenAI-compatible model connection uses the same fail-closed trio", async () => {
  const valid = await employeeModelConfig("openai-compatible", undefined, true, provider);
  assert.equal(valid.connection?.status, "configured");
  assert.equal(valid.options[0]?.resolvedModel, "provider/model-1");

  for (const env of [
    { ...provider, OPENAI_MODEL: undefined },
    { ...provider, OPENAI_BASE_URL: "https://relay.example/v1#fragment" },
  ]) {
    const invalid = await employeeModelConfig("openai-compatible", undefined, true, env);
    assert.equal(invalid.connection?.status, "invalid");
  }
});

test("OpenAI-compatible bundled engine streams SSE without exposing provider error bodies", async (t) => {
  let mode: "ok" | "error" = "ok";
  let request: { url?: string; authorization?: string; body?: string } = {};
  const server = createServer((incoming, response) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk) => { body += chunk; });
    incoming.on("end", () => {
      request = { url: incoming.url, authorization: incoming.headers.authorization, body };
      if (mode === "error") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end('{"error":"provider-secret-must-not-escape"}');
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        'data: {"choices":[{"delta":{"content":"hello "}}]}',
        'data: {"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const adapter = fileURLToPath(new URL("../../bin/qoder-engine.mjs", import.meta.url));
  const run = () => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [adapter, "turn", "run", "/tmp", "--position", "repo-owner", "--stdin"], {
      env: { ...process.env, DIGITAL_EMPLOYEE_ENGINE_MODEL: "openai-compatible", OPENAI_API_KEY: "fixture-provider-key", OPENAI_BASE_URL: baseUrl, OPENAI_MODEL: "provider/model-1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", () => resolve({ stdout, stderr }));
    child.stdin.end(JSON.stringify({ input: "hello" }));
  });

  const success = await run();
  assert.match(success.stdout, /"type":"run.completed"/);
  assert.match(success.stdout, /"output":"hello world"/);
  assert.equal(request.url, "/v1/chat/completions");
  assert.equal(request.authorization, "Bearer fixture-provider-key");
  assert.equal(JSON.parse(request.body ?? "{}").model, "provider/model-1");

  mode = "error";
  const failure = await run();
  assert.match(failure.stdout, /"code":"openai.http_401"/);
  assert.doesNotMatch(failure.stdout, /provider-secret-must-not-escape|model\.delta/);
  assert.doesNotMatch(failure.stderr, /provider-secret-must-not-escape/);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { employeeModelConfig } from "../src/model-selection.js";
import { applyLocalProviderHealth, hostHealth } from "../src/routes/health.js";

async function localHome(run: (home: string, env: NodeJS.ProcessEnv) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-provider-integration-"));
  try {
    await fs.mkdir(path.join(home, ".claude"));
    await fs.mkdir(path.join(home, ".qoder"));
    await run(home, { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), QODER_CONFIG_DIR: path.join(home, ".qoder") });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}

test("local Claude keeps the gateway model default and exposes no credentials", async () => {
  await localHome(async (home, env) => {
    await fs.writeFile(path.join(home, ".claude/settings.json"), JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: "test-private-token", ANTHROPIC_BASE_URL: "http://127.0.0.1:18999/private-route", ANTHROPIC_MODEL: "gateway-balanced", ANTHROPIC_DEFAULT_HAIKU_MODEL: "gateway-small" },
      hooks: { Stop: [{ command: "do-not-run" }] },
    }));
    const config = await employeeModelConfig("claude-local", undefined, true, env);
    assert.equal(config.selected, "provider-default");
    assert.equal(config.recommended, "provider-default");
    assert.equal(config.source, "local-config");
    assert.equal(config.connection?.kind, "gateway");
    assert.equal(config.connection?.endpointHost, "127.0.0.1");
    assert.equal(config.connection?.billing, "provider");
    assert.equal(config.options.find((m) => m.id === "provider-default")?.resolvedModel, "gateway-balanced");
    assert.equal(config.options.find((m) => m.id === "haiku")?.resolvedModel, "gateway-small");
    assert.doesNotMatch(JSON.stringify(config), /test-private-token|private-route|do-not-run|AUTH_TOKEN/);
    const base = hostHealth({ engineAvailable: true, engineVersion: "qoder-engine 1.0.0", bundledElectronEngine: true, env,
      claudeLocal: { installed: true, supported: true, version: "2.1.263" } });
    const hosts = applyLocalProviderHealth(base, env);
    assert.equal(hosts["claude-local"].ready, true);
    assert.equal(hosts["claude-local"].connection?.endpointHost, "127.0.0.1");
    assert.doesNotMatch(JSON.stringify(hosts), /test-private-token|private-route|do-not-run/);
  });
});

test("invalid local gateway fails closed in both health and employee config", async () => {
  await localHome(async (home, env) => {
    await fs.writeFile(path.join(home, ".claude/settings.json"), '{"env":{"ANTHROPIC_AUTH_TOKEN":"never-disclose-this",');
    const config = await employeeModelConfig("claude-local", undefined, true, env);
    assert.equal(config.connection?.status, "invalid");
    assert.doesNotMatch(JSON.stringify(config), /never-disclose-this/);
    const base = hostHealth({ engineAvailable: true, bundledElectronEngine: true, env,
      claudeLocal: { installed: true, supported: true, version: "2.1.263" } });
    const hosts = applyLocalProviderHealth(base, env);
    assert.equal(hosts["claude-local"].ready, false);
    assert.equal(hosts["claude-local"].connection?.status, "invalid");
    assert.doesNotMatch(JSON.stringify(hosts), /never-disclose-this/);
    assert.equal((await employeeModelConfig("claude-local", undefined, false, env)).connection, undefined);
  });
});

test("Qoder default does not silently pin efficient and unknown Custom IDs stay explicit", async () => {
  await localHome(async (_home, env) => {
    const config = await employeeModelConfig("qoder", undefined, true, env);
    assert.equal(config.selected, "provider-default");
    assert.equal(config.allowCustomModel, true);
    const explicit = await employeeModelConfig("qoder", "efficient", true, env);
    assert.equal(explicit.selected, "efficient");
    const custom = await employeeModelConfig("qoder", "my-provider/registered-model", true, env);
    assert.equal(custom.selected, "my-provider/registered-model");
    assert.equal(custom.options.find((model) => model.id === custom.selected)?.billing, "unknown");
    assert.equal(custom.connection?.billing, "unknown");
  });
});

test("bundled Claude service preflight accepts Bearer credentials", () => {
  const state = hostHealth({ engineAvailable: true, engineVersion: "qoder-engine 1.0.0", bundledElectronEngine: true,
    env: { ANTHROPIC_AUTH_TOKEN: "test-bearer" }, claudeLocal: { installed: true, supported: true, version: "2.1.263" } });
  assert.equal(state["claude-code"].configured, true);
  assert.equal(state["claude-code"].ready, true);
  assert.doesNotMatch(JSON.stringify(state), /test-bearer/);
});

test("credential-bearing URL queries are rejected without echoing their value", async () => {
  await localHome(async (_home, env) => {
    const config = await employeeModelConfig("claude-code", undefined, true, {
      ...env, ANTHROPIC_AUTH_TOKEN: "fixture-provider-token", ANTHROPIC_BASE_URL: "https://gateway.example/api?key=fixture-query-private",
    });
    assert.equal(config.connection?.status, "invalid");
    assert.doesNotMatch(JSON.stringify(config), /fixture-query-private|fixture-provider-token/);
  });
});

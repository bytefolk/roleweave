import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalProviderConfigError, resolveClaudeProviderConfig, resolveQoderProviderConfig } from "../src/local-provider-config.js";

// All credential-shaped values below are generated test placeholders, never copied from a user's config.
const fakeCredential = () => `unit-test-placeholder-${Math.random().toString(36).slice(2)}`;

function fixture(t: { after: (fn: () => void) => void }, name: string, settings?: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "roleweave-provider-test-"));
  const config = path.join(dir, name);
  mkdirSync(config);
  if (settings !== undefined) writeFileSync(path.join(config, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, config, file: path.join(config, "settings.json") };
}

function rejectsConfig(fn: () => unknown, secrets: string[] = []) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof LocalProviderConfigError);
    assert.equal(error.code, "local_provider_config_invalid");
    for (const secret of secrets) assert.ok(!error.message.includes(secret));
    return true;
  });
}

test("Claude inherits only connection/model fields, with settings.env above shell", (t) => {
  const localToken = fakeCredential();
  const shellToken = fakeCredential();
  const f = fixture(t, ".claude", {
    env: {
      ANTHROPIC_AUTH_TOKEN: localToken, ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:23456/private-api",
      ANTHROPIC_MODEL: "economical-model", ANTHROPIC_DEFAULT_HAIKU_MODEL: "economical-model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "balanced-model", ANTHROPIC_DEFAULT_OPUS_MODEL: "large-model",
      NODE_OPTIONS: "--require /untrusted", CLAUDE_CODE_OAUTH_TOKEN: fakeCredential(),
    },
    model: "ignored-settings-default", hooks: { fake: "never execute" },
    apiKeyHelper: "never execute", mcpServers: { unsafe: { command: "never execute" } },
  });
  const result = resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config, ANTHROPIC_AUTH_TOKEN: shellToken, ANTHROPIC_API_KEY: shellToken, ANTHROPIC_MODEL: "shell-model" });
  assert.equal(result.providerEnv.ANTHROPIC_AUTH_TOKEN, localToken);
  assert.equal(result.providerEnv.ANTHROPIC_API_KEY, "");
  assert.equal(result.selectedDefault, "economical-model");
  assert.deepEqual(result.providerSettings, {});
  assert.equal(result.providerEnv.NODE_OPTIONS, undefined);
  assert.equal(result.providerEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual(result.connection, { source: "local-config", kind: "gateway", endpointHost: "127.0.0.1", billing: "provider", status: "configured" });
  assert.equal(result.models.find((model) => model.id === "haiku")?.resolvedModel, "economical-model");
  const publicValue = JSON.stringify({ models: result.models, connection: result.connection });
  for (const privateValue of [localToken, shellToken, "23456", "private-api", "tenant=private"]) assert.ok(!publicValue.includes(privateValue));
});

test("Claude service uses explicit environment and never reads local settings", (t) => {
  const f = fixture(t, ".claude");
  writeFileSync(f.file, "not JSON including credential-shaped content");
  const key = fakeCredential();
  const result = resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config, ANTHROPIC_API_KEY: key, ANTHROPIC_MODEL: "service-model" }, { local: false });
  assert.equal(result.providerEnv.ANTHROPIC_API_KEY, key);
  assert.equal(result.selectedDefault, "service-model");
  assert.equal(result.connection.source, "environment");
  assert.equal(result.connection.billing, "provider");
});

test("Claude no provider config keeps official login and resolves HOME user settings", (t) => {
  const f = fixture(t, ".claude", { model: "sonnet" });
  const result = resolveClaudeProviderConfig({ HOME: f.dir });
  assert.equal(result.selectedDefault, "sonnet");
  assert.equal(result.connection.kind, "official");
  assert.equal(result.connection.billing, "subscription");
  assert.deepEqual(result.providerEnv, {});
});

test("missing settings is not an authentication failure", (t) => {
  const f = fixture(t, ".claude");
  assert.equal(resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }).connection.source, "official");
  assert.equal(resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config }).connection.billing, "qoder");
});

test("a BASE_URL alone cannot receive inherited official OAuth", (t) => {
  const f = fixture(t, ".claude", { env: { ANTHROPIC_BASE_URL: "https://gateway.example/private" } });
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config, CLAUDE_CODE_OAUTH_TOKEN: fakeCredential() }));
  rejectsConfig(() => resolveClaudeProviderConfig({ ANTHROPIC_BASE_URL: "https://gateway.example" }, { local: false }));
});

test("empty user credentials override shell credentials and fail closed for a gateway", (t) => {
  const f = fixture(t, ".claude", { env: { ANTHROPIC_BASE_URL: "https://gateway.example", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" } });
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config, ANTHROPIC_API_KEY: fakeCredential() }));
});

test("malformed and oversized settings fail closed without echoing raw content", (t) => {
  const f = fixture(t, ".claude");
  const token = fakeCredential();
  writeFileSync(f.file, `{ "env": { "ANTHROPIC_AUTH_TOKEN": "${token}" `);
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }), [token]);
  writeFileSync(f.file, " ".repeat(1024 * 1024 + 1));
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }));
  writeFileSync(f.file, "[]");
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }));
});

test("non-file or symlink settings cannot silently fall back to official", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t, ".claude");
  symlinkSync(path.join(f.dir, "nonexistent"), f.file);
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }));
  rmSync(f.file);
  mkdirSync(f.file);
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }));
});

test("unsafe URLs, non-string secrets, and invalid model names are rejected", (t) => {
  const f = fixture(t, ".claude");
  const token = fakeCredential();
  for (const base of ["ftp://gateway.example", `https://user:${token}@gateway.example`, "not a URL", "https://gateway.example/#private", `https://gateway.example/?api_key=${token}`]) {
    writeFileSync(f.file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: token } }));
    rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }), [token]);
  }
  writeFileSync(f.file, JSON.stringify({ env: { ANTHROPIC_API_KEY: 123 } }));
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }));
  writeFileSync(f.file, JSON.stringify({ model: "--injected flag" }));
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }));
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: "relative/path" }));
});

test("Claude custom model and small-fast aliases are visible without executable config", (t) => {
  const f = fixture(t, ".claude", { env: { ANTHROPIC_CUSTOM_MODEL_OPTION: "provider/custom", ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "自定义模型", ANTHROPIC_SMALL_FAST_MODEL: "small-model" }, commands: { fake: "ignored" } });
  const result = resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config });
  assert.equal(result.models.find((model) => model.id === "provider/custom")?.name, "自定义模型");
  assert.equal(result.models.find((model) => model.id === "small-model")?.tier, "default");
});

test("Qoder providers preserve protocol/model parameters but never hooks or MCP", (t) => {
  const token = fakeCredential();
  const f = fixture(t, ".qoder", {
    providers: {
      gateway: { protocol: "openai-responses", type: "openai-compatible", authType: "bearer", baseUrl: "https://gateway.example/private", apiKey: token, model: "cheap", displayName: "我的中转", models: [{ model: "cheap", displayName: "轻量模型", contextWindow: 64000, maxOutputTokens: 8000, maxTokensField: "max_completion_tokens", capabilities: { tools: true, vision: false }, unknownExecutable: "ignored" }], routing: { main: "cheap", compact: "cheap" }, hooks: "ignored" },
    },
    model: { name: "gateway/cheap", systemPrompt: "ignored" }, hooks: { fake: "ignored" }, mcpServers: { fake: "ignored" }, env: { NODE_OPTIONS: "ignored" },
  });
  const result = resolveQoderProviderConfig({ HOME: f.dir });
  assert.equal(result.selectedDefault, "gateway/cheap");
  assert.equal(result.providerSettings.providers.gateway.apiKey, token);
  assert.equal(result.providerSettings.providers.gateway.protocol, "openai-responses");
  assert.equal(result.providerSettings.providers.gateway.models[0].contextWindow, 64000);
  assert.deepEqual(Object.keys(result.providerSettings).sort(), ["model", "providers"]);
  assert.deepEqual(result.providerSettings.model, { name: "gateway/cheap" });
  assert.equal(result.providerSettings.providers.gateway.hooks, undefined);
  assert.equal(result.providerSettings.providers.gateway.models[0].unknownExecutable, undefined);
  assert.equal(result.models[0]?.id, "gateway/cheap");
  assert.equal(result.models[0]?.resolvedModel, "cheap");
  assert.equal(result.models[0]?.endpointHost, "gateway.example");
  assert.equal(result.connection.billing, "provider");
  assert.equal(result.connection.endpointHost, "gateway.example");
  const publicValue = JSON.stringify({ models: result.models, connection: result.connection });
  for (const privateValue of [token, "private", "hidden", "https:"]) assert.ok(!publicValue.includes(privateValue));
});

test("Qoder selected provider determines connection while default stays unchanged", (t) => {
  const f = fixture(t, ".qoder", { providers: {
    first: { protocol: "openai", baseUrl: "https://first.example", apiKey: fakeCredential(), model: "model-one" },
    second: { protocol: "anthropic", baseUrl: "https://second.example", apiKey: fakeCredential(), model: "model-two", anthropic: { version: "2023-06-01", betas: ["feature-2025-01-01"], cache: { mode: "auto", ttl: "5m" }, queryParams: { tenant: "internal" } } },
  }, model: { name: "first/model-one" } });
  const result = resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config }, { model: "second/model-two" });
  assert.equal(result.selectedDefault, "first/model-one");
  assert.equal(result.connection.endpointHost, "second.example");
  assert.equal(result.providerSettings.providers.second.anthropic.cache.ttl, "5m");
  const unknown = resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config }, { model: "uid-registered-custom-model" });
  assert.equal(unknown.connection.billing, "unknown");
  assert.equal(unknown.connection.endpointHost, undefined);
  assert.equal(unknown.selectedDefault, "first/model-one");
});

test("Qoder legacy custom models retain registered selector and API protocol", (t) => {
  const token = fakeCredential();
  const f = fixture(t, ".qoder", { modelConfigs: { customModels: [{ provider: "gateway", model: "custom-model", apiKey: token, baseURL: "https://legacy.example/v1", format: "anthropic", key: "registered-uid-model", displayName: "自定义", isVl: true, isReasoning: false, maxInputTokens: 32000, mcpServers: "ignored" }] }, model: { name: "registered-uid-model" } });
  const result = resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config });
  assert.equal(result.providerSettings.modelConfigs.customModels[0].apiKey, token);
  assert.equal(result.providerSettings.modelConfigs.customModels[0].format, "anthropic");
  assert.equal(result.providerSettings.modelConfigs.customModels[0].mcpServers, undefined);
  assert.equal(result.models[0]?.id, "registered-uid-model");
  assert.equal(result.connection.endpointHost, "legacy.example");
  assert.ok(!JSON.stringify(result.models).includes(token));
});

test("Qoder UID-backed selection is retained without reading credential storage or guessing billing", (t) => {
  const f = fixture(t, ".qoder", { model: { name: "opaque-uid-model" }, modelConfigs: { unrelatedEncryptedField: fakeCredential() } });
  writeFileSync(path.join(f.config, "credentials.json"), "not JSON; must not read");
  const result = resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config, QODER_MODEL: "ignored-in-qoder-1.1" });
  assert.equal(result.selectedDefault, "opaque-uid-model");
  assert.deepEqual(result.providerSettings, { model: { name: "opaque-uid-model" } });
  assert.equal(result.models[0]?.id, "opaque-uid-model");
  assert.equal(result.connection.billing, "unknown");
  assert.equal(result.connection.source, "local-config");
  assert.equal(result.providerEnv.QODER_MODEL, undefined);
});

test("Qoder invalid provider/auth/protocol fails closed with no credential excerpts", (t) => {
  const token = fakeCredential();
  const f = fixture(t, ".qoder");
  for (const provider of [
    { protocol: "openai", baseUrl: "https://gateway.example" },
    { protocol: "unsupported", baseUrl: "https://gateway.example", apiKey: token },
    { protocol: "anthropic", baseUrl: `https://user:${token}@gateway.example`, apiKey: token },
    { baseUrl: "https://gateway.example", apiKey: token },
  ]) {
    writeFileSync(f.file, JSON.stringify({ providers: { gateway: provider }, model: { name: "gateway/model" } }));
    rejectsConfig(() => resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config }), [token]);
  }
});

test("Qoder built-in tiers stay Qoder billed and model lists do not implicitly select gateways", (t) => {
  const f = fixture(t, ".qoder", { providers: { gateway: { protocol: "openai", baseUrl: "https://gateway.example", apiKey: fakeCredential(), model: "cheap" } }, model: { name: "efficient" } });
  const result = resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config });
  assert.equal(result.connection.billing, "qoder");
  assert.equal(result.connection.endpointHost, undefined);
  assert.equal(result.selectedDefault, "efficient");
  assert.equal(result.models.find((model) => model.id === "gateway/cheap")?.billing, "provider");
});

test("Qoder duplicated selectors cannot silently change provider", (t) => {
  const f = fixture(t, ".qoder", { providers: { gateway: { protocol: "openai", baseUrl: "https://first.example", apiKey: fakeCredential(), model: "model" } }, modelConfigs: { customModels: [{ provider: "other", model: "model", key: "gateway/model", baseURL: "https://second.example", apiKey: fakeCredential() }] } });
  rejectsConfig(() => resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config }));
});

test("Claude authentication fields are selected atomically, never mixed between settings and shell", (t) => {
  const localToken = fakeCredential();
  const shellKey = fakeCredential();
  const f = fixture(t, ".claude", { env: { ANTHROPIC_AUTH_TOKEN: localToken, ANTHROPIC_BASE_URL: "https://local-gateway.example" } });
  const env = { CLAUDE_CONFIG_DIR: f.config, ANTHROPIC_API_KEY: shellKey, ANTHROPIC_BASE_URL: "https://shell-gateway.example", ANTHROPIC_CUSTOM_HEADERS: `Authorization: Bearer ${shellKey}` };
  const result = resolveClaudeProviderConfig(env);
  assert.equal(result.providerEnv.ANTHROPIC_AUTH_TOKEN, localToken);
  assert.equal(result.providerEnv.ANTHROPIC_API_KEY, "");
  assert.equal(result.providerEnv.ANTHROPIC_CUSTOM_HEADERS, "");
  assert.equal(result.connection.endpointHost, "local-gateway.example");
  writeFileSync(f.file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://local-gateway.example" } }));
  rejectsConfig(() => resolveClaudeProviderConfig(env));
  writeFileSync(f.file, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: localToken } }));
  rejectsConfig(() => resolveClaudeProviderConfig(env));
  const official = resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config, ANTHROPIC_API_KEY: shellKey });
  assert.equal(official.providerEnv.ANTHROPIC_API_KEY, "");
  assert.equal(official.connection.kind, "official");
});

test("Claude custom request headers are internal and cannot replace an explicit credential", (t) => {
  const token = fakeCredential();
  const headers = `X-Tenant: private-tenant\nAuthorization: Bearer ${token}`;
  const f = fixture(t, ".claude", { env: { ANTHROPIC_API_KEY: token, ANTHROPIC_BASE_URL: "https://gateway.example", ANTHROPIC_CUSTOM_HEADERS: headers } });
  const result = resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config });
  assert.equal(result.providerEnv.ANTHROPIC_CUSTOM_HEADERS, headers);
  assert.ok(!JSON.stringify({ connection: result.connection, models: result.models }).includes(token));
  writeFileSync(f.file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example", ANTHROPIC_CUSTOM_HEADERS: headers } }));
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }));
  rejectsConfig(() => resolveClaudeProviderConfig({ ANTHROPIC_CUSTOM_HEADERS: "not a header" }, { local: false }));
});

test("Claude custom headers cannot opt into the official OAuth connection by themselves", (t) => {
  const token = fakeCredential();
  const headers = `Authorization: Bearer ${token}`;
  const f = fixture(t, ".claude", { env: { ANTHROPIC_CUSTOM_HEADERS: headers } });
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }), [token]);
  rejectsConfig(() => resolveClaudeProviderConfig({ ANTHROPIC_CUSTOM_HEADERS: headers, ANTHROPIC_API_KEY: token }, { local: false }), [token]);
  rejectsConfig(() => resolveClaudeProviderConfig({ ANTHROPIC_CUSTOM_HEADERS: headers, ANTHROPIC_BASE_URL: "https://gateway.example" }, { local: false }), [token]);
});

test("Claude helper-only authentication is reported as unsupported, never executed or changed to OAuth", (t) => {
  const f = fixture(t, ".claude", { apiKeyHelper: "this-command-must-never-run" });
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }));
  assert.equal(resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config, ANTHROPIC_API_KEY: fakeCredential() }).connection.billing, "provider");
});

test("mapped and gateway aliases do not claim a cost tier", (t) => {
  const f = fixture(t, ".claude", { env: { ANTHROPIC_API_KEY: fakeCredential(), ANTHROPIC_BASE_URL: "https://gateway.example", ANTHROPIC_DEFAULT_HAIKU_MODEL: "unknown-priced-model" } });
  assert.ok(resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }).models.every((model) => model.tier === "default"));
});

test("remote HTTP endpoints fail closed but loopback HTTP is allowed", (t) => {
  const f = fixture(t, ".claude", { env: { ANTHROPIC_API_KEY: fakeCredential(), ANTHROPIC_BASE_URL: "http://unsecured.example" } });
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }));
  for (const base of ["http://localhost:1234", "http://127.0.0.2:1234", "http://[::1]:1234"]) {
    assert.equal(resolveClaudeProviderConfig({ ANTHROPIC_API_KEY: fakeCredential(), ANTHROPIC_BASE_URL: base }, { local: false }).connection.kind, "gateway");
  }
});

test("Qoder wizard selectors preserve spaces, parentheses, and non-Latin display names", (t) => {
  const id = "custom/自定义模型 (经济版)";
  const f = fixture(t, ".qoder", { model: { name: id }, modelConfigs: { customModels: [{ provider: "custom", model: "upstream-model", key: id, apiKey: fakeCredential(), baseURL: "https://gateway.example", format: "openai" }] } });
  const result = resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config });
  assert.equal(result.selectedDefault, id);
  assert.equal(result.models[0]?.id, id);
  assert.equal(result.connection.billing, "provider");
  rejectsConfig(() => resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config }, { model: "--injected" }));
  rejectsConfig(() => resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config }, { model: "custom/name\nsecond" }));
});

test("Qoder JSONC supports line and block comments without altering URL or credential strings", (t) => {
  const f = fixture(t, ".qoder");
  const token = `${fakeCredential()}//literal/*not a comment*/\\\"tail`;
  const baseUrl = "https://gateway.example/v1//messages";
  writeFileSync(f.file, `// User-level connection\r\n{
    "providers": { /* connection metadata */
      "gateway": {
        "protocol": "openai", // Preserve this protocol
        "baseUrl": ${JSON.stringify(baseUrl)},
        "apiKey": ${JSON.stringify(token)},
        "model": "cheap"
      }
    },
    "model": {"name": "gateway/cheap"},
    "hooks": {"fake": "never execute"}, // ignored by the field projection
    "mcpServers": {"unsafe": {"command": "never execute"}},
    "ignored": "escaped quote: \\\" // still inside string"
  } // no newline required after the final comment`);
  const result = resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config });
  assert.equal(result.providerSettings.providers.gateway.baseUrl, baseUrl);
  assert.equal(result.providerSettings.providers.gateway.apiKey, token);
  assert.equal(result.selectedDefault, "gateway/cheap");
  assert.deepEqual(Object.keys(result.providerSettings).sort(), ["model", "providers"]);
  assert.equal(result.connection.endpointHost, "gateway.example");
  const publicValue = JSON.stringify({ connection: result.connection, models: result.models });
  assert.ok(!publicValue.includes(token));
  assert.ok(!publicValue.includes("v1//messages"));
});

test("Qoder JSONC handles comments between tokens and preserves escaped model display names", (t) => {
  const f = fixture(t, ".qoder");
  const id = 'custom/模型 "双引号" \\ // literal /* text */';
  writeFileSync(f.file, `{/*start*/"model"/*key*/:/*value*/{"name":${JSON.stringify(id)}}/*end*/}`);
  assert.equal(resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config }).selectedDefault, id);
  for (const newline of ["\n", "\r", "\r\n"]) {
    writeFileSync(f.file, `{ // leading${newline}"model": {"name": "efficient"} // trailing${newline}}`);
    assert.equal(resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config }).selectedDefault, "efficient");
  }
});

test("Qoder JSONC remains strict about damaged syntax and never echoes comment contents", (t) => {
  const f = fixture(t, ".qoder");
  const secret = fakeCredential();
  for (const content of [
    `{"model": {"name": "efficient"}} /* unterminated ${secret}`,
    `{"model": {"name": "efficient"}, "ignored": 1/*${secret}*/2}`,
    `{"model": {"name": "efficient"}, "ignored": tr/*${secret}*/ue}`,
    `{"model": {"name": "efficient"}} // ${secret}\n unwanted`,
    `{"model": {"name": "efficient",}} // ${secret}`,
    `{"model": {"name": "unterminated // ${secret}}`,
    `/* ${secret} */ ["not an object"]`,
    `// only a comment ${secret}`,
  ]) {
    writeFileSync(f.file, content);
    rejectsConfig(() => resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config }), [secret]);
  }
});

test("JSONC does not bypass Qoder size limits, provider validation, or Claude strict JSON", (t) => {
  const f = fixture(t, ".qoder");
  writeFileSync(f.file, `// ${"x".repeat(1024 * 1024)}\n{}`);
  rejectsConfig(() => resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config }));
  writeFileSync(f.file, '{ // comment\n "providers": {"gateway": {"protocol": "openai", "baseUrl": "https://gateway.example"}}}');
  rejectsConfig(() => resolveQoderProviderConfig({ QODER_CONFIG_DIR: f.config }));
  writeFileSync(f.file, '{ // Qoder-only comment\n "model": {"name": "efficient"}}');
  rejectsConfig(() => resolveClaudeProviderConfig({ CLAUDE_CONFIG_DIR: f.config }));
});

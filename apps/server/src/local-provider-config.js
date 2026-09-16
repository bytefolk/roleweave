import { constants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_MODELS = 256;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const CLAUDE_FIELDS = [
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_CUSTOM_MODEL_OPTION", "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION", "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
];
const AUTH_FIELDS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"];

/** Errors deliberately contain field names, never a config value or JSON parser excerpt. */
export class LocalProviderConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalProviderConfigError";
    this.code = "local_provider_config_invalid";
  }
}

function invalid(field, reason = "无效") {
  throw new LocalProviderConfigError(`本机模型配置 ${field} ${reason}；请修正后重试，不会自动切换连接。`);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field, "必须是对象");
  return value;
}

function string(value, field, max = 4096) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(field, "必须是有效字符串");
  return value;
}

function nonempty(value, field, max = 4096) {
  const result = string(value, field, max).trim();
  if (!result) invalid(field, "不能为空");
  return result;
}

function modelId(value, field) {
  const result = nonempty(value, field, 128);
  if (!MODEL_ID.test(result)) invalid(field, "不是有效模型标识");
  return result;
}

function qoderModelId(value, field) {
  // Qoder's official custom-model wizard uses custom/<display name>, including spaces and Unicode.
  const result = nonempty(value, field, 256);
  if (result.startsWith("-") || /[\u2028\u2029]/.test(result)) invalid(field, "不是有效模型标识");
  return result;
}

function endpoint(value, field) {
  const raw = nonempty(value, field, 2048);
  let parsed;
  try { parsed = new URL(raw); } catch { invalid(field, "不是有效 URL"); }
  if (!parsed.hostname || !["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) {
    invalid(field, "必须是无内嵌凭据的 HTTP(S) URL");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname);
  if (parsed.protocol === "http:" && !loopback) invalid(field, "仅允许 HTTPS 或本机回环 HTTP");
  return { raw, hostname: parsed.hostname };
}

function settingsDirectory(env, variable, fallback) {
  const explicit = env[variable];
  if (explicit !== undefined && explicit !== "") {
    const value = nonempty(explicit, variable);
    if (!path.isAbsolute(value)) invalid(variable, "必须是绝对路径");
    return value;
  }
  const userHome = env.HOME || env.USERPROFILE || homedir();
  if (!path.isAbsolute(string(userHome, "HOME"))) invalid("HOME", "必须是绝对路径");
  return path.join(userHome, fallback);
}

/**
 * Qoder documents comments in settings.json: https://docs.qoder.com/cli/settings#file-format
 * Scan once with JSON string/escape awareness. Replace comments with whitespace rather
 * than joining adjacent tokens; JSON.parse still rejects damaged JSON and trailing commas.
 */
function withoutJsonComments(source) {
  const pieces = [];
  let copiedThrough = 0;
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== "/" || !["/", "*"].includes(source[index + 1])) continue;
    pieces.push(source.slice(copiedThrough, index), " ");
    if (source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      copiedThrough = index;
    } else {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new SyntaxError("Unterminated JSON comment");
      index = end + 1;
      copiedThrough = index + 1;
    }
  }
  pieces.push(source.slice(copiedThrough));
  return pieces.join("");
}

/** Bounded user-settings read. Never reads project settings, credential stores, or executes helpers. */
function readSettings(env, variable, fallback, label, allowComments = false) {
  const file = path.join(settingsDirectory(env, variable, fallback), "settings.json");
  let fd;
  try {
    // Open first and check via the descriptor from then on: O_NOFOLLOW refuses
    // symlinks atomically at open time, and fstat below never re-touches the
    // path, so there is no check-then-use window to swap the file (TOCTOU).
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    invalid(label, "无法安全读取");
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_SETTINGS_BYTES) invalid(label, "不是有效的小型配置文件");
    const buffer = Buffer.alloc(Math.min(before.size + 1, MAX_SETTINGS_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      invalid(label, "读取时发生变化");
    }
    let parsed;
    try {
      const source = buffer.subarray(0, length).toString("utf8");
      parsed = JSON.parse(allowComments ? withoutJsonComments(source) : source);
    } catch { invalid(label, allowComments ? "不是有效 JSONC" : "不是有效 JSON"); }
    return object(parsed, label);
  } catch (error) {
    if (error instanceof LocalProviderConfigError) throw error;
    invalid(label, "无法安全读取");
  } finally {
    closeSync(fd);
  }
}

function whitelistEnv(env, keys, label) {
  const safe = {};
  for (const key of keys) {
    if (!Object.hasOwn(env, key) || env[key] === undefined) continue;
    if (key === "ANTHROPIC_CUSTOM_HEADERS") {
      const value = env[key];
      if (typeof value !== "string" || value.length > 16384 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid(`${label}.${key}`, "不是有效 HTTP 请求头");
      for (const line of value.split(/\r?\n/)) {
        if (line.trim() && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[^\r\n]*$/.test(line)) invalid(`${label}.${key}`, "不是有效 HTTP 请求头");
      }
      safe[key] = value;
    } else safe[key] = string(env[key], `${label}.${key}`, 16384);
  }
  return safe;
}

function addModel(models, entry) {
  const existing = models.findIndex((item) => item.id === entry.id);
  if (existing < 0) models.push(entry);
  else models[existing] = { ...models[existing], ...entry };
}

/** Internal env/settings can contain secrets. Only models and connection may cross an API boundary. */
export function resolveClaudeProviderConfig(env = process.env, { local = true } = {}) {
  const settings = local ? readSettings(env, "CLAUDE_CONFIG_DIR", ".claude", "Claude settings.json") : {};
  const localEnv = settings.env === undefined ? {} : whitelistEnv(object(settings.env, "Claude settings.env"), CLAUDE_FIELDS, "Claude settings.env");
  // Claude user settings.env overrides matching shell variables. Empty values also clear inherited fields.
  const shellEnv = whitelistEnv(env, CLAUDE_FIELDS, "environment");
  const providerEnv = { ...shellEnv, ...localEnv };
  if (AUTH_FIELDS.some((key) => Object.hasOwn(localEnv, key))) {
    // Never pair a local endpoint with a shell credential, or leak another auth method/header to it.
    const hasLocalCredentials = Boolean(localEnv.ANTHROPIC_AUTH_TOKEN?.trim() || localEnv.ANTHROPIC_API_KEY?.trim());
    if (hasLocalCredentials && !Object.hasOwn(localEnv, "ANTHROPIC_BASE_URL") && shellEnv.ANTHROPIC_BASE_URL?.trim()) {
      invalid("Claude settings.env", "连接地址与凭据来自不同来源，请在同一配置中明确指定 BASE_URL");
    }
    for (const key of AUTH_FIELDS) {
      // Explicit empty entries clear auth inherited later when consumers merge providerEnv into a base env.
      providerEnv[key] = localEnv[key] ?? "";
    }
  }
  const hasCredentials = Boolean(providerEnv.ANTHROPIC_AUTH_TOKEN?.trim() || providerEnv.ANTHROPIC_API_KEY?.trim());
  const base = providerEnv.ANTHROPIC_BASE_URL?.trim() ? endpoint(providerEnv.ANTHROPIC_BASE_URL, "ANTHROPIC_BASE_URL") : undefined;
  if (base && !hasCredentials) invalid("ANTHROPIC_BASE_URL", "缺少配套的 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY");
  // A custom Authorization/header must never be mixed with the official OAuth
  // path. Require an explicit gateway and credential in the same resolved
  // provider configuration so header-only settings fail closed.
  const hasCustomHeaders = Boolean(providerEnv.ANTHROPIC_CUSTOM_HEADERS?.trim());
  if (hasCustomHeaders && (!base || !hasCredentials)) {
    invalid("ANTHROPIC_CUSTOM_HEADERS", "必须与配套的 ANTHROPIC_BASE_URL 和 API_KEY 或 AUTH_TOKEN 一起配置");
  }
  if (!hasCredentials && settings.apiKeyHelper !== undefined && settings.apiKeyHelper !== "") {
    invalid("Claude apiKeyHelper", "不受支持，请显式配置 API_KEY 或 AUTH_TOKEN；不会执行命令或改用登录账户");
  }
  const settingsModel = settings.model === undefined ? undefined : modelId(settings.model, "Claude model");
  const selectedDefault = providerEnv.ANTHROPIC_MODEL?.trim()
    ? modelId(providerEnv.ANTHROPIC_MODEL, "ANTHROPIC_MODEL") : settingsModel;
  const source = AUTH_FIELDS.some((key) => Boolean(localEnv[key]?.trim())) ? "local-config"
    : AUTH_FIELDS.some((key) => Boolean(providerEnv[key]?.trim())) ? "environment"
      : settingsModel || Object.keys(localEnv).length ? "local-config" : "official";
  const billing = hasCredentials ? "provider" : "subscription";
  const connection = {
    source, kind: base && base.hostname !== "api.anthropic.com" ? "gateway" : "official",
    ...(base ? { endpointHost: base.hostname } : {}), billing, status: "configured",
  };
  const connectionLabel = base?.hostname || (hasCredentials ? "Anthropic API" : "Claude 登录");
  const models = [];
  for (const [id, name, tier] of [["haiku", "Haiku", "economy"], ["sonnet", "Sonnet", "balanced"], ["opus", "Opus", "powerful"]]) {
    const key = `ANTHROPIC_DEFAULT_${id.toUpperCase()}_MODEL`;
    const mapped = providerEnv[key]?.trim();
    addModel(models, { id, name, tier: base || mapped ? "default" : tier, ...(mapped ? { resolvedModel: modelId(mapped, key) } : {}), billing, connectionLabel });
  }
  for (const key of ["ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_CUSTOM_MODEL_OPTION"]) {
    if (!providerEnv[key]?.trim()) continue;
    const id = modelId(providerEnv[key], key);
    const name = key === "ANTHROPIC_CUSTOM_MODEL_OPTION" && providerEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME?.trim()
      ? string(providerEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME", 256) : id;
    addModel(models, { id, name, tier: "default", billing, connectionLabel });
  }
  if (selectedDefault && !models.some((item) => item.id === selectedDefault)) {
    addModel(models, { id: selectedDefault, name: selectedDefault, tier: "default", billing, connectionLabel });
  }
  return { providerEnv, providerSettings: {}, selectedDefault, models, connection };
}

function optionalString(source, target, key, label, max = 256) {
  if (source[key] !== undefined) target[key] = nonempty(source[key], `${label}.${key}`, max);
}

function optionalEnum(source, target, key, allowed, label) {
  if (source[key] === undefined) return;
  if (!allowed.includes(source[key])) invalid(`${label}.${key}`, "不受支持");
  target[key] = source[key];
}

function optionalPositive(source, target, key, label) {
  if (source[key] === undefined) return;
  if (!Number.isSafeInteger(source[key]) || source[key] < 1) invalid(`${label}.${key}`, "必须是正整数");
  target[key] = source[key];
}

function optionalBoolean(source, target, key, label) {
  if (source[key] === undefined) return;
  if (typeof source[key] !== "boolean") invalid(`${label}.${key}`, "必须是布尔值");
  target[key] = source[key];
}

function array(value, label, max = MAX_MODELS) {
  if (!Array.isArray(value) || value.length > max) invalid(label, "必须是有限的数组");
  return value;
}

function qoderModel(value, label) {
  const input = object(value, label);
  const result = { model: qoderModelId(input.model, `${label}.model`) };
  optionalString(input, result, "displayName", label);
  for (const key of ["contextWindow", "maxOutputTokens"]) optionalPositive(input, result, key, label);
  optionalEnum(input, result, "maxTokensField", ["max_tokens", "max_completion_tokens"], label);
  if (input.capabilities !== undefined) {
    const capabilities = object(input.capabilities, `${label}.capabilities`);
    result.capabilities = {};
    for (const key of ["tools", "vision", "cacheControl", "thinking", "reasoning"]) optionalBoolean(capabilities, result.capabilities, key, `${label}.capabilities`);
  }
  return result;
}

function qoderProvider(value) {
  const label = "Qoder providers entry";
  const input = object(value, label);
  const base = endpoint(input.baseUrl, `${label}.baseUrl`);
  const result = { baseUrl: base.raw, apiKey: nonempty(input.apiKey, `${label}.apiKey`, 16384) };
  if (input.protocol === undefined) invalid(`${label}.protocol`, "不能为空");
  optionalEnum(input, result, "protocol", ["openai", "openai-responses", "anthropic"], label);
  optionalEnum(input, result, "type", ["openai-compatible", "alibaba", "aliyun-bailian"], label);
  optionalEnum(input, result, "authType", ["bearer", "api-key"], label);
  optionalString(input, result, "displayName", label);
  if (input.model !== undefined) result.model = qoderModelId(input.model, `${label}.model`);
  if (input.models !== undefined) result.models = array(input.models, `${label}.models`).map((item) => qoderModel(item, `${label}.models entry`));
  if (input.routing !== undefined) {
    const routing = object(input.routing, `${label}.routing`);
    result.routing = {};
    for (const key of ["main", "subagent", "web_fetch", "compact"]) {
      if (routing[key] !== undefined) result.routing[key] = qoderModelId(routing[key], `${label}.routing.${key}`);
    }
  }
  if (input.anthropic !== undefined) {
    const anthropic = object(input.anthropic, `${label}.anthropic`);
    result.anthropic = {};
    optionalEnum(anthropic, result.anthropic, "version", ["2023-06-01", false], `${label}.anthropic`);
    if (anthropic.betas !== undefined) result.anthropic.betas = array(anthropic.betas, `${label}.anthropic.betas`, 32).map((item) => nonempty(item, `${label}.anthropic.betas entry`, 128));
    if (anthropic.cache !== undefined) {
      const cache = object(anthropic.cache, `${label}.anthropic.cache`);
      result.anthropic.cache = {};
      optionalEnum(cache, result.anthropic.cache, "mode", ["off", "auto"], `${label}.anthropic.cache`);
      optionalEnum(cache, result.anthropic.cache, "ttl", ["5m", "1h"], `${label}.anthropic.cache`);
    }
    if (anthropic.queryParams !== undefined) {
      const params = object(anthropic.queryParams, `${label}.anthropic.queryParams`);
      if (Object.keys(params).length > 32) invalid(`${label}.anthropic.queryParams`, "项目过多");
      result.anthropic.queryParams = {};
      for (const [key, value] of Object.entries(params)) {
        if (!PROVIDER_ID.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) invalid(`${label}.anthropic.queryParams`, "包含无效字段名");
        result.anthropic.queryParams[key] = string(value, `${label}.anthropic.queryParams value`, 1024);
      }
    }
  }
  return { settings: result, hostname: base.hostname };
}

function qoderLegacyModel(value) {
  const label = "Qoder modelConfigs.customModels entry";
  const input = object(value, label);
  const provider = nonempty(input.provider, `${label}.provider`, 64);
  if (!PROVIDER_ID.test(provider)) invalid(`${label}.provider`, "不是有效提供方标识");
  const result = { provider, model: qoderModelId(input.model, `${label}.model`), apiKey: nonempty(input.apiKey, `${label}.apiKey`, 16384) };
  let hostname;
  if (input.baseURL !== undefined) {
    const base = endpoint(input.baseURL, `${label}.baseURL`);
    result.baseURL = base.raw;
    hostname = base.hostname;
  }
  optionalEnum(input, result, "format", ["openai", "anthropic"], label);
  if (input.key !== undefined) result.key = qoderModelId(input.key, `${label}.key`);
  optionalString(input, result, "displayName", label);
  optionalString(input, result, "type", label, 64);
  optionalBoolean(input, result, "isVl", label);
  optionalBoolean(input, result, "isReasoning", label);
  optionalPositive(input, result, "maxInputTokens", label);
  return { settings: result, hostname };
}

/** Only connection/model fields are copied. UID-backed Qoder models are retained, never decrypted. */
export function resolveQoderProviderConfig(env = process.env, { model: selectedModel } = {}) {
  const settings = readSettings(env, "QODER_CONFIG_DIR", ".qoder", "Qoder settings.json", true);
  const providerEnv = whitelistEnv(env, ["QODER_PERSONAL_ACCESS_TOKEN"], "environment");
  const providerSettings = {};
  const models = [];
  const connections = new Map();
  if (settings.providers !== undefined) {
    const providers = object(settings.providers, "Qoder providers");
    if (Object.keys(providers).length > 32) invalid("Qoder providers", "项目过多");
    providerSettings.providers = {};
    for (const [id, value] of Object.entries(providers)) {
      if (!PROVIDER_ID.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) invalid("Qoder providers", "包含无效提供方标识");
      const safe = qoderProvider(value);
      providerSettings.providers[id] = safe.settings;
      const declaredModels = [...(safe.settings.models || [])];
      if (safe.settings.model && !declaredModels.some((item) => item.model === safe.settings.model)) declaredModels.push({ model: safe.settings.model });
      for (const declared of declaredModels) {
        const selector = qoderModelId(`${id}/${declared.model}`, "Qoder provider model selector");
        addModel(models, { id: selector, name: declared.displayName || selector, resolvedModel: declared.model, tier: "default", billing: "provider", connectionLabel: safe.hostname, endpointHost: safe.hostname });
        connections.set(selector, { source: "local-config", kind: "gateway", endpointHost: safe.hostname, billing: "provider", status: "configured" });
      }
    }
  }
  if (settings.modelConfigs !== undefined) {
    const config = object(settings.modelConfigs, "Qoder modelConfigs");
    if (config.customModels !== undefined) {
      providerSettings.modelConfigs = { customModels: [] };
      for (const value of array(config.customModels, "Qoder modelConfigs.customModels")) {
        const safe = qoderLegacyModel(value);
        providerSettings.modelConfigs.customModels.push(safe.settings);
        const selector = safe.settings.key || qoderModelId(`${safe.settings.provider}/${safe.settings.model}`, "Qoder custom model selector");
        // Reject conflicting declarations rather than silently switching the provider for the same selector.
        if (connections.has(selector)) invalid("Qoder custom model selector", "重复定义");
        addModel(models, { id: selector, name: safe.settings.displayName || selector, resolvedModel: safe.settings.model, tier: "default", billing: "provider", connectionLabel: safe.hostname || safe.settings.provider, ...(safe.hostname ? { endpointHost: safe.hostname } : {}) });
        connections.set(selector, { source: "local-config", kind: "gateway", ...(safe.hostname ? { endpointHost: safe.hostname } : {}), billing: "provider", status: "configured" });
      }
    }
  }
  let selectedDefault;
  if (settings.model !== undefined) {
    const model = object(settings.model, "Qoder model");
    if (model.name !== undefined) {
      selectedDefault = qoderModelId(model.name, "Qoder model.name");
      providerSettings.model = { name: selectedDefault };
    }
  }
  // Qoder 1.1.x resolves --model > settings.model.name; its documented QODER_MODEL is not consumed.
  const effectiveModel = selectedModel === undefined ? selectedDefault : qoderModelId(selectedModel, "Qoder selected model");
  const knownTier = effectiveModel && ["auto", "efficient", "lite", "performance", "ultimate"].includes(effectiveModel);
  const unknownSelection = Boolean(effectiveModel && !knownTier && !connections.has(effectiveModel));
  const connection = connections.get(effectiveModel) || {
    source: selectedDefault || selectedModel ? "local-config" : "official",
    kind: unknownSelection ? "unknown" : "official", billing: unknownSelection ? "unknown" : "qoder", status: "configured",
    ...(unknownSelection ? { message: "由 Qoder 验证已注册的模型标识；未读取或解密凭据。" } : {}),
  };
  if (selectedDefault && !models.some((item) => item.id === selectedDefault)) {
    const isTier = ["auto", "efficient", "lite", "performance", "ultimate"].includes(selectedDefault);
    addModel(models, { id: selectedDefault, name: selectedDefault, tier: "default", billing: isTier ? "qoder" : "unknown", connectionLabel: isTier ? "Qoder" : "Qoder 已配置模型" });
  }
  return { providerEnv, providerSettings, selectedDefault, models, connection };
}

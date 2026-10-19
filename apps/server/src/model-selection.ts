import os from "node:os";
import path from "node:path";
import { isEngineModelId, isModelId } from "@roleweave/shared";
import type { EmployeeModelConfig, EmployeeModelConnection, EmployeeModelOption, TurnEngine } from "@roleweave/shared";
import { decodeStableUtf8, readStableBoundedFile } from "./stable-read.js";
import { LocalProviderConfigError, resolveClaudeProviderConfig, resolveQoderProviderConfig } from "./local-provider-config.js";
import { qoderModelCatalog } from "./qoder-model-catalog.js";
import { openAICompatibleConfiguration } from "./codex-binary.js";
import { workbuddyConfiguration } from "./workbuddy-runtime.js";
import { workbuddyLocalBridgeConfigured } from "./workbuddy-local.js";
import { qwenOfficeLocalBridgeConfigured } from "./qwen-office-local.js";
import { codexModelCatalog, codexModelTier } from "./codex-model-catalog.js";

const MAX_MODEL_CACHE_BYTES = 4 * 1024 * 1024;

/** Provider catalogs own concrete model availability; disk caches are fallbacks. */
export async function employeeModelConfig(engine: TurnEngine, selected?: string, editable = true, env: NodeJS.ProcessEnv = process.env, catalogMode: "refresh" | "cached" = "refresh"): Promise<EmployeeModelConfig> {
  if (engine === "qwen-office-local") {
    // The native Office client owns its model. Ignore stale saved selectors,
    // never read another Host's account cache, and never mutate client config.
    const connection: EmployeeModelConnection | undefined = editable
      ? { source: "official", kind: "official", billing: "unknown", status: qwenOfficeLocalBridgeConfigured(env) ? "configured" : "invalid" }
      : undefined;
    return {
      selected: "provider-default", recommended: "provider-default", source: "default", editable: false,
      options: [{ id: "provider-default", name: "Current Qwen Office model", tier: "default", billing: "unknown" }],
      ...(connection ? { connection } : {}),
    };
  }
  let source: EmployeeModelConfig["source"] = "provider-tiers";
  let options: EmployeeModelOption[] = [];
  let connection: EmployeeModelConnection | undefined;
  let followLocalDefault = false;
  let selectedDefault: string | undefined;
  let allowCustomModel = false;
  let customModelFormat: EmployeeModelConfig["customModelFormat"];
  let catalogStatus: EmployeeModelConfig["catalogStatus"];
  let catalogRecommended: string | undefined;
  try {
  if (engine === "qoder") {
    options = [
      { id: "efficient", name: "Efficient", tier: "economy" },
      { id: "auto", name: "Auto · Qoder", tier: "auto" },
      { id: "performance", name: "Performance", tier: "balanced" },
      { id: "ultimate", name: "Ultimate", tier: "powerful" },
    ].map((option) => ({ ...option, tier: option.tier as EmployeeModelOption["tier"], billing: "qoder" as const, group: "tiers" as const }));
    if (editable) {
      const local = resolveQoderProviderConfig(env, { model: selected === "provider-default" ? undefined : selected });
      const catalog = await qoderModelCatalog.read(env, catalogMode);
      catalogStatus = catalog.status;
      if (catalog.options.length > 0) {
        options = catalog.options;
        source = "provider-catalog";
      }
      // Locally declared connection metadata stays authoritative for a matching
      // selector; listing a CLI model must not change its provider or billing.
      const localOptions = local.models.map((model): EmployeeModelOption => ({
        ...model, tier: model.tier ?? "default",
        group: model.billing === "provider" ? "custom" : options.find((entry) => entry.id === model.id
          || (entry.group === "tiers" && entry.id.toLowerCase() === model.id.toLowerCase()))?.group ?? "custom",
      }));
      options = [...localOptions, ...options.filter((model) => !localOptions.some((localModel) => localModel.id === model.id))];
      connection = local.connection;
      selectedDefault = local.selectedDefault;
      allowCustomModel = true;
      customModelFormat = "qoder";
      // Even without a plaintext model setting, the CLI may have an account-
      // scoped encrypted Custom selection. Never override it with efficient.
      followLocalDefault = true;
      if (local.connection.source === "local-config") source = "local-config";
    }
  } else if (engine.startsWith("claude")) {
    options = [{ id: "haiku", name: "Haiku", tier: "economy" }, { id: "sonnet", name: "Sonnet", tier: "balanced" }, { id: "opus", name: "Opus", tier: "powerful" }];
    if (editable) {
      const local = resolveClaudeProviderConfig(env, { local: engine === "claude-local" });
      connection = local.connection;
      selectedDefault = local.selectedDefault;
      options = local.models.map((model) => ({ ...model, tier: model.tier ?? "default" }));
      followLocalDefault = local.connection.kind === "gateway" || !!selectedDefault;
      if (local.connection.source === "local-config") source = "local-config";
    }
  } else if (engine === "workbuddy-local" || engine === "workbuddy") {
    // WorkBuddy owns its model selection. Never read Codex's model cache or
    // borrow a service credential for the client-login mode.
    source = "default";
    followLocalDefault = true;
    if (engine === "workbuddy-local") {
      const ownedAdapter = editable;
      editable = false;
      selectedDefault = "auto";
      // Automatic selection is the adapter's fixed contract, not an account
      // catalog. Background employee-card reads must not consume broker slots
      // or turn temporary concurrency pressure into a false login failure.
      // Health probes the desktop client separately; a real turn asserts auth.
      if (ownedAdapter) connection = { source: "official", kind: "official", billing: "unknown", status: workbuddyLocalBridgeConfigured(env) ? "configured" : "invalid" };
    } else if (editable) {
      const configuration = workbuddyConfiguration({ ...env, ROLEWEAVE_TURN_MODEL: undefined });
      selectedDefault = configuration.ready ? configuration.model : undefined;
      if (selectedDefault) options = [{ id: selectedDefault, name: selectedDefault, tier: "default", billing: "provider" }];
      connection = { source: "environment", kind: configuration.baseUrl ? "gateway" : "official", billing: "provider", status: configuration.ready ? "configured" : "invalid",
        ...(configuration.baseUrl ? { endpointHost: new URL(configuration.baseUrl).hostname } : {}) };
      allowCustomModel = true;
      customModelFormat = "strict";
    }
  } else if (engine === "gemini") {
    // Both Gemini CLI and Antigravity CLI own their account-specific catalog.
    // Keep the provider default plus any explicit/saved model instead of
    // accidentally showing Codex's models_cache.json for this Host.
    source = "default";
    followLocalDefault = true;
    allowCustomModel = true;
    customModelFormat = "strict";
    selectedDefault = isModelId(env.GEMINI_MODEL) ? env.GEMINI_MODEL : undefined;
    const apiKey = typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.trim().length > 0;
    connection = {
      source: apiKey ? "environment" : "official",
      kind: "official",
      billing: apiKey ? "provider" : "subscription",
      status: "configured",
    };
  } else if (engine === "openai-compatible") {
    // A user-configured OpenAI-compatible endpoint (e.g. TokenRhythm, OpenRouter,
    // or any provider that speaks the /v1/chat/completions protocol). The
    // operator supplies OPENAI_API_KEY, OPENAI_BASE_URL, and OPENAI_MODEL in the
    // server environment; this engine forwards them verbatim and exposes a free
    // model text field so arbitrary model ids from the provider's catalog work.
    source = "default";
    followLocalDefault = true;
    allowCustomModel = true;
    customModelFormat = "strict";
    const configuration = openAICompatibleConfiguration(env);
    selectedDefault = configuration.ready ? configuration.model : undefined;
    let endpointHost: string | undefined;
    if (configuration.ready && configuration.baseUrl) endpointHost = new URL(configuration.baseUrl).hostname;
    const hasProviderInput = [env.OPENAI_API_KEY, env.OPENAI_BASE_URL, env.OPENAI_MODEL]
      .some((value) => typeof value === "string" && value.length > 0);
    connection = {
      source: hasProviderInput ? "environment" : "official",
      kind: "gateway",
      billing: "provider",
      status: configuration.ready ? "configured" : "invalid",
      ...(endpointHost ? { endpointHost } : {}),
      ...(configuration.ready ? {} : { message: "Set a valid OPENAI_API_KEY, OPENAI_BASE_URL, and OPENAI_MODEL to use this agent" }),
    };
  } else if (engine === "codex" || engine === "codex-local") {
    source = "default";
    const catalog = editable ? await codexModelCatalog.read(env, catalogMode, engine) : undefined;
    if (catalog) {
      options = catalog.options;
      catalogStatus = catalog.status;
      catalogRecommended = catalog.recommended;
      if (catalog.status !== "unavailable") source = "provider-catalog";
      allowCustomModel = true;
      customModelFormat = "strict";
    }
    if (!catalog || catalog.status === "unavailable") {
      try {
        const file = path.join(env.CODEX_HOME ?? path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".codex"), "models_cache.json");
        const stable = await readStableBoundedFile(file, MAX_MODEL_CACHE_BYTES);
        const cache = JSON.parse(decodeStableUtf8(stable.buffer));
        if (Array.isArray(cache.models)) {
          options = cache.models.filter((m: any) => m?.visibility === "list" && isModelId(m.slug)).slice(0, 64).map((m: any): EmployeeModelOption => ({
            id: m.slug, name: typeof m.display_name === "string" ? m.display_name.slice(0, 100) : m.slug,
            tier: codexModelTier(m.slug),
          }));
          if (options.length > 0) { source = "local-cache"; if (editable) catalogStatus = "stale"; }
        }
      } catch { /* Without an account catalog, retain an explicit provider default. */ }
    }
  }
  } catch (error) {
    if (!(error instanceof LocalProviderConfigError)) throw error;
    return {
      selected: selected ?? "provider-default", recommended: "provider-default",
      options: [{ id: selected ?? "provider-default", name: selected ?? "Agent default", tier: "default" }],
      source: "local-config", editable,
      connection: { source: "local-config", kind: "gateway", billing: "unknown", status: "invalid", message: error.message },
    };
  }
  // Honor the provider's recommendation; older catalogs retain the affordable
  // general-purpose fallback. Labels are qualitative, never fabricated prices.
  const recommended = followLocalDefault ? "provider-default" : catalogRecommended ?? options.find((m) => /luna/.test(m.id))?.id ?? options.find((m) => m.tier === "economy")?.id ?? "provider-default";
  options = options.filter((option, index, all) => all.findIndex((item) => item.id === option.id) === index && option.id !== "provider-default");
  options.sort((a, b) => Number(b.id === recommended) - Number(a.id === recommended));
  options.push({ id: "provider-default", name: "Agent default", tier: "default", ...(selectedDefault ? { resolvedModel: selectedDefault } : {}), ...(connection ? { billing: connection.billing } : {}) });
  if (selected && isEngineModelId(selected, engine) && !options.some((m) => m.id === selected)) options.push({ id: selected, name: selected, tier: "default", billing: "unknown" });
  if (recommended === "provider-default") options.sort((a, b) => Number(b.id === recommended) - Number(a.id === recommended));
  return { selected: selected ?? (editable ? recommended : "provider-default"), recommended, options, source, editable, ...(connection ? { connection } : {}), ...(allowCustomModel ? { allowCustomModel, ...(customModelFormat ? { customModelFormat } : {}) } : {}), ...(catalogStatus ? { catalogStatus } : {}) };
}

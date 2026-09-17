import os from "node:os";
import path from "node:path";
import { isEngineModelId, isModelId } from "@roleweave/shared";
import type { EmployeeModelConfig, EmployeeModelConnection, EmployeeModelOption, TurnEngine } from "@roleweave/shared";
import { decodeStableUtf8, readStableBoundedFile } from "./stable-read.js";
import { LocalProviderConfigError, resolveClaudeProviderConfig, resolveQoderProviderConfig } from "./local-provider-config.js";
import { qoderModelCatalog } from "./qoder-model-catalog.js";

const MAX_MODEL_CACHE_BYTES = 4 * 1024 * 1024;

/** These are provider-supported aliases; Codex's concrete list comes from
 * its local account cache, never from a guessed public model availability. */
export async function employeeModelConfig(engine: TurnEngine, selected?: string, editable = true, env: NodeJS.ProcessEnv = process.env, catalogMode: "refresh" | "cached" = "refresh"): Promise<EmployeeModelConfig> {
  let source: EmployeeModelConfig["source"] = "provider-tiers";
  let options: EmployeeModelOption[] = [];
  let connection: EmployeeModelConnection | undefined;
  let followLocalDefault = false;
  let selectedDefault: string | undefined;
  let allowCustomModel = false;
  let catalogStatus: EmployeeModelConfig["catalogStatus"];
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
  } else {
    source = "default";
    try {
      const file = path.join(env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), ".codex"), "models_cache.json");
      const stable = await readStableBoundedFile(file, MAX_MODEL_CACHE_BYTES);
      const cache = JSON.parse(decodeStableUtf8(stable.buffer));
      if (Array.isArray(cache.models)) {
        options = cache.models.filter((m: any) => m.visibility === "list" && isModelId(m.slug)).slice(0, 64).map((m: any): EmployeeModelOption => ({
          id: m.slug, name: typeof m.display_name === "string" ? m.display_name.slice(0, 100) : m.slug,
          tier: /luna|mini|spark/i.test(m.slug) ? "economy" : /astra|pro|opus/i.test(m.slug) ? "powerful" : "balanced",
        }));
        if (options.length > 0) source = "local-cache";
      }
    } catch { /* Without an account catalog, retain an explicit provider default. */ }
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
  // Prefer the account's affordable general-purpose model over a specialist
  // fast model. Labels are qualitative, never fabricated prices or rates.
  const recommended = followLocalDefault ? "provider-default" : options.find((m) => /luna/.test(m.id))?.id ?? options.find((m) => m.tier === "economy")?.id ?? "provider-default";
  options = options.filter((option, index, all) => all.findIndex((item) => item.id === option.id) === index && option.id !== "provider-default");
  options.sort((a, b) => Number(b.id === recommended) - Number(a.id === recommended));
  options.push({ id: "provider-default", name: "Agent default", tier: "default", ...(selectedDefault ? { resolvedModel: selectedDefault } : {}), ...(connection ? { billing: connection.billing } : {}) });
  if (selected && isEngineModelId(selected, engine) && !options.some((m) => m.id === selected)) options.push({ id: selected, name: selected, tier: "default", billing: "unknown" });
  if (recommended === "provider-default") options.sort((a, b) => Number(b.id === recommended) - Number(a.id === recommended));
  return { selected: selected ?? (editable ? recommended : "provider-default"), recommended, options, source, editable, ...(connection ? { connection } : {}), ...(allowCustomModel ? { allowCustomModel } : {}), ...(catalogStatus ? { catalogStatus } : {}) };
}

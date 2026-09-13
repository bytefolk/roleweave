import os from "node:os";
import path from "node:path";
import { isModelId } from "@roleweave/shared";
import type { EmployeeModelConfig, EmployeeModelOption, TurnEngine } from "@roleweave/shared";
import { decodeStableUtf8, readStableBoundedFile } from "./stable-read.js";

const MAX_MODEL_CACHE_BYTES = 4 * 1024 * 1024;

/** These are provider-supported aliases; Codex's concrete list comes from
 * its local account cache, never from a guessed public model availability. */
export async function employeeModelConfig(engine: TurnEngine, selected?: string, editable = true): Promise<EmployeeModelConfig> {
  let source: EmployeeModelConfig["source"] = "provider-tiers";
  let options: EmployeeModelOption[] = [];
  if (engine === "qoder") {
    options = [
      { id: "efficient", name: "Efficient", tier: "economy" },
      { id: "auto", name: "Auto · Qoder", tier: "auto" },
      { id: "performance", name: "Performance", tier: "balanced" },
      { id: "ultimate", name: "Ultimate", tier: "powerful" },
    ];
  } else if (engine.startsWith("claude")) {
    options = [{ id: "haiku", name: "Haiku", tier: "economy" }, { id: "sonnet", name: "Sonnet", tier: "balanced" }, { id: "opus", name: "Opus", tier: "powerful" }];
  } else {
    source = "default";
    try {
      const file = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "models_cache.json");
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
  // Prefer the account's affordable general-purpose model over a specialist
  // fast model. Labels are qualitative, never fabricated prices or rates.
  const recommended = options.find((m) => /luna/.test(m.id))?.id ?? options.find((m) => m.tier === "economy")?.id ?? "provider-default";
  options.sort((a, b) => Number(b.id === recommended) - Number(a.id === recommended));
  options.push({ id: "provider-default", name: "Agent default", tier: "default" });
  if (selected && !options.some((m) => m.id === selected)) options.push({ id: selected, name: selected, tier: "default" });
  return { selected: selected ?? (editable ? recommended : "provider-default"), recommended, options, source, editable };
}

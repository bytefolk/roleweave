import { askLaya, type LayaAsk } from "../laya/client.js";
import { layaEnabled } from "../laya/config.js";

export interface ReadyHostFact {
  positionId: string;
  engine: string;
  ready: boolean;
}

export interface ReadyHostChoiceDeps {
  env?: NodeJS.Dict<string>;
  ask?: LayaAsk;
}

const ALLOWED_FACT_KEYS = new Set(["positionId", "engine", "ready"]);

export function sanitizeReadyHostFact(value: unknown): ReadyHostFact | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ALLOWED_FACT_KEYS.has(key))) return null;
  if (typeof record.positionId !== "string" || record.positionId.length === 0 || record.positionId.length > 128) return null;
  if (typeof record.engine !== "string" || record.engine.length === 0 || record.engine.length > 32) return null;
  if (typeof record.ready !== "boolean") return null;
  return { positionId: record.positionId, engine: record.engine, ready: record.ready };
}

export function sanitizeReadyHostFacts(value: unknown): ReadyHostFact[] {
  if (!Array.isArray(value)) return [];
  const facts: ReadyHostFact[] = [];
  for (const item of value) {
    const fact = sanitizeReadyHostFact(item);
    if (fact === null) return [];
    facts.push(fact);
  }
  return facts;
}

/**
 * 0/1 ready candidates never call the provider. 2+ send only
 * `{ positionId, engine, ready }` and accept a Choice that hits that set.
 * timeout / invalid / disabled / unconfigured fail closed to null.
 */
export async function resolveReadyHostChoice(
  candidates: ReadyHostFact[],
  deps: ReadyHostChoiceDeps = {},
): Promise<string | null> {
  const ready = candidates.filter((fact) => fact.ready);
  if (ready.length < 2) return null;
  const env = deps.env ?? process.env;
  if (!layaEnabled(env)) return null;
  const state = ready.map((fact) => ({
    positionId: fact.positionId,
    engine: fact.engine,
    ready: fact.ready,
  }));
  const ids = ready.map((fact) => fact.positionId);
  const ask = deps.ask ?? ((request) => askLaya(request, { env }));
  try {
    const answers = await ask({
      state,
      questions: {
        host: {
          type: "choice",
          instructions: "Select one ready host by positionId. Advisory only.",
          criteria: Object.fromEntries(ids.map((id) => [id, id])),
        },
      },
    });
    const answer = answers?.host;
    if (answer?.type !== "choice") return null;
    if (!ids.includes(answer.selected)) return null;
    return answer.selected;
  } catch {
    return null;
  }
}

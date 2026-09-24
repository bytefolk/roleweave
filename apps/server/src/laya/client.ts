import { isLoopbackEndpoint, layaRequestConfig } from "./config.js";

export type LayaNoulQuestion = { type: "noul"; instructions: string };
export type LayaChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type LayaScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type LayaQuestion = LayaNoulQuestion | LayaChoiceQuestion | LayaScoreQuestion;

export type LayaNoulAnswer = { type: "noul"; probability: number };
export type LayaChoiceAnswer = {
  type: "choice";
  selected: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type LayaScoreAnswer = { type: "score"; score: number; confidence: number };
export type LayaAnswer = LayaNoulAnswer | LayaChoiceAnswer | LayaScoreAnswer;

export interface LayaRequest {
  state: unknown;
  questions: Record<string, LayaQuestion>;
}

export type LayaAsk = (request: LayaRequest) => Promise<Record<string, LayaAnswer> | null>;
export interface AskLayaDeps {
  env?: NodeJS.Dict<string>;
  fetchImpl?: typeof fetch;
  config?: { url: string; model: string; timeoutMs: number };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every(key => allowed.includes(key));
}

const probability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

function parseAnswer(value: unknown): LayaAnswer | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.type === "noul" && hasOnlyKeys(record, ["type", "probability", "noul"]) && probability(record.probability ?? record.noul)) {
    return { type: "noul", probability: (record.probability ?? record.noul) as number };
  }
  const selected = record.selected ?? record.choice;
  if (record.type === "choice" && hasOnlyKeys(record, ["type", "selected", "choice", "probabilities", "confidence"]) && typeof selected === "string") {
    const probabilities = asRecord(record.probabilities) ?? {};
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(probabilities)) if (probability(value)) numeric[key] = value;
    const confidence = probability(record.confidence) ? record.confidence : numeric[selected];
    if (!probability(confidence)) return null;
    return { type: "choice", selected, probabilities: numeric, confidence };
  }
  if (record.type === "score" && hasOnlyKeys(record, ["type", "score", "confidence"]) && typeof record.score === "number" && Number.isFinite(record.score) && probability(record.confidence)) {
    return { type: "score", score: record.score, confidence: record.confidence };
  }
  return null;
}

/** Local typed System One call. It never sends authorization headers or reaches a non-loopback host. */
export async function askLaya(request: LayaRequest, deps: AskLayaDeps = {}): Promise<Record<string, LayaAnswer> | null> {
  if (deps.config && !isLoopbackEndpoint(deps.config.url)) return null;
  const config = deps.config
    ? layaRequestConfig({
        ROLEWEAVE_LAYA_ENABLED: "1",
        ROLEWEAVE_LAYA_URL: deps.config.url,
        ROLEWEAVE_LAYA_MODEL: deps.config.model,
        ROLEWEAVE_LAYA_TIMEOUT_MS: String(deps.config.timeoutMs),
      })
    : layaRequestConfig(deps.env ?? process.env);
  if (!config) return null;
  try {
    const response = await (deps.fetchImpl ?? fetch)(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.model, state: request.state, questions: request.questions }),
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "error",
    });
    if (!response.ok) return null;
    const body = asRecord(await response.json().catch(() => null));
    const rawAnswers = asRecord(body?.answers);
    if (!rawAnswers) return null;
    const answers: Record<string, LayaAnswer> = {};
    for (const [key, value] of Object.entries(rawAnswers)) {
      const parsed = parseAnswer(value);
      if (parsed) answers[key] = parsed;
    }
    return Object.keys(answers).length > 0 ? answers : null;
  } catch {
    return null;
  }
}

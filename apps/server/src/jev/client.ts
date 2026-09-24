import { layaRequestConfig } from "./config.js";

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
}

/** @deprecated Type aliases for the Laya swap. */
export type JevNoulQuestion = LayaNoulQuestion;
export type JevChoiceQuestion = LayaChoiceQuestion;
export type JevScoreQuestion = LayaScoreQuestion;
export type JevQuestion = LayaQuestion;
export type JevNoulAnswer = LayaNoulAnswer;
export type JevChoiceAnswer = LayaChoiceAnswer;
export type JevScoreAnswer = LayaScoreAnswer;
export type JevAnswer = LayaAnswer;
export type JevRequest = LayaRequest;
export type JevAsk = LayaAsk;
export type AskJevDeps = AskLayaDeps;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseAnswer(value: unknown): LayaAnswer | null {
  const record = asRecord(value);
  if (!record) return null;
  const noul = typeof record.noul === "number" ? record.noul : typeof record.probability === "number" ? record.probability : null;
  if (record.type === "noul" && noul !== null) {
    return { type: "noul", probability: noul };
  }
  const selected = typeof record.choice === "string" ? record.choice : typeof record.selected === "string" ? record.selected : null;
  if (record.type === "choice" && selected) {
    const probabilities = asRecord(record.probabilities) ?? {};
    const numeric: Record<string, number> = {};
    for (const [key, probability] of Object.entries(probabilities)) {
      if (typeof probability === "number") numeric[key] = probability;
    }
    return {
      type: "choice",
      selected,
      probabilities: numeric,
      confidence: typeof record.confidence === "number" ? record.confidence : 0,
    };
  }
  if (record.type === "score" && typeof record.score === "number") {
    return { type: "score", score: record.score, confidence: typeof record.confidence === "number" ? record.confidence : 0 };
  }
  return null;
}

/** Typed System One call against local Laya. Null when disabled or the call fails. */
export async function askLaya(request: LayaRequest, deps: AskLayaDeps = {}): Promise<Record<string, LayaAnswer> | null> {
  const config = layaRequestConfig(deps.env ?? process.env);
  if (!config) return null;
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        state: request.state,
        questions: request.questions,
      }),
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

/** @deprecated Use askLaya. */
export const askJev = askLaya;

import { jevRequestConfig } from "./config.js";

export type JevNoulQuestion = { type: "noul"; instructions: string };
export type JevChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type JevScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export type JevNoulAnswer = { type: "noul"; probability: number };
export type JevChoiceAnswer = {
  type: "choice";
  selected: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type JevScoreAnswer = { type: "score"; score: number; confidence: number };
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
}

export type JevAsk = (request: JevRequest) => Promise<Record<string, JevAnswer> | null>;

export interface AskJevDeps {
  env?: NodeJS.Dict<string>;
  fetchImpl?: typeof fetch;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseAnswer(value: unknown): JevAnswer | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.type === "noul" && typeof record.probability === "number") {
    return { type: "noul", probability: record.probability };
  }
  if (record.type === "choice" && typeof record.selected === "string") {
    const probabilities = asRecord(record.probabilities) ?? {};
    const numeric: Record<string, number> = {};
    for (const [key, probability] of Object.entries(probabilities)) {
      if (typeof probability === "number") numeric[key] = probability;
    }
    return {
      type: "choice",
      selected: record.selected,
      probabilities: numeric,
      confidence: typeof record.confidence === "number" ? record.confidence : 0,
    };
  }
  if (record.type === "score" && typeof record.score === "number") {
    return { type: "score", score: record.score, confidence: typeof record.confidence === "number" ? record.confidence : 0 };
  }
  return null;
}

/** Typed System One call. Returns null when disabled, unconfigured, or the network/parse fails. */
export async function askJev(request: JevRequest, deps: AskJevDeps = {}): Promise<Record<string, JevAnswer> | null> {
  const config = jevRequestConfig(deps.env ?? process.env);
  if (!config) return null;
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
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
    const answers: Record<string, JevAnswer> = {};
    for (const [key, value] of Object.entries(rawAnswers)) {
      const parsed = parseAnswer(value);
      if (parsed) answers[key] = parsed;
    }
    return Object.keys(answers).length > 0 ? answers : null;
  } catch {
    return null;
  }
}

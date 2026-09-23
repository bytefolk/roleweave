import { reportAdviceSuggestions, type ReportAdviceSuggestion } from "@roleweave/shared";

/** Fixed official origin: opting in never authorizes a configurable third-party proxy.
 * Contract verified against https://docs.typesafe.ai/api on 2026-09-22. */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MAX_ADVICE_ITEMS = 20;
export type AdviceErrorCode = "turn_budget_exceeded" | "position_budget_exceeded" |
  "engine_unavailable" | "turn_engine_unavailable" | "turn_timeout" | "turn_failed" | "turn_indeterminate" | "other";
export interface AdviceMetadata {
  status: "failed" | "indeterminate";
  errorCode: AdviceErrorCode;
  budgetRelated: boolean;
}
export interface AdviceProvider {
  evaluate(items: AdviceMetadata[], signal: AbortSignal): Promise<ReportAdviceSuggestion[]>;
}

const criteria: Record<ReportAdviceSuggestion, string> = {
  inspect_budget: "Review the declared budget and recorded usage before deciding what to do.",
  check_connection: "Check whether the execution engine is reachable and configured.",
  inspect_run: "Read the local execution evidence to understand the failure before acting.",
  insufficient_information: "The limited metadata does not support a specific next step.",
};
const probability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Only these typed fields cross the external boundary. No local IDs or free text. */
export function normalizeAdviceMetadata(item: { status: "failed" | "indeterminate"; code: string; budgetRelated: boolean }): AdviceMetadata {
  const known: AdviceErrorCode[] = ["turn_budget_exceeded", "position_budget_exceeded", "engine_unavailable", "turn_engine_unavailable", "turn_timeout", "turn_failed", "turn_indeterminate"];
  return {
    status: item.status,
    errorCode: known.includes(item.code as AdviceErrorCode) ? item.code as AdviceErrorCode : "other",
    budgetRelated: item.budgetRelated,
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("invalid provider response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) throw new Error("provider response too large");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { await reader.cancel().catch(() => undefined); }
}

export class JevAdviceProvider implements AdviceProvider {
  constructor(private readonly apiKey: string, private readonly model = "jev-latest", private readonly fetcher: typeof fetch = fetch) {}

  async evaluate(items: AdviceMetadata[], signal: AbortSignal): Promise<ReportAdviceSuggestion[]> {
    if (items.length === 0 || items.length > MAX_ADVICE_ITEMS) throw new Error("invalid provider batch");
    const questions = Object.fromEntries(items.map((_, index) => [`item_${index}`, {
      type: "choice",
      instructions: `Suggest a human's next investigation step for state[${index}] using only its failure metadata. Do not infer urgency, ownership, business impact, or task content. This is advisory and cannot authorize an action. Select insufficient_information when uncertain.`,
      criteria,
    }]));
    const response = await this.fetcher(JEV_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      redirect: "error",
      signal,
      body: JSON.stringify({ model: this.model, state: items.map(item => ({
        status: item.status, errorCode: item.errorCode, budgetRelated: item.budgetRelated,
      })), questions }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("provider unavailable");
    }
    const raw = await boundedJson(response) as { answers?: Record<string, unknown> } | null;
    if (!raw || !raw.answers || typeof raw.answers !== "object") throw new Error("invalid provider response");
    return items.map((_, index) => {
      const answer = raw.answers![`item_${index}`] as Record<string, unknown> | undefined;
      if (!answer || answer.type !== "choice" || !reportAdviceSuggestions.includes(answer.choice as ReportAdviceSuggestion) ||
        !probability(answer.confidence) || !answer.probabilities || typeof answer.probabilities !== "object") throw new Error("invalid provider answer");
      const probabilities = answer.probabilities as Record<string, unknown>;
      if (Object.keys(probabilities).length !== reportAdviceSuggestions.length ||
        reportAdviceSuggestions.some(key => !probability(probabilities[key])) ||
        Math.abs(reportAdviceSuggestions.reduce((sum, key) => sum + (probabilities[key] as number), 0) - 1) > 0.01) throw new Error("invalid provider probabilities");
      const selectedProbability = probabilities[answer.choice as ReportAdviceSuggestion] as number;
      if (reportAdviceSuggestions.some(key => (probabilities[key] as number) > selectedProbability + 0.000001)) throw new Error("inconsistent provider choice");
      // Conservative preview guard, not a calibrated accuracy claim. The threshold
      // must be evaluated against real examples before this preview graduates.
      return answer.confidence < 0.6 ? "insufficient_information" : answer.choice as ReportAdviceSuggestion;
    });
  }
}

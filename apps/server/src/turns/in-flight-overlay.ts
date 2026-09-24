import { askLaya, type LayaAsk } from "../laya/client.js";
import { layaEnabled } from "../laya/config.js";

export interface InFlightFact {
  positionId: string;
  status: "running";
  goalId?: string;
  errorCode?: string;
}

export type InFlightMatching = "abstain" | "join_existing" | "send_anyway";

const ALLOWED_FACT_KEYS = new Set(["positionId", "status", "errorCode"]);

/** Running statuses and error codes only. No inputs/outputs. */
export function assertInFlightAdvicePayload(payload: Record<string, unknown>): void {
  const extra = Object.keys(payload).filter((key) => !ALLOWED_FACT_KEYS.has(key));
  if (extra.length > 0) {
    throw new Error(`in-flight advice payload has forbidden keys: ${extra.sort().join(",")}`);
  }
  if (typeof payload.positionId !== "string" || payload.positionId.length === 0) {
    throw new Error("in-flight advice payload positionId is invalid");
  }
  if (payload.status !== "running") {
    throw new Error("in-flight advice payload status is invalid");
  }
  if (payload.errorCode !== undefined && (typeof payload.errorCode !== "string" || payload.errorCode.length === 0)) {
    throw new Error("in-flight advice payload errorCode is invalid");
  }
}

export function presentInFlightOverlay(input: {
  flagOn: boolean;
  hasConfirmedTaskSummary: boolean;
  facts: InFlightFact[];
  choice?: InFlightMatching;
}): { visible: boolean; facts: InFlightFact[]; matching: InFlightMatching } {
  if (!input.flagOn) {
    return { visible: false, facts: [], matching: "abstain" };
  }
  const facts = input.facts.filter((fact) => fact.status === "running");
  if (!input.hasConfirmedTaskSummary) {
    return { visible: true, facts, matching: "abstain" };
  }
  const choice = input.choice === "join_existing" || input.choice === "send_anyway" ? input.choice : "abstain";
  return { visible: true, facts, matching: choice };
}

export interface ResolveInFlightChoiceDeps {
  env?: NodeJS.Dict<string>;
  ask?: LayaAsk;
}

/** Advisory. Never cancels a turn. State is codes-only. */
export async function resolveInFlightChoice(
  facts: InFlightFact[],
  hasConfirmedTaskSummary: boolean,
  deps: ResolveInFlightChoiceDeps = {},
): Promise<InFlightMatching> {
  const env = deps.env ?? process.env;
  if (!layaEnabled(env) || !hasConfirmedTaskSummary || facts.length === 0) return "abstain";
  const payload = facts.map((fact) => {
    const row: Record<string, unknown> = { positionId: fact.positionId, status: fact.status };
    if (fact.errorCode) row.errorCode = fact.errorCode;
    assertInFlightAdvicePayload(row);
    return row;
  });
  const ask = deps.ask ?? ((request) => askLaya(request, { env }));
  try {
    const answers = await ask({
      state: { running: payload },
      questions: {
        action: {
          type: "choice",
          instructions: "Join an existing running turn or send anyway. Never cancel.",
          criteria: {
            join_existing: "Same goal or error is already running",
            send_anyway: "Operator should still send a new turn",
          },
        },
      },
    });
    const selected = answers?.action?.type === "choice" ? answers.action.selected : undefined;
    if (selected === "join_existing" || selected === "send_anyway") return selected;
    return "abstain";
  } catch {
    return "abstain";
  }
}

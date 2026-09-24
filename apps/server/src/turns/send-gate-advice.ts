import { sendGateAdviceChoices, type PositionMode, type SendGateAdviceChoice } from "@roleweave/shared";
import type { LayaAnswer, LayaAsk } from "../laya/client.js";

export interface SendGateAdviceState {
  positionId: string;
  mode: PositionMode;
  taskSummary: string;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function parseSendGateChoice(answer: LayaAnswer | undefined): SendGateAdviceChoice | null {
  if (!answer || answer.type !== "choice" ||
    !sendGateAdviceChoices.includes(answer.selected as SendGateAdviceChoice) ||
    !probability(answer.confidence) || answer.confidence < 0.6) return null;
  const keys = Object.keys(answer.probabilities);
  if (keys.length !== sendGateAdviceChoices.length ||
    sendGateAdviceChoices.some(choice => !probability(answer.probabilities[choice]))) return null;
  const total = sendGateAdviceChoices.reduce((sum, choice) => sum + answer.probabilities[choice]!, 0);
  const selected = answer.selected as SendGateAdviceChoice;
  if (Math.abs(total - 1) > 0.01 ||
    sendGateAdviceChoices.some(choice => answer.probabilities[choice]! > answer.probabilities[selected]! + 0.000001)) return null;
  return selected;
}

/** Advisory only. The caller owns consent and authoritative role lookup. */
export async function resolveSendGateChoice(state: SendGateAdviceState, ask: LayaAsk): Promise<SendGateAdviceChoice | null> {
  const answers = await ask({
    state: { positionId: state.positionId, mode: state.mode, taskSummary: state.taskSummary },
    questions: {
      humanGate: {
        type: "choice",
        instructions: "Choose whether this task should keep the employee's current mode or be presented as requiring human approval. Advisory only; do not authorize, deny, or execute anything.",
        criteria: {
          keep: "Keep the current employee mode for this send-time preview.",
          approval_required: "Suggest human approval for this send-time preview.",
        },
      },
    },
  });
  return parseSendGateChoice(answers?.humanGate);
}

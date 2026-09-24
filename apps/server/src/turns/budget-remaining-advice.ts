import {
  budgetRemainingAdviceChoices,
  type BudgetRemainingAdviceChoice,
  type BudgetRemainingFact,
  type BudgetReport,
} from "@roleweave/shared";
import type { LayaAnswer, LayaAsk } from "../laya/client.js";

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function parseBudgetRemainingChoice(
  answer: LayaAnswer | undefined,
): BudgetRemainingAdviceChoice | null {
  if (!answer || answer.type !== "choice" ||
    Object.keys(answer).some(key => !["type", "selected", "probabilities", "confidence"].includes(key)) ||
    !budgetRemainingAdviceChoices.includes(answer.selected as BudgetRemainingAdviceChoice) ||
    !probability(answer.confidence) || answer.confidence < 0.6) return null;
  const keys = Object.keys(answer.probabilities);
  if (keys.length !== budgetRemainingAdviceChoices.length ||
    budgetRemainingAdviceChoices.some(choice => !probability(answer.probabilities[choice]))) return null;
  const total = budgetRemainingAdviceChoices.reduce((sum, choice) => sum + answer.probabilities[choice]!, 0);
  const selected = answer.selected as BudgetRemainingAdviceChoice;
  if (Math.abs(total - 1) > 0.01 ||
    budgetRemainingAdviceChoices.some(choice => answer.probabilities[choice]! > answer.probabilities[selected]! + 0.000001)) return null;
  return selected;
}

/**
 * Project only facts already proved by reports.v1. The report contract has no
 * authoritative daily bucket, so daily remaining stays explicitly unknown.
 */
export function projectBudgetRemainingFact(
  positionId: string,
  budget: BudgetReport | undefined,
): BudgetRemainingFact {
  const cap = budget?.declared.perTask.tokens;
  const used = budget?.latestTurn?.totalTokens;
  const known = Number.isSafeInteger(cap) && (cap as number) >= 0 &&
    Number.isSafeInteger(used) && (used as number) >= 0;
  return {
    positionId,
    remainingPerTask: known ? Math.max(0, cap! - used!) : null,
    remainingPerDay: null,
  };
}

/** Advisory only. The caller owns consent and all authoritative actions. */
export async function resolveBudgetRemainingChoice(
  state: { positionId: string; remainingPerTask: number; remainingPerDay: number },
  ask: LayaAsk,
): Promise<BudgetRemainingAdviceChoice | null> {
  if (!Number.isSafeInteger(state.remainingPerTask) || state.remainingPerTask < 0 ||
    !Number.isSafeInteger(state.remainingPerDay) || state.remainingPerDay < 0) return null;
  const answers = await ask({
    state: {
      remainingPerTask: state.remainingPerTask,
      remainingPerDay: state.remainingPerDay,
      positionId: state.positionId,
    },
    questions: {
      budgetAction: {
        type: "choice",
        instructions: "Choose one advisory pre-send action from the fixed list. Do not change a budget, select an employee, or send a turn.",
        criteria: {
          shrink: "Suggest reducing the unsent task scope.",
          switch_employee: "Suggest considering another employee.",
          send_anyway: "Suggest keeping the unsent task as-is.",
        },
      },
    },
  });
  return parseBudgetRemainingChoice(answers?.budgetAction);
}

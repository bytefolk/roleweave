import { askJev, type JevAsk } from "./client.js";
import { jevEnabled } from "./config.js";

export interface OverlayDeps {
  env?: NodeJS.Dict<string>;
  ask?: JevAsk;
}

export interface AuditGoalBinding {
  goalId: string;
  positionIds: string[];
}

/** Join dismissed/moved ids to goal branch positionIds. No audit diff text. */
export async function resolveUncoveredGoals(
  dismissedIds: readonly string[],
  movedIds: readonly string[],
  goals: readonly AuditGoalBinding[],
  deps: OverlayDeps = {},
): Promise<string[] | null> {
  const env = deps.env ?? process.env;
  const gone = [...new Set([...dismissedIds, ...movedIds])];
  if (!jevEnabled(env) || gone.length === 0 || goals.length === 0) return null;
  const ask = deps.ask ?? ((request) => askJev(request, { env }));
  try {
    const answers = await ask({
      state: { gone, goals },
      questions: {
        uncovered: {
          type: "noul",
          instructions: "Probability this org change leaves a listed goal with no remaining bound position.",
        },
      },
    });
    if (answers?.uncovered?.type !== "noul" || answers.uncovered.probability < 0.5) return null;
    const uncovered = goals
      .filter((goal) =>
        goal.positionIds.length > 0 && goal.positionIds.every((id) => gone.includes(id)),
      )
      .map((goal) => goal.goalId);
    return uncovered.length > 0 ? uncovered : null;
  } catch {
    return null;
  }
}

import { askJev, type JevAsk } from "./client.js";
import { jevEnabled } from "./config.js";

export interface OverlayDeps {
  env?: NodeJS.Dict<string>;
  ask?: JevAsk;
}

export interface StaleGoalState {
  updatedAt: string;
  boundTurnCount: number;
  lastTerminalAt?: string;
}

/** Stale is separate from healthOverlay. Does not write goal.health. */
export async function resolveStaleOverlay(
  state: StaleGoalState,
  deps: OverlayDeps = {},
): Promise<boolean | null> {
  const env = deps.env ?? process.env;
  if (!jevEnabled(env)) return null;
  const ask = deps.ask ?? ((request) => askJev(request, { env }));
  try {
    const answers = await ask({
      state,
      questions: {
        stale: {
          type: "noul",
          instructions: "Probability this goal has silently stalled (no recent bound work) even if heuristic health is not at_risk.",
        },
      },
    });
    if (answers?.stale?.type !== "noul") return null;
    return answers.stale.probability >= 0.5 ? true : null;
  } catch {
    return null;
  }
}

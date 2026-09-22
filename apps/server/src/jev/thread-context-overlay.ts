import { askJev, type JevAsk } from "./client.js";
import { jevEnabled } from "./config.js";

export interface OverlayDeps {
  env?: NodeJS.Dict<string>;
  ask?: JevAsk;
}

export interface ThreadContextOverlayState {
  enabled: boolean;
  sourceTurnCount: number;
  contextBytes: number;
  truncated: boolean;
  omittedTurnCount: number;
  failedOrCancelledCount: number;
}

export interface ThreadContextOverlay {
  suggestRotate?: boolean;
  suggestDisable?: boolean;
}

/** Suggest rotate or disable. Does not PATCH the session. No turn bodies. */
export async function resolveThreadContextOverlay(
  state: ThreadContextOverlayState,
  deps: OverlayDeps = {},
): Promise<ThreadContextOverlay | null> {
  const env = deps.env ?? process.env;
  if (!jevEnabled(env)) return null;
  const ask = deps.ask ?? ((request) => askJev(request, { env }));
  try {
    const answers = await ask({
      state,
      questions: {
        rotate: {
          type: "noul",
          instructions: "Probability the operator should rotate to a fresh session before the next turn.",
        },
        disable: {
          type: "noul",
          instructions: "Probability the operator should turn history off for the next turn.",
        },
      },
    });
    const suggestRotate = answers?.rotate?.type === "noul" ? answers.rotate.probability >= 0.5 : undefined;
    const suggestDisable = answers?.disable?.type === "noul" ? answers.disable.probability >= 0.5 : undefined;
    if (suggestRotate === undefined && suggestDisable === undefined) return null;
    const overlay: ThreadContextOverlay = {};
    if (suggestRotate) overlay.suggestRotate = true;
    if (suggestDisable) overlay.suggestDisable = true;
    return Object.keys(overlay).length > 0 ? overlay : null;
  } catch {
    return null;
  }
}

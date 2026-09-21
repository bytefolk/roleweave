import type { EscalationEntry } from "@roleweave/shared";
import { askJev, type JevAsk } from "./client.js";
import { jevEnabled } from "./config.js";

const CATEGORIES = ["budget", "permission", "engine-error", "user-cancelled", "benign"] as const;
export type EscalationCategory = (typeof CATEGORIES)[number];

export interface OverlayDeps {
  env?: NodeJS.Dict<string>;
  ask?: JevAsk;
}

function isCategory(value: string): value is EscalationCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}

/** Advisory chips only. Never drops a row. State is status/errorCode only. */
export async function overlayEscalations(
  entries: EscalationEntry[],
  deps: OverlayDeps = {},
): Promise<EscalationEntry[]> {
  const env = deps.env ?? process.env;
  if (!jevEnabled(env) || entries.length === 0) return entries;
  const ask = deps.ask ?? ((request) => askJev(request, { env }));
  const head = entries.slice(0, 20);
  const overlaid = await Promise.all(head.map(async (entry) => {
    try {
      const answers = await ask({
        state: { status: entry.status, errorCode: entry.code, budgetRelated: entry.budgetRelated },
        questions: {
          category: {
            type: "choice",
            instructions: "Classify this failed or indeterminate turn without conversation content.",
            criteria: {
              budget: "Token or iteration budget exhausted",
              permission: "Waiting on approval or missing capability",
              "engine-error": "Engine or process failed",
              "user-cancelled": "Operator cancelled",
              benign: "No human action needed",
            },
          },
          needsAttention: {
            type: "noul",
            instructions: "Probability that the org owner should personally handle this row.",
          },
        },
      });
      const selected = answers?.category?.type === "choice" ? answers.category.selected : undefined;
      const category = typeof selected === "string" && isCategory(selected) ? selected : undefined;
      const needsAttention = answers?.needsAttention?.type === "noul"
        ? answers.needsAttention.probability >= 0.5
        : undefined;
      return {
        ...entry,
        ...(category ? { category } : {}),
        ...(needsAttention !== undefined ? { needsAttention } : {}),
      };
    } catch {
      return entry;
    }
  }));
  return [...overlaid, ...entries.slice(20)];
}

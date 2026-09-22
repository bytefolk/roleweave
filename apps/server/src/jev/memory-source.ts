import { askJev, type JevAsk } from "./client.js";
import { jevEnabled } from "./config.js";

export const MEMORY_RAILS = ["docs", "shared", "sessions", "drive"] as const;
export type MemoryRail = (typeof MEMORY_RAILS)[number];

export interface OverlayDeps {
  env?: NodeJS.Dict<string>;
  ask?: JevAsk;
}

export interface MemorySourceState {
  kind: string;
  state: string;
  binding: string;
  itemCount?: number;
}

/** Suggest a MemoryModule rail. Does not bind hire memoryScope. */
export async function resolveMemorySourceOverlay(
  sources: readonly MemorySourceState[],
  deps: OverlayDeps = {},
): Promise<MemoryRail | null> {
  const env = deps.env ?? process.env;
  if (!jevEnabled(env)) return null;
  const ask = deps.ask ?? ((request) => askJev(request, { env }));
  try {
    const answers = await ask({
      state: { sources: sources.map((source) => ({
        kind: source.kind,
        state: source.state,
        binding: source.binding,
        itemCount: source.itemCount ?? 0,
      })) },
      questions: {
        rail: {
          type: "choice",
          instructions: "Pick which memory rail the operator should open. No file contents.",
          criteria: {
            docs: "Position knowledge files",
            shared: "Team shared documents",
            sessions: "Prior session receipts",
            drive: "Workspace drive",
          },
        },
      },
    });
    const selected = answers?.rail?.type === "choice" ? answers.rail.selected : undefined;
    if (selected === "docs" || selected === "shared" || selected === "sessions" || selected === "drive") {
      return selected;
    }
    return null;
  } catch {
    return null;
  }
}

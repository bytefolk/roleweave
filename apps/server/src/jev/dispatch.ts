import type { GroupConversation, GroupExecutionMode } from "@roleweave/shared";
import { askJev, type JevAsk } from "./client.js";
import { jevEnabled } from "./config.js";

export interface OverlayDeps {
  env?: NodeJS.Dict<string>;
  ask?: JevAsk;
}

export interface DispatchOverlay {
  mentions: string[];
  mode: GroupExecutionMode;
}

/** Prefill only. Must not be applied inside handleGroupTurnPost. */
export async function resolveDispatchOverlay(
  group: GroupConversation,
  members: readonly { id: string; name: string }[],
  deps: OverlayDeps = {},
): Promise<DispatchOverlay | null> {
  const env = deps.env ?? process.env;
  if (!jevEnabled(env) || group.members.length === 0) return null;
  const ask = deps.ask ?? ((request) => askJev(request, { env }));
  const allowed = new Set(group.members);
  try {
    const answers = await ask({
      state: {
        members: members.filter((member) => allowed.has(member.id)).map((member) => ({
          id: member.id,
          name: member.name,
        })),
      },
      questions: {
        mode: {
          type: "choice",
          instructions: "Choose parallel unless member titles look like a writer-then-reviewer relay.",
          criteria: {
            parallel: "Independent concurrent work",
            relay: "Ordered draft then review",
          },
        },
      },
    });
    const mode = answers?.mode?.type === "choice" && (answers.mode.selected === "parallel" || answers.mode.selected === "relay")
      ? answers.mode.selected
      : null;
    if (!mode) return null;
    const mentions = group.members.filter((id) => allowed.has(id));
    if (mentions.length === 0) return null;
    return { mentions, mode };
  } catch {
    return null;
  }
}

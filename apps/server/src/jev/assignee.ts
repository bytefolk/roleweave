import { askJev, type JevAsk } from "./client.js";
import { jevEnabled } from "./config.js";

export interface AssigneeRole {
  id: string;
  name: string;
  mode: string;
}

export interface OverlayDeps {
  env?: NodeJS.Dict<string>;
  ask?: JevAsk;
}

/** Suggest a positionId. Does not select or start a turn. */
export async function resolveAssigneeOverlay(
  roles: readonly AssigneeRole[],
  deps: OverlayDeps = {},
): Promise<{ positionId: string } | null> {
  const env = deps.env ?? process.env;
  if (!jevEnabled(env) || roles.length === 0) return null;
  const ask = deps.ask ?? ((request) => askJev(request, { env }));
  const ids = new Set(roles.map((role) => role.id));
  try {
    const answers = await ask({
      state: { roles: roles.map((role) => ({ id: role.id, name: role.name, mode: role.mode })) },
      questions: {
        assignee: {
          type: "choice",
          instructions: "Pick the positionId that is the safest default assignee from titles and modes only.",
          criteria: Object.fromEntries(roles.map((role) => [role.id, role.name])),
        },
      },
    });
    const selected = answers?.assignee?.type === "choice" ? answers.assignee.selected : undefined;
    if (typeof selected !== "string" || !ids.has(selected)) return null;
    return { positionId: selected };
  } catch {
    return null;
  }
}

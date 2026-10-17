import type { OwbT } from "@roleweave/ui";

export const goalCreatePresetIds = ["feature", "research", "content", "custom"] as const;
export type GoalCreatePresetId = typeof goalCreatePresetIds[number];

export interface GoalCreateDraft {
  title: string;
  description: string;
  criteria: string[];
}

/** Templates are local editable drafts. They never create or execute a goal. */
export function goalCreatePresetDraft(id: GoalCreatePresetId, t: OwbT): GoalCreateDraft {
  if (id === "custom") return { title: "", description: "", criteria: [] };
  const prefix = `creation.planPresets.${id}`;
  return { title: t(`${prefix}.title`), description: t(`${prefix}.description`),
    criteria: [0, 1, 2].map(index => t(`${prefix}.criteria.${index}`)) };
}

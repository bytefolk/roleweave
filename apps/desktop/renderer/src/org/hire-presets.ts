/** Role text only: presets never grant tools, access, memory or extra budget. */
export const HIRE_ROLE_PRESETS = [
  { id: "engineer", nameKey: "hire.preset.engineer.name", summaryKey: "hire.preset.engineer.summary", descriptionKey: "hire.preset.engineer.description" },
  { id: "designer", nameKey: "hire.preset.designer.name", summaryKey: "hire.preset.designer.summary", descriptionKey: "hire.preset.designer.description" },
  { id: "qa", nameKey: "hire.preset.qa.name", summaryKey: "hire.preset.qa.summary", descriptionKey: "hire.preset.qa.description" },
  { id: "research", nameKey: "hire.preset.research.name", summaryKey: "hire.preset.research.summary", descriptionKey: "hire.preset.research.description" },
] as const;

export type HireRolePreset = (typeof HIRE_ROLE_PRESETS)[number];
export type HireRolePresetId = HireRolePreset["id"];

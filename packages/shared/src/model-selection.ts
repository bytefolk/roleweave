export interface EmployeeModelOption {
  id: string;
  name: string;
  tier: "economy" | "balanced" | "powerful" | "auto" | "default";
}
export interface EmployeeModelConfig {
  selected: string;
  recommended: string;
  options: EmployeeModelOption[];
  source: "local-cache" | "provider-tiers" | "default";
  editable: boolean;
}
export function isModelId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value);
}

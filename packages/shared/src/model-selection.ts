export interface EmployeeModelOption {
  id: string;
  name: string;
  tier: "economy" | "balanced" | "powerful" | "auto" | "default";
  /** Concrete local mapping, not a claim about a provider's eventual routing. */
  resolvedModel?: string;
  billing?: "provider" | "subscription" | "qoder" | "unknown";
  connectionLabel?: string;
  /** Provider-reported model class; absent for an unknown saved selection. */
  group?: "tiers" | "models" | "custom";
}
export interface EmployeeModelConnection {
  source: "local-config" | "environment" | "official";
  kind: "gateway" | "official" | "unknown";
  /** Hostname only; no credentials, URL path or query are exposed. */
  endpointHost?: string;
  billing: "provider" | "subscription" | "qoder" | "unknown";
  /** Local preflight only, never a claim that remote authentication succeeded. */
  status: "configured" | "invalid";
  message?: string;
}
export interface EmployeeModelConfig {
  selected: string;
  recommended: string;
  options: EmployeeModelOption[];
  source: "local-cache" | "local-config" | "provider-tiers" | "provider-catalog" | "default";
  editable: boolean;
  connection?: EmployeeModelConnection;
  /** The CLI validates already-registered custom IDs without changing provider credentials. */
  allowCustomModel?: boolean;
  /** A stale catalog is an earlier account read, not a fresh entitlement check. */
  catalogStatus?: "ready" | "stale" | "unavailable";
}
export function isModelId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value);
}
/** Qoder's registered Custom selector can contain a user-facing Unicode name. */
export function isQoderModelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim()
    && !value.startsWith("-") && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
}
export function isEngineModelId(value: unknown, engine: unknown): value is string {
  return engine === "qoder" ? isQoderModelId(value) : isModelId(value);
}

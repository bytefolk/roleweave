export interface LocalProviderModel {
  id: string;
  name: string;
  resolvedModel?: string;
  tier?: "economy" | "balanced" | "powerful" | "default";
  billing?: "provider" | "subscription" | "qoder" | "unknown";
  connectionLabel?: string;
  endpointHost?: string;
}
export interface LocalProviderConnection {
  source: "local-config" | "environment" | "official";
  kind: "gateway" | "official" | "unknown";
  endpointHost?: string;
  billing: "provider" | "subscription" | "qoder" | "unknown";
  status: "configured" | "invalid";
  message?: string;
}
export interface LocalProviderConfig {
  /** INTERNAL ONLY: may contain authentication credentials. Never serialize in an API or log. */
  providerEnv: Record<string, string>;
  /** INTERNAL ONLY: allowlisted CLI settings, possibly including API keys. Never put in argv. */
  providerSettings: Record<string, any>;
  selectedDefault?: string;
  /** Safe for API/UI use: contains no credential or complete endpoint URL. */
  models: LocalProviderModel[];
  /** Describes local configuration only, not proof of successful remote authentication. */
  connection: LocalProviderConnection;
}
export class LocalProviderConfigError extends Error {
  readonly code: "local_provider_config_invalid";
  constructor(message: string);
}
export function resolveClaudeProviderConfig(env?: Record<string, string | undefined>, options?: { local?: boolean }): LocalProviderConfig;
/** Reads bounded user JSON/JSONC settings (comments only); does not execute or load project configuration. */
export function resolveQoderProviderConfig(env?: Record<string, string | undefined>, options?: { model?: string }): LocalProviderConfig;

/** Workspace-scoped, explicitly opted-in preview. Credentials remain server-only. */
export interface ExperimentsResponse {
  schemaVersion: "experiments.v1";
  workspacePath: string;
  /** Identifies this opening of a workspace, including A -> B -> A switches. */
  workspaceSession: string;
  revision: number;
  enabled: boolean;
  availability: "disabled" | "not_configured" | "ready" | "storage_error";
  provider: {
    name: "Laya · local";
    endpointHost: "127.0.0.1";
    /** Complete loopback destination used by the local provider request. */
    endpointUrl: string;
    configured: boolean;
  };
  sending: ["status", "errorCode", "budgetRelated"];
}

export interface ReportsAdviceRequest {
  workspacePath: string;
  workspaceSession: string;
  revision: number;
}

export interface ReadyHostFact {
  positionId: string;
  engine: string;
  ready: boolean;
}

export interface ReadyHostChoiceRequest extends ReportsAdviceRequest {
  candidates: ReadyHostFact[];
}

export interface ReadyHostChoiceResponse extends ReportsAdviceRequest {
  status: "ready" | "disabled" | "unavailable";
  reason?: "not_configured" | "timeout" | "provider_error" | "settings_invalid";
  positionId: string | null;
}

export interface ExperimentsUpdateRequest extends ReportsAdviceRequest {
  enabled: boolean;
}

export const reportAdviceSuggestions = [
  "inspect_budget", "check_connection", "inspect_run", "insufficient_information",
] as const;
export type ReportAdviceSuggestion = (typeof reportAdviceSuggestions)[number];

export interface ReportAdviceItem {
  turnId: string;
  positionId: string;
  /** Binds a suggestion to the exact local failure snapshot. Never sent externally. */
  at: string;
  suggestion: ReportAdviceSuggestion;
  source: "laya";
}

export interface ReportsAdviceResponse extends ReportsAdviceRequest {
  status: "ready" | "disabled" | "unavailable";
  reason?: "not_configured" | "timeout" | "provider_error" | "settings_invalid";
  items: ReportAdviceItem[];
  cached: boolean;
  considered: number;
  total: number;
  generatedAt: string | null;
}

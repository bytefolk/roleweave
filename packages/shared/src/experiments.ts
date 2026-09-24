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
  /** Deterministic fields used by the send-gate preview. */
  sendGateSending: ["positionId", "mode"];
  /** Sent only after a separate, per-request user confirmation. */
  sendGateOptional: ["taskSummary"];
}

export interface ReportsAdviceRequest {
  workspacePath: string;
  workspaceSession: string;
  revision: number;
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

export const sendGateAdviceChoices = ["keep", "approval_required"] as const;
export type SendGateAdviceChoice = (typeof sendGateAdviceChoices)[number];

export interface SendGateAdviceRequest extends ReportsAdviceRequest {
  positionId: string;
  taskSummary?: {
    value: string;
    confirmed: true;
  };
}

export interface SendGateAdviceResponse extends ReportsAdviceRequest {
  status: "ready" | "disabled" | "abstained" | "unavailable";
  reason?:
    | "flag_off"
    | "task_summary_required"
    | "not_configured"
    | "insufficient_information"
    | "timeout"
    | "provider_error"
    | "settings_invalid";
  rule: {
    positionId: string;
    mode: import("./org-tree.js").PositionMode;
  };
  suggestion: SendGateAdviceChoice | null;
}

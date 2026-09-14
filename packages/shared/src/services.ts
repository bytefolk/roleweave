/** Independent service boundary. Never include credentials in a view or probe. */
export type ExternalServiceKind = "doc" | "mem";
export interface ServiceConnectionInput {
  kind: ExternalServiceKind;
  apiUrl: string;
  webUrl?: string;
  /** Omitted: preserve existing token for the same origin. Empty: clear. */
  token?: string;
  workspaceId?: string;
}
export interface ServiceConnectionView {
  kind: ExternalServiceKind;
  apiUrl: string | null;
  webUrl: string | null;
  workspaceId: string | null;
  tokenConfigured: boolean;
  configured: boolean;
}
export interface ServiceProbe {
  kind: ExternalServiceKind;
  state: "ready" | "unconfigured" | "unauthorized" | "unavailable" | "incompatible";
  apiVersion: "v1";
  version: string | null;
  message: string;
  checkedAt: string;
}
export interface ServiceRelease {
  kind: ExternalServiceKind;
  state: "available" | "unpublished" | "unavailable";
  version: string | null;
  url: string;
  publishedAt: string | null;
  /** mem releases currently contain the MCP client, not the full service stack. */
  artifact: "source" | "mcp-client";
}
export interface ServicesResponse { connections: ServiceConnectionView[] }

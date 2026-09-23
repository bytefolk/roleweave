/** Read-only ontology projection. A relation is evidence, never a permission grant. */
export const RELATIONSHIP_GRAPH_SCHEMA = "relationship-graph.v1" as const;
export const relationshipNodeKinds = ["workspace", "agent", "host", "source", "resource", "capability", "policy", "goal", "task"] as const;
export type RelationshipNodeKind = typeof relationshipNodeKinds[number];
export type RelationshipBasis = "declared" | "observed";
export type RelationshipState = "ready" | "configured" | "available" | "not_configured" | "unknown" | "error";
export type RelationshipKind = "contains" | "reports_to" | "bound_to" | "declares_source" | "available_in" | "contains_resource" | "declares_allow" | "declares_deny" | "has_policy" | "assigned_to" | "requested_by" | "budget_owner";

export interface RelationshipEvidence {
  /** Safe source name, never credentials, raw tool arguments or an absolute host path. */
  source: string;
  locator: string;
  basis: RelationshipBasis;
  observedAt: string;
}

export interface RelationshipNode {
  id: string;
  kind: RelationshipNodeKind;
  label: string;
  state: RelationshipState;
  evidence: RelationshipEvidence;
  positionId?: string;
  resourcePath?: string;
  /** Explicit structured facts; a display value must not imply permission evaluation. */
  facts?: Array<{ key: string; value: string }>;
}

export interface RelationshipEdge {
  id: string;
  source: string;
  target: string;
  kind: RelationshipKind;
  evidence: RelationshipEvidence;
  /** P0 exposes configuration/observations, not a runtime access decision. */
  permission: "not_applicable" | "declaration_only" | "unknown";
}

export interface RelationshipCoverage {
  source: string;
  state: "complete" | "partial" | "not_connected" | "unsupported" | "error";
  count?: number;
  /** A stable reason code translated by the presentation layer. */
  reason?: string;
}

export interface RelationshipGraphResponse {
  schemaVersion: typeof RELATIONSHIP_GRAPH_SCHEMA;
  /** Workspace-scoped opaque ID; stable for this workspace, never a filesystem path. */
  workspaceId: string;
  generatedAt: string;
  revision: string;
  nodes: RelationshipNode[];
  edges: RelationshipEdge[];
  coverage: RelationshipCoverage[];
  truncated: boolean;
  limits: { nodes: number; edges: number };
}

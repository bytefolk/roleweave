/**
 * Organization tree contract mirror.
 *
 * org-tree.v1 mirrors the engine's frozen minimal shape
 * (digital-employee apps/cli/org/model.ts buildOrgTree +
 * configs/org-tree.schema.json, published per the schema-publishing
 * discipline). The node deliberately carries only id/reportTo/budget/
 * children; display names and modes live in workspace-org.v1 roles and are
 * served via /positions/:id — the client never invents semantics.
 *
 * workspace-org.v1 mirrors digital-employee `apps/cli/workspace/templates.ts`
 * RenderedOrganization plus the #157 R3 budget field (DEC-DE-157-002).
 * Budget units are tokens / iterations only — never currency (#155 non-goal).
 */

export const WORKSPACE_ORG_SCHEMA_VERSION = "workspace-org.v1" as const;
export const WORKSPACE_MANIFEST_SCHEMA_VERSION = "workspace.v1alpha1" as const;
export const ORG_TREE_SCHEMA_VERSION = "org-tree.v1" as const;

/** Budget scope: positive integer caps; each cap <= 1_000_000_000. */
export interface BudgetScope {
  tokens?: number;
  iterations?: number;
}

/**
 * Position budget declaration (REQ-006: hire = budget attached, exactly one
 * per position). "Fully allocated" = perTask AND perDay each carry at least
 * one positive integer cap; checking full allocation is the engine's job,
 * never the client's.
 */
export interface PositionBudget {
  perTask: BudgetScope;
  perDay: BudgetScope;
}

export interface PositionPackageRef {
  name: string;
  version: string;
  digest: string;
  /** Absolute final position path; state-bearing, never printed to logs. */
  localReference: string;
}

export type PositionMode = "read_only" | "approval_required";

export interface OrgRole {
  id: string;
  name: string;
  description: string;
  reportTo: string | null;
  package: PositionPackageRef;
  mode: PositionMode;
  memoryScope: string;
  toolAllow: string[];
  toolDeny: string[];
  budget: PositionBudget;
  metadata: Record<string, string>;
}

export interface OrganizationFile {
  $schema?: string;
  schemaVersion: typeof WORKSPACE_ORG_SCHEMA_VERSION;
  business: string;
  description: string;
  owner: string;
  roles: OrgRole[];
  updatedAt: string;
}

export interface OrgTreeVersion {
  /** Monotonic control-plane stamp; bumped on every org.updated. */
  seq: number;
  updatedAt: string;
}

/** org-tree.v1 node (frozen minimal shape — mirrors the engine builder). */
export interface OrgTreeNodeV1 {
  id: string;
  reportTo: string | null;
  budget: PositionBudget;
  children: OrgTreeNodeV1[];
}

/** org-tree.v1 snapshot served by GET /org/tree (frozen minimal shape). */
export interface OrgTreeSnapshot {
  schemaVersion: typeof ORG_TREE_SCHEMA_VERSION;
  business: string;
  owner: string;
  /** Applied-state stamp from the organization model; aligns org.updated. */
  updatedAt: string;
  positionCount: number;
  depth: number;
  tree: OrgTreeNodeV1[];
  /** Advisory Jev assignee; never written to org.json. */
  assigneeOverlay?: { positionId: string };
}

export interface WorkspaceManifest {
  $schema?: string;
  schemaVersion: typeof WORKSPACE_MANIFEST_SCHEMA_VERSION;
  name: string;
  description: string;
  template: string;
  createdAt: string;
  organization: string;
  positions: string;
  context: string;
}

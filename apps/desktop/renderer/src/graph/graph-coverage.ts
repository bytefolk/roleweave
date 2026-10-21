import type { RelationshipCoverage, RelationshipGraphResponse } from "@roleweave/shared/relationship-graph";

/** Expected scope boundaries remain disclosed; unknown gaps remain actionable. */
export function isExpectedCoverageScope(item: RelationshipCoverage): boolean {
  if (item.state !== "partial") return false;
  return (item.source === "workspace_identity" && item.reason === "local_identity_fallback")
    || (/^permissions:[a-zA-Z0-9_-]+$/.test(item.source) && item.reason === "permission_manifest_missing")
    || (["mem", "doc"].includes(item.source) && item.reason === "external_inventory_not_loaded")
    || (item.source === "context" && item.reason === "recall_lineage_not_loaded");
}

export function graphCoverageIssues(data: RelationshipGraphResponse | null): RelationshipCoverage[] {
  return data?.coverage.filter(item => item.state === "error"
    || (item.state === "partial" && !isExpectedCoverageScope(item))
    || (item.state === "not_connected" && item.source.startsWith("documents:") && item.reason === "package_missing")) ?? [];
}

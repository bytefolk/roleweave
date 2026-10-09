import { describe, expect, it } from "vitest";
import type { RelationshipCoverage, RelationshipGraphResponse } from "@roleweave/shared/relationship-graph";
import { graphCoverageIssues } from "../src/graph/graph-coverage";

function snapshot(coverage: RelationshipCoverage[]): RelationshipGraphResponse {
  return { schemaVersion: "relationship-graph.v1", workspaceId: "coverage-test", revision: "1", generatedAt: "2026-10-09T00:00:00Z",
    nodes: [], edges: [], coverage, truncated: false, limits: { nodes: 400, edges: 800 } };
}

describe("relationship coverage diagnostics", () => {
  it("discloses expected integration boundaries without reporting local data corruption", () => {
    const data = snapshot([
      { source: "workspace_identity", state: "partial", reason: "local_identity_fallback" },
      { source: "permissions:employee", state: "partial", reason: "permission_manifest_missing" },
      { source: "doc", state: "partial", reason: "external_inventory_not_loaded" },
      { source: "context", state: "partial", reason: "recall_lineage_not_loaded" },
      { source: "mem", state: "not_connected", reason: "service_not_configured" },
      { source: "execution_lineage", state: "unsupported", reason: "task_run_link_unavailable" },
    ]);
    const before = structuredClone(data);
    expect(graphCoverageIssues(data)).toEqual([]);
    expect(data).toEqual(before);
  });

  it("keeps upstream errors, unreadable records, limits and missing role packages actionable", () => {
    const problems: RelationshipCoverage[] = [
      { source: "mem", state: "error", reason: "inventory_upstream_failed" },
      { source: "goals", state: "partial", reason: "invalid_or_unresolved_record" },
      { source: "documents:employee", state: "partial", reason: "document_limit" },
      { source: "documents:missing", state: "not_connected", reason: "package_missing" },
    ];
    expect(graphCoverageIssues(snapshot(problems))).toEqual(problems);
  });

  it("does not whitelist unknown sources or turn an explicit error into an expected boundary", () => {
    const problems: RelationshipCoverage[] = [
      { source: "new_source", state: "partial", reason: "external_inventory_not_loaded" },
      { source: "mem", state: "partial", reason: "unknown_reason" },
      { source: "workspace_identity", state: "error", reason: "local_identity_fallback" },
    ];
    expect(graphCoverageIssues(snapshot(problems))).toEqual(problems);
    expect(graphCoverageIssues(null)).toEqual([]);
  });
});

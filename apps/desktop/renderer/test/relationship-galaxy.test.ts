import { describe, expect, it } from "vitest";
import type { RelationshipEdge, RelationshipNode } from "@roleweave/shared";
import { buildRelationshipGalaxyLayout, buildRelationshipSpatialLayout } from "../src/graph/RelationshipSpatialScene";

const evidence = { source: "test", locator: "graph", basis: "observed" as const, observedAt: "2026-09-25T00:00:00Z" };
const nodes: RelationshipNode[] = [
  { id: "workspace:one", kind: "workspace", label: "Workspace", state: "ready", evidence },
  { id: "agent:alice", kind: "agent", label: "Alice", state: "ready", evidence },
  { id: "source:docs", kind: "source", label: "Docs", state: "configured", evidence },
  { id: "resource:brief", kind: "resource", label: "Brief", state: "ready", evidence },
];
const edges: RelationshipEdge[] = [
  { id: "one", source: "workspace:one", target: "agent:alice", kind: "contains", evidence, permission: "not_applicable" },
  { id: "two", source: "agent:alice", target: "source:docs", kind: "declares_source", evidence, permission: "declaration_only" },
];

describe("relationship spatial layouts", () => {
  it("deterministically places every projected object around a central workspace", () => {
    const first = buildRelationshipGalaxyLayout(nodes, edges);
    const second = buildRelationshipGalaxyLayout(nodes, edges);

    expect(first).toEqual(second);
    expect(first.map(point => point.id)).toEqual(nodes.map(node => node.id));
    expect(first.find(point => point.id === "workspace:one")).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(first.every(point => [point.x, point.y, point.z, point.size].every(Number.isFinite))).toBe(true);
    expect(new Set(first.map(point => `${point.x}:${point.y}:${point.z}`)).size).toBe(nodes.length);
  });

  it("uses the same node and edge contract for topology and orbit modes", () => {
    const topology = buildRelationshipSpatialLayout(nodes, edges, "topology");
    const orbit = buildRelationshipSpatialLayout(nodes, edges, "orbit");

    expect(topology.map(point => point.id)).toEqual(nodes.map(node => node.id));
    expect(orbit.map(point => point.id)).toEqual(nodes.map(node => node.id));
    expect(topology).not.toEqual(orbit);
    expect(topology.find(point => point.id === "resource:brief")?.size).toBeLessThan(
      topology.find(point => point.id === "agent:alice")!.size,
    );
  });
});

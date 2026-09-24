import { describe, expect, it } from "vitest";
import type { OrgTreeSnapshot } from "@roleweave/shared";
import {
  isInvalidStarMapDrop,
  kindForDepth,
  layoutStarMap,
  matchStarMapQuery,
  orbitRadiusForDepth,
} from "../src/org/star-map-layout";

const SNAPSHOT: OrgTreeSnapshot = {
  schemaVersion: "org-tree.v1",
  business: "oss-maintainer",
  owner: "repo-owner",
  updatedAt: "2026-08-23T00:00:00.000Z",
  positionCount: 4,
  depth: 2,
  tree: [
    {
      id: "repo-owner",
      reportTo: null,
      budget: { perTask: { tokens: 1 }, perDay: { tokens: 1 } },
      children: [
        {
          id: "community-operator",
          reportTo: "repo-owner",
          budget: { perTask: { tokens: 1 }, perDay: { tokens: 1 } },
          children: [
            {
              id: "docs-writer",
              reportTo: "community-operator",
              budget: { perTask: { tokens: 1 }, perDay: { tokens: 1 } },
              children: [],
            },
          ],
        },
        {
          id: "issue-researcher",
          reportTo: "repo-owner",
          budget: { perTask: { tokens: 1 }, perDay: { tokens: 1 } },
          children: [],
        },
        {
          id: "release-engineer",
          reportTo: "repo-owner",
          budget: { perTask: { tokens: 1 }, perDay: { tokens: 1 } },
          children: [],
        },
      ],
    },
  ],
};

describe("star-map layout", () => {
  it("maps owner to the star at the origin and direct reports to one orbit", () => {
    const layout = layoutStarMap(SNAPSHOT);
    expect(layout.starId).toBe("repo-owner");
    const star = layout.bodies.find((body) => body.id === "repo-owner")!;
    expect(star.kind).toBe("star");
    expect(star).toMatchObject({ x: 0, y: 0, z: 0, depth: 0 });
    const planets = layout.bodies.filter((body) => body.kind === "planet");
    expect(planets.map((body) => body.id).sort()).toEqual([
      "community-operator",
      "issue-researcher",
      "release-engineer",
    ]);
    expect(new Set(planets.map((body) => body.orbitRadius)).size).toBe(1);
    expect(layout.rings.some((ring) => ring.parentId === "repo-owner")).toBe(true);
  });

  it("places moons on the parent planet ring, not the star ring", () => {
    const layout = layoutStarMap(SNAPSHOT);
    const moon = layout.bodies.find((body) => body.id === "docs-writer")!;
    const planet = layout.bodies.find((body) => body.id === "community-operator")!;
    expect(moon.kind).toBe("moon");
    expect(moon.parentId).toBe("community-operator");
    const dx = moon.x - planet.x;
    const dy = moon.y - planet.y;
    const dz = moon.z - planet.z;
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(moon.orbitRadius, 6);
  });

  it("is deterministic and spaces siblings evenly", () => {
    const a = layoutStarMap(SNAPSHOT);
    const b = layoutStarMap(SNAPSHOT);
    expect(a).toEqual(b);
    const planets = a.bodies.filter((body) => body.kind === "planet");
    expect(planets).toHaveLength(3);
    expect(planets.map((body) => body.siblingIndex).sort()).toEqual([0, 1, 2]);
  });

  it("orbits roots around a virtual origin when the owner is not in the tree", () => {
    const layout = layoutStarMap({ ...SNAPSHOT, owner: "missing-ceo", tree: SNAPSHOT.tree[0]!.children });
    expect(layout.starId).toBeNull();
    expect(layout.bodies.every((body) => body.kind !== "star")).toBe(true);
    expect(layout.rings.some((ring) => ring.parentId === null && ring.x === 0)).toBe(true);
  });

  it("refuses self, descendant, and owner drops", () => {
    expect(isInvalidStarMapDrop(SNAPSHOT, "community-operator", "community-operator")).toBe(true);
    expect(isInvalidStarMapDrop(SNAPSHOT, "community-operator", "docs-writer")).toBe(true);
    expect(isInvalidStarMapDrop(SNAPSHOT, "repo-owner", "issue-researcher")).toBe(true);
    expect(isInvalidStarMapDrop(SNAPSHOT, "docs-writer", "issue-researcher")).toBe(false);
  });

  it("matches search by id or display name and keeps every hit in a 100+ tree", () => {
    const wide: OrgTreeSnapshot = {
      ...SNAPSHOT,
      owner: "n0",
      positionCount: 120,
      tree: [
        {
          id: "n0",
          reportTo: null,
          budget: { perTask: { tokens: 1 }, perDay: { tokens: 1 } },
          children: Array.from({ length: 119 }, (_, index) => ({
            id: `n${index + 1}`,
            reportTo: "n0",
            budget: { perTask: { tokens: 1 }, perDay: { tokens: 1 } },
            children: [],
          })),
        },
      ],
    };
    const layout = layoutStarMap(wide);
    expect(layout.bodies).toHaveLength(120);
    const names: Record<string, string> = { n42: "Release Engineer" };
    expect(matchStarMapQuery(layout.bodies, names, "Release")).toEqual(["n42"]);
    expect(matchStarMapQuery(layout.bodies, names, "n118")).toEqual(["n118"]);
    expect(matchStarMapQuery(layout.bodies, names, "   ")).toHaveLength(120);
  });

  it("keeps planet orbits larger than moon orbits", () => {
    expect(orbitRadiusForDepth(1, 3)).toBeGreaterThan(orbitRadiusForDepth(2, 3));
    expect(kindForDepth(0)).toBe("star");
    expect(kindForDepth(2)).toBe("moon");
  });
});

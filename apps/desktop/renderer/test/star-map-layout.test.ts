import { describe, expect, it } from "vitest";
import type { OrgTreeSnapshot } from "@roleweave/shared";
import {
  buildCelestialLayout,
  isInvalidStarDrop,
  matchStarQuery,
  VIRTUAL_STAR_ID,
} from "../src/org/star-map-layout";

const snapshot: OrgTreeSnapshot = {
  schemaVersion: "org-tree.v1",
  business: "开源业务",
  owner: "ceo",
  updatedAt: "2026-09-23T04:00:00.000Z",
  positionCount: 4,
  depth: 3,
  tree: [
    {
      id: "ceo",
      reportTo: null,
      budget: { perTask: { tokens: 40000 }, perDay: {} },
      children: [
        {
          id: "platform-lead",
          reportTo: "ceo",
          budget: { perTask: {}, perDay: {} },
          children: [
            {
              id: "frontend",
              reportTo: "platform-lead",
              budget: { perTask: {}, perDay: {} },
              children: [],
            },
          ],
        },
        {
          id: "design-lead",
          reportTo: "ceo",
          budget: { perTask: {}, perDay: {} },
          children: [],
        },
      ],
    },
  ],
};

describe("celestial layout (#472): deterministic orbital mapping of the reporting tree", () => {
  it("empty or missing snapshot yields an empty sky", () => {
    expect(buildCelestialLayout(null).bodies).toEqual([]);
    expect(buildCelestialLayout({ ...snapshot, tree: [] }).bodies).toEqual([]);
  });

  it("owner becomes the star; reports become planets; deeper levels become moons", () => {
    const layout = buildCelestialLayout(snapshot);
    const byId = new Map(layout.bodies.map((body) => [body.id, body]));
    expect(layout.starId).toBe("ceo");
    expect(byId.get("ceo")?.kind).toBe("star");
    expect(byId.get("ceo")?.position).toEqual([0, 0, 0]);
    expect(byId.get("platform-lead")?.kind).toBe("planet");
    expect(byId.get("design-lead")?.kind).toBe("planet");
    expect(byId.get("frontend")?.kind).toBe("moon");
    expect(layout.maxDepth).toBe(2);
  });

  it("planets ride the base ring and moons ride their parent's ring", () => {
    const layout = buildCelestialLayout(snapshot);
    const byId = new Map(layout.bodies.map((body) => [body.id, body]));
    const distance = (position: readonly number[]) =>
      Math.sqrt(position[0] ** 2 + position[1] ** 2 + position[2] ** 2);
    for (const id of ["platform-lead", "design-lead"]) {
      expect(distance(byId.get(id)!.position)).toBeCloseTo(byId.get(id)!.orbitRadius!, 6);
    }
    const parent = byId.get("platform-lead")!;
    const moon = byId.get("frontend")!;
    const toParent = Math.sqrt(
      (moon.position[0] - parent.position[0]) ** 2 +
        (moon.position[1] - parent.position[1]) ** 2 +
        (moon.position[2] - parent.position[2]) ** 2,
    );
    expect(toParent).toBeCloseTo(moon.orbitRadius!, 6);
    // One orbit ring per parent that has children: ceo's ring + platform-lead's.
    expect(layout.orbits.map((orbit) => orbit.centerId).sort()).toEqual(["ceo", "platform-lead"]);
  });

  it("is deterministic: same snapshot, same sky", () => {
    expect(buildCelestialLayout(snapshot)).toEqual(buildCelestialLayout(snapshot));
  });

  it("synthesizes an enterprise star when the owner is not in the tree", () => {
    const layout = buildCelestialLayout({ ...snapshot, owner: "ghost" });
    expect(layout.starId).toBe(VIRTUAL_STAR_ID);
    expect(layout.bodies[0]?.virtual).toBe(true);
    expect(layout.bodies.find((body) => body.id === "ceo")?.kind).toBe("planet");
  });

  it("refuses cycles: self and descendant targets are invalid drops", () => {
    const layout = buildCelestialLayout(snapshot);
    expect(isInvalidStarDrop(layout, "platform-lead", "platform-lead")).toBe(true);
    expect(isInvalidStarDrop(layout, "platform-lead", "frontend")).toBe(true);
    expect(isInvalidStarDrop(layout, "frontend", "platform-lead")).toBe(false);
    expect(isInvalidStarDrop(layout, "design-lead", "ceo")).toBe(false);
  });

  it("search matches name and id case-insensitively, prefix-first", () => {
    const entries = [
      { id: "frontend", name: "前端工程师" },
      { id: "design-lead", name: "Design Lead" },
      { id: "undoc-id", name: "文档工程师" },
    ];
    expect(matchStarQuery(entries, "")).toEqual([]);
    expect(matchStarQuery(entries, "DESIGN")).toEqual(["design-lead"]);
    expect(matchStarQuery(entries, "doc")).toEqual(["undoc-id"]);
    expect(matchStarQuery(entries, "前端")).toEqual(["frontend"]);
    // Prefix on the human name outranks a prefix on the raw id.
    const ordered = [
      { id: "doc-a", name: "undoc name" },
      { id: "x", name: "Doc lead" },
    ];
    expect(matchStarQuery(ordered, "doc")).toEqual(["x", "doc-a"]);
  });
});

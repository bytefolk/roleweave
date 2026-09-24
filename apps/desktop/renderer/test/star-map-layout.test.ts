import { describe, expect, it } from "vitest";
import type { OrgTreeSnapshot, RelationshipGraphResponse } from "@roleweave/shared";
import {
  buildCelestialLayout,
  deriveKnowledgeLinks,
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
    // The focus card renders declared budgets verbatim from org-tree.v1.
    expect(byId.get("ceo")?.budget).toEqual({ perTask: { tokens: 40000 }, perDay: {} });
    expect(byId.get("frontend")?.budget).toEqual({ perTask: {}, perDay: {} });
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

  it("computes 3D topology network positions on a constellation sphere", () => {
    const layout = buildCelestialLayout(snapshot);
    const byId = new Map(layout.bodies.map((body) => [body.id, body]));
    expect(byId.get("ceo")?.networkPosition).toEqual([0, 0, 0]);
    const lead1 = byId.get("platform-lead")?.networkPosition;
    const lead2 = byId.get("design-lead")?.networkPosition;
    expect(lead1).toBeDefined();
    expect(lead2).toBeDefined();
    const distLead1 = Math.hypot(lead1![0], lead1![1], lead1![2]);
    const distLead2 = Math.hypot(lead2![0], lead2![1], lead2![2]);
    expect(distLead1).toBeCloseTo(26, 1);
    expect(distLead2).toBeCloseTo(26, 1);
    // Sub-member should be clustered near parent
    const moon = byId.get("frontend")?.networkPosition;
    expect(moon).toBeDefined();
    const distToParent = Math.hypot(moon![0] - lead1![0], moon![1] - lead1![1], moon![2] - lead1![2]);
    expect(distToParent).toBeGreaterThan(0);
    expect(distToParent).toBeLessThan(15);
  });

  it("dynamically adapts when digital employees are hired, dismissed, or reparented", () => {
    // 1. Initial layout
    const initial = buildCelestialLayout(snapshot);
    expect(initial.bodies.length).toBe(4);

    // 2. Hire a new digital employee (qa-engineer under platform-lead)
    const hiredSnapshot: OrgTreeSnapshot = {
      ...snapshot,
      positionCount: 5,
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
                { id: "frontend", reportTo: "platform-lead", budget: { perTask: {}, perDay: {} }, children: [] },
                { id: "qa-engineer", reportTo: "platform-lead", budget: { perTask: {}, perDay: {} }, children: [] },
              ],
            },
            { id: "design-lead", reportTo: "ceo", budget: { perTask: {}, perDay: {} }, children: [] },
          ],
        },
      ],
    };
    const afterHire = buildCelestialLayout(hiredSnapshot);
    expect(afterHire.bodies.length).toBe(5);
    const qaBody = afterHire.bodies.find((b) => b.id === "qa-engineer");
    expect(qaBody).toBeDefined();
    expect(qaBody?.parentId).toBe("platform-lead");
    expect(qaBody?.kind).toBe("moon");

    // 3. Move/reparent: move frontend from platform-lead to design-lead
    const movedSnapshot: OrgTreeSnapshot = {
      ...hiredSnapshot,
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
                { id: "qa-engineer", reportTo: "platform-lead", budget: { perTask: {}, perDay: {} }, children: [] },
              ],
            },
            {
              id: "design-lead",
              reportTo: "ceo",
              budget: { perTask: {}, perDay: {} },
              children: [
                { id: "frontend", reportTo: "design-lead", budget: { perTask: {}, perDay: {} }, children: [] },
              ],
            },
          ],
        },
      ],
    };
    const afterMove = buildCelestialLayout(movedSnapshot);
    const movedFrontend = afterMove.bodies.find((b) => b.id === "frontend");
    expect(movedFrontend?.parentId).toBe("design-lead");
    expect(afterMove.orbits.map((o) => o.centerId).sort()).toEqual(["ceo", "design-lead", "platform-lead"]);

    // 4. Dismiss: remove qa-engineer
    const dismissedSnapshot: OrgTreeSnapshot = {
      ...movedSnapshot,
      positionCount: 4,
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
              children: [],
            },
            {
              id: "design-lead",
              reportTo: "ceo",
              budget: { perTask: {}, perDay: {} },
              children: [
                { id: "frontend", reportTo: "design-lead", budget: { perTask: {}, perDay: {} }, children: [] },
              ],
            },
          ],
        },
      ],
    };
    const afterDismiss = buildCelestialLayout(dismissedSnapshot);
    expect(afterDismiss.bodies.length).toBe(4);
    expect(afterDismiss.bodies.some((b) => b.id === "qa-engineer")).toBe(false);
    // platform-lead has 0 children now, so only ceo and design-lead have orbit rings
    expect(afterDismiss.orbits.map((o) => o.centerId).sort()).toEqual(["ceo", "design-lead"]);
  });

  it("deriveKnowledgeLinks extracts cross-position collaborations dynamically", () => {
    const mockGraph: RelationshipGraphResponse = {
      schemaVersion: "relationship-graph.v1",
      workspaceId: "ws-1",
      revision: "1",
      generatedAt: "2026-09-24T00:00:00Z",
      truncated: false,
      limits: { nodes: 400, edges: 800 },
      coverage: [],
      nodes: [
        {
          id: "agent:hash-ceo",
          kind: "agent",
          label: "CEO",
          state: "ready",
          positionId: "ceo",
          evidence: { source: "org", locator: "pos:ceo", basis: "declared", observedAt: "now" },
        },
        {
          id: "agent:hash-plat",
          kind: "agent",
          label: "平台负责人",
          state: "ready",
          positionId: "platform-lead",
          evidence: { source: "org", locator: "pos:platform-lead", basis: "declared", observedAt: "now" },
        },
        {
          id: "agent:hash-front",
          kind: "agent",
          label: "前端工程师",
          state: "ready",
          positionId: "frontend",
          evidence: { source: "org", locator: "pos:frontend", basis: "declared", observedAt: "now" },
        },
        {
          id: "task:task-1",
          kind: "task",
          label: "重构星图 3D 渲染管线",
          state: "ready",
          evidence: { source: "tasks", locator: "task:task-1", basis: "observed", observedAt: "now" },
        },
        {
          id: "goal:goal-1",
          kind: "goal",
          label: "2026 Q3 体验升级战役",
          state: "ready",
          evidence: { source: "goals", locator: "goal:goal-1", basis: "observed", observedAt: "now" },
        },
      ],
      edges: [
        // Reporting edge (should not be included in knowledge links)
        {
          id: "e-report",
          source: "agent:hash-plat",
          target: "agent:hash-ceo",
          kind: "reports_to",
          evidence: { source: "org", locator: "r", basis: "declared", observedAt: "now" },
          permission: "not_applicable",
        },
        // Task: requested by ceo, assigned to frontend
        {
          id: "e-task-req",
          source: "task:task-1",
          target: "agent:hash-ceo",
          kind: "requested_by",
          evidence: { source: "tasks", locator: "t", basis: "declared", observedAt: "now" },
          permission: "not_applicable",
        },
        {
          id: "e-task-asg",
          source: "task:task-1",
          target: "agent:hash-front",
          kind: "assigned_to",
          evidence: { source: "tasks", locator: "t", basis: "declared", observedAt: "now" },
          permission: "not_applicable",
        },
        // Goal: assigned to platform-lead and frontend
        {
          id: "e-goal-p",
          source: "goal:goal-1",
          target: "agent:hash-plat",
          kind: "assigned_to",
          evidence: { source: "goals", locator: "g", basis: "declared", observedAt: "now" },
          permission: "not_applicable",
        },
        {
          id: "e-goal-f",
          source: "goal:goal-1",
          target: "agent:hash-front",
          kind: "assigned_to",
          evidence: { source: "goals", locator: "g", basis: "declared", observedAt: "now" },
          permission: "not_applicable",
        },
      ],
    };

    const validPositions = new Set(["ceo", "platform-lead", "frontend"]);
    const links = deriveKnowledgeLinks(mockGraph, validPositions);
    expect(links.length).toBe(2);

    // 1. Task collaboration link between ceo and frontend
    const taskLink = links.find((l) => (l.source === "ceo" && l.target === "frontend") || (l.source === "frontend" && l.target === "ceo"));
    expect(taskLink).toBeDefined();
    expect(taskLink?.label).toBe("任务协同");
    expect(taskLink?.desc).toContain("重构星图 3D 渲染管线");

    // 2. Goal collaboration link between platform-lead and frontend
    const goalLink = links.find((l) => (l.source === "platform-lead" && l.target === "frontend") || (l.source === "frontend" && l.target === "platform-lead"));
    expect(goalLink).toBeDefined();
    expect(goalLink?.label).toBe("目标协同");
    expect(goalLink?.desc).toContain("2026 Q3 体验升级战役");

    // If an employee is dismissed (e.g. frontend dismissed), validPositions filters out the links
    const withoutFrontend = new Set(["ceo", "platform-lead"]);
    const filteredLinks = deriveKnowledgeLinks(mockGraph, withoutFrontend);
    expect(filteredLinks.length).toBe(0);
  });
});

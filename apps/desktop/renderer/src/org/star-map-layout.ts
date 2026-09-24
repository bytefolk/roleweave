/**
 * Deterministic celestial layout for org-tree.v1.
 *
 * Hierarchy maps to orbits, never a force simulation: the same snapshot
 * always yields the same coordinates, siblings are evenly spaced, and depth
 * maps to orbit radius. Search matching is a pure string filter.
 */
import type { OrgTreeNodeV1, OrgTreeSnapshot } from "@roleweave/shared";

export type StarMapKind = "star" | "planet" | "moon";

export interface StarMapBody {
  id: string;
  parentId: string | null;
  kind: StarMapKind;
  depth: number;
  siblingIndex: number;
  siblingCount: number;
  x: number;
  y: number;
  z: number;
  orbitRadius: number;
  childIds: string[];
}

export interface StarMapRing {
  parentId: string | null;
  radius: number;
  x: number;
  y: number;
  z: number;
}

export interface StarMapLayout {
  bodies: StarMapBody[];
  rings: StarMapRing[];
  starId: string | null;
}

const PLANET_ORBIT = 7;
const MOON_ORBIT = 2.65;
const DEEP_ORBIT = 1.45;

export function orbitRadiusForDepth(depth: number, siblingCount: number): number {
  const base = depth <= 1 ? PLANET_ORBIT : depth === 2 ? MOON_ORBIT : DEEP_ORBIT;
  const spread = 1 + Math.log2(Math.max(1, siblingCount)) * 0.12;
  return base * spread;
}

export function kindForDepth(depth: number): StarMapKind {
  if (depth <= 0) return "star";
  if (depth === 1) return "planet";
  return "moon";
}

function collectIds(nodes: OrgTreeNodeV1[], into: Set<string>): void {
  for (const node of nodes) {
    into.add(node.id);
    collectIds(node.children, into);
  }
}

function findNode(nodes: OrgTreeNodeV1[], id: string): OrgTreeNodeV1 | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested) return nested;
  }
  return null;
}

function isDescendant(node: OrgTreeNodeV1, id: string): boolean {
  return node.children.some((child) => child.id === id || isDescendant(child, id));
}

/** True when dropping `sourceId` onto `targetId` would cycle or is a no-op. */
export function isInvalidStarMapDrop(
  snapshot: OrgTreeSnapshot,
  sourceId: string,
  targetId: string,
): boolean {
  if (!sourceId || !targetId || sourceId === targetId) return true;
  if (sourceId === snapshot.owner) return true;
  const source = findNode(snapshot.tree, sourceId);
  if (!source) return true;
  return isDescendant(source, targetId);
}

export function matchStarMapQuery(
  bodies: readonly StarMapBody[],
  displayNames: Record<string, string> | undefined,
  query: string,
): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return bodies.map((body) => body.id);
  return bodies
    .filter((body) => {
      const name = displayNames?.[body.id] ?? "";
      return `${name} ${body.id}`.toLowerCase().includes(needle);
    })
    .map((body) => body.id);
}

function place(
  node: OrgTreeNodeV1,
  parentId: string | null,
  depth: number,
  siblingIndex: number,
  siblingCount: number,
  origin: { x: number; y: number; z: number },
  bodies: StarMapBody[],
  rings: StarMapRing[],
): void {
  const radius = depth === 0 ? 0 : orbitRadiusForDepth(depth, siblingCount);
  const inclination = depth * 0.22;
  const angle = siblingCount === 0 ? 0 : (Math.PI * 2 * siblingIndex) / siblingCount - Math.PI / 2;
  const x = origin.x + radius * Math.cos(angle);
  const y = origin.y + radius * Math.sin(angle) * Math.sin(inclination);
  const z = origin.z + radius * Math.sin(angle) * Math.cos(inclination);
  const body: StarMapBody = {
    id: node.id,
    parentId,
    kind: kindForDepth(depth),
    depth,
    siblingIndex,
    siblingCount,
    x,
    y,
    z,
    orbitRadius: radius,
    childIds: node.children.map((child) => child.id),
  };
  bodies.push(body);
  if (node.children.length > 0) {
    const childRadius = orbitRadiusForDepth(depth + 1, node.children.length);
    rings.push({ parentId: node.id, radius: childRadius, x, y, z });
    node.children.forEach((child, index) => {
      place(child, node.id, depth + 1, index, node.children.length, { x, y, z }, bodies, rings);
    });
  }
}

/**
 * Star = in-tree owner when present; otherwise roots orbit a virtual origin
 * and `starId` is null (no fabricated position).
 */
export function layoutStarMap(snapshot: OrgTreeSnapshot): StarMapLayout {
  const bodies: StarMapBody[] = [];
  const rings: StarMapRing[] = [];
  const ids = new Set<string>();
  collectIds(snapshot.tree, ids);
  const ownerInTree = snapshot.owner && ids.has(snapshot.owner) ? findNode(snapshot.tree, snapshot.owner) : null;

  if (ownerInTree) {
    place(ownerInTree, null, 0, 0, 1, { x: 0, y: 0, z: 0 }, bodies, rings);
    return { bodies, rings, starId: ownerInTree.id };
  }

  if (snapshot.tree.length === 0) {
    return { bodies, rings, starId: null };
  }

  rings.push({
    parentId: null,
    radius: orbitRadiusForDepth(1, snapshot.tree.length),
    x: 0,
    y: 0,
    z: 0,
  });
  snapshot.tree.forEach((root, index) => {
    place(root, null, 1, index, snapshot.tree.length, { x: 0, y: 0, z: 0 }, bodies, rings);
  });
  return { bodies, rings, starId: null };
}

export function findStarMapBody(layout: StarMapLayout, id: string): StarMapBody | undefined {
  return layout.bodies.find((body) => body.id === id);
}

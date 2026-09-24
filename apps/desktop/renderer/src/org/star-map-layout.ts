/**
 * Deterministic celestial layout for the 3D org star map (#472).
 *
 * The reporting tree maps onto a solar system: the enterprise owner (CEO) is
 * the star at the origin, direct reports are planets on the base orbit ring,
 * and every deeper level rides a smaller orbit ring around its own parent
 * (moons of moons). Orbit rings are emitted alongside the bodies so the
 * renderer can draw them: a child always sits on its parent's ring, which
 * makes the hierarchy legible without any interaction.
 *
 * The layout is a pure function of the snapshot — same tree, same sky. No
 * force simulation, no randomness beyond a stable per-id hash used to rotate
 * each orbit ring's starting slot and tilt its plane, so sibling subtrees do
 * not coplanar-overlap. Framework-free on purpose: unit tests cover the math
 * without a DOM or a WebGL context.
 */
import type { OrgTreeNodeV1, OrgTreeSnapshot } from "@roleweave/shared";

export type CelestialKind = "star" | "planet" | "moon";

export interface CelestialBody {
  id: string;
  parentId: string | null;
  /** 0 = star, 1 = planet, 2+ = moon tiers. */
  depth: number;
  kind: CelestialKind;
  position: readonly [number, number, number];
  /** 3D spherical constellation/topology network position. */
  networkPosition: readonly [number, number, number];
  /** Visual sphere radius. */
  size: number;
  /** Radius of the orbit ring this body rides on; null for the star. */
  orbitRadius: number | null;
  /** Tilt (radians, around X) of the orbit ring this body rides on. */
  orbitTilt: number;
  /** Angular slot on the orbit ring (radians). */
  angle: number;
  childCount: number;
  /** Declared per-task/per-day caps, served verbatim from org-tree.v1; the
   *  focus card renders them, never inventing numbers when absent. */
  budget: OrgTreeNodeV1["budget"] | null;
  /** Synthetic enterprise star, present only when the owner is not in tree. */
  virtual?: boolean;
}

export interface CelestialOrbit {
  centerId: string;
  center: readonly [number, number, number];
  radius: number;
  tilt: number;
}

export interface CelestialLayout {
  bodies: CelestialBody[];
  orbits: CelestialOrbit[];
  starId: string;
  maxDepth: number;
}

/** Id of the synthetic star body when the snapshot owner is absent. */
export const VIRTUAL_STAR_ID = "__enterprise_star__";

const BASE_ORBIT = 26;
const ORBIT_DECAY = 0.42;
const MIN_ORBIT = 1.9;

function bodySize(depth: number): number {
  if (depth <= 0) return 3.4;
  if (depth === 1) return 1.7;
  if (depth === 2) return 1.05;
  return 0.68;
}

/** Stable 0..1 hash so ring slots/tilts differ per parent but never jitter. */
function hash01(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 997;
  return hash / 997;
}

/** Orbit planes alternate tilt by depth with a per-center nudge: sibling
 *  subtrees stay out of each other's plane without looking random. */
function orbitTilt(depth: number, centerId: string): number {
  const base = depth % 2 === 1 ? 0.34 : -0.26;
  return base + (hash01(centerId) - 0.5) * 0.2;
}

function orbitPoint(
  center: readonly [number, number, number],
  radius: number,
  tilt: number,
  angle: number,
): [number, number, number] {
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  // Rotate the XZ circle around X by `tilt`.
  return [center[0] + x, center[1] - z * Math.sin(tilt), center[2] + z * Math.cos(tilt)];
}

function findNode(nodes: OrgTreeNodeV1[], id: string): OrgTreeNodeV1 | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested) return nested;
  }
  return null;
}

interface ParentFrame {
  /** Radius of the ring the parent itself rides on (star: the base ring). */
  ring: number;
  /** How many siblings share that ring (drives available spacing). */
  siblings: number;
}

function normalize3(v: readonly [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len === 0) return [0, 1, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross3(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

const NETWORK_SPHERE_R = 26;

function fibonacciSpherePoint(index: number, total: number, radius: number): [number, number, number] {
  if (total <= 1) return [radius, 0, 0];
  const phi = Math.acos(-1 + (2 * index) / (total - 1));
  const theta = Math.sqrt(total * Math.PI) * phi;
  return [
    radius * Math.cos(theta) * Math.sin(phi),
    radius * Math.sin(theta) * Math.sin(phi),
    radius * Math.cos(phi),
  ];
}

function clusterAroundParent(
  parentPos: readonly [number, number, number],
  childIndex: number,
  childCount: number,
  dist: number,
): [number, number, number] {
  const [px, py, pz] = parentPos;
  const normal = normalize3([px, py, pz]);
  const arbitrary: [number, number, number] = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize3(cross3(normal, arbitrary));
  const v = normalize3(cross3(normal, u));
  const angle = (childIndex / Math.max(childCount, 1)) * Math.PI * 2;
  const cosA = Math.cos(angle) * dist;
  const sinA = Math.sin(angle) * dist;
  return [
    px + u[0] * cosA + v[0] * sinA + normal[0] * 2.0,
    py + u[1] * cosA + v[1] * sinA + normal[1] * 2.0,
    pz + u[2] * cosA + v[2] * sinA + normal[2] * 2.0,
  ];
}

export function buildCelestialLayout(snapshot: OrgTreeSnapshot | null): CelestialLayout {
  const bodies: CelestialBody[] = [];
  const orbits: CelestialOrbit[] = [];
  if (!snapshot || snapshot.tree.length === 0) {
    return { bodies, orbits, starId: "", maxDepth: 0 };
  }
  const ownerNode = snapshot.owner ? findNode(snapshot.tree, snapshot.owner) : null;
  const starNode = ownerNode;
  const star: CelestialBody = starNode
    ? {
        id: starNode.id,
        parentId: null,
        depth: 0,
        kind: "star",
        position: [0, 0, 0],
        networkPosition: [0, 0, 0],
        size: bodySize(0),
        orbitRadius: null,
        orbitTilt: 0,
        angle: 0,
        childCount: starNode.children.length,
        budget: starNode.budget,
      }
    : {
        id: VIRTUAL_STAR_ID,
        parentId: null,
        depth: 0,
        kind: "star",
        position: [0, 0, 0],
        networkPosition: [0, 0, 0],
        size: bodySize(0),
        orbitRadius: null,
        orbitTilt: 0,
        angle: 0,
        childCount: snapshot.tree.length,
        budget: null,
        virtual: true,
      };
  bodies.push(star);

  /** Planets = the star node's children plus any other top-level roots. */
  const planets: OrgTreeNodeV1[] = starNode
    ? [
        ...starNode.children,
        ...snapshot.tree.filter((node) => node.id !== starNode.id),
      ]
    : [...snapshot.tree];

  let maxDepth = 0;
  const placeChildren = (
    parent: CelestialBody,
    children: OrgTreeNodeV1[],
    depth: number,
    frame: ParentFrame,
  ): void => {
    const count = children.length;
    if (count === 0) return;
    // Room available to this subtree: half the chord between the parent and
    // its nearest sibling on the parent's own ring. A lone child gets the
    // whole ring (sin(π/1) would wrongly collapse to zero).
    const halfChord =
      frame.ring * (frame.siblings <= 1 ? 1 : Math.sin(Math.PI / frame.siblings));
    const base = BASE_ORBIT * Math.pow(ORBIT_DECAY, depth - 1);
    const radius =
      depth === 1
        ? BASE_ORBIT
        : Math.max(MIN_ORBIT, Math.min(base, halfChord * 0.9, frame.ring * 0.5));
    const tilt = orbitTilt(depth, parent.id);
    const offset = hash01(parent.id) * Math.PI * 2;
    orbits.push({ centerId: parent.id, center: parent.position, radius, tilt });
    children.forEach((child, index) => {
      const angle = offset + (Math.PI * 2 * index) / count;
      const netPos =
        depth === 1
          ? fibonacciSpherePoint(index, count, NETWORK_SPHERE_R)
          : clusterAroundParent(parent.networkPosition, index, count, 7.5 * Math.pow(0.72, depth - 2));

      const body: CelestialBody = {
        id: child.id,
        parentId: parent.id,
        depth,
        kind: depth === 1 ? "planet" : "moon",
        position: orbitPoint(parent.position, radius, tilt, angle),
        networkPosition: netPos,
        size: bodySize(depth),
        orbitRadius: radius,
        orbitTilt: tilt,
        angle,
        childCount: child.children.length,
        budget: child.budget,
      };
      bodies.push(body);
      if (depth > maxDepth) maxDepth = depth;
      placeChildren(body, child.children, depth + 1, { ring: radius, siblings: count });
    });
  };

  placeChildren(star, planets, 1, { ring: BASE_ORBIT, siblings: Math.max(planets.length, 1) });
  return { bodies, orbits, starId: star.id, maxDepth };
}

export function starMapParentMap(layout: CelestialLayout): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const body of layout.bodies) map.set(body.id, body.parentId);
  return map;
}

/** Dropping a body onto itself or onto one of its own descendants would
 *  create a reporting cycle; walk up from the target to detect it. */
export function isInvalidStarDrop(
  layout: CelestialLayout,
  draggedId: string,
  targetId: string,
): boolean {
  if (draggedId === targetId) return true;
  const parentOf = starMapParentMap(layout);
  let current: string | null | undefined = targetId;
  while (current) {
    if (current === draggedId) return true;
    current = parentOf.get(current) ?? null;
  }
  return false;
}

export interface StarSearchEntry {
  id: string;
  name: string;
}

/** Case-insensitive locate over display name and position id; prefix matches
 *  on the human name rank first so "doc" finds "Doc lead" before "undoc-id". */
export function matchStarQuery(entries: StarSearchEntry[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = entries
    .map((entry) => {
      const name = entry.name.toLowerCase();
      const id = entry.id.toLowerCase();
      if (!name.includes(q) && !id.includes(q)) return null;
      const score = name.startsWith(q) ? 0 : id.startsWith(q) ? 1 : 2;
      return { id: entry.id, name: entry.name, score };
    })
    .filter((entry): entry is { id: string; name: string; score: number } => entry !== null);
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.map((entry) => entry.id);
}

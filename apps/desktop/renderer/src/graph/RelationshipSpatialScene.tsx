import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BufferGeometry,
  Group,
  Line,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  WebGLRenderer,
} from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { RelationshipEdge, RelationshipNode, RelationshipNodeKind } from "@roleweave/shared/relationship-graph";
import { useT } from "@roleweave/ui";

export type RelationshipSpatialMode = "minimal" | "galaxy";
export type RelationshipSpatialLayout = "topology" | "orbit";
export type RelationshipSpatialTheme = "dark" | "light";

export interface RelationshipSpatialPoint {
  id: string;
  x: number;
  y: number;
  z: number;
  size: number;
}

const sizes: Record<RelationshipNodeKind, number> = {
  workspace: 2.2,
  host: 1.7,
  agent: 1.65,
  goal: 1.3,
  task: 1.05,
  source: 1.25,
  resource: 0.95,
  capability: 1.05,
  policy: 1.05,
};
const galaxyColors: Record<RelationshipNodeKind, number> = {
  workspace: 0xd45c32,
  host: 0x8da0b8,
  agent: 0x4f8de8,
  goal: 0x4baa74,
  task: 0xd67a3c,
  source: 0x32a89d,
  resource: 0xd0a347,
  capability: 0x9a6de2,
  policy: 0xd15b8f,
};
const minimalDarkColors: Record<RelationshipNodeKind, number> = {
  workspace: 0xffffff,
  host: 0xd4d4d8,
  agent: 0xe4e4e7,
  goal: 0xc4c4cc,
  task: 0xa1a1aa,
  source: 0xc4c4cc,
  resource: 0xa1a1aa,
  capability: 0xd4d4d8,
  policy: 0xb8b8c0,
};
const minimalLightColors: Record<RelationshipNodeKind, number> = {
  workspace: 0x09090b,
  host: 0x27272a,
  agent: 0x18181b,
  goal: 0x3f3f46,
  task: 0x52525b,
  source: 0x3f3f46,
  resource: 0x52525b,
  capability: 0x27272a,
  policy: 0x45454f,
};
const structuralRelations = new Set<RelationshipEdge["kind"]>([
  "contains",
  "reports_to",
  "bound_to",
  "available_in",
  "contains_resource",
]);

function hash01(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function graphDepths(nodes: RelationshipNode[], edges: RelationshipEdge[]) {
  const ids = new Set(nodes.map(node => node.id));
  const neighbors = new Map(nodes.map(node => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    neighbors.get(edge.source)!.push(edge.target);
    neighbors.get(edge.target)!.push(edge.source);
  }
  const anchor = nodes.find(node => node.kind === "workspace") ?? nodes.find(node => node.kind === "agent") ?? nodes[0];
  const depth = new Map<string, number>();
  if (!anchor) return { anchor: undefined, depth };
  depth.set(anchor.id, 0);
  const queue = [anchor.id];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    for (const neighbor of neighbors.get(id) ?? []) {
      if (depth.has(neighbor)) continue;
      depth.set(neighbor, depth.get(id)! + 1);
      queue.push(neighbor);
    }
  }
  return { anchor, depth };
}

export function buildRelationshipSpatialLayout(
  nodes: RelationshipNode[],
  edges: RelationshipEdge[],
  layout: RelationshipSpatialLayout,
): RelationshipSpatialPoint[] {
  if (!nodes.length) return [];
  const { anchor, depth } = graphDepths(nodes, edges);
  const levels = new Map<number, RelationshipNode[]>();
  for (const node of nodes) {
    const level = depth.get(node.id) ?? 3;
    levels.set(level, [...(levels.get(level) ?? []), node]);
  }
  return nodes.map(node => {
    const level = depth.get(node.id) ?? 3;
    if (node.id === anchor?.id) return { id: node.id, x: 0, y: 0, z: 0, size: sizes[node.kind] };
    const peers = levels.get(level) ?? [node];
    const peerIndex = peers.findIndex(peer => peer.id === node.id);
    const stableOffset = hash01(node.id) * Math.PI * 0.34;
    const angle = (peerIndex / Math.max(peers.length, 1)) * Math.PI * 2 + stableOffset;
    if (layout === "topology") {
      const spread = 5 + Math.min(peers.length, 8) * 0.7;
      return {
        id: node.id,
        x: level * 12 - 13,
        y: Math.sin(angle) * spread,
        z: Math.cos(angle) * spread,
        size: sizes[node.kind],
      };
    }
    const radius = 8 + level * 7 + peerIndex * 0.45;
    return {
      id: node.id,
      x: Math.cos(angle) * radius,
      y: ((peerIndex % 5) - 2) * 1.8,
      z: Math.sin(angle) * radius,
      size: sizes[node.kind],
    };
  });
}

/** Backward-compatible pure helper retained for focused galaxy layout tests. */
export function buildRelationshipGalaxyLayout(nodes: RelationshipNode[], edges: RelationshipEdge[]) {
  return buildRelationshipSpatialLayout(nodes, edges, "orbit");
}

export interface RelationshipSpatialSceneProps {
  nodes: RelationshipNode[];
  edges: RelationshipEdge[];
  mode: RelationshipSpatialMode;
  layout: RelationshipSpatialLayout;
  theme: RelationshipSpatialTheme;
  showKnowledgeRelationships: boolean;
  selectedId?: string;
  visible?: boolean;
  onLayoutChange: (layout: RelationshipSpatialLayout) => void;
  onThemeChange: (theme: RelationshipSpatialTheme) => void;
  onShowKnowledgeRelationshipsChange: (visible: boolean) => void;
  onSelect: (id: string) => void;
}

interface NodeView {
  mesh: Mesh;
  shell: Mesh;
  material: MeshStandardMaterial;
  shellMaterial: MeshStandardMaterial;
  label: HTMLButtonElement;
  size: number;
}

interface EdgeView {
  line: Line;
  geometry: BufferGeometry;
  material: Material;
  arrowMaterial: Material;
}

interface SceneState {
  THREE: typeof import("three");
  CSS2DObject: typeof CSS2DObject;
  renderer: WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  world: Group;
  decoration: Group;
  geometries: Record<"round" | "box" | "diamond" | "arrow", BufferGeometry>;
  raycaster: Raycaster;
  views: Map<string, NodeView>;
  edges: EdgeView[];
  frame: number | null;
  disposed: boolean;
  requestRender: () => void;
}

function disposeObject(object: Object3D) {
  const mesh = object as Mesh;
  mesh.geometry?.dispose();
  const materials = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
  materials.forEach(material => material.dispose());
}

function clearWorld(state: SceneState) {
  for (const view of state.views.values()) {
    view.label.remove();
    view.material.dispose();
    view.shellMaterial.dispose();
  }
  for (const edge of state.edges) {
    edge.geometry.dispose();
    edge.material.dispose();
    edge.arrowMaterial.dispose();
  }
  state.views.clear();
  state.edges = [];
  state.world.clear();
}

function resetCamera(state: SceneState, mode: RelationshipSpatialMode) {
  state.camera.position.set(mode === "minimal" ? 38 : 36, mode === "minimal" ? 24 : 28, mode === "minimal" ? 42 : 48);
  state.controls.target.set(0, 0, 0);
  state.controls.update();
  state.requestRender();
}

export function RelationshipSpatialScene({
  nodes,
  edges,
  mode,
  layout,
  theme,
  showKnowledgeRelationships,
  selectedId,
  visible = true,
  onLayoutChange,
  onThemeChange,
  onShowKnowledgeRelationshipsChange,
  onSelect,
}: RelationshipSpatialSceneProps) {
  const t = useT();
  const stage = useRef<HTMLDivElement>(null);
  const scene = useRef<SceneState | null>(null);
  const latest = useRef({ onSelect, visible });
  latest.current = { onSelect, visible };
  const [ready, setReady] = useState(0);
  const [webglFailed, setWebglFailed] = useState(false);
  const activeLayout = mode === "galaxy" ? "orbit" : layout;
  const points = useMemo(() => buildRelationshipSpatialLayout(nodes, edges, activeLayout), [activeLayout, edges, nodes]);
  const canvasLabel = t(mode === "minimal" ? "graph.minimalCanvas" : "graph.galaxyCanvas");
  const objectsLabel = t(mode === "minimal" ? "graph.minimalObjects" : "graph.galaxyObjects");

  useEffect(() => {
    const host = stage.current;
    if (!host) return;
    if (typeof WebGLRenderingContext === "undefined" && typeof WebGL2RenderingContext === "undefined") {
      setWebglFailed(true);
      return;
    }
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void Promise.all([
      import("three"),
      import("three/examples/jsm/controls/OrbitControls.js"),
      import("three/examples/jsm/renderers/CSS2DRenderer.js"),
    ]).then(([THREE, { OrbitControls: OrbitControlsConstructor }, { CSS2DObject: CSS2DObjectConstructor, CSS2DRenderer: CSS2DRendererConstructor }]) => {
      if (cancelled) return;
      try {
        const width = host.clientWidth || 680;
        const height = host.clientHeight || 470;
        const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        const labelRenderer = new CSS2DRendererConstructor();
        labelRenderer.setSize(width, height);
        labelRenderer.domElement.className = "owb-rgraph__spatial-labels";
        const currentScene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(46, width / height, 0.1, 400);
        const controls = new OrbitControlsConstructor(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = 12;
        controls.maxDistance = 140;
        controls.minPolarAngle = 0.25;
        controls.maxPolarAngle = Math.PI / 1.75;
        const ambient = new THREE.HemisphereLight(0xffffff, 0x18181b, 1.2);
        const key = new THREE.DirectionalLight(0xffffff, 1.8);
        key.position.set(18, 28, 16);
        const world = new THREE.Group();
        const decoration = new THREE.Group();
        currentScene.add(ambient, key, decoration, world);
        host.append(renderer.domElement, labelRenderer.domElement);
        const state: SceneState = {
          THREE,
          CSS2DObject: CSS2DObjectConstructor,
          renderer,
          labelRenderer,
          scene: currentScene,
          camera,
          controls,
          world,
          decoration,
          geometries: {
            round: new THREE.SphereGeometry(1, 24, 24),
            box: new THREE.BoxGeometry(1.65, 1.65, 1.65),
            diamond: new THREE.OctahedronGeometry(1.15, 0),
            arrow: new THREE.ConeGeometry(0.32, 0.9, 10),
          },
          raycaster: new THREE.Raycaster(),
          views: new Map(),
          edges: [],
          frame: null,
          disposed: false,
          requestRender: () => {},
        };
        scene.current = state;
        const renderFrame = () => {
          state.frame = null;
          if (state.disposed || !latest.current.visible) return;
          const moving = state.controls.update();
          state.renderer.render(state.scene, state.camera);
          state.labelRenderer.render(state.scene, state.camera);
          if (moving) state.requestRender();
        };
        state.requestRender = () => {
          if (state.disposed || state.frame !== null || !latest.current.visible) return;
          state.frame = requestAnimationFrame(renderFrame);
        };
        const requestRender = () => state.requestRender();
        controls.addEventListener("change", requestRender);
        let pointerStart: { x: number; y: number } | null = null;
        const pick = (event: PointerEvent) => {
          const rect = renderer.domElement.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          state.raycaster.setFromCamera(
            new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1),
            camera,
          );
          const hit = state.raycaster.intersectObjects([...state.views.values()].map(view => view.mesh), false)[0];
          const id = hit?.object.userData.relationshipId;
          if (typeof id === "string") latest.current.onSelect(id);
        };
        const onPointerDown = (event: PointerEvent) => { pointerStart = { x: event.clientX, y: event.clientY }; };
        const onPointerUp = (event: PointerEvent) => {
          if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) <= 4) pick(event);
          pointerStart = null;
        };
        renderer.domElement.addEventListener("pointerdown", onPointerDown);
        renderer.domElement.addEventListener("pointerup", onPointerUp);
        const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
          const nextWidth = host.clientWidth;
          const nextHeight = host.clientHeight;
          if (!latest.current.visible || nextWidth <= 0 || nextHeight <= 0) return;
          renderer.setSize(nextWidth, nextHeight);
          labelRenderer.setSize(nextWidth, nextHeight);
          camera.aspect = nextWidth / nextHeight;
          camera.updateProjectionMatrix();
          state.requestRender();
        });
        observer?.observe(host);
        resetCamera(state, mode);
        setWebglFailed(false);
        setReady(value => value + 1);
        state.requestRender();
        cleanup = () => {
          state.disposed = true;
          if (state.frame !== null) cancelAnimationFrame(state.frame);
          observer?.disconnect();
          controls.removeEventListener("change", requestRender);
          renderer.domElement.removeEventListener("pointerdown", onPointerDown);
          renderer.domElement.removeEventListener("pointerup", onPointerUp);
          controls.dispose();
          clearWorld(state);
          state.decoration.traverse(disposeObject);
          state.decoration.clear();
          Object.values(state.geometries).forEach(geometry => geometry.dispose());
          renderer.dispose();
          renderer.domElement.remove();
          labelRenderer.domElement.remove();
          scene.current = null;
        };
      } catch {
        setWebglFailed(true);
      }
    }).catch(() => { if (!cancelled) setWebglFailed(true); });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const state = scene.current;
    if (!state || !ready) return;
    state.decoration.traverse(disposeObject);
    state.decoration.clear();
    const minimalLight = mode === "minimal" && theme === "light";
    const background = mode === "galaxy" ? 0x12151c : minimalLight ? 0xf8f9fa : 0x09090b;
    state.scene.background = new state.THREE.Color(background);
    state.scene.fog = new state.THREE.Fog(background, mode === "galaxy" ? 44 : 58, mode === "galaxy" ? 150 : 170);
    const grid = new state.THREE.GridHelper(84, 42, minimalLight ? 0x52525b : mode === "galaxy" ? 0x33415c : 0x71717a, minimalLight ? 0xd4d4d8 : mode === "galaxy" ? 0x1f293b : 0x27272a);
    grid.position.y = -14;
    const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
    materials.forEach(material => { material.transparent = true; material.opacity = mode === "galaxy" ? 0.22 : 0.32; });
    state.decoration.add(grid);
    resetCamera(state, mode);
  }, [mode, ready, theme]);

  useEffect(() => {
    const state = scene.current;
    if (!state || !ready) return;
    clearWorld(state);
    const positions = new Map(points.map(point => [point.id, point]));
    const minimalLight = mode === "minimal" && theme === "light";
    for (const edge of edges) {
      if (!showKnowledgeRelationships && !structuralRelations.has(edge.kind)) continue;
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (!source || !target) continue;
      const geometry = new state.THREE.BufferGeometry().setFromPoints([
        new state.THREE.Vector3(source.x, source.y, source.z),
        new state.THREE.Vector3(target.x, target.y, target.z),
      ]);
      const material = new state.THREE.LineDashedMaterial({
        color: mode === "galaxy" ? 0x7b91ad : minimalLight ? 0x52525b : 0xa1a1aa,
        transparent: true,
        opacity: edge.evidence.basis === "declared" ? 0.48 : 0.78,
        dashSize: edge.evidence.basis === "declared" ? 0.8 : 1000,
        gapSize: edge.evidence.basis === "declared" ? 0.55 : 0,
      });
      const line = new state.THREE.Line(geometry, material);
      line.computeLineDistances();
      const direction = new state.THREE.Vector3(target.x - source.x, target.y - source.y, target.z - source.z).normalize();
      const arrowMaterial = new state.THREE.MeshBasicMaterial({ color: mode === "galaxy" ? 0x9eb5d4 : minimalLight ? 0x27272a : 0xd4d4d8, transparent: true, opacity: 0.82 });
      const arrow = new state.THREE.Mesh(state.geometries.arrow, arrowMaterial);
      arrow.position.set(target.x, target.y, target.z).addScaledVector(direction, -(target.size + 0.7));
      arrow.quaternion.setFromUnitVectors(new state.THREE.Vector3(0, 1, 0), direction);
      state.world.add(line, arrow);
      state.edges.push({ line, geometry, material, arrowMaterial });
    }
    const colors = mode === "galaxy" ? galaxyColors : minimalLight ? minimalLightColors : minimalDarkColors;
    for (const node of nodes) {
      const point = positions.get(node.id);
      if (!point) continue;
      const geometry = node.kind === "resource" || node.kind === "task" ? state.geometries.box : node.kind === "policy" || node.kind === "capability" ? state.geometries.diamond : state.geometries.round;
      const color = colors[node.kind];
      const material = new state.THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: mode === "galaxy" ? 0.12 : 0.04,
        roughness: mode === "galaxy" ? 0.3 : 0.72,
        metalness: mode === "galaxy" ? 0.18 : 0.06,
      });
      const mesh = new state.THREE.Mesh(geometry, material);
      mesh.position.set(point.x, point.y, point.z);
      mesh.scale.setScalar(point.size);
      mesh.userData.relationshipId = node.id;
      const shellMaterial = new state.THREE.MeshStandardMaterial({ color, wireframe: true, transparent: true, opacity: mode === "galaxy" ? 0.18 : 0.34, depthWrite: false });
      const shell = new state.THREE.Mesh(geometry, shellMaterial);
      shell.scale.setScalar(node.kind === "workspace" || node.kind === "agent" ? 1.32 : 1.15);
      mesh.add(shell);
      const label = document.createElement("button");
      label.type = "button";
      label.tabIndex = -1;
      label.setAttribute("aria-hidden", "true");
      label.className = `owb-rgraph__spatial-label owb-rgraph__spatial-label--${mode}`;
      label.textContent = node.label;
      label.addEventListener("click", () => latest.current.onSelect(node.id));
      const labelObject = new state.CSS2DObject(label);
      labelObject.position.set(0, point.size + 0.8, 0);
      mesh.add(labelObject);
      state.world.add(mesh);
      state.views.set(node.id, { mesh, shell, material, shellMaterial, label, size: point.size });
    }
    state.requestRender();
    return () => clearWorld(state);
  }, [edges, mode, nodes, points, ready, showKnowledgeRelationships, theme]);

  useEffect(() => {
    const state = scene.current;
    if (!state) return;
    for (const [id, view] of state.views) {
      const selected = id === selectedId;
      view.mesh.scale.setScalar(view.size * (selected ? 1.16 : 1));
      view.material.emissiveIntensity = selected ? 0.34 : mode === "galaxy" ? 0.12 : 0.04;
      view.shellMaterial.opacity = selected ? 0.62 : mode === "galaxy" ? 0.18 : 0.34;
      view.label.classList.toggle("is-selected", selected);
    }
    state.requestRender();
  }, [mode, selectedId, ready]);

  useEffect(() => {
    if (!visible) return;
    const state = scene.current;
    const host = stage.current;
    if (!state || !host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
    state.renderer.setSize(host.clientWidth, host.clientHeight);
    state.labelRenderer.setSize(host.clientWidth, host.clientHeight);
    state.camera.aspect = host.clientWidth / host.clientHeight;
    state.camera.updateProjectionMatrix();
    state.requestRender();
  }, [visible]);

  const reset = useCallback(() => {
    const state = scene.current;
    if (state) resetCamera(state, mode);
  }, [mode]);

  return <div
    className={`owb-rgraph__spatial owb-rgraph__spatial--${mode} owb-rgraph__spatial--${theme}`}
    role="region"
    aria-label={canvasLabel}
    data-visual-style={mode === "minimal" ? "bindy-spatial" : "yuanyang-galaxy"}
  >
    <div className="owb-rgraph__spatial-controls">
      {mode === "minimal" ? <>
        <div role="group" aria-label={t("graph.spatialLayout")}>
          <button type="button" aria-pressed={layout === "topology"} onClick={() => onLayoutChange("topology")}>{t("graph.layoutTopology")}</button>
          <button type="button" aria-pressed={layout === "orbit"} onClick={() => onLayoutChange("orbit")}>{t("graph.layoutOrbit")}</button>
        </div>
        <button type="button" aria-pressed={showKnowledgeRelationships} onClick={() => onShowKnowledgeRelationshipsChange(!showKnowledgeRelationships)}>{t("graph.knowledgeRelationships")}</button>
        <div role="group" aria-label={t("graph.spatialTheme")}>
          <button type="button" aria-pressed={theme === "dark"} onClick={() => onThemeChange("dark")}>{t("graph.themeDark")}</button>
          <button type="button" aria-pressed={theme === "light"} onClick={() => onThemeChange("light")}>{t("graph.themeLight")}</button>
        </div>
      </> : null}
      <button type="button" onClick={reset}>{t("graph.cameraReset")}</button>
    </div>
    <div ref={stage} className="owb-rgraph__spatial-stage" aria-hidden="true" />
    {webglFailed ? <p className="owb-rgraph__spatial-fallback" role="status">{t("graph.spatialFallback")}</p> : null}
    <ul className="owb-rgraph__spatial-objects" aria-label={objectsLabel}>
      {nodes.map(node => <li key={node.id}><button type="button" aria-label={`${t(`graph.kind.${node.kind}`)} · ${node.label}`} aria-pressed={selectedId === node.id} onClick={() => onSelect(node.id)}><span>{t(`graph.kind.${node.kind}`)}</span><strong>{node.label}</strong></button></li>)}
    </ul>
  </div>;
}

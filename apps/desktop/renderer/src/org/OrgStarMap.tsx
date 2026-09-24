/**
 * 3D Org Star Map & Knowledge Graph (Minimalist Monochrome Edition).
 * Refactored according to org-star-map-minimalist.html (#482).
 *
 * Visual principles:
 * - Minimalist monochrome visual design: clean black/white canvas (#09090b / #f8f9fa)
 *   with subtle spatial floor grid, zero bloom/glare light pollution.
 * - Solid sphere meshes with outer geometric precision rings for root & leads,
 *   crisp wireframe reticle for selection and hover states.
 * - Dual 3D layout modes:
 *   1. Celestial Orbit: Deterministic solar system hierarchy.
 *   2. 3D Constellation Topology: Fibonacci spherical layout with smooth lerp transitions.
 * - Hairline orbit reference rings (toggleable).
 * - Reporting hierarchy tree lines and knowledge dependency cross-links with active focus dimming.
 * - Full backward compatibility: drag-and-drop reparenting (cycle guard), hire-under,
 *   dismiss slot, undo, search locate fly-to, and accessible WebGL-less fallback.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Spin } from "antd";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { useT } from "@roleweave/ui";
import type { OrgTreeSnapshot, RelationshipGraphResponse } from "@roleweave/shared";
import {
  buildCelestialLayout,
  deriveKnowledgeLinks,
  isInvalidStarDrop,
  matchStarQuery,
  VIRTUAL_STAR_ID,
  type CelestialBody,
  type CelestialLayout,
  type OrgKnowledgeLink,
} from "./star-map-layout";
import "./OrgStarMap.css";

export type { OrgKnowledgeLink };

export interface OrgStarMapProps {
  snapshot: OrgTreeSnapshot | null;
  loading?: boolean;
  /** Business name; labels the synthetic star when the owner is not in tree. */
  enterpriseName?: string;
  displayNames?: Record<string, string>;
  avatarColors?: Record<string, string>;
  avatarUrls?: Record<string, string>;
  displayTitles?: Record<string, string>;
  displayModes?: Record<string, "read_only" | "approval_required">;
  runningIds?: ReadonlySet<string>;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onOpenConversation?: (id: string) => void;
  onMove?: (id: string, reportTo: string | null) => void;
  onHireEntry?: (parentId: string) => void;
  onUndo?: () => void;
  moveDisabled?: boolean;
  dismissSlot?: ReactNode;
  knowledgeLinks?: OrgKnowledgeLink[];
  relationshipGraph?: RelationshipGraphResponse | null;
  className?: string;
}

interface SharedGeometries {
  sphereRoot: THREE.SphereGeometry;
  sphereLead: THREE.SphereGeometry;
  sphereMember: THREE.SphereGeometry;
  ringRoot: THREE.RingGeometry;
  ringLead: THREE.RingGeometry;
  reticleRoot: THREE.RingGeometry;
  reticleLead: THREE.RingGeometry;
  reticleMember: THREE.RingGeometry;
}

interface BodyView {
  body: CelestialBody;
  group: THREE.Group;
  coreMesh: THREE.Mesh;
  ringMesh: THREE.Mesh | null;
  reticleMesh: THREE.Mesh;
  label: HTMLDivElement;
  labelObject: CSS2DObject;
  currentPos: THREE.Vector3;
  targetPos: THREE.Vector3;
}

interface LinkView {
  source: string;
  target: string;
  line: THREE.Line;
  material: THREE.LineBasicMaterial;
}

interface CrossLinkView {
  source: string;
  target: string;
  label?: string;
  desc?: string;
  line: THREE.Line;
  material: THREE.LineDashedMaterial;
}

interface SceneState {
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  grid: THREE.GridHelper;
  orbitsGroup: THREE.Group;
  treeLinesGroup: THREE.Group;
  crossLinksGroup: THREE.Group;
  nodesGroup: THREE.Group;
  geometries: SharedGeometries;
  views: Map<string, BodyView>;
  links: LinkView[];
  crossLinks: CrossLinkView[];
  raycaster: THREE.Raycaster;
  clock: THREE.Clock;
  /** Pending requestAnimationFrame id. Null means the scene is idle. */
  frame: number | null;
  /** Invalidate the scene after an input or data update. */
  requestRender: () => void;
  fly: {
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromCam: THREE.Vector3;
    toCam: THREE.Vector3;
    start: number;
    duration: number;
  } | null;
  drag: { id: string; x: number; y: number; moved: boolean } | null;
  pointerStart: { x: number; y: number } | null;
  dropCandidate: string | null;
  disposed: boolean;
}

const DEFAULT_CAM: readonly [number, number, number] = [0, 36, 68];
const DRAG_THRESHOLD = 4;

function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) {
      mat.forEach((m) => m.dispose());
    } else if (mat) {
      mat.dispose();
    }
  });
}

function budgetLabelText(budget: CelestialBody["budget"]): string | null {
  const perTask = budget?.perTask;
  if (!perTask) return null;
  if (typeof perTask.tokens === "number") {
    const k = perTask.tokens / 1000;
    const compact = k >= 1 ? (Number.isInteger(k) ? k : k.toFixed(1)) : String(perTask.tokens);
    return `${compact}/task`;
  }
  if (typeof perTask.iterations === "number") return `${perTask.iterations} iter/task`;
  return null;
}

export default function OrgStarMap({
  snapshot,
  loading = false,
  enterpriseName,
  displayNames,
  avatarColors: _avatarColors,
  avatarUrls: _avatarUrls,
  displayTitles,
  displayModes,
  runningIds,
  selectedId,
  onSelect,
  onOpenConversation,
  onMove,
  onHireEntry,
  onUndo,
  moveDisabled = false,
  dismissSlot,
  knowledgeLinks,
  relationshipGraph,
  className,
}: OrgStarMapProps) {
  const t = useT();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<SceneState | null>(null);
  const layoutRef = useRef<CelestialLayout>({ bodies: [], orbits: [], starId: "", maxDepth: 0 });

  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [layoutMode, setLayoutMode] = useState<"celestial" | "network">("celestial");
  const [showOrbits, setShowOrbits] = useState(true);
  const [showCrossLinks, setShowCrossLinks] = useState(true);
  const [autoRotate, setAutoRotate] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const [webglFailed, setWebglFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [cardDismissed, setCardDismissed] = useState(false);

  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const latest = useRef({
    onSelect,
    onOpenConversation,
    onMove,
    moveDisabled,
    selectedId,
    hoveredId,
    runningIds,
    query,
    reducedMotion,
    t,
    theme,
    layoutMode,
    showOrbits,
    showCrossLinks,
    autoRotate,
  });
  latest.current = {
    onSelect,
    onOpenConversation,
    onMove,
    moveDisabled,
    selectedId,
    hoveredId,
    runningIds,
    query,
    reducedMotion,
    t,
    theme,
    layoutMode,
    showOrbits,
    showCrossLinks,
    autoRotate,
  };

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    setCardDismissed(false);
  }, [selectedId]);

  const layout = useMemo(() => buildCelestialLayout(snapshot), [snapshot]);
  layoutRef.current = layout;
  const isEmpty = snapshot === null || snapshot.tree.length === 0;

  const activePositionIds = useMemo(
    () => new Set(layout.bodies.filter((b) => !b.virtual).map((b) => b.id)),
    [layout.bodies],
  );

  const effectiveKnowledgeLinks = useMemo(() => {
    const directLinks = (knowledgeLinks ?? []).filter(
      (link) =>
        link.source !== link.target &&
        activePositionIds.has(link.source) &&
        activePositionIds.has(link.target),
    );
    const derived = deriveKnowledgeLinks(relationshipGraph, activePositionIds);
    const combined: OrgKnowledgeLink[] = [...directLinks];
    const seen = new Set(
      directLinks.map((l) =>
        l.source < l.target ? `${l.source}->${l.target}` : `${l.target}->${l.source}`,
      ),
    );
    for (const d of derived) {
      const key = d.source < d.target ? `${d.source}->${d.target}` : `${d.target}->${d.source}`;
      if (!seen.has(key)) {
        seen.add(key);
        combined.push(d);
      }
    }
    return combined;
  }, [knowledgeLinks, relationshipGraph, activePositionIds]);

  const nameOf = useCallback(
    (body: CelestialBody): string => {
      if (body.virtual) return enterpriseName?.trim() || t("star.enterprise");
      return displayNames?.[body.id] ?? body.id;
    },
    [displayNames, enterpriseName, t],
  );

  const entries = useMemo(
    () =>
      layout.bodies
        .filter((body) => !body.virtual)
        .map((body) => ({ id: body.id, name: nameOf(body) })),
    [layout, nameOf],
  );
  const candidates = useMemo(() => matchStarQuery(entries, query).slice(0, 8), [entries, query]);

  /* ---------------------------------------------------------------- scene */
  useEffect(() => {
    const host = stageRef.current;
    if (!host) return;
    let state: SceneState;

    try {
      const width = host.clientWidth || 640;
      const height = host.clientHeight || 420;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      renderer.setClearColor(theme === "dark" ? 0x09090b : 0xf8f9fa, 1.0);

      const labelRenderer = new CSS2DRenderer();
      labelRenderer.setSize(width, height);
      labelRenderer.domElement.style.position = "absolute";
      labelRenderer.domElement.style.top = "0";
      labelRenderer.domElement.style.left = "0";
      labelRenderer.domElement.style.pointerEvents = "none";

      const scene = new THREE.Scene();

      const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
      camera.position.set(...DEFAULT_CAM);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = 10;
      controls.maxDistance = 240;
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = 0.8;
      controls.target.set(0, 0, 0);

      // Subtle Spatial Floor Grid
      const grid = new THREE.GridHelper(
        120,
        24,
        theme === "dark" ? 0x1c1c24 : 0xd1d5db,
        theme === "dark" ? 0x14141a : 0xe5e7eb,
      );
      grid.position.y = -16;
      scene.add(grid);

      // World Groups
      const orbitsGroup = new THREE.Group();
      const treeLinesGroup = new THREE.Group();
      const crossLinksGroup = new THREE.Group();
      const nodesGroup = new THREE.Group();

      scene.add(orbitsGroup);
      scene.add(treeLinesGroup);
      scene.add(crossLinksGroup);
      scene.add(nodesGroup);

      host.appendChild(renderer.domElement);
      host.appendChild(labelRenderer.domElement);

      const geometries: SharedGeometries = {
        sphereRoot: new THREE.SphereGeometry(1.8, 24, 24),
        sphereLead: new THREE.SphereGeometry(1.1, 20, 20),
        sphereMember: new THREE.SphereGeometry(0.62, 16, 16),
        ringRoot: new THREE.RingGeometry(2.35, 2.52, 48),
        ringLead: new THREE.RingGeometry(1.45, 1.58, 36),
        reticleRoot: new THREE.RingGeometry(2.7, 2.85, 32),
        reticleLead: new THREE.RingGeometry(1.75, 1.88, 32),
        reticleMember: new THREE.RingGeometry(1.05, 1.18, 24),
      };

      state = {
        renderer,
        labelRenderer,
        scene,
        camera,
        controls,
        grid,
        orbitsGroup,
        treeLinesGroup,
        crossLinksGroup,
        nodesGroup,
        geometries,
        views: new Map(),
        links: [],
        crossLinks: [],
        raycaster: new THREE.Raycaster(),
        clock: new THREE.Clock(),
        frame: null,
        requestRender: () => {},
        fly: null,
        drag: null,
        pointerStart: null,
        dropCandidate: null,
        disposed: false,
      };
      stateRef.current = state;

      const pick = (clientX: number, clientY: number): string | null => {
        if (typeof document !== "undefined" && typeof document.elementFromPoint === "function") {
          const elem = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".owb-star-label");
          if (elem && elem.dataset.id && elem.dataset.id !== VIRTUAL_STAR_ID) {
            return elem.dataset.id;
          }
        }

        const rect = renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const pointer = new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1,
        );
        state.raycaster.setFromCamera(pointer, camera);
        const meshes: THREE.Object3D[] = [];
        for (const v of state.views.values()) {
          meshes.push(v.coreMesh);
        }
        const hit = state.raycaster.intersectObjects(meshes, false)[0];
        if (!hit) return null;
        const id = hit.object.userData.positionId;
        return typeof id === "string" ? id : null;
      };

      const clearDropMarks = (): void => {
        for (const view of state.views.values()) {
          view.label.classList.remove("is-drop-ok", "is-drop-bad");
        }
      };

      const onPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0) return;
        state.pointerStart = { x: event.clientX, y: event.clientY };
        const id = pick(event.clientX, event.clientY);
        if (!id || id === VIRTUAL_STAR_ID) return;
        state.drag = { id, x: event.clientX, y: event.clientY, moved: false };
        state.controls.enabled = false;
        renderer.domElement.setPointerCapture?.(event.pointerId);
      };

      const onPointerMove = (event: PointerEvent): void => {
        const drag = state.drag;
        if (!drag) {
          const id = pick(event.clientX, event.clientY);
          setHoveredId(id);
          return;
        }
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD) return;
        drag.moved = true;
        const target = pick(event.clientX, event.clientY);
        state.dropCandidate = target && target !== drag.id ? target : null;
        clearDropMarks();
        if (state.dropCandidate) {
          const view = state.views.get(state.dropCandidate);
          if (view) {
            const invalid =
              isInvalidStarDrop(layoutRef.current, drag.id, state.dropCandidate) || latest.current.moveDisabled;
            view.label.classList.add(invalid ? "is-drop-bad" : "is-drop-ok");
          }
        }
      };

      const onPointerUp = (event: PointerEvent): void => {
        const drag = state.drag;
        const start = state.pointerStart;
        state.drag = null;
        state.pointerStart = null;
        state.controls.enabled = true;
        renderer.domElement.releasePointerCapture?.(event.pointerId);

        const movedDist = start ? Math.hypot(event.clientX - start.x, event.clientY - start.y) : 0;

        if (!drag) {
          if (movedDist <= DRAG_THRESHOLD) {
            const id = pick(event.clientX, event.clientY);
            if (!id) {
              latest.current.onSelect?.("");
            }
          }
          return;
        }

        const current = latest.current;
        if (!drag.moved) {
          if (drag.id !== VIRTUAL_STAR_ID) {
            setCardDismissed(false);
            flyTo(drag.id, true);
            current.onSelect?.(drag.id);
          }
          clearDropMarks();
          state.dropCandidate = null;
          return;
        }

        const target = state.dropCandidate;
        clearDropMarks();
        state.dropCandidate = null;
        if (!target || !current.onMove || current.moveDisabled) return;
        if (isInvalidStarDrop(layoutRef.current, drag.id, target)) {
          setToast(latest.current.t("star.dropDenied"));
          return;
        }
        current.onMove(drag.id, target === VIRTUAL_STAR_ID ? null : target);
      };

      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("pointermove", onPointerMove);
      renderer.domElement.addEventListener("pointerup", onPointerUp);
      renderer.domElement.addEventListener("pointercancel", onPointerUp);

      const renderFrame = (): void => {
        if (state.disposed) return;
        state.frame = null;
        const elapsed = state.clock.getElapsedTime();

        // Smooth camera fly
        if (state.fly) {
          const progress = Math.min((performance.now() - state.fly.start) / state.fly.duration, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          state.controls.target.lerpVectors(state.fly.fromTarget, state.fly.toTarget, eased);
          state.camera.position.lerpVectors(state.fly.fromCam, state.fly.toCam, eased);
          if (progress >= 1) state.fly = null;
        }

        // Billboarding & Smooth Node Position Interpolation
        let moved = false;
        const camDist = state.camera.position.distanceTo(state.controls.target);

        for (const view of state.views.values()) {
          view.reticleMesh.quaternion.copy(state.camera.quaternion);

          if (view.currentPos.distanceTo(view.targetPos) > 0.005) {
            view.currentPos.lerp(view.targetPos, 0.12);
            view.group.position.copy(view.currentPos);
            moved = true;
          }

          // Active running turn pulse
          const isRunning = latest.current.runningIds?.has(view.body.id) === true;
          const isSelected = view.body.id === latest.current.selectedId;
          const isHovered = view.body.id === latest.current.hoveredId;
          const baseScale = isSelected ? 1.25 : isHovered ? 1.15 : 1.0;
          if (isRunning && !latest.current.reducedMotion) {
            const pulse = 1 + Math.sin(elapsed * 4.2) * 0.12;
            view.coreMesh.scale.setScalar(baseScale * pulse);
          } else if (Math.abs(view.coreMesh.scale.x - baseScale) > 0.001) {
            view.coreMesh.scale.setScalar(baseScale);
          }

          // Dynamic Level of Detail (LOD)
          const isFocus =
            view.body.id === latest.current.selectedId || view.body.id === latest.current.hoveredId;
          const isFar = camDist > 85 && view.body.kind === "moon";
          if (isFar && !isFocus && !view.label.classList.contains("is-selected")) {
            view.label.style.opacity = "0";
            view.label.style.pointerEvents = "none";
          } else if (!view.label.classList.contains("is-dimmed")) {
            view.label.style.opacity = "";
            view.label.style.pointerEvents = "auto";
          }
        }

        if (moved) {
          updateLinePositions();
        }

        const controlsChanged = state.controls.update();
        state.renderer.render(state.scene, state.camera);
        state.labelRenderer.render(state.scene, state.camera);

        // Keep frames flowing only while there is actual visual work. The
        // former perpetual RAF loop repainted the full WebGL and CSS2D scene
        // at 60 FPS even when the map was completely idle.
        let hasRunningPulse = false;
        if (!latest.current.reducedMotion) {
          for (const view of state.views.values()) {
            if (latest.current.runningIds?.has(view.body.id)) {
              hasRunningPulse = true;
              break;
            }
          }
        }
        if (moved || state.fly || controlsChanged || latest.current.autoRotate || hasRunningPulse) {
          state.requestRender();
        }
      };

      state.requestRender = (): void => {
        if (state.disposed || state.frame !== null) return;
        state.frame = requestAnimationFrame(renderFrame);
      };
      const onControlsChange = (): void => state.requestRender();
      controls.addEventListener("change", onControlsChange);
      state.requestRender();

      const observer = new ResizeObserver(() => {
        const w = host.clientWidth;
        const h = host.clientHeight;
        if (w <= 0 || h <= 0) return;
        renderer.setSize(w, h);
        labelRenderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        state.requestRender();
      });
      observer.observe(host);
      setWebglFailed(false);

      return () => {
        state.disposed = true;
        if (state.frame !== null) cancelAnimationFrame(state.frame);
        observer.disconnect();
        controls.removeEventListener("change", onControlsChange);
        renderer.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer.domElement.removeEventListener("pointermove", onPointerMove);
        renderer.domElement.removeEventListener("pointerup", onPointerUp);
        renderer.domElement.removeEventListener("pointercancel", onPointerUp);
        controls.dispose();
        for (const view of state.views.values()) view.label.remove();
        state.scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material?.dispose();
        });
        renderer.dispose();
        host.removeChild(renderer.domElement);
        host.removeChild(labelRenderer.domElement);
        stateRef.current = null;
      };
    } catch {
      setWebglFailed(true);
      return;
    }
  }, [loading, isEmpty, webglFailed]);

  /* ------------------------------------------------- rebuild orbits */
  const rebuildOrbits = useCallback(
    (mode: "celestial" | "network" = layoutMode, visible = showOrbits, curTheme = theme): void => {
      const state = stateRef.current;
      if (!state) return;

      while (state.orbitsGroup.children.length > 0) {
        const child = state.orbitsGroup.children[0]!;
        state.orbitsGroup.remove(child);
        disposeObject3D(child);
      }

      if (mode !== "celestial" || !visible) {
        state.requestRender();
        return;
      }

      const ringColor = curTheme === "dark" ? 0x22222a : 0xd1d5db;
      const subRingColor = curTheme === "dark" ? 0x181820 : 0xe5e7eb;

      // Major Base Orbit around root
      const baseCurve = new THREE.EllipseCurve(0, 0, 26, 26, 0, Math.PI * 2, false, 0);
      const basePoints = baseCurve.getPoints(96).map((p) => new THREE.Vector3(p.x, 0, p.y));
      const baseGeo = new THREE.BufferGeometry().setFromPoints(basePoints);
      const baseMat = new THREE.LineBasicMaterial({ color: ringColor, transparent: true, opacity: 0.85 });
      const baseLoop = new THREE.LineLoop(baseGeo, baseMat);
      state.orbitsGroup.add(baseLoop);

      // Sub-orbits for parents with children
      for (const orbit of layout.orbits) {
        const curve = new THREE.EllipseCurve(0, 0, orbit.radius, orbit.radius, 0, Math.PI * 2, false, 0);
        const points = curve.getPoints(64).map((p) => new THREE.Vector3(p.x, 0, p.y));
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({ color: subRingColor, transparent: true, opacity: 0.65 });
        const loop = new THREE.LineLoop(geo, mat);
        loop.rotation.x = orbit.tilt;
        loop.position.set(...orbit.center);
        state.orbitsGroup.add(loop);
      }
      state.requestRender();
    },
    [layout],
  );

  useEffect(() => {
    rebuildOrbits(layoutMode, showOrbits, theme);
  }, [layoutMode, showOrbits, theme, rebuildOrbits]);

  /* ------------------------------------------- update line positions */
  const updateLinePositions = useCallback((): void => {
    const state = stateRef.current;
    if (!state) return;

    for (const link of state.links) {
      const src = state.views.get(link.source);
      const tgt = state.views.get(link.target);
      if (!src || !tgt) continue;
      const posAttr = link.line.geometry.attributes.position as THREE.BufferAttribute;
      posAttr.setXYZ(0, src.currentPos.x, src.currentPos.y, src.currentPos.z);
      posAttr.setXYZ(1, tgt.currentPos.x, tgt.currentPos.y, tgt.currentPos.z);
      posAttr.needsUpdate = true;
    }

    for (const cl of state.crossLinks) {
      const src = state.views.get(cl.source);
      const tgt = state.views.get(cl.target);
      if (!src || !tgt) continue;
      const posAttr = cl.line.geometry.attributes.position as THREE.BufferAttribute;
      posAttr.setXYZ(0, src.currentPos.x, src.currentPos.y, src.currentPos.z);
      posAttr.setXYZ(1, tgt.currentPos.x, tgt.currentPos.y, tgt.currentPos.z);
      posAttr.needsUpdate = true;
      cl.line.computeLineDistances();
    }
  }, []);

  /* ------------------------------------------- apply visual state */
  const applyVisualState = useCallback((): void => {
    const state = stateRef.current;
    if (!state) return;

    const { selectedId: selected, hoveredId: hovered, query: rawQuery, theme: curTheme, showCrossLinks: curShowCross } = latest.current;
    const isDark = curTheme === "dark";
    const q = rawQuery.trim().toLowerCase();
    const activeId = hovered || selected;

    const connectedNodeIds = new Set<string>();
    const activeLinkIndices = new Set<number>();
    const activeCrossLinkIndices = new Set<number>();

    if (activeId) {
      connectedNodeIds.add(activeId);
      state.links.forEach((l, idx) => {
        if (l.source === activeId || l.target === activeId) {
          connectedNodeIds.add(l.source);
          connectedNodeIds.add(l.target);
          activeLinkIndices.add(idx);
        }
      });
      state.crossLinks.forEach((cl, idx) => {
        if (cl.source === activeId || cl.target === activeId) {
          connectedNodeIds.add(cl.source);
          connectedNodeIds.add(cl.target);
          activeCrossLinkIndices.add(idx);
        }
      });
    }

    // Nodes
    for (const view of state.views.values()) {
      const name = view.label.textContent ?? "";
      const haystack = `${name} ${view.body.id}`.toLowerCase();
      const matchesSearch = q.length === 0 || haystack.includes(q);

      const isSelected = view.body.id === selected;
      const isHovered = view.body.id === hovered;
      const isConnected = !activeId || connectedNodeIds.has(view.body.id);
      const isDimmed = !matchesSearch || (!!activeId && !isConnected);

      view.label.classList.toggle("is-dimmed", isDimmed);
      view.label.classList.toggle("is-selected", isSelected);

      // Reticle Wireframe Ring
      if (isSelected) {
        (view.reticleMesh.material as THREE.MeshBasicMaterial).opacity = 0.95;
        (view.reticleMesh.material as THREE.MeshBasicMaterial).color.set(isDark ? 0xffffff : 0x111827);
      } else if (isHovered) {
        (view.reticleMesh.material as THREE.MeshBasicMaterial).opacity = 0.45;
        (view.reticleMesh.material as THREE.MeshBasicMaterial).color.set(isDark ? 0xa1a1aa : 0x4b5563);
      } else {
        (view.reticleMesh.material as THREE.MeshBasicMaterial).opacity = 0;
      }

      // Group scale
      const scale = isSelected ? 1.25 : isHovered ? 1.15 : 1.0;
      view.coreMesh.scale.set(scale, scale, scale);
    }

    // Hierarchy Lines
    const lineTreeBase = isDark ? 0x2e2e38 : 0xd1d5db;
    const lineTreeActive = isDark ? 0xffffff : 0x111827;

    state.links.forEach((l, idx) => {
      if (!activeId) {
        l.material.color.set(lineTreeBase);
        l.material.opacity = 0.75;
      } else if (activeLinkIndices.has(idx)) {
        l.material.color.set(lineTreeActive);
        l.material.opacity = 1.0;
      } else {
        l.material.color.set(lineTreeBase);
        l.material.opacity = 0.12;
      }
    });

    // Knowledge Cross Links
    const lineCrossBase = isDark ? 0x383844 : 0x9ca3af;
    const lineCrossActive = isDark ? 0xd4d4d8 : 0x374151;

    state.crossLinks.forEach((cl, idx) => {
      cl.line.visible = curShowCross;
      if (!curShowCross) return;
      if (!activeId) {
        cl.material.color.set(lineCrossBase);
        cl.material.opacity = 0.65;
      } else if (activeCrossLinkIndices.has(idx)) {
        cl.material.color.set(lineCrossActive);
        cl.material.opacity = 1.0;
      } else {
        cl.material.color.set(lineCrossBase);
        cl.material.opacity = 0.1;
      }
    });
    state.requestRender();
  }, []);

  /* ------------------------------------------------------- data → scene */
  useEffect(() => {
    const state = stateRef.current;
    if (!state || webglFailed) return;

    const isDark = theme === "dark";
    const currentLayoutMode = layoutMode;

    const nextBodyIds = new Set(layout.bodies.map((b) => b.id));

    // A. Remove dismissed/deleted nodes (clean DOM and GPU memory)
    for (const [id, view] of state.views.entries()) {
      if (!nextBodyIds.has(id)) {
        view.label.remove();
        state.nodesGroup.remove(view.group);
        view.group.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.material) {
            if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
            else mesh.material.dispose();
          }
        });
        state.views.delete(id);
      }
    }
    if (latest.current.hoveredId && !nextBodyIds.has(latest.current.hoveredId)) {
      setHoveredId(null);
    }
    if (state.drag && !nextBodyIds.has(state.drag.id)) {
      state.drag = null;
      state.dropCandidate = null;
    }

    // B. Reconcile remaining and new nodes using shared geometries
    for (const body of layout.bodies) {
      const pos = currentLayoutMode === "celestial" ? body.position : body.networkPosition;
      const targetVec = new THREE.Vector3(...pos);
      const existing = state.views.get(body.id);

      const targetGeo =
        body.kind === "star"
          ? state.geometries.sphereRoot
          : body.kind === "planet"
            ? state.geometries.sphereLead
            : state.geometries.sphereMember;

      const targetReticleGeo =
        body.kind === "star"
          ? state.geometries.reticleRoot
          : body.kind === "planet"
            ? state.geometries.reticleLead
            : state.geometries.reticleMember;

      const color =
        body.kind === "star"
          ? (isDark ? 0xffffff : 0x000000)
          : body.kind === "planet"
            ? (isDark ? 0xe4e4e7 : 0x1f2937)
            : (isDark ? 0xa1a1aa : 0x6b7280);

      const labelYOffset = body.kind === "star" ? 2.6 : body.kind === "planet" ? 1.8 : 1.1;

      if (existing) {
        // Node already exists: update data and smooth target position (no teleport)
        existing.body = body;
        existing.targetPos.copy(targetVec);
        existing.label.textContent = nameOf(body);
        existing.label.title = body.virtual ? nameOf(body) : `${nameOf(body)} · ${body.id}`;
        existing.label.className = `owb-star-label owb-star-label--${body.kind}`;
        existing.coreMesh.userData.positionId = body.id;

        if (existing.coreMesh.geometry !== targetGeo) {
          existing.coreMesh.geometry = targetGeo;
        }
        (existing.coreMesh.material as THREE.MeshBasicMaterial).color.set(color);

        if (existing.reticleMesh.geometry !== targetReticleGeo) {
          existing.reticleMesh.geometry = targetReticleGeo;
        }

        // Reconcile ringMesh for kind transitions (promote / demote)
        if (body.kind === "star" || body.kind === "planet") {
          const ringGeo = body.kind === "star" ? state.geometries.ringRoot : state.geometries.ringLead;
          const ringColor = isDark
            ? (body.kind === "star" ? 0x52525b : 0x3f3f46)
            : (body.kind === "star" ? 0xadb5bd : 0xd1d5db);

          if (!existing.ringMesh) {
            const ringMat = new THREE.MeshBasicMaterial({ color: ringColor, side: THREE.DoubleSide });
            const ringMesh = new THREE.Mesh(ringGeo, ringMat);
            ringMesh.rotation.x = Math.PI / 2;
            existing.group.add(ringMesh);
            existing.ringMesh = ringMesh;
          } else {
            if (existing.ringMesh.geometry !== ringGeo) {
              existing.ringMesh.geometry = ringGeo;
            }
            (existing.ringMesh.material as THREE.MeshBasicMaterial).color.set(ringColor);
          }
        } else if (existing.ringMesh) {
          existing.group.remove(existing.ringMesh);
          (existing.ringMesh.material as THREE.Material).dispose();
          existing.ringMesh = null;
        }

        existing.labelObject.position.set(0, labelYOffset, 0);
      } else {
        // Newly added node (e.g. hired digital employee): spawn from parent if available
        const group = new THREE.Group();
        let initialPos = targetVec.clone();
        if (body.parentId && state.views.has(body.parentId)) {
          initialPos = state.views.get(body.parentId)!.currentPos.clone();
        }
        group.position.copy(initialPos);

        const material = new THREE.MeshBasicMaterial({ color });
        const coreMesh = new THREE.Mesh(targetGeo, material);
        coreMesh.userData = { positionId: body.id };
        group.add(coreMesh);

        let ringMesh: THREE.Mesh | null = null;
        if (body.kind === "star" || body.kind === "planet") {
          const ringGeo = body.kind === "star" ? state.geometries.ringRoot : state.geometries.ringLead;
          const ringColor = isDark
            ? (body.kind === "star" ? 0x52525b : 0x3f3f46)
            : (body.kind === "star" ? 0xadb5bd : 0xd1d5db);
          const ringMat = new THREE.MeshBasicMaterial({ color: ringColor, side: THREE.DoubleSide });
          ringMesh = new THREE.Mesh(ringGeo, ringMat);
          ringMesh.rotation.x = Math.PI / 2;
          group.add(ringMesh);
        }

        const reticleMat = new THREE.MeshBasicMaterial({
          color: isDark ? 0xffffff : 0x111827,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0,
        });
        const reticleMesh = new THREE.Mesh(targetReticleGeo, reticleMat);
        group.add(reticleMesh);

        const label = document.createElement("div");
        label.className = `owb-star-label owb-star-label--${body.kind}`;
        label.textContent = nameOf(body);
        label.dataset.id = body.id;
        label.title = body.virtual ? nameOf(body) : `${nameOf(body)} · ${body.id}`;
        label.addEventListener("click", (e) => {
          e.stopPropagation();
          if (body.virtual) return;
          setCardDismissed(false);
          flyTo(body.id, true);
          latest.current.onSelect?.(body.id);
        });
        label.addEventListener("mouseenter", () => setHoveredId(body.id));
        label.addEventListener("mouseleave", () => setHoveredId(null));

        const labelObject = new CSS2DObject(label);
        labelObject.center.set(0.5, 1.0);
        labelObject.position.set(0, labelYOffset, 0);
        group.add(labelObject);

        state.nodesGroup.add(group);

        state.views.set(body.id, {
          body,
          group,
          coreMesh,
          ringMesh,
          reticleMesh,
          label,
          labelObject,
          currentPos: initialPos,
          targetPos: targetVec,
        });
      }
    }

    // C. Rebuild Hierarchy Lines (cleanly dispose previous line geometries & materials)
    while (state.treeLinesGroup.children.length > 0) {
      const child = state.treeLinesGroup.children[0]!;
      state.treeLinesGroup.remove(child);
      disposeObject3D(child);
    }
    state.links = [];

    const defaultColor = isDark ? 0x2e2e38 : 0xd1d5db;
    for (const body of layout.bodies) {
      if (!body.parentId || !state.views.has(body.parentId) || !state.views.has(body.id)) continue;
      const parentPos = state.views.get(body.parentId)!.currentPos;
      const childPos = state.views.get(body.id)!.currentPos;

      const geometry = new THREE.BufferGeometry().setFromPoints([parentPos, childPos]);
      const material = new THREE.LineBasicMaterial({
        color: defaultColor,
        transparent: true,
        opacity: 0.75,
      });
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      state.treeLinesGroup.add(line);
      state.links.push({ source: body.parentId, target: body.id, line, material });
    }

    // D. Rebuild Knowledge Cross Links (cleanly dispose previous cross line geometries & materials)
    while (state.crossLinksGroup.children.length > 0) {
      const child = state.crossLinksGroup.children[0]!;
      state.crossLinksGroup.remove(child);
      disposeObject3D(child);
    }
    state.crossLinks = [];

    const crossColor = isDark ? 0x383844 : 0x9ca3af;
    for (const cl of effectiveKnowledgeLinks) {
      if (!state.views.has(cl.source) || !state.views.has(cl.target)) continue;
      const srcPos = state.views.get(cl.source)!.currentPos;
      const tgtPos = state.views.get(cl.target)!.currentPos;

      const geometry = new THREE.BufferGeometry().setFromPoints([srcPos, tgtPos]);
      const material = new THREE.LineDashedMaterial({
        color: crossColor,
        dashSize: 0.8,
        gapSize: 0.6,
        transparent: true,
        opacity: 0.65,
      });
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      line.computeLineDistances();
      state.crossLinksGroup.add(line);
      state.crossLinks.push({
        source: cl.source,
        target: cl.target,
        label: cl.label,
        desc: cl.desc,
        line,
        material,
      });
    }

    applyVisualState();
  }, [layout, theme, webglFailed, nameOf, effectiveKnowledgeLinks, applyVisualState, layoutMode]);

  useEffect(() => {
    applyVisualState();
  }, [selectedId, hoveredId, query, runningIds, applyVisualState, theme, showCrossLinks]);

  /* ------------------------------------------------- layout switching */
  const switchLayoutMode = useCallback(
    (mode: "celestial" | "network"): void => {
      if (layoutMode === mode) return;
      setLayoutMode(mode);
      const state = stateRef.current;
      if (!state) return;

      for (const view of state.views.values()) {
        const p = mode === "celestial" ? view.body.position : view.body.networkPosition;
        view.targetPos.set(...p);
      }
      rebuildOrbits(mode, showOrbits, theme);
    },
    [layoutMode, rebuildOrbits, showOrbits, theme],
  );

  /* ------------------------------------------------- camera glide */
  const flyTo = useCallback((id: string, close = false): void => {
    const state = stateRef.current;
    const view = state?.views.get(id);
    if (!state || !view) return;

    const toTarget = view.currentPos.clone();
    if (latest.current.reducedMotion) {
      state.controls.target.copy(toTarget);
      state.camera.position.copy(toTarget.clone().add(new THREE.Vector3(...DEFAULT_CAM).setLength(close ? 18 : 46)));
      state.requestRender();
      return;
    }

    const direction = state.camera.position.clone().sub(state.controls.target);
    const distance = close ? Math.max(16, view.body.size * 9) : Math.max(30, Math.min(direction.length(), 60));
    direction.y = Math.max(direction.y, 8);

    state.fly = {
      fromTarget: state.controls.target.clone(),
      toTarget,
      fromCam: state.camera.position.clone(),
      toCam: toTarget.clone().add(direction.normalize().multiplyScalar(distance)),
      start: performance.now(),
      duration: 650,
    };
    state.requestRender();
  }, []);

  const flyHome = useCallback((): void => {
    const state = stateRef.current;
    if (!state) return;
    if (latest.current.reducedMotion) {
      state.controls.target.set(0, 0, 0);
      state.camera.position.set(...DEFAULT_CAM);
      state.requestRender();
      return;
    }
    state.fly = {
      fromTarget: state.controls.target.clone(),
      toTarget: new THREE.Vector3(0, 0, 0),
      fromCam: state.camera.position.clone(),
      toCam: new THREE.Vector3(...DEFAULT_CAM),
      start: performance.now(),
      duration: 750,
    };
    state.requestRender();
  }, []);

  const resetView = useCallback((): void => {
    flyHome();
  }, [flyHome]);

  const locate = useCallback(
    (id: string): void => {
      setCardDismissed(false);
      setQuery("");
      latest.current.onSelect?.(id);
      flyTo(id, true);
    },
    [flyTo],
  );

  const toggleTheme = useCallback((): void => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    const state = stateRef.current;
    if (state) {
      state.renderer.setClearColor(nextTheme === "dark" ? 0x09090b : 0xf8f9fa, 1.0);
      state.scene.remove(state.grid);
      state.grid.geometry.dispose();
      (state.grid.material as THREE.Material).dispose();
      state.grid = new THREE.GridHelper(
        120,
        24,
        nextTheme === "dark" ? 0x1c1c24 : 0xd1d5db,
        nextTheme === "dark" ? 0x14141a : 0xe5e7eb,
      );
      state.grid.position.y = -16;
      state.scene.add(state.grid);
      state.requestRender();
    }
  }, [theme]);

  const toggleAutoRotation = useCallback((): void => {
    setAutoRotate((prev) => {
      const next = !prev;
      if (stateRef.current) {
        stateRef.current.controls.autoRotate = next;
        stateRef.current.requestRender();
      }
      return next;
    });
  }, []);

  const toggleOrbitLines = useCallback((): void => {
    setShowOrbits((prev) => !prev);
  }, []);

  const toggleCrossLinksVisibility = useCallback((): void => {
    setShowCrossLinks((prev) => !prev);
  }, []);

  /* ------------------------------------------------------------- render */
  const selectedBody = selectedId ? layout.bodies.find((b) => b.id === selectedId) ?? null : null;
  const parentBody = selectedBody?.parentId
    ? layout.bodies.find((b) => b.id === selectedBody.parentId) ?? null
    : null;
  const selectedBudget = budgetLabelText(selectedBody?.budget ?? null);

  const directReports = useMemo(() => {
    if (!selectedBody) return [];
    return layout.bodies.filter((b) => b.parentId === selectedBody.id);
  }, [layout.bodies, selectedBody]);

  const relevantCrossLinks = useMemo(() => {
    if (!selectedBody) return [];
    return effectiveKnowledgeLinks.filter(
      (c) => c.source === selectedBody.id || c.target === selectedBody.id,
    );
  }, [effectiveKnowledgeLinks, selectedBody]);

  const knowledgeLinkCopy = useCallback(
    (link: OrgKnowledgeLink): { label: string | undefined; desc: string | undefined } => {
      if (!link.relation) return { label: link.label, desc: link.desc };
      const relationKeys = {
        task: ["star.knowledgeTask", "star.knowledgeTaskSubject"],
        goal: ["star.knowledgeGoal", "star.knowledgeGoalSubject"],
        resource: ["star.knowledgeResource", "star.knowledgeResourceSubject"],
        relationship: ["star.knowledgeRelationship", "star.knowledgeRelationshipSubject"],
      } as const;
      const [labelKey, descKey] = relationKeys[link.relation];
      return {
        label: t(labelKey),
        desc: link.subject ? t(descKey, { name: link.subject }) : undefined,
      };
    },
    [t],
  );

  return (
    <section
      className={`owb-star-map owb-star-map--${theme}${className ? ` ${className}` : ""}`}
      aria-label={t("star.title")}
    >
      {/* Top Header Bar */}
      <header className="owb-star-map__head">
        <div className="owb-star-map__brand">
          <div className="owb-star-map__brand-mark">
            <div className="owb-star-map__brand-icon" />
            <strong className="owb-star-map__title">{t("star.title")}</strong>
          </div>
          <div className="owb-star-map__divider" />
          {snapshot && !isEmpty ? (
            <span className="owb-star-map__meta">{t("star.meta", { count: snapshot.positionCount, depth: snapshot.depth })}</span>
          ) : null}
        </div>

        {/* Header Dock Controls */}
        <div className="owb-star-map__controls">
          {/* Layout Mode Switcher */}
          <div className="owb-star-map__control-group" role="group" aria-label="3D Layout Modes">
            <button
              type="button"
              className={`owb-star-map__toggle-btn${layoutMode === "celestial" ? " is-active" : ""}`}
              onClick={() => switchLayoutMode("celestial")}
              title={t("star.layoutCelestialTitle")}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9" />
                <path d="M3.6 9h16.8M3.6 15h16.8" />
              </svg>
              {t("star.layoutCelestial")}
            </button>
            <button
              type="button"
              className={`owb-star-map__toggle-btn${layoutMode === "network" ? " is-active" : ""}`}
              onClick={() => switchLayoutMode("network")}
              title={t("star.layoutNetworkTitle")}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="6" cy="6" r="3" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="12" cy="18" r="3" />
                <path d="M8 8l8 8M16 8l-8 8" />
              </svg>
              {t("star.layoutNetwork")}
            </button>
          </div>

          {/* Feature Toggles */}
          <div className="owb-star-map__control-group" role="group" aria-label="Feature Toggles">
            <button
              type="button"
              className={`owb-star-map__toggle-btn${showOrbits ? " is-active" : ""}`}
              onClick={toggleOrbitLines}
              title={t("star.toggleOrbitsTitle")}
            >
              {t("star.toggleOrbits")}
            </button>
            <button
              type="button"
              className={`owb-star-map__toggle-btn${showCrossLinks ? " is-active" : ""}`}
              onClick={toggleCrossLinksVisibility}
              title={t("star.toggleCrossLinksTitle")}
            >
              {t("star.toggleCrossLinks")}
            </button>
            <button
              type="button"
              className={`owb-star-map__toggle-btn${autoRotate ? " is-active" : ""}`}
              onClick={toggleAutoRotation}
              title={t("star.toggleAutoRotateTitle")}
            >
              {t("star.toggleAutoRotate")}
            </button>
          </div>

          {/* Theme Switcher */}
          <button
            type="button"
            className="owb-star-map__icon-btn"
            onClick={toggleTheme}
            title={theme === "dark" ? t("star.themePaperTitle") : t("star.themeDarkTitle")}
          >
            <span>{theme === "dark" ? "◐" : "◑"}</span>
            <span>{theme === "dark" ? t("star.themePaper") : t("star.themeDark")}</span>
          </button>

          {/* Reset View */}
          <button type="button" className="owb-star-map__icon-btn" onClick={resetView} title={t("star.resetCamera")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            {t("star.resetCamera")}
          </button>
        </div>
      </header>

      {/* Main Search & Actions Dock */}
      <div className="owb-star-map__dock">
        <div className="owb-star-map__search">
          <span className="owb-star-map__search-icon">🔍</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && candidates[0]) locate(candidates[0]);
              else if (e.key === "Escape") setQuery("");
            }}
            placeholder={t("star.search")}
            aria-label={t("star.search")}
          />
          {query.trim() ? (
            <button type="button" className="owb-star-map__search-clear" onClick={() => setQuery("")}>
              ×
            </button>
          ) : null}
          {query.trim() && candidates.length > 0 ? (
            <ul className="owb-star-map__candidates" role="listbox" aria-label={t("star.search")}>
              {candidates.map((id) => (
                <li key={id}>
                  <button type="button" role="option" aria-selected={selectedId === id} onClick={() => locate(id)}>
                    <span className="owb-star-map__candidate-name">{displayNames?.[id] ?? id}</span>
                    <span className="owb-star-map__candidate-id">{id}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="owb-star-map__actions">
          <button
            type="button"
            className="owb-star-map__btn"
            disabled={!selectedId || moveDisabled || !onHireEntry}
            title={t("star.hireUnderTitle")}
            onClick={() => selectedId && onHireEntry?.(selectedId)}
          >
            {t("star.hireUnder")}
          </button>
          {dismissSlot}
          {onUndo ? (
            <button type="button" className="owb-star-map__btn" disabled={moveDisabled} onClick={onUndo}>
              {t("star.undo")}
            </button>
          ) : null}
          <button type="button" className="owb-star-map__btn" onClick={resetView}>
            {t("star.resetView")}
          </button>
          <button type="button" className="owb-star-map__btn" onClick={flyHome}>
            {t("star.zoomOut")}
          </button>
        </div>

        <p className="owb-star-map__hint">{t("star.hint")}</p>
        {toast ? (
          <p className="owb-star-map__toast" role="status">
            {toast}
          </p>
        ) : null}
      </div>

      {/* Focus Inspector Card */}
      {selectedBody && !cardDismissed ? (
        <aside className="owb-star-map__card" aria-label={t("star.cardTitle")}>
          <header>
            <div className="owb-star-map__card-title-wrap">
              <span className="owb-star-map__card-role-badge">
                {selectedBody.kind === "star"
                  ? t("star.layerRoot")
                  : selectedBody.kind === "planet"
                    ? t("star.layerLead")
                    : t("star.layerMember")}
              </span>
              <strong>{nameOf(selectedBody)}</strong>
              {!selectedBody.virtual ? <div className="owb-star-map__card-id">{selectedBody.id}</div> : null}
            </div>
            <button
              type="button"
              className="owb-star-map__card-close"
              aria-label={t("star.close")}
              onClick={() => setCardDismissed(true)}
            >
              ×
            </button>
          </header>

          <div className="owb-star-map__card-body">
            {selectedBody.virtual ? (
              <p>{t("star.enterpriseHint")}</p>
            ) : (
              <>
                <p className="owb-star-map__card-id">{selectedBody.id}</p>
                {displayTitles?.[selectedBody.id] ? (
                  <p className="owb-star-map__card-desc">{displayTitles[selectedBody.id]}</p>
                ) : null}

                {/* 2x2 Structured Meta Grid matching minimalist design */}
                <div className="owb-star-map__card-meta-grid">
                  <div className="owb-star-map__card-meta-box">
                    <div className="owb-star-map__card-meta-label">{t("star.cardMode")}</div>
                    <div className="owb-star-map__card-meta-val">
                      {displayModes?.[selectedBody.id] === "approval_required"
                        ? t("star.modeApproval")
                        : t("star.modeReadOnly")}
                    </div>
                  </div>
                  <div className="owb-star-map__card-meta-box">
                    <div className="owb-star-map__card-meta-label">{t("star.cardParent")}</div>
                    <div className="owb-star-map__card-meta-val">
                      {parentBody ? nameOf(parentBody) : t("org.enterpriseRoot")}
                    </div>
                  </div>
                  <div className="owb-star-map__card-meta-box">
                    <div className="owb-star-map__card-meta-label">{t("star.cardBudget")}</div>
                    <div className="owb-star-map__card-meta-val">
                      {selectedBudget ?? t("star.declaration")}
                    </div>
                  </div>
                  <div className="owb-star-map__card-meta-box">
                    <div className="owb-star-map__card-meta-label">{t("star.directReports")}</div>
                    <div className="owb-star-map__card-meta-val">
                      {t("star.reports", { count: selectedBody.childCount })}
                    </div>
                  </div>
                </div>


                {directReports.length > 0 ? (
                  <div className="owb-star-map__card-section">
                    <div className="owb-star-map__card-section-label">{t("star.directReports")}</div>
                    <ul className="owb-star-map__card-links-list">
                      {directReports.map((sub) => (
                        <li key={sub.id}>
                          <button type="button" onClick={() => locate(sub.id)}>
                            <span>{nameOf(sub)}</span>
                            <span className="owb-star-map__card-id">{sub.id}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {relevantCrossLinks.length > 0 ? (
                  <div className="owb-star-map__card-section">
                    <div className="owb-star-map__card-section-label">{t("star.knowledgeLinks")}</div>
                    <ul className="owb-star-map__card-links-list">
                      {relevantCrossLinks.map((cl, i) => {
                        const otherId = cl.source === selectedBody.id ? cl.target : cl.source;
                        const otherBody = layout.bodies.find((b) => b.id === otherId);
                        const otherName = otherBody ? nameOf(otherBody) : (displayNames?.[otherId] ?? otherId);
                        const isSource = cl.source === selectedBody.id;
                        const copy = knowledgeLinkCopy(cl);
                        return (
                          <li key={`${cl.source}-${cl.target}-${i}`}>
                            <button
                              type="button"
                              onClick={() => locate(otherId)}
                              title={copy.desc || copy.label}
                            >
                              <span>{copy.label ? `${copy.label} · ${otherName}` : otherName}</span>
                              <span className="owb-star-map__card-link-rel">{isSource ? "→" : "←"}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </div>

          <footer>
            {latest.current.onOpenConversation && !selectedBody.virtual ? (
              <button
                type="button"
                className="owb-star-map__btn primary"
                style={{ flex: 1 }}
                onClick={() => latest.current.onOpenConversation?.(selectedBody.id)}
              >
                {t("star.openChat")}
              </button>
            ) : null}
            <button
              type="button"
              className="owb-star-map__btn"
              style={{ flex: 1 }}
              onClick={() => flyTo(selectedBody.id, true)}
            >
              {t("star.zoomIn")}
            </button>
            <button type="button" className="owb-star-map__btn" style={{ flex: 1 }} onClick={flyHome}>
              {t("star.zoomOut")}
            </button>
          </footer>
        </aside>
      ) : null}

      {/* 3D Viewport or Fallback State */}
      {loading ? (
        <div className="owb-star-map__loading">
          <Spin />
        </div>
      ) : isEmpty ? (
        <div className="owb-star-map__fallback">
          <p>{t("star.empty")}</p>
        </div>
      ) : webglFailed ? (
        <div className="owb-star-map__fallback">
          <p>{t("star.fallback")}</p>
          <ul>
            {layout.bodies
              .filter((body) => !body.virtual)
              .map((body) => (
                <li key={body.id}>
                  <button
                    type="button"
                    style={{ paddingLeft: 8 + body.depth * 14 }}
                    aria-pressed={selectedId === body.id}
                    onClick={() => {
                      setCardDismissed(false);
                      latest.current.onSelect?.(body.id);
                    }}
                  >
                    {nameOf(body)}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ) : (
        <div className="owb-star-map__stage" ref={stageRef} />
      )}

      {/* Bottom Status & Minimalist Legend Dock */}
      <footer className="owb-star-map__bottom">
        <div className="owb-star-map__metrics">
          <div className="owb-star-map__metric-item">
            <span>{t("star.metricsNodes")}:</span>
            <span className="owb-star-map__metric-val">{layout.bodies.filter((b) => !b.virtual).length}</span>
          </div>
          <div className="owb-star-map__metric-sep" />
          <div className="owb-star-map__metric-item">
            <span>{t("star.metricsDepth")}:</span>
            <span className="owb-star-map__metric-val">{layout.maxDepth}</span>
          </div>
          <div className="owb-star-map__metric-sep" />
          <div className="owb-star-map__metric-item">
            <span>{t("star.metricsLinks")}:</span>
            <span className="owb-star-map__metric-val">
              {layout.bodies.filter((b) => !b.virtual && b.parentId !== null).length}
            </span>
          </div>
          {effectiveKnowledgeLinks.length > 0 ? (
            <>
              <div className="owb-star-map__metric-sep" />
              <div className="owb-star-map__metric-item">
                <span>{t("star.metricsCrossLinks")}:</span>
                <span className="owb-star-map__metric-val">{effectiveKnowledgeLinks.length}</span>
              </div>
            </>
          ) : null}
        </div>

        <div className="owb-star-map__legend">
          <div className="owb-star-map__legend-item">
            <span className="owb-star-map__legend-dot root" />
            <span>{t("star.layerRoot")}</span>
          </div>
          <div className="owb-star-map__legend-item">
            <span className="owb-star-map__legend-dot lead" />
            <span>{t("star.layerLead")}</span>
          </div>
          <div className="owb-star-map__legend-item">
            <span className="owb-star-map__legend-dot member" />
            <span>{t("star.layerMember")}</span>
          </div>
          <div className="owb-star-map__legend-item">
            <span className="owb-star-map__legend-line solid" />
            <span>{t("star.legendHierarchy")}</span>
          </div>
          {showCrossLinks ? (
            <div className="owb-star-map__legend-item">
              <span className="owb-star-map__legend-line dashed" />
              <span>{t("star.legendCross")}</span>
            </div>
          ) : null}
        </div>
      </footer>
    </section>
  );
}

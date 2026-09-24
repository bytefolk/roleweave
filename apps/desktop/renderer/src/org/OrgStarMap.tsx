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
import type { OrgTreeSnapshot } from "@roleweave/shared";
import {
  buildCelestialLayout,
  isInvalidStarDrop,
  matchStarQuery,
  VIRTUAL_STAR_ID,
  type CelestialBody,
  type CelestialLayout,
} from "./star-map-layout";
import "./OrgStarMap.css";

export interface OrgKnowledgeLink {
  source: string;
  target: string;
  label?: string;
  desc?: string;
}

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
  onMove?: (id: string, reportTo: string | null) => void;
  onHireEntry?: (parentId: string) => void;
  onUndo?: () => void;
  moveDisabled?: boolean;
  dismissSlot?: ReactNode;
  knowledgeLinks?: OrgKnowledgeLink[];
  className?: string;
}

interface BodyView {
  body: CelestialBody;
  group: THREE.Group;
  coreMesh: THREE.Mesh;
  ringMesh: THREE.Mesh | null;
  reticleMesh: THREE.Mesh;
  label: HTMLDivElement;
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
  views: Map<string, BodyView>;
  links: LinkView[];
  crossLinks: CrossLinkView[];
  raycaster: THREE.Raycaster;
  clock: THREE.Clock;
  frame: number;
  fly: {
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromCam: THREE.Vector3;
    toCam: THREE.Vector3;
    start: number;
    duration: number;
  } | null;
  drag: { id: string; x: number; y: number; moved: boolean } | null;
  dropCandidate: string | null;
  disposed: boolean;
}

const DEFAULT_CAM: readonly [number, number, number] = [0, 36, 68];
const DRAG_THRESHOLD = 4;

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
  avatarUrls,
  displayTitles,
  displayModes,
  runningIds,
  selectedId,
  onSelect,
  onMove,
  onHireEntry,
  onUndo,
  moveDisabled = false,
  dismissSlot,
  knowledgeLinks,
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
        theme === "dark" ? 0x1c1c24 : 0xe5e7eb,
        theme === "dark" ? 0x14141a : 0xd1d5db,
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
        views: new Map(),
        links: [],
        crossLinks: [],
        raycaster: new THREE.Raycaster(),
        clock: new THREE.Clock(),
        frame: 0,
        fly: null,
        drag: null,
        dropCandidate: null,
        disposed: false,
      };
      stateRef.current = state;

      const pick = (clientX: number, clientY: number): string | null => {
        const rect = renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const pointer = new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1,
        );
        state.raycaster.setFromCamera(pointer, camera);
        const meshes = [...state.views.values()].map((v) => v.coreMesh);
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
        state.drag = null;
        state.controls.enabled = true;
        renderer.domElement.releasePointerCapture?.(event.pointerId);
        if (!drag) {
          const id = pick(event.clientX, event.clientY);
          if (!id) {
            latest.current.onSelect?.("");
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

      const animate = (): void => {
        if (state.disposed) return;
        state.frame = requestAnimationFrame(animate);
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
        for (const view of state.views.values()) {
          view.reticleMesh.quaternion.copy(state.camera.quaternion);

          if (view.currentPos.distanceTo(view.targetPos) > 0.005) {
            view.currentPos.lerp(view.targetPos, 0.12);
            view.group.position.copy(view.currentPos);
            moved = true;
          }

          // Active running turn pulse
          const isRunning = latest.current.runningIds?.has(view.body.id) === true;
          if (isRunning && !latest.current.reducedMotion) {
            const pulse = 1 + Math.sin(elapsed * 4.2) * 0.12;
            view.coreMesh.scale.setScalar(pulse);
          }
        }

        if (moved) {
          updateLinePositions();
        }

        state.controls.update();
        state.renderer.render(state.scene, state.camera);
        state.labelRenderer.render(state.scene, state.camera);
      };
      animate();

      const observer = new ResizeObserver(() => {
        const w = host.clientWidth;
        const h = host.clientHeight;
        if (w <= 0 || h <= 0) return;
        renderer.setSize(w, h);
        labelRenderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      });
      observer.observe(host);
      setWebglFailed(false);

      return () => {
        state.disposed = true;
        cancelAnimationFrame(state.frame);
        observer.disconnect();
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
  const rebuildOrbits = useCallback((): void => {
    const state = stateRef.current;
    if (!state) return;

    while (state.orbitsGroup.children.length > 0) {
      const child = state.orbitsGroup.children[0];
      state.orbitsGroup.remove(child!);
    }

    if (latest.current.layoutMode !== "celestial" || !latest.current.showOrbits) return;

    const ringColor = latest.current.theme === "dark" ? 0x22222a : 0xd1d5db;
    const subRingColor = latest.current.theme === "dark" ? 0x181820 : 0xe5e7eb;

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
  }, [layout]);

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

  /* ------------------------------------------------------- data → scene */
  useEffect(() => {
    const state = stateRef.current;
    if (!state || webglFailed) return;

    // Clear previous
    for (const view of state.views.values()) view.label.remove();
    state.nodesGroup.clear();
    state.treeLinesGroup.clear();
    state.crossLinksGroup.clear();
    state.views.clear();
    state.links = [];
    state.crossLinks = [];

    const isDark = theme === "dark";

    // 1. Build Nodes
    const nodeGeometries = {
      root: new THREE.SphereGeometry(1.8, 24, 24),
      lead: new THREE.SphereGeometry(1.1, 20, 20),
      member: new THREE.SphereGeometry(0.62, 16, 16),
    };

    for (const body of layout.bodies) {
      const group = new THREE.Group();
      const pos = layoutMode === "celestial" ? body.position : body.networkPosition;
      group.position.set(...pos);

      // Core Solid Sphere
      const color =
        body.kind === "star"
          ? (isDark ? 0xffffff : 0x000000)
          : body.kind === "planet"
            ? (isDark ? 0xe4e4e7 : 0x1f2937)
            : (isDark ? 0xa1a1aa : 0x6b7280);

      const material = new THREE.MeshBasicMaterial({ color });
      const coreGeo =
        body.kind === "star"
          ? nodeGeometries.root
          : body.kind === "planet"
            ? nodeGeometries.lead
            : nodeGeometries.member;

      const coreMesh = new THREE.Mesh(coreGeo, material);
      coreMesh.userData = { positionId: body.id };
      group.add(coreMesh);

      // Outer Geometric Precision Ring for Root and Leads
      let ringMesh: THREE.Mesh | null = null;
      if (body.kind === "star") {
        const ringGeo = new THREE.RingGeometry(2.4, 2.58, 48);
        const ringMat = new THREE.MeshBasicMaterial({
          color: isDark ? 0x52525b : 0xadb5bd,
          side: THREE.DoubleSide,
        });
        ringMesh = new THREE.Mesh(ringGeo, ringMat);
        ringMesh.rotation.x = Math.PI / 2;
        group.add(ringMesh);
      } else if (body.kind === "planet") {
        const ringGeo = new THREE.RingGeometry(1.5, 1.62, 36);
        const ringMat = new THREE.MeshBasicMaterial({
          color: isDark ? 0x3f3f46 : 0xd1d5db,
          side: THREE.DoubleSide,
        });
        ringMesh = new THREE.Mesh(ringGeo, ringMat);
        ringMesh.rotation.x = Math.PI / 2;
        group.add(ringMesh);
      }

      // Selection Wire Reticle
      const reticleGeo = new THREE.RingGeometry(body.size * 1.5, body.size * 1.65, 32);
      const reticleMat = new THREE.MeshBasicMaterial({
        color: isDark ? 0xffffff : 0x111827,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0,
      });
      const reticleMesh = new THREE.Mesh(reticleGeo, reticleMat);
      group.add(reticleMesh);

      // CSS2D DOM Label
      const label = document.createElement("div");
      label.className = `owb-star-label owb-star-label--${body.kind}`;
      label.textContent = nameOf(body);
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
      labelObject.position.set(0, body.size + 1.2, 0);
      group.add(labelObject);

      state.nodesGroup.add(group);

      const targetPos = new THREE.Vector3(...pos);
      state.views.set(body.id, {
        body,
        group,
        coreMesh,
        ringMesh,
        reticleMesh,
        label,
        currentPos: targetPos.clone(),
        targetPos,
      });
    }

    // 2. Build Hierarchy Lines
    const defaultColor = isDark ? 0x2e2e38 : 0xd1d5db;
    for (const body of layout.bodies) {
      if (!body.parentId || !state.views.has(body.parentId)) continue;
      const parentPos = state.views.get(body.parentId)!.currentPos;
      const childPos = state.views.get(body.id)!.currentPos;

      const geometry = new THREE.BufferGeometry().setFromPoints([parentPos, childPos]);
      const material = new THREE.LineBasicMaterial({
        color: defaultColor,
        transparent: true,
        opacity: 0.75,
      });
      const line = new THREE.Line(geometry, material);
      state.treeLinesGroup.add(line);
      state.links.push({ source: body.parentId, target: body.id, line, material });
    }

    // 3. Build Knowledge Cross Links (if any)
    const crossColor = isDark ? 0x383844 : 0x9ca3af;
    if (knowledgeLinks && knowledgeLinks.length > 0) {
      for (const cl of knowledgeLinks) {
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
    }

    rebuildOrbits();
    applyVisualState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, theme, webglFailed, nameOf, knowledgeLinks, rebuildOrbits]);

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
  }, []);

  useEffect(() => {
    applyVisualState();
  }, [selectedId, hoveredId, query, applyVisualState, theme, showCrossLinks]);

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
      rebuildOrbits();
    },
    [layoutMode, rebuildOrbits],
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
  }, []);

  const flyHome = useCallback((): void => {
    const state = stateRef.current;
    if (!state) return;
    if (latest.current.reducedMotion) {
      state.controls.target.set(0, 0, 0);
      state.camera.position.set(...DEFAULT_CAM);
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
  }, []);

  const resetView = useCallback((): void => {
    flyHome();
  }, [flyHome]);

  const locate = useCallback(
    (id: string): void => {
      setCardDismissed(false);
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
      state.grid.material.color.set(nextTheme === "dark" ? 0x1c1c24 : 0xe5e7eb);
    }
  }, [theme]);

  const toggleAutoRotation = useCallback((): void => {
    setAutoRotate((prev) => {
      const next = !prev;
      if (stateRef.current) {
        stateRef.current.controls.autoRotate = next;
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
              title="切换为立体轨道星图"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9" />
                <path d="M3.6 9h16.8M3.6 15h16.8" />
              </svg>
              {t("star.layoutCelestial") || "立体轨道星图"}
            </button>
            <button
              type="button"
              className={`owb-star-map__toggle-btn${layoutMode === "network" ? " is-active" : ""}`}
              onClick={() => switchLayoutMode("network")}
              title="切换为3D拓扑星网"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="6" cy="6" r="3" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="12" cy="18" r="3" />
                <path d="M8 8l8 8M16 8l-8 8" />
              </svg>
              {t("star.layoutNetwork") || "3D 拓扑星网"}
            </button>
          </div>

          {/* Feature Toggles */}
          <div className="owb-star-map__control-group" role="group" aria-label="Feature Toggles">
            <button
              type="button"
              className={`owb-star-map__toggle-btn${showOrbits ? " is-active" : ""}`}
              onClick={toggleOrbitLines}
              title="显示/隐藏天体轨道参考线"
            >
              {t("star.toggleOrbits") || "轨道参考线"}
            </button>
            <button
              type="button"
              className={`owb-star-map__toggle-btn${showCrossLinks ? " is-active" : ""}`}
              onClick={toggleCrossLinksVisibility}
              title="显示/隐藏跨项目协同链"
            >
              {t("star.toggleCrossLinks") || "知识协同链"}
            </button>
            <button
              type="button"
              className={`owb-star-map__toggle-btn${autoRotate ? " is-active" : ""}`}
              onClick={toggleAutoRotation}
              title="开启/停止视口缓动自转"
            >
              {t("star.toggleAutoRotate") || "自转巡航"}
            </button>
          </div>

          {/* Theme Switcher */}
          <button
            type="button"
            className="owb-star-map__icon-btn"
            onClick={toggleTheme}
            title={theme === "dark" ? "切换为素雅白纸模式" : "切换为极简黑夜模式"}
          >
            <span>{theme === "dark" ? "◐" : "◑"}</span>
            <span>{theme === "dark" ? t("star.themePaper") || "素雅白纸" : t("star.themeDark") || "极简黑夜"}</span>
          </button>

          {/* Reset View */}
          <button type="button" className="owb-star-map__icon-btn" onClick={resetView} title={t("star.resetCamera") || "视角复位"}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            {t("star.resetCamera") || "视角复位"}
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
                  ? t("star.layerRoot") || "ORG ROOT"
                  : selectedBody.kind === "planet"
                    ? t("star.layerLead") || "PROJECT LEAD"
                    : t("star.layerMember") || "SPECIALIST"}
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
                {displayModes?.[selectedBody.id] ? (
                  <p>
                    <span className="owb-star-map__tag">
                      {displayModes?.[selectedBody.id] === "approval_required"
                        ? t("star.modeApproval")
                        : t("star.modeReadOnly")}
                    </span>
                  </p>
                ) : null}
                <p>{t("star.reportTo", { name: parentBody ? nameOf(parentBody) : t("org.enterpriseRoot") })}</p>
                <p>{t("star.reports", { count: selectedBody.childCount })}</p>
                <p>{`${t("star.budget")}: ${selectedBudget ?? t("star.declaration")}`}</p>
                {directReports.length > 0 ? (
                  <div className="owb-star-map__card-section">
                    <div className="owb-star-map__card-section-label">直接下属</div>
                    <ul className="owb-star-map__card-links-list">
                      {directReports.slice(0, 5).map((sub) => (
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
              </>
            )}
          </div>

          <footer>
            <button
              type="button"
              className="owb-star-map__btn primary"
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
            <span>{t("star.metricsNodes") || "组织节点"}:</span>
            <span className="owb-star-map__metric-val">{layout.bodies.filter((b) => !b.virtual).length}</span>
          </div>
          <div className="owb-star-map__metric-sep" />
          <div className="owb-star-map__metric-item">
            <span>{t("star.metricsDepth") || "层级深度"}:</span>
            <span className="owb-star-map__metric-val">{layout.maxDepth}</span>
          </div>
          <div className="owb-star-map__metric-sep" />
          <div className="owb-star-map__metric-item">
            <span>{t("star.metricsLinks") || "层级汇报"}:</span>
            <span className="owb-star-map__metric-val">
              {layout.bodies.filter((b) => !b.virtual && b.parentId !== null).length}
            </span>
          </div>
        </div>

        <div className="owb-star-map__legend">
          <div className="owb-star-map__legend-item">
            <span className="owb-star-map__legend-dot root" />
            <span>{t("star.layerRoot") || "组织决策根"}</span>
          </div>
          <div className="owb-star-map__legend-item">
            <span className="owb-star-map__legend-dot lead" />
            <span>{t("star.layerLead") || "项目负责人"}</span>
          </div>
          <div className="owb-star-map__legend-item">
            <span className="owb-star-map__legend-dot member" />
            <span>{t("star.layerMember") || "专职职能岗"}</span>
          </div>
          <div className="owb-star-map__legend-item">
            <span className="owb-star-map__legend-line solid" />
            <span>{t("star.legendHierarchy") || "管理汇报"}</span>
          </div>
          {showCrossLinks ? (
            <div className="owb-star-map__legend-item">
              <span className="owb-star-map__legend-line dashed" />
              <span>{t("star.legendCross") || "知识依赖"}</span>
            </div>
          ) : null}
        </div>
      </footer>
    </section>
  );
}

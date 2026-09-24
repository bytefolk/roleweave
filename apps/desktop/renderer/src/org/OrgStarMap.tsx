/**
 * 3D orbital org map of the reporting tree (#472).
 *
 * Hierarchy is a solar-system layout: the owner is the hub sphere, direct
 * reports sit on the base ring, deeper levels are moons on parent rings.
 * The stage is a dark studio (floor, grid, keyed lights, shadows) so the
 * spheres read as volume, not flat discs. Avatars and names live on CSS2D
 * plates; bodies stay solid colored orbs with a faint self-glow. Links and
 * orbit tori are slightly emissive tubes, not additive neon.
 *
 * Interactions: OrbitControls defaults — left-drag orbits, wheel zooms,
 * right-drag pans. Auto-rotate is a dedicated button. Clicking a body selects
 * the position (same channel as the directory tree); empty canvas clicks do
 * not close the card or toggle rotation. Labels: root/managers stay visible;
 * others fade in on hover, selection, or close camera. Dragging a body onto
 * another body proposes a reporting-line move through the existing
 * change-manifest channel, with the cycle guard refusing self/descendant
 * drops visibly. The dock is search-only; hire, dismiss, undo and camera
 * helpers live on the person card or the one-shot help panel.
 *
 * three.js is imported by this module only; App lazy-loads it, so the default
 * renderer bundle never pays for WebGL. Environments without a WebGL context
 * (jsdom tests, blocked GPUs) degrade to an accessible list of the same
 * bodies plus the same dock, never a blank panel.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Spin } from "antd";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { hueForId, useT } from "@roleweave/ui";
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

export interface OrgStarMapProps {
  snapshot: OrgTreeSnapshot | null;
  loading?: boolean;
  /** Business name; labels the synthetic star when the owner is not in tree. */
  enterpriseName?: string;
  displayNames?: Record<string, string>;
  avatarColors?: Record<string, string>;
  /** Shown as a chip on the name plate and the focus card. */
  avatarUrls?: Record<string, string>;
  displayTitles?: Record<string, string>;
  displayModes?: Record<string, "read_only" | "approval_required">;
  displayEngines?: Record<string, string>;
  /** Position ids with a turn in flight: the halo pulses AI purple. */
  runningIds?: ReadonlySet<string>;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onMove?: (id: string, reportTo: string | null) => void;
  onHireEntry?: (parentId: string) => void;
  onUndo?: () => void;
  moveDisabled?: boolean;
  dismissSlot?: ReactNode;
  className?: string;
}

interface BodyView {
  body: CelestialBody;
  mesh: THREE.Mesh;
  material: THREE.MeshPhysicalMaterial;
  label: HTMLDivElement;
  baseColor: THREE.Color;
  baseEmissive: number;
}

interface SceneState {
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  world: THREE.Group;
  views: Map<string, BodyView>;
  raycaster: THREE.Raycaster;
  clock: THREE.Clock;
  frame: number;
  fly: {
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromCam: THREE.Vector3;
    toCam: THREE.Vector3;
    start: number;
  } | null;
  drag: { id: string; x: number; y: number; moved: boolean } | null;
  dropCandidate: string | null;
  hoverId: string | null;
  disposed: boolean;
  pmrem: THREE.PMREMGenerator;
}

/** Lower, closer camera so rings foreshorten instead of reading as a 2D oval. */
const DEFAULT_CAM: readonly [number, number, number] = [36, 28, 48];
const DRAG_THRESHOLD = 4;
const RUNNING_COLOR = "#722ed1";
const STUDIO = 0x12151c;

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

function makeLink(from: THREE.Vector3, to: THREE.Vector3): THREE.Mesh {
  const direction = to.clone().sub(from);
  const length = Math.max(0.01, direction.length());
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, length, 12),
    new THREE.MeshStandardMaterial({
      color: 0x9ec8ea,
      emissive: 0x3d7eb0,
      emissiveIntensity: 0.4,
      roughness: 0.32,
      metalness: 0.22,
    }),
  );
  mesh.position.copy(from).add(direction.clone().multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.castShadow = true;
  return mesh;
}

function colorFor(id: string, avatarColors?: Record<string, string>): THREE.Color {
  const declared = avatarColors?.[id];
  if (typeof declared === "string" && declared.trim()) {
    const parsed = new THREE.Color(declared);
    if (!Number.isNaN(parsed.r) || !Number.isNaN(parsed.g) || !Number.isNaN(parsed.b)) return parsed;
  }
  return new THREE.Color(`hsl(${hueForId(id)}, 58%, 52%)`);
}

export default function OrgStarMap({
  snapshot,
  loading = false,
  enterpriseName,
  displayNames,
  avatarColors,
  avatarUrls,
  displayTitles,
  displayModes,
  displayEngines,
  runningIds,
  selectedId,
  onSelect,
  onMove,
  onHireEntry,
  onUndo,
  moveDisabled = false,
  dismissSlot,
  className,
}: OrgStarMapProps) {
  const t = useT();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<SceneState | null>(null);
  const layoutRef = useRef<CelestialLayout>({ bodies: [], orbits: [], starId: "", maxDepth: 0 });
  const [webglFailed, setWebglFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [cardDismissed, setCardDismissed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [searchIndex, setSearchIndex] = useState(0);
  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const latest = useRef({ onSelect, onMove, moveDisabled, selectedId, runningIds, query, reducedMotion, t, autoRotate });
  latest.current = { onSelect, onMove, moveDisabled, selectedId, runningIds, query, reducedMotion, t, autoRotate };
  const paintRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 2200);
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
  useEffect(() => {
    setSearchIndex(0);
  }, [query]);

  useEffect(() => {
    const host = stageRef.current;
    if (!host) return;
    let state: SceneState;
    try {
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(host.clientWidth || 640, host.clientHeight || 420);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const labelRenderer = new CSS2DRenderer();
      labelRenderer.setSize(host.clientWidth || 640, host.clientHeight || 420);
      labelRenderer.domElement.style.position = "absolute";
      labelRenderer.domElement.style.top = "0";
      labelRenderer.domElement.style.left = "0";
      labelRenderer.domElement.style.pointerEvents = "none";
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(STUDIO);
      scene.fog = new THREE.Fog(STUDIO, 36, 140);
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      const camera = new THREE.PerspectiveCamera(
        46,
        (host.clientWidth || 640) / (host.clientHeight || 420),
        0.1,
        500,
      );
      camera.position.set(...DEFAULT_CAM);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = 16;
      controls.maxDistance = 120;
      controls.minPolarAngle = 0.42;
      controls.maxPolarAngle = Math.PI / 2.12;
      controls.target.set(0, 0.4, 0);
      controls.autoRotate = false;
      controls.autoRotateSpeed = 0.45;

      const hemi = new THREE.HemisphereLight(0xc9d6ee, 0x1a1c22, 0.55);
      scene.add(hemi);
      const key = new THREE.DirectionalLight(0xfff4e6, 1.85);
      key.position.set(18, 28, 16);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.near = 2;
      key.shadow.camera.far = 80;
      key.shadow.camera.left = -28;
      key.shadow.camera.right = 28;
      key.shadow.camera.top = 28;
      key.shadow.camera.bottom = -28;
      scene.add(key);
      const fill = new THREE.DirectionalLight(0x8eb4ff, 0.7);
      fill.position.set(-22, 10, -12);
      scene.add(fill);
      const rim = new THREE.DirectionalLight(0xd8e8ff, 0.85);
      rim.position.set(-8, 6, 24);
      scene.add(rim);

      const studio = new THREE.Group();
      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(48, 64),
        new THREE.MeshStandardMaterial({ color: 0x0e1118, roughness: 0.92, metalness: 0.08 }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -12;
      floor.receiveShadow = true;
      studio.add(floor);
      const grid = new THREE.GridHelper(48, 24, 0x2a3348, 0x1a2030);
      grid.position.y = -11.96;
      const gridMats = Array.isArray(grid.material) ? grid.material : [grid.material];
      gridMats.forEach((entry) => {
        entry.transparent = true;
        entry.opacity = 0.22;
      });
      studio.add(grid);
      const wall = new THREE.Mesh(
        new THREE.PlaneGeometry(90, 50),
        new THREE.MeshStandardMaterial({ color: 0x161922, roughness: 1, metalness: 0 }),
      );
      wall.position.set(0, 18, -42);
      studio.add(wall);
      scene.add(studio);

      const world = new THREE.Group();
      scene.add(world);
      host.appendChild(renderer.domElement);
      host.appendChild(labelRenderer.domElement);

      state = {
        renderer,
        labelRenderer,
        scene,
        camera,
        controls,
        world,
        views: new Map(),
        raycaster: new THREE.Raycaster(),
        clock: new THREE.Clock(),
        frame: 0,
        fly: null,
        drag: null,
        dropCandidate: null,
        hoverId: null,
        disposed: false,
        pmrem,
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
        const meshes = [...state.views.values()].map((view) => view.mesh);
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
          const hovered = pick(event.clientX, event.clientY);
          if (hovered !== state.hoverId) {
            state.hoverId = hovered;
            paintRef.current();
          }
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
            const invalid = isInvalidStarDrop(layoutRef.current, drag.id, state.dropCandidate)
              || latest.current.moveDisabled;
            view.label.classList.add(invalid ? "is-drop-bad" : "is-drop-ok");
          }
        }
      };
      const onPointerUp = (event: PointerEvent): void => {
        const drag = state.drag;
        state.drag = null;
        state.controls.enabled = true;
        renderer.domElement.releasePointerCapture?.(event.pointerId);
        if (!drag) return;
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
        if (state.fly) {
          const progress = Math.min((performance.now() - state.fly.start) / 620, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          state.controls.target.lerpVectors(state.fly.fromTarget, state.fly.toTarget, eased);
          state.camera.position.lerpVectors(state.fly.fromCam, state.fly.toCam, eased);
          if (progress >= 1) state.fly = null;
        }
        state.controls.autoRotate = latest.current.autoRotate && !latest.current.reducedMotion;
        if (!latest.current.reducedMotion) {
          state.world.rotation.y = Math.sin(elapsed * 0.12) * 0.04;
          for (const view of state.views.values()) {
            view.mesh.rotation.y = elapsed * (view.body.kind === "star" ? 0.18 : 0.32);
            const running = latest.current.runningIds?.has(view.body.id) === true;
            if (running) {
              view.material.emissiveIntensity = view.baseEmissive + 0.12 + Math.sin(elapsed * 3.2) * 0.08;
            }
          }
        }
        paintRef.current();
        state.controls.update();
        state.renderer.render(state.scene, state.camera);
        state.labelRenderer.render(state.scene, state.camera);
      };
      animate();

      const observer = new ResizeObserver(() => {
        const width = host.clientWidth;
        const height = host.clientHeight;
        if (width <= 0 || height <= 0) return;
        renderer.setSize(width, height);
        labelRenderer.setSize(width, height);
        camera.aspect = width / height;
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
          if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
          else material?.dispose();
        });
        state.scene.environment?.dispose();
        pmrem.dispose();
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

  useEffect(() => {
    const state = stateRef.current;
    if (!state || webglFailed) return;
    for (const view of state.views.values()) view.label.remove();
    state.world.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material?.dispose();
    });
    state.world.clear();
    state.views.clear();

    for (const orbit of layout.orbits) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(orbit.radius, 0.06, 12, 128),
        new THREE.MeshStandardMaterial({
          color: 0x44587a,
          emissive: 0x22344f,
          emissiveIntensity: 0.28,
          roughness: 0.4,
          metalness: 0.35,
        }),
      );
      ring.rotation.x = Math.PI / 2 + orbit.tilt;
      ring.position.set(orbit.center[0], orbit.center[1], orbit.center[2]);
      ring.castShadow = true;
      ring.receiveShadow = true;
      state.world.add(ring);
    }

    const byId = new Map(layout.bodies.map((body) => [body.id, body]));
    for (const body of layout.bodies) {
      if (body.parentId && byId.has(body.parentId)) {
        const parent = byId.get(body.parentId)!;
        state.world.add(makeLink(new THREE.Vector3(...parent.position), new THREE.Vector3(...body.position)));
      }
    }

    for (const body of layout.bodies) {
      const baseColor = body.kind === "star" ? new THREE.Color("#d45c32") : colorFor(body.id, avatarColors);
      const baseEmissive = body.kind === "star" ? 0.22 : 0.1;
      const geometry = new THREE.SphereGeometry(body.size, 64, 64);
      const material = new THREE.MeshPhysicalMaterial({
        color: baseColor,
        emissive: baseColor,
        emissiveIntensity: baseEmissive,
        roughness: 0.28,
        metalness: 0.18,
        clearcoat: 0.7,
        clearcoatRoughness: 0.18,
        envMapIntensity: 1.05,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...body.position);
      mesh.userData.positionId = body.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(body.size * 1.07, 32, 32),
        new THREE.MeshBasicMaterial({
          color: baseColor,
          transparent: true,
          opacity: 0.12,
          depthWrite: false,
        }),
      );
      mesh.add(shell);

      const label = document.createElement("div");
      label.className = `owb-star-label owb-star-label--${body.kind}`;
      const avatarSrc = body.virtual ? undefined : avatarUrls?.[body.id];
      if (avatarSrc) {
        const img = document.createElement("img");
        img.className = "owb-star-label__avatar";
        img.alt = "";
        img.src = avatarSrc;
        label.appendChild(img);
      }
      const nameEl = document.createElement("span");
      nameEl.className = "owb-star-label__name";
      nameEl.textContent = nameOf(body);
      label.appendChild(nameEl);
      label.title = body.virtual ? nameOf(body) : `${nameOf(body)} · ${body.id}`;
      label.addEventListener("click", () => {
        if (body.virtual) return;
        setCardDismissed(false);
        flyTo(body.id, true);
        latest.current.onSelect?.(body.id);
      });
      const labelObject = new CSS2DObject(label);
      labelObject.position.set(0, body.size + 1.15, 0);
      mesh.add(labelObject);

      state.world.add(mesh);
      state.views.set(body.id, { body, mesh, material, label, baseColor, baseEmissive });
    }
    applyVisualState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, avatarColors, avatarUrls, webglFailed, nameOf]);

  const applyVisualState = useCallback((): void => {
    const state = stateRef.current;
    if (!state) return;
    const { selectedId: selected, runningIds: running, query: rawQuery } = latest.current;
    const q = rawQuery.trim().toLowerCase();
    const camera = state.camera.position;
    const world = new THREE.Vector3();
    for (const view of state.views.values()) {
      const name = view.label.textContent ?? "";
      const haystack = `${name} ${view.body.id}`.toLowerCase();
      const dimmed = q.length > 0 && !haystack.includes(q);
      const isSelected = view.body.id === selected;
      const isRunning = running?.has(view.body.id) === true;
      const isHover = view.body.id === state.hoverId;
      view.mesh.getWorldPosition(world);
      const dist = camera.distanceTo(world);
      const fade = dist >= 88 ? 0 : dist <= 40 ? 1 : (88 - dist) / 48;
      const keepAlways =
        view.body.kind === "star" ||
        view.body.depth <= 1 ||
        view.body.childCount > 0 ||
        isSelected ||
        isHover ||
        (q.length > 0 && !dimmed);
      const keepLabel = keepAlways || fade > 0.04;
      view.label.classList.toggle("is-hidden", !keepLabel);
      view.label.classList.toggle("is-dimmed", dimmed);
      view.label.style.opacity = keepAlways ? "" : keepLabel ? String(fade) : "0";
      view.label.classList.toggle("is-selected", isSelected);
      view.mesh.scale.setScalar(isSelected ? 1.12 : 1);
      view.material.transparent = dimmed;
      view.material.opacity = dimmed ? 0.18 : 1;
      if (!isRunning) {
        view.material.emissive.copy(isSelected ? view.baseColor.clone().lerp(new THREE.Color("#ffffff"), 0.2) : view.baseColor);
        view.material.emissiveIntensity = isSelected ? view.baseEmissive + 0.1 : view.baseEmissive;
      } else {
        view.material.emissive.set(RUNNING_COLOR);
      }
    }
  }, []);
  paintRef.current = applyVisualState;

  useEffect(() => {
    applyVisualState();
  }, [selectedId, runningIds, query, applyVisualState, layout]);

  const flyTo = useCallback((id: string, close = false): void => {
    const state = stateRef.current;
    const body = layoutRef.current.bodies.find((entry) => entry.id === id);
    if (!state || !body) return;
    const toTarget = new THREE.Vector3(...body.position);
    if (latest.current.reducedMotion) {
      state.controls.target.copy(toTarget);
      state.camera.position.copy(toTarget.clone().add(new THREE.Vector3(...DEFAULT_CAM).setLength(close ? Math.max(12, body.size * 8) : 40)));
      return;
    }
    const direction = state.camera.position.clone().sub(state.controls.target);
    const distance = close ? Math.max(12, body.size * 8) : Math.max(22, Math.min(direction.length(), 48));
    state.fly = {
      fromTarget: state.controls.target.clone(),
      toTarget,
      fromCam: state.camera.position.clone(),
      toCam: toTarget.clone().add(direction.setLength(distance)),
      start: performance.now(),
    };
  }, []);

  const flyHome = useCallback((): void => {
    const state = stateRef.current;
    if (!state) return;
    if (latest.current.reducedMotion) {
      state.controls.target.set(0, 0.4, 0);
      state.camera.position.set(...DEFAULT_CAM);
      return;
    }
    state.fly = {
      fromTarget: state.controls.target.clone(),
      toTarget: new THREE.Vector3(0, 0.4, 0),
      fromCam: state.camera.position.clone(),
      toCam: new THREE.Vector3(...DEFAULT_CAM),
      start: performance.now(),
    };
  }, []);

  const locate = useCallback(
    (id: string): void => {
      setCardDismissed(false);
      latest.current.onSelect?.(id);
      flyTo(id, true);
    },
    [flyTo],
  );

  const resetView = useCallback((): void => {
    const state = stateRef.current;
    if (!state) return;
    state.fly = null;
    state.controls.target.set(0, 0.4, 0);
    state.camera.position.set(...DEFAULT_CAM);
  }, []);

  const selectedBody = selectedId ? layout.bodies.find((body) => body.id === selectedId) ?? null : null;
  const parentBody = selectedBody?.parentId
    ? layout.bodies.find((body) => body.id === selectedBody.parentId) ?? null
    : null;
  const selectedBudget = budgetLabelText(selectedBody?.budget ?? null);
  return (
    <section className={`owb-star-map${className ? ` ${className}` : ""}`} aria-label={t("star.title")}>
      <header className="owb-star-map__head">
        <strong>{t("star.title")}</strong>
        {snapshot && !isEmpty ? (
          <span className="owb-star-map__meta">{t("star.meta", { count: snapshot.positionCount, depth: snapshot.depth })}</span>
        ) : null}
        <span className="owb-star-map__head-actions">
          <button
            type="button"
            className="owb-star-map__btn"
            aria-pressed={autoRotate}
            onClick={() => setAutoRotate((value) => !value)}
          >
            {autoRotate ? t("star.autoRotateOn") : t("star.autoRotateOff")}
          </button>
          <button
            type="button"
            className="owb-star-map__btn owb-star-map__help-btn"
            aria-expanded={helpOpen}
            aria-label={t("star.helpTitle")}
            onClick={() => setHelpOpen((value) => !value)}
          >
            ?
          </button>
        </span>
      </header>
      {helpOpen ? (
        <div className="owb-star-map__help" role="dialog" aria-label={t("star.helpTitle")}>
          <p>{t("star.hint")}</p>
          <div className="owb-star-map__actions">
            <button type="button" className="owb-star-map__btn" onClick={resetView}>
              {t("star.resetView")}
            </button>
            <button type="button" className="owb-star-map__btn" onClick={flyHome}>
              {t("star.zoomOut")}
            </button>
            {onUndo ? (
              <button type="button" className="owb-star-map__btn" onClick={onUndo}>
                {t("star.undo")}
              </button>
            ) : null}
            <button type="button" className="owb-star-map__btn" onClick={() => setHelpOpen(false)}>
              {t("star.close")}
            </button>
          </div>
        </div>
      ) : null}
      <div className="owb-star-map__dock">
        <div className="owb-star-map__search">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setQuery("");
                return;
              }
              if (event.key === "ArrowDown" && candidates.length > 0) {
                event.preventDefault();
                setSearchIndex((index) => (index + 1) % candidates.length);
                return;
              }
              if (event.key === "ArrowUp" && candidates.length > 0) {
                event.preventDefault();
                setSearchIndex((index) => (index - 1 + candidates.length) % candidates.length);
                return;
              }
              if (event.key === "Enter") {
                const id = candidates[searchIndex] ?? candidates[0];
                if (id) locate(id);
              }
            }}
            placeholder={t("star.search")}
            aria-label={t("star.search")}
            aria-autocomplete="list"
          />
          {query.trim() && candidates.length > 0 ? (
            <ul className="owb-star-map__candidates" role="listbox" aria-label={t("star.search")}>
              {candidates.map((id, index) => (
                <li key={id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === searchIndex}
                    className={index === searchIndex ? "is-active" : undefined}
                    onClick={() => locate(id)}
                  >
                    <span className="owb-star-map__candidate-name">{displayNames?.[id] ?? id}</span>
                    <span className="owb-star-map__candidate-id">{id}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {query.trim() && candidates.length === 0 ? (
            <p className="owb-star-map__search-empty" role="status">
              {t("star.searchEmpty")}
            </p>
          ) : null}
        </div>
        {toast ? (
          <p className="owb-star-map__toast" role="status">
            {toast}
          </p>
        ) : null}
      </div>
      {selectedBody && !cardDismissed ? (
        <aside className="owb-star-map__card" aria-label={t("star.cardTitle")}>
          <header>
            <span className="owb-star-map__card-who">
              {selectedBody.virtual ? null : avatarUrls?.[selectedBody.id] ? (
                <img className="owb-star-map__card-avatar" src={avatarUrls[selectedBody.id]} alt="" />
              ) : null}
              <strong>{nameOf(selectedBody)}</strong>
            </span>
            <button
              type="button"
              className="owb-star-map__card-close"
              aria-label={t("star.close")}
              onClick={() => setCardDismissed(true)}
            >
              ×
            </button>
          </header>
          {selectedBody.virtual ? (
            <p>{t("star.enterpriseHint")}</p>
          ) : (
            <>
              <p className="owb-star-map__card-id">{selectedBody.id}</p>
              {displayTitles?.[selectedBody.id] ? <p>{displayTitles[selectedBody.id]}</p> : null}
              {displayModes?.[selectedBody.id] ? (
                <p>
                  <span className="owb-star-map__tag">
                    {displayModes[selectedBody.id] === "approval_required" ? t("star.modeApproval") : t("star.modeReadOnly")}
                  </span>
                </p>
              ) : null}
              <p>{t("star.reportTo", { name: parentBody ? nameOf(parentBody) : t("org.enterpriseRoot") })}</p>
              <p>{t("star.reports", { count: selectedBody.childCount })}</p>
              <p>{`${t("star.budget")}: ${selectedBudget ?? t("star.declaration")}`}</p>
              <p>
                {runningIds?.has(selectedBody.id) ? t("star.running") : t("star.idle")}
                {displayEngines?.[selectedBody.id] ? ` · ${displayEngines[selectedBody.id]}` : ""}
              </p>
            </>
          )}
          <footer>
            {selectedBody.virtual ? null : (
              <button type="button" className="owb-star-map__btn owb-star-map__btn--primary" onClick={() => onSelect?.(selectedBody.id)}>
                {t("star.enterConversation")}
              </button>
            )}
            <button type="button" className="owb-star-map__btn" onClick={() => flyTo(selectedBody.id, true)}>
              {t("star.zoomIn")}
            </button>
            <button
              type="button"
              className="owb-star-map__btn"
              disabled={moveDisabled || !onHireEntry}
              onClick={() => onHireEntry?.(selectedBody.id)}
            >
              {t("star.hireUnder")}
            </button>
            {dismissSlot}
          </footer>
        </aside>
      ) : null}
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
            {layout.bodies.filter((body) => !body.virtual).map((body) => (
              <li key={body.id}>
                <button
                  type="button"
                  style={{ paddingLeft: 6 + body.depth * 14 }}
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
    </section>
  );
}

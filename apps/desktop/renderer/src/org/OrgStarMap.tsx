/**
 * 3D celestial star map of the reporting tree (#472).
 *
 * The org becomes a solar system: the enterprise owner is a glowing star,
 * direct reports are planets on the base orbit ring, deeper levels are moons
 * on smaller rings around their own parent, and the whole thing floats in a
 * procedural starfield instead of a flat black canvas. Hierarchy stays
 * legible by construction — deterministic orbital layout (see
 * ./star-map-layout), orbit rings per parent, and DOM-text labels rendered
 * through CSS2DRenderer so names stay pixel-crisp at every zoom level
 * (canvas-baked sprites smear; this view forbids that).
 *
 * Interactions: left-drag orbits the camera, wheel zooms, right-drag pans;
 * clicking a body selects the position (same channel as the directory tree);
 * dragging a body onto another body proposes a reporting-line move through
 * the existing change-manifest channel, with the cycle guard refusing
 * self/descendant drops visibly. The dock offers locate-by-name/id with a
 * camera fly-to, hire-under-selection, caller-owned dismiss and undo — no new
 * mutation path is invented here.
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
  /** Position ids with a turn in flight: the halo pulses AI purple. */
  runningIds?: ReadonlySet<string>;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Reporting-line move proposal; the caller owns validation/apply. */
  onMove?: (id: string, reportTo: string | null) => void;
  onHireEntry?: (parentId: string) => void;
  onUndo?: () => void;
  moveDisabled?: boolean;
  /** Caller-owned dismiss trigger (confirm dialog) for the selected position. */
  dismissSlot?: ReactNode;
  className?: string;
}

interface BodyView {
  body: CelestialBody;
  mesh: THREE.Mesh;
  halo: THREE.Sprite;
  haloMaterial: THREE.SpriteMaterial;
  material: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
  label: HTMLDivElement;
  baseColor: THREE.Color;
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
  disposed: boolean;
}

const DEFAULT_CAM: readonly [number, number, number] = [0, 30, 74];
const DRAG_THRESHOLD = 4;
const RUNNING_COLOR = "#722ed1";

function glowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.35, "rgba(255,255,255,0.55)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function colorFor(id: string, avatarColors?: Record<string, string>): THREE.Color {
  const declared = avatarColors?.[id];
  if (typeof declared === "string" && declared.trim()) {
    const parsed = new THREE.Color(declared);
    if (!Number.isNaN(parsed.r) || !Number.isNaN(parsed.g) || !Number.isNaN(parsed.b)) return parsed;
  }
  return new THREE.Color(`hsl(${hueForId(id)}, 55%, 62%)`);
}

export default function OrgStarMap({
  snapshot,
  loading = false,
  enterpriseName,
  displayNames,
  avatarColors,
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
  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const latest = useRef({ onSelect, onMove, moveDisabled, selectedId, runningIds, query, reducedMotion, t });
  latest.current = { onSelect, onMove, moveDisabled, selectedId, runningIds, query, reducedMotion, t };

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

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
    () => layout.bodies.map((body) => ({ id: body.id, name: nameOf(body) })),
    [layout, nameOf],
  );
  const candidates = useMemo(() => matchStarQuery(entries, query).slice(0, 8), [entries, query]);

  /* ---------------------------------------------------------------- scene */
  useEffect(() => {
    const host = stageRef.current;
    if (!host) return;
    let state: SceneState;
    try {
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(host.clientWidth || 640, host.clientHeight || 420);
      const labelRenderer = new CSS2DRenderer();
      labelRenderer.setSize(host.clientWidth || 640, host.clientHeight || 420);
      labelRenderer.domElement.style.position = "absolute";
      labelRenderer.domElement.style.top = "0";
      labelRenderer.domElement.style.left = "0";
      labelRenderer.domElement.style.pointerEvents = "none";
      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#070b18");
      const camera = new THREE.PerspectiveCamera(
        55,
        (host.clientWidth || 640) / (host.clientHeight || 420),
        0.1,
        2000,
      );
      camera.position.set(...DEFAULT_CAM);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = 8;
      controls.maxDistance = 320;
      const glow = glowTexture();

      // Starfield: the background is space, not a void (#472).
      const starCount = 1500;
      const positions = new Float32Array(starCount * 3);
      const colors = new Float32Array(starCount * 3);
      const palette = [new THREE.Color("#ffffff"), new THREE.Color("#9db4ff"), new THREE.Color("#ffd9a0")];
      for (let i = 0; i < starCount; i += 1) {
        const radius = 280 + Math.random() * 320;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = radius * Math.cos(phi);
        positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
        const tint = palette[Math.floor(Math.random() * palette.length)] ?? palette[0]!;
        const dim = 0.45 + Math.random() * 0.55;
        colors[i * 3] = tint.r * dim;
        colors[i * 3 + 1] = tint.g * dim;
        colors[i * 3 + 2] = tint.b * dim;
      }
      const starGeometry = new THREE.BufferGeometry();
      starGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      starGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const stars = new THREE.Points(
        starGeometry,
        new THREE.PointsMaterial({
          size: 1.5,
          sizeAttenuation: true,
          vertexColors: true,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        }),
      );
      scene.add(stars);

      // Faint nebulae for depth; additive, far behind the system.
      for (const [color, scale, pos, opacity] of [
        ["#4c3a8f", 300, [-240, 130, -420], 0.16],
        ["#14406b", 230, [270, -150, -460], 0.12],
      ] as const) {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: glow,
            color: new THREE.Color(color),
            transparent: true,
            opacity,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        sprite.scale.setScalar(scale);
        sprite.position.set(pos[0], pos[1], pos[2]);
        scene.add(sprite);
      }

      scene.add(new THREE.AmbientLight(0x8fa0ff, 0.55));
      const sunLight = new THREE.PointLight(0xffcf8a, 1400, 0, 2);
      scene.add(sunLight);
      const rim = new THREE.DirectionalLight(0xffffff, 0.7);
      rim.position.set(60, 90, 40);
      scene.add(rim);

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
        if (!id) return;
        state.drag = { id, x: event.clientX, y: event.clientY, moved: false };
        state.controls.enabled = false;
        renderer.domElement.setPointerCapture?.(event.pointerId);
      };
      const onPointerMove = (event: PointerEvent): void => {
        const drag = state.drag;
        if (!drag) return;
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
          current.onSelect?.(drag.id);
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
        for (const view of state.views.values()) {
          const running = latest.current.runningIds?.has(view.body.id) === true;
          if (running && !latest.current.reducedMotion) {
            const pulse = 1 + Math.sin(elapsed * 4.2) * 0.16;
            view.halo.scale.setScalar(view.body.size * 3.4 * pulse);
            view.haloMaterial.opacity = 0.5 + Math.sin(elapsed * 4.2) * 0.14;
          }
        }
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
        state.world.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
          else {
            material?.dispose();
            (material as THREE.SpriteMaterial | null)?.map?.dispose();
          }
        });
        state.scene.traverse((object) => {
          const sprite = object as THREE.Sprite;
          sprite.material?.dispose?.();
        });
        renderer.dispose();
        host.removeChild(renderer.domElement);
        host.removeChild(labelRenderer.domElement);
        stateRef.current = null;
      };
    } catch {
      // No WebGL (jsdom tests, blocked GPUs): the dock + list fallback below
      // keeps every operation reachable.
      setWebglFailed(true);
      return;
    }
    // Re-runs only when the stage element (re)appears: the initial loading
    // flip, workspace open/close, or a WebGL-failure fallback transition.
  }, [loading, isEmpty, webglFailed]);

  /* ------------------------------------------------------- data → scene */
  useEffect(() => {
    const state = stateRef.current;
    if (!state || webglFailed) return;
    // Rebuild the world group from the layout; dispose the previous bodies.
    for (const view of state.views.values()) view.label.remove();
    state.world.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else {
        material?.dispose();
        (material as THREE.SpriteMaterial | null)?.map?.dispose();
      }
    });
    state.world.clear();
    state.views.clear();
    const glow = glowTexture();

    for (const orbit of layout.orbits) {
      const curve = new THREE.EllipseCurve(0, 0, orbit.radius, orbit.radius, 0, Math.PI * 2, false, 0);
      const points = curve.getPoints(96).map((point) => new THREE.Vector3(point.x, 0, point.y));
      const ring = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0x55608a, transparent: true, opacity: 0.5 }),
      );
      ring.rotation.x = orbit.tilt;
      ring.position.set(orbit.center[0], orbit.center[1], orbit.center[2]);
      state.world.add(ring);
    }

    const byId = new Map(layout.bodies.map((body) => [body.id, body]));
    for (const body of layout.bodies) {
      if (body.parentId && byId.has(body.parentId)) {
        const parent = byId.get(body.parentId)!;
        const link = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(...parent.position),
            new THREE.Vector3(...body.position),
          ]),
          new THREE.LineBasicMaterial({ color: 0x7f8db8, transparent: true, opacity: 0.34 }),
        );
        state.world.add(link);
      }
    }

    for (const body of layout.bodies) {
      const baseColor = body.kind === "star" ? new THREE.Color("#ffd27a") : colorFor(body.id, avatarColors);
      const geometry = new THREE.SphereGeometry(body.size, body.kind === "star" ? 48 : 32, body.kind === "star" ? 48 : 32);
      const material =
        body.kind === "star"
          ? new THREE.MeshBasicMaterial({ color: baseColor })
          : new THREE.MeshStandardMaterial({
              color: baseColor,
              roughness: 0.38,
              metalness: 0.08,
              emissive: baseColor.clone().multiplyScalar(0.32),
            });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...body.position);
      mesh.userData.positionId = body.id;
      const haloMaterial = new THREE.SpriteMaterial({
        map: glow,
        color: baseColor.clone(),
        transparent: true,
        opacity: body.kind === "star" ? 0.85 : 0.16,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const halo = new THREE.Sprite(haloMaterial);
      halo.scale.setScalar(body.size * (body.kind === "star" ? 6.5 : 3.4));
      mesh.add(halo);

      const label = document.createElement("div");
      label.className = `owb-star-label owb-star-label--${body.kind}`;
      label.textContent = nameOf(body);
      label.title = body.virtual ? nameOf(body) : `${nameOf(body)} · ${body.id}`;
      label.addEventListener("click", () => latest.current.onSelect?.(body.id));
      const labelObject = new CSS2DObject(label);
      labelObject.position.set(0, body.size + 1.1, 0);
      mesh.add(labelObject);

      state.world.add(mesh);
      state.views.set(body.id, { body, mesh, halo, haloMaterial, material, label, baseColor });
    }
    applyVisualState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, avatarColors, webglFailed, nameOf]);

  /* ------------------------------------------- selection / runs / filter */
  const applyVisualState = useCallback((): void => {
    const state = stateRef.current;
    if (!state) return;
    const { selectedId: selected, runningIds: running, query: rawQuery } = latest.current;
    const q = rawQuery.trim().toLowerCase();
    for (const view of state.views.values()) {
      const name = view.label.textContent ?? "";
      const haystack = `${name} ${view.body.id}`.toLowerCase();
      const dimmed = q.length > 0 && !haystack.includes(q);
      const isSelected = view.body.id === selected;
      const isRunning = running?.has(view.body.id) === true;
      view.label.classList.toggle("is-dimmed", dimmed);
      view.label.classList.toggle("is-selected", isSelected);
      view.mesh.scale.setScalar(isSelected ? 1.18 : 1);
      const transparent = true;
      view.material.transparent = transparent;
      view.material.opacity = dimmed ? 0.16 : 1;
      if (!isRunning) {
        view.haloMaterial.color.copy(isSelected ? view.baseColor.clone().lerp(new THREE.Color("#ffffff"), 0.35) : view.baseColor);
        view.haloMaterial.opacity = view.body.kind === "star" ? 0.85 : isSelected ? 0.5 : dimmed ? 0.05 : 0.16;
        view.halo.scale.setScalar(view.body.size * (view.body.kind === "star" ? 6.5 : 3.4));
      } else {
        view.haloMaterial.color.set(RUNNING_COLOR);
      }
    }
  }, []);

  useEffect(() => {
    applyVisualState();
  }, [selectedId, runningIds, query, applyVisualState, layout]);

  const flyTo = useCallback((id: string): void => {
    const state = stateRef.current;
    const body = layoutRef.current.bodies.find((entry) => entry.id === id);
    if (!state || !body) return;
    const toTarget = new THREE.Vector3(...body.position);
    if (latest.current.reducedMotion) {
      state.controls.target.copy(toTarget);
      state.camera.position.copy(toTarget.clone().add(new THREE.Vector3(...DEFAULT_CAM).setLength(46)));
      return;
    }
    const direction = state.camera.position.clone().sub(state.controls.target);
    const distance = Math.max(30, Math.min(direction.length(), 60));
    state.fly = {
      fromTarget: state.controls.target.clone(),
      toTarget,
      fromCam: state.camera.position.clone(),
      toCam: toTarget.clone().add(direction.setLength(distance)),
      start: performance.now(),
    };
  }, []);

  const locate = useCallback(
    (id: string): void => {
      latest.current.onSelect?.(id);
      flyTo(id);
    },
    [flyTo],
  );

  const resetView = useCallback((): void => {
    const state = stateRef.current;
    if (!state) return;
    state.fly = null;
    state.controls.target.set(0, 0, 0);
    state.camera.position.set(...DEFAULT_CAM);
  }, []);

  /* ------------------------------------------------------------- render */
  return (
    <section className={`owb-star-map${className ? ` ${className}` : ""}`} aria-label={t("star.title")}>
      <header className="owb-star-map__head">
        <strong>{t("star.title")}</strong>
        {snapshot && !isEmpty ? (
          <span className="owb-star-map__meta">{t("star.meta", { count: snapshot.positionCount, depth: snapshot.depth })}</span>
        ) : null}
      </header>
      <div className="owb-star-map__dock">
        <div className="owb-star-map__search">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && candidates[0]) locate(candidates[0]);
            }}
            placeholder={t("star.search")}
            aria-label={t("star.search")}
          />
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
        </div>
        <p className="owb-star-map__hint">{t("star.hint")}</p>
        {toast ? (
          <p className="owb-star-map__toast" role="status">
            {toast}
          </p>
        ) : null}
      </div>
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
            {layout.bodies.map((body) => (
              <li key={body.id}>
                <button
                  type="button"
                  style={{ paddingLeft: 6 + body.depth * 14 }}
                  aria-pressed={selectedId === body.id}
                  onClick={() => latest.current.onSelect?.(body.id)}
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

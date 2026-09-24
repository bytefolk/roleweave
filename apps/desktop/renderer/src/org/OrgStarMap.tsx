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
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
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
  /** Render-ready avatar sources: bodies become portrait medallions fused
   *  into the space scene; positions without one stay colored planets. */
  avatarUrls?: Record<string, string>;
  displayTitles?: Record<string, string>;
  displayModes?: Record<string, "read_only" | "approval_required">;
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
  medallion: THREE.Sprite | null;
  label: HTMLDivElement;
  baseColor: THREE.Color;
  baseOpacity: number;
}

interface SceneState {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
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
  sky: THREE.Group;
}

const DEFAULT_CAM: readonly [number, number, number] = [0, 26, 64];
const DRAG_THRESHOLD = 4;
const RUNNING_COLOR = "#722ed1";

/** Circular portrait medallion texture: rim glow + clipped photo + ring, so
 *  employee avatars read as planets fused into the space scene (#472 R2). */
function makeMedallionTexture(rim: THREE.Color): {
  texture: THREE.CanvasTexture;
  paint: (img?: HTMLImageElement) => void;
} {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const rimStyle = `#${rim.getHexString()}`;
  const paint = (img?: HTMLImageElement): void => {
    if (!ctx) return;
    ctx.clearRect(0, 0, 256, 256);
    const glow = ctx.createRadialGradient(128, 128, 90, 128, 128, 128);
    glow.addColorStop(0, `${rimStyle}99`);
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 256, 256);
    ctx.save();
    ctx.beginPath();
    ctx.arc(128, 128, 92, 0, Math.PI * 2);
    ctx.clip();
    if (img && img.width > 0 && img.height > 0) {
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 36, 36, 184, 184);
    } else {
      ctx.fillStyle = rimStyle;
      ctx.fillRect(36, 36, 184, 184);
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(128, 128, 92, 0, Math.PI * 2);
    ctx.strokeStyle = rimStyle;
    ctx.lineWidth = 5;
    ctx.stroke();
    texture.needsUpdate = true;
  };
  paint();
  return { texture, paint };
}

/** Honest budget line for the focus card: declaration phase says so instead
 *  of fabricating a number. */
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

function makeGlowBeam(from: THREE.Vector3, to: THREE.Vector3, hex: number): THREE.Mesh {
  const direction = to.clone().sub(from);
  const length = Math.max(0.01, direction.length());
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, length, 10, 1, true),
    new THREE.MeshBasicMaterial({
      color: hex,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.position.copy(from).add(direction.clone().multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

function paintSkyCanvas(): HTMLCanvasElement {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = "#02040c";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(-0.38);
  const milky = ctx.createLinearGradient(0, -36, 0, 36);
  milky.addColorStop(0, "rgba(70,120,255,0)");
  milky.addColorStop(0.35, "rgba(90,150,255,0.16)");
  milky.addColorStop(0.5, "rgba(200,220,255,0.32)");
  milky.addColorStop(0.65, "rgba(255,90,160,0.12)");
  milky.addColorStop(1, "rgba(70,120,255,0)");
  ctx.fillStyle = milky;
  ctx.fillRect(-width, -40, width * 2, 80);
  ctx.restore();
  for (const [color, x, y, r, a] of [
    ["70, 90, 255", 220, 180, 220, 0.22],
    ["0, 180, 255", 760, 300, 260, 0.18],
    ["255, 40, 120", 520, 90, 180, 0.1],
    ["120, 40, 255", 880, 120, 160, 0.12],
  ] as const) {
    const g = ctx.createRadialGradient(x, y, 8, x, y, r);
    g.addColorStop(0, `rgba(${color},${a})`);
    g.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 2400; i += 1) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    const s = Math.random() * Math.random() * 1.6;
    const c = Math.random();
    ctx.fillStyle = c > 0.7 ? "rgba(160,190,255,0.9)" : c > 0.4 ? "rgba(255,255,255,0.85)" : "rgba(255,220,170,0.7)";
    ctx.fillRect(x, y, s, s);
  }
  return canvas;
}

function makeSkyDome(): THREE.Mesh {
  const texture = new THREE.CanvasTexture(paintSkyCanvas());
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(900, 48, 32),
    new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  return mesh;
}

function makeStarLayer(
  count: number,
  radiusMin: number,
  radiusMax: number,
  size: number,
  map: THREE.Texture,
): THREE.Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const palette = [new THREE.Color("#ffffff"), new THREE.Color("#9db4ff"), new THREE.Color("#ffd9a0"), new THREE.Color("#7cf0ff")];
  for (let i = 0; i < count; i += 1) {
    const radius = radiusMin + Math.random() * (radiusMax - radiusMin);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.cos(phi);
    positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    const tint = palette[Math.floor(Math.random() * palette.length)] ?? palette[0]!;
    const dim = 0.35 + Math.random() * 0.65;
    colors[i * 3] = tint.r * dim;
    colors[i * 3 + 1] = tint.g * dim;
    colors[i * 3 + 2] = tint.b * dim;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      map,
      size,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      alphaTest: 0.02,
    }),
  );
}

function glowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.18, "rgba(255,255,255,0.85)");
    gradient.addColorStop(0.45, "rgba(255,255,255,0.28)");
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
  return new THREE.Color(`hsl(${hueForId(id)}, 82%, 58%)`);
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
  /** The focus card hides itself on 拉远/关闭 until the selection changes. */
  const [cardDismissed, setCardDismissed] = useState(false);
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
        // The synthetic enterprise star is scenery, not an employee: it must
        // never appear as a searchable/selectable position.
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
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(host.clientWidth || 640, host.clientHeight || 420);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      const labelRenderer = new CSS2DRenderer();
      labelRenderer.setSize(host.clientWidth || 640, host.clientHeight || 420);
      labelRenderer.domElement.style.position = "absolute";
      labelRenderer.domElement.style.top = "0";
      labelRenderer.domElement.style.left = "0";
      labelRenderer.domElement.style.pointerEvents = "none";
      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#02040a");
      scene.fog = new THREE.FogExp2(0x02040a, 0.0016);
      const camera = new THREE.PerspectiveCamera(
        55,
        (host.clientWidth || 640) / (host.clientHeight || 420),
        0.1,
        4000,
      );
      camera.position.set(...DEFAULT_CAM);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = 8;
      controls.maxDistance = 320;
      const glow = glowTexture();

      const sky = new THREE.Group();
      sky.add(makeSkyDome());
      const farStars = makeStarLayer(3200, 420, 820, 1.6, glow);
      const midStars = makeStarLayer(1800, 160, 380, 2.4, glow);
      const nearStars = makeStarLayer(420, 70, 150, 4.2, glow);
      farStars.userData.spin = 0.00012;
      midStars.userData.spin = 0.00028;
      nearStars.userData.spin = 0.0005;
      sky.add(farStars, midStars, nearStars);
      for (let i = 0; i < 28; i += 1) {
        const radius = 95 + Math.random() * 70;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: glow,
            color: new THREE.Color(["#ffffff", "#9db4ff", "#ffd9a0"][i % 3]),
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        sprite.scale.setScalar(6 + Math.random() * 10);
        sprite.position.set(
          radius * Math.sin(phi) * Math.cos(theta),
          radius * Math.cos(phi),
          radius * Math.sin(phi) * Math.sin(theta),
        );
        sky.add(sprite);
      }
      for (const [color, scale, pos, opacity] of [
        ["#3a1cff", 520, [-280, 160, -520], 0.34],
        ["#0090ff", 460, [310, -170, -540], 0.28],
        ["#ff2a7a", 360, [50, 240, -420], 0.16],
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
        sky.add(sprite);
      }
      scene.add(sky);

      scene.add(new THREE.AmbientLight(0x1a2a55, 0.22));
      const sunLight = new THREE.PointLight(0xfff1c2, 2800, 0, 2);
      scene.add(sunLight);
      const rim = new THREE.DirectionalLight(0x7ecbff, 0.55);
      rim.position.set(60, 90, 40);
      scene.add(rim);

      const world = new THREE.Group();
      scene.add(world);
      const composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(host.clientWidth || 640, host.clientHeight || 420),
        reducedMotion ? 0.35 : 1.12,
        0.62,
        0.2,
      );
      composer.addPass(bloom);
      host.appendChild(renderer.domElement);
      host.appendChild(labelRenderer.domElement);

      state = {
        renderer,
        composer,
        bloom,
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
        sky,
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
        // The synthetic star is a drop target (reportTo null) but never a
        // drag source or a selection.
        if (!id || id === VIRTUAL_STAR_ID) return;
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
        if (!latest.current.reducedMotion) {
          state.sky.children.forEach((child) => {
            const spin = child.userData.spin;
            if (typeof spin === "number") child.rotation.y += spin;
          });
        }
        for (const view of state.views.values()) {
          const running = latest.current.runningIds?.has(view.body.id) === true;
          if (running && !latest.current.reducedMotion) {
            const pulse = 1 + Math.sin(elapsed * 4.2) * 0.16;
            view.halo.scale.setScalar(view.body.size * 8.4 * pulse);
            view.haloMaterial.opacity = 0.78 + Math.sin(elapsed * 4.2) * 0.18;
          }
        }
        state.controls.update();
        state.composer.render();
        state.labelRenderer.render(state.scene, state.camera);
      };
      animate();

      const observer = new ResizeObserver(() => {
        const width = host.clientWidth;
        const height = host.clientHeight;
        if (width <= 0 || height <= 0) return;
        renderer.setSize(width, height);
        state.composer.setSize(width, height);
        state.bloom.setSize(width, height);
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
        state.composer.dispose();
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
        new THREE.LineBasicMaterial({
          color: 0x66d8ff,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      ring.rotation.x = orbit.tilt;
      ring.position.set(orbit.center[0], orbit.center[1], orbit.center[2]);
      state.world.add(ring);
    }

    const byId = new Map(layout.bodies.map((body) => [body.id, body]));
    for (const body of layout.bodies) {
      if (body.parentId && byId.has(body.parentId)) {
        const parent = byId.get(body.parentId)!;
        const from = new THREE.Vector3(...parent.position);
        const to = new THREE.Vector3(...body.position);
        state.world.add(makeGlowBeam(from, to, body.kind === "planet" ? 0xd7f6ff : 0x7cf0ff));
      }
    }

    for (const body of layout.bodies) {
      const baseColor = body.kind === "star" ? new THREE.Color("#ff4d3a") : colorFor(body.id, avatarColors);
      const geometry = new THREE.SphereGeometry(body.size, body.kind === "star" ? 64 : 48, body.kind === "star" ? 64 : 48);
      const material = new THREE.MeshBasicMaterial({
        color: baseColor.clone().multiplyScalar(body.kind === "star" ? 1.8 : 1.35),
        transparent: true,
        opacity: 1,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...body.position);
      mesh.userData.positionId = body.id;
      const haloMaterial = new THREE.SpriteMaterial({
        map: glow,
        color: baseColor.clone(),
        transparent: true,
        opacity: body.kind === "star" ? 1 : 0.72,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const halo = new THREE.Sprite(haloMaterial);
      halo.scale.setScalar(body.size * (body.kind === "star" ? 16 : 7.2));
      mesh.add(halo);
      if (body.kind === "star") {
        const flare = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: glow,
            color: new THREE.Color("#ffd27a"),
            transparent: true,
            opacity: 0.7,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        flare.scale.setScalar(body.size * 22);
        mesh.add(flare);
        const core = new THREE.PointLight(0xff6a3c, 90, 80, 2);
        mesh.add(core);
      } else {
        const lamp = new THREE.PointLight(baseColor, body.kind === "planet" ? 18 : 8, body.size * 18, 2);
        mesh.add(lamp);
      }

      // Portrait medallion: the employee's own avatar fused into the body;
      // positions without an avatar stay solid colored planets.
      let medallion: THREE.Sprite | null = null;
      let baseOpacity = 1;
      const avatarSrc = body.virtual ? undefined : avatarUrls?.[body.id];
      if (avatarSrc) {
        const medallionTexture = makeMedallionTexture(baseColor);
        medallion = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: medallionTexture.texture, transparent: true, depthWrite: false }),
        );
        medallion.scale.setScalar(body.size * (body.kind === "star" ? 3.6 : 2.8));
        mesh.add(medallion);
        material.transparent = true;
        baseOpacity = 0.35;
        material.opacity = baseOpacity;
        const img = new Image();
        img.onload = () => {
          if (!state.disposed) medallionTexture.paint(img);
        };
        img.src = avatarSrc;
      }

      const label = document.createElement("div");
      label.className = `owb-star-label owb-star-label--${body.kind}`;
      label.textContent = nameOf(body);
      label.title = body.virtual ? nameOf(body) : `${nameOf(body)} · ${body.id}`;
      label.addEventListener("click", () => {
        if (body.virtual) return;
        setCardDismissed(false);
        flyTo(body.id, true);
        latest.current.onSelect?.(body.id);
      });
      const labelObject = new CSS2DObject(label);
      labelObject.position.set(0, body.size + 1.1, 0);
      mesh.add(labelObject);

      state.world.add(mesh);
      state.views.set(body.id, { body, mesh, halo, haloMaterial, material, medallion, label, baseColor, baseOpacity });
    }
    applyVisualState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, avatarColors, avatarUrls, webglFailed, nameOf]);

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
      view.material.opacity = dimmed ? 0.16 : view.baseOpacity;
      if (!isRunning) {
        view.haloMaterial.color.copy(isSelected ? view.baseColor.clone().lerp(new THREE.Color("#ffffff"), 0.35) : view.baseColor);
        view.haloMaterial.opacity = view.body.kind === "star" ? 1 : isSelected ? 0.95 : dimmed ? 0.08 : 0.72;
        view.halo.scale.setScalar(view.body.size * (view.body.kind === "star" ? 16 : isSelected ? 9.5 : 7.2));
      } else {
        view.haloMaterial.color.set(RUNNING_COLOR);
      }
    }
  }, []);

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
      state.camera.position.copy(toTarget.clone().add(new THREE.Vector3(...DEFAULT_CAM).setLength(close ? Math.max(10, body.size * 8) : 46)));
      return;
    }
    const direction = state.camera.position.clone().sub(state.controls.target);
    const distance = close ? Math.max(10, body.size * 8) : Math.max(30, Math.min(direction.length(), 60));
    state.fly = {
      fromTarget: state.controls.target.clone(),
      toTarget,
      fromCam: state.camera.position.clone(),
      toCam: toTarget.clone().add(direction.setLength(distance)),
      start: performance.now(),
    };
  }, []);

  /** 拉远: pull the camera back to the whole-system framing. */
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
    state.controls.target.set(0, 0, 0);
    state.camera.position.set(...DEFAULT_CAM);
  }, []);

  /* ------------------------------------------------------------- render */
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
      {selectedBody && !cardDismissed ? (
        <aside className="owb-star-map__card" aria-label={t("star.cardTitle")}>
          <header>
            <strong>{nameOf(selectedBody)}</strong>
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
            </>
          )}
          <footer>
            <button type="button" className="owb-star-map__btn" onClick={() => flyTo(selectedBody.id, true)}>
              {t("star.zoomIn")}
            </button>
            <button type="button" className="owb-star-map__btn" onClick={flyHome}>
              {t("star.zoomOut")}
            </button>
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

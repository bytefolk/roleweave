import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { StarMapBody, StarMapLayout } from "./star-map-layout";

export interface StarMapSceneOptions {
  layout: StarMapLayout;
  displayNames: Record<string, string>;
  avatarUrls: Record<string, string>;
  runningIds: ReadonlySet<string>;
  selectedId: string | null;
  matches: Set<string>;
  queryActive: boolean;
  onSelect: (id: string) => void;
  onMove: (sourceId: string, targetId: string) => void;
}

const DRAG_THRESHOLD = 6;
const BODY_RADIUS: Record<StarMapBody["kind"], number> = { star: 0.95, planet: 0.42, moon: 0.2 };

export function mountStarMapScene(host: HTMLElement, options: StarMapSceneOptions) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b18);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);
  camera.position.set(0, 6.5, 16);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.className = "owb-star-map__canvas";
  host.appendChild(renderer.domElement);

  const labels = new CSS2DRenderer();
  labels.domElement.className = "owb-star-map__labels";
  host.appendChild(labels.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 3;
  controls.maxDistance = 42;

  scene.add(new THREE.AmbientLight(0x9bb4ff, 0.55));
  const sunLight = new THREE.PointLight(0xffe7b0, 2.4, 40, 1.6);
  scene.add(sunLight);

  const starfield = makeStarfield();
  scene.add(starfield);

  const bodyGroup = new THREE.Group();
  scene.add(bodyGroup);
  const ringGroup = new THREE.Group();
  scene.add(ringGroup);
  const meshes = new Map<string, THREE.Mesh>();
  const labelNodes = new Map<string, HTMLDivElement>();
  const textures = new Map<string, THREE.Texture>();
  let pointer: { x: number; y: number; id: string | null } | null = null;
  let draggingId: string | null = null;
  let frame = 0;
  const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();

  function resize(): void {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    labels.setSize(width, height);
  }

  function rebuild(next: StarMapSceneOptions): void {
    bodyGroup.clear();
    ringGroup.clear();
    meshes.clear();
    labelNodes.clear();
    for (const ring of next.layout.rings) {
      const geometry = new THREE.RingGeometry(ring.radius * 0.98, ring.radius * 1.02, 96);
      const material = new THREE.MeshBasicMaterial({
        color: 0x8aa2d6,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(ring.x, ring.y, ring.z);
      mesh.rotation.x = Math.PI / 2.35;
      ringGroup.add(mesh);
    }
    for (const body of next.layout.bodies) {
      const radius = BODY_RADIUS[body.kind];
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 32, 24),
        new THREE.MeshStandardMaterial({
          color: body.kind === "star" ? 0xffe08a : 0x8eb4ff,
          emissive: body.kind === "star" ? 0xffc14d : 0x1b2a4a,
          emissiveIntensity: body.kind === "star" ? 0.85 : 0.2,
          metalness: 0.15,
          roughness: 0.45,
        }),
      );
      mesh.position.set(body.x, body.y, body.z);
      mesh.userData.id = body.id;
      const url = next.avatarUrls[body.id];
      if (url) applyPhoto(mesh, url);
      bodyGroup.add(mesh);
      meshes.set(body.id, mesh);
      const label = document.createElement("div");
      label.className = `owb-star-map__label is-${body.kind}`;
      label.textContent = next.displayNames[body.id] ?? body.id;
      const css2d = new CSS2DObject(label);
      css2d.position.set(0, -radius - 0.08, 0);
      mesh.add(css2d);
      labelNodes.set(body.id, label);
      if (body.parentId) {
        const parent = next.layout.bodies.find((item) => item.id === body.parentId);
        if (parent) {
          const points = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(parent.x, parent.y, parent.z),
            new THREE.Vector3(body.x, body.y, body.z),
          ]);
          ringGroup.add(new THREE.Line(points, new THREE.LineBasicMaterial({ color: 0x6f86b8, transparent: true, opacity: 0.28 })));
        }
      }
    }
    paint(next);
  }

  function applyPhoto(mesh: THREE.Mesh, url: string): void {
    const existing = textures.get(url);
    const apply = (texture: THREE.Texture) => {
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.map = texture;
      material.color.set(0xffffff);
      material.needsUpdate = true;
    };
    if (existing) {
      apply(existing);
      return;
    }
    new THREE.TextureLoader().load(url, (texture: { colorSpace: unknown }) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      textures.set(url, texture);
      apply(texture);
    });
  }

  function paint(next: StarMapSceneOptions): void {
    for (const [id, mesh] of meshes) {
      const selected = next.selectedId === id;
      mesh.scale.setScalar(selected ? 1.28 : 1);
      const label = labelNodes.get(id);
      if (label) {
        label.classList.toggle("is-dim", next.queryActive && !next.matches.has(id));
      }
      const material = mesh.material as THREE.MeshStandardMaterial;
      const running = next.runningIds.has(id);
      material.emissiveIntensity = running ? 1.1 : (findKind(next.layout.bodies, id) === "star" ? 0.85 : 0.2);
    }
  }

  function pick(clientX: number, clientY: number): string | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);
    const hits = raycaster.intersectObjects([...meshes.values()], false);
    const id = hits[0]?.object.userData.id;
    return typeof id === "string" ? id : null;
  }

  function flyTo(id: string): void {
    const mesh = meshes.get(id);
    if (!mesh) return;
    const offset = mesh.position.clone().normalize().multiplyScalar(3.4);
    if (offset.lengthSq() < 0.01) offset.set(0, 1.2, 4.2);
    camera.position.copy(mesh.position).add(offset);
    controls.target.copy(mesh.position);
    controls.update();
  }

  function reset(): void {
    camera.position.set(0, 6.5, 16);
    controls.target.set(0, 0, 0);
    controls.update();
  }

  function zoom(direction: 1 | -1): void {
    const factor = direction > 0 ? 0.82 : 1.22;
    camera.position.multiplyScalar(factor);
    controls.update();
  }

  const onPointerDown = (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY, id: pick(event.clientX, event.clientY) };
    draggingId = null;
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!pointer) return;
    if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= DRAG_THRESHOLD) {
      draggingId = pointer.id;
    }
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!pointer) return;
    const target = pick(event.clientX, event.clientY);
    const moved = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
    if (draggingId && target && moved >= DRAG_THRESHOLD) options.onMove(draggingId, target);
    else if (pointer.id && moved < DRAG_THRESHOLD) options.onSelect(pointer.id);
    pointer = null;
    draggingId = null;
  };

  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerup", onPointerUp);

  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  observer?.observe(host);
  resize();
  rebuild(options);

  const tick = () => {
    frame = requestAnimationFrame(tick);
    if (!reduceMotion) starfield.rotation.y += 0.00035;
    controls.update();
    renderer.render(scene, camera);
    labels.render(scene, camera);
  };
  tick();

  return {
    flyTo,
    reset,
    zoom,
    dispose() {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labels.domElement.remove();
    },
  };
}

function findKind(bodies: StarMapBody[], id: string): StarMapBody["kind"] | undefined {
  return bodies.find((body) => body.id === id)?.kind;
}

function makeStarfield(): THREE.Points {
  const count = 1800;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const radius = 28 + Math.random() * 40;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ color: 0xd9e6ff, size: 0.06, sizeAttenuation: true, transparent: true, opacity: 0.9 }),
  );
}

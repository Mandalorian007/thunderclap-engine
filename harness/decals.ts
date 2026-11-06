/**
 * Decals demo page (STATUS "Decals", ws/decals): a floor and two blocks under a perspective
 * camera, stamped with `Decals` from `@thunderclap/engine/fx`. Noun-free, and nothing here is
 * engine code.
 *
 * - The atlas is a 2×2 canvas drawn at boot (`renderer.textureFromSource`): ring, splat, cross,
 *   square.
 * - A click (or `api.placeAt`) casts the pointer ray against the floor plane and the two blocks
 *   here on the page and adds a decal at the hit, facing along the hit normal.
 * - `?mode=box|quad` forces the implementation; the default `auto` is `box` under this depth
 *   camera. `?capacity=n` sets the ring size (default 16).
 * - State on `window.__harnessDecals` (harness/decals-state.ts): the live count, the mode and
 *   the two probe points e2e/decals.spec.ts samples.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { type DecalMode, Decals } from '@thunderclap/engine/fx';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  Renderer,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap/engine/render';
import type { DecalProbe, HarnessDecalsApi, HarnessDecalsState } from './decals-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const query = new URLSearchParams(location.search);
const REQUESTED = query.get('mode') ?? 'auto';
const MODE: DecalMode = REQUESTED === 'box' || REQUESTED === 'quad' ? REQUESTED : 'auto';
const CAPACITY = Math.max(1, Number(query.get('capacity') ?? 16) || 16);

const state: HarnessDecalsState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  requested: REQUESTED,
  mode: null,
  capacity: CAPACITY,
  count: 0,
  decalPixel: { x: 0, y: 0 },
  floorPixel: { x: 0, y: 0 },
  ages: [],
  gpuErrors: 0,
};

// ------------------------------------------------------------------ geometry (12 floats/vertex)

/** A unit cube centred on the origin: 24 vertices (a normal per face), 36 indices, white. */
function cubeGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const faces: [number[], number[], number[]][] = [
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
  ];
  const vertices = new Float32Array(24 * 12);
  const indices = new Uint16Array(36);
  let v = 0;
  let i = 0;
  for (const [n, r, u] of faces) {
    const base = v / 12;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      for (let k = 0; k < 3; k++) vertices[v + k] = (n[k]! + sx * r[k]! + sy * u[k]!) * 0.5;
      vertices[v + 3] = n[0]!;
      vertices[v + 4] = n[1]!;
      vertices[v + 5] = n[2]!;
      vertices[v + 6] = (sx + 1) / 2;
      vertices[v + 7] = (1 - sy) / 2;
      vertices[v + 8] = vertices[v + 9] = vertices[v + 10] = vertices[v + 11] = 1;
      v += 12;
    }
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], i);
    i += 6;
  }
  return { vertices, indices };
}

/** A unit quad in the XZ plane (y = 0) facing +y, white. */
function groundGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const vertices = new Float32Array([
    ...[-0.5, 0, 0.5, 0, 1, 0, 0, 1, 1, 1, 1, 1],
    ...[0.5, 0, 0.5, 0, 1, 0, 1, 1, 1, 1, 1, 1],
    ...[0.5, 0, -0.5, 0, 1, 0, 1, 0, 1, 1, 1, 1],
    ...[-0.5, 0, -0.5, 0, 1, 0, 0, 0, 1, 1, 1, 1],
  ]);
  return { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}

// ------------------------------------------------------------------ the atlas

/** A 2×2 atlas of white shapes on transparent: ring, splat, cross, square. */
function atlasCanvas(): HTMLCanvasElement {
  const size = 256;
  const half = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no 2d context');
  g.clearRect(0, 0, size, size);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  // Ring (top-left).
  g.lineWidth = 14;
  g.beginPath();
  g.arc(half / 2, half / 2, half / 2 - 16, 0, Math.PI * 2);
  g.stroke();
  // Splat (top-right): a blob of overlapping discs.
  const cx = half + half / 2;
  const cy = half / 2;
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    const r = k % 2 ? 26 : 38;
    g.beginPath();
    g.arc(cx + Math.cos(a) * 22, cy + Math.sin(a) * 22, r, 0, Math.PI * 2);
    g.fill();
  }
  // Cross (bottom-left).
  g.fillRect(half / 2 - 12, half + 14, 24, half - 28);
  g.fillRect(14, half + half / 2 - 12, half - 28, 24);
  // Square (bottom-right).
  g.fillRect(half + 14, half + 14, half - 28, half - 28);
  return canvas;
}

// ------------------------------------------------------------------ the material

/** Albedo × the lighting block. */
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(in.color.rgb * (engine_lambert(n, in.worldPos) + 0.12 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

// ------------------------------------------------------------------ the scene

const EYE = [0, 6, 11] as const;
const TARGET = [0, 0.5, 0] as const;
/** A bare floor point no decal from the spec covers. */
const FLOOR_SPOT = [-3.5, 0, 3] as const;

interface Block {
  min: [number, number, number];
  max: [number, number, number];
  transform: Transform;
  params: InstanceParams;
}

function block(x: number, size: number, tint: [number, number, number, number]): Block {
  const h = size / 2;
  return {
    min: [x - h, 0, -1 - h],
    max: [x + h, size, -1 + h],
    transform: new Transform({ x, y: h, z: -1, scaleX: size, scaleY: size, scaleZ: size }),
    params: { tint },
  };
}

const BLOCKS: Block[] = [
  block(-2.5, 1.5, [0.9, 0.25, 0.2, 1]),
  block(2.5, 1.5, [0.2, 0.4, 0.9, 1]),
];

interface Hit {
  point: [number, number, number];
  normal: [number, number, number];
  t: number;
}

/** Nearest hit of the ray `o + t d` (t > 0) against the floor plane and the blocks. */
function castRay(o: CameraPoint, d: [number, number, number]): Hit | null {
  let best: Hit | null = null;
  if (Math.abs(d[1]) > 1e-6) {
    const t = -o.y / d[1];
    if (t > 0) best = { point: [o.x + d[0] * t, 0, o.z + d[2] * t], normal: [0, 1, 0], t };
  }
  for (const b of BLOCKS) {
    let tmin = 0;
    let tmax = Number.POSITIVE_INFINITY;
    let axis = -1;
    let sign = 0;
    const oa = [o.x, o.y, o.z];
    for (let k = 0; k < 3; k++) {
      const inv = 1 / d[k]!;
      let t0 = (b.min[k]! - oa[k]!) * inv;
      let t1 = (b.max[k]! - oa[k]!) * inv;
      let s = -1;
      if (t0 > t1) {
        [t0, t1] = [t1, t0];
        s = 1;
      }
      if (t0 > tmin) {
        tmin = t0;
        axis = k;
        sign = s;
      }
      tmax = Math.min(tmax, t1);
      if (tmin > tmax) break;
    }
    if (tmin <= tmax && axis >= 0 && tmin > 0 && (!best || tmin < best.t)) {
      const normal: [number, number, number] = [0, 0, 0];
      normal[axis] = sign;
      best = {
        point: [o.x + d[0] * tmin, o.y + d[1] * tmin, o.z + d[2] * tmin],
        normal,
        t: tmin,
      };
    }
  }
  return best;
}

const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };
const rayNear: CameraPoint = { x: 0, y: 0, z: 0 };
const rayFar: CameraPoint = { x: 0, y: 0, z: 0 };

function probe(camera: Camera, x: number, y: number, z: number, out: DecalProbe): void {
  camera.worldToScreen(x, y, z, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine decals demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  camera.lookAt(EYE, TARGET);
  renderer.camera = camera;

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const ground = renderer.createMesh({
    ...groundGeometry(),
    layout: VERTEX_LAYOUT_3D,
    label: 'ground',
  });
  const groundT = new Transform({ scaleX: 80, scaleY: 1, scaleZ: 80 });
  const groundP: InstanceParams = { tint: [0.42, 0.45, 0.4, 1] };

  const atlas = renderer.textureFromSource(atlasCanvas(), 'decal-atlas');
  const decals = new Decals(renderer, {
    capacity: CAPACITY,
    texture: atlas,
    atlas: { columns: 2, rows: 2 },
    mode: MODE,
  });

  const lights = new Lights();
  lights.ambient.set([0.25, 0.26, 0.3]);
  lights.sun.dir = [-0.4, -1.0, -0.5];
  lights.sun.color = [0.85, 0.85, 0.8];

  /** Handles added through the api, oldest first, with where each decal sits. */
  const placed: { handle: number; at: [number, number, number] }[] = [];

  const api: HarnessDecalsApi = {
    state,
    add(x, y, z, nx, ny, nz, size, tile = 0, color, lifetime) {
      const handle = decals.add({ x, y, z, nx, ny, nz, size, tile, color, lifetime });
      placed.push({ handle, at: [x, y, z] });
      return handle;
    },
    placeAt(sx, sy) {
      camera.screenToWorld(sx, sy, 0, rayNear);
      camera.screenToWorld(sx, sy, 1, rayFar);
      const d: [number, number, number] = [
        rayFar.x - rayNear.x,
        rayFar.y - rayNear.y,
        rayFar.z - rayNear.z,
      ];
      const hit = castRay(rayNear, d);
      if (!hit) return -1;
      const [x, y, z] = hit.point;
      const [nx, ny, nz] = hit.normal;
      const tile = placed.length % 4;
      const hue = placed.length % 3;
      const color: [number, number, number, number] = [
        hue === 0 ? 0.95 : 0.2,
        hue === 1 ? 0.95 : 0.2,
        hue === 2 ? 0.95 : 0.2,
        1,
      ];
      return api.add(x, y, z, nx, ny, nz, 1.6, tile, color, undefined);
    },
    remove: (handle) => decals.remove(handle),
    has: (handle) => decals.has(handle),
    clear() {
      decals.clear();
      placed.length = 0;
    },
  };
  window.__harnessDecals = api;

  surface.canvas.addEventListener('pointerdown', (e) => {
    const p = surface.clientToLogical(e.clientX, e.clientY);
    api.placeAt(p.x, p.y);
  });

  const loop = new GameLoop({
    update(dt) {
      decals.update(dt);
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      frame.mesh(ground, lit, groundT, groundP);
      for (const b of BLOCKS) frame.mesh(cube, lit, b.transform, b.params);
      frame.drawable(decals, 1);
      renderer.endFrame();
      state.frames++;
      state.mode = decals.activeMode;
      state.count = decals.count;
      state.gpuErrors = gpuDiagnostics.errorCount;
      // Forget the decals that expired or were overwritten; probe the oldest one left.
      for (let i = placed.length - 1; i >= 0; i--) {
        if (!decals.has(placed[i]!.handle)) placed.splice(i, 1);
      }
      state.ages = placed.map((p) => decals.ageOf(p.handle));
      const first = placed[0];
      if (first) probe(camera, first.at[0], first.at[1], first.at[2], state.decalPixel);
      probe(camera, FLOOR_SPOT[0], FLOOR_SPOT[1], FLOOR_SPOT[2], state.floorPixel);
    },
  });
  res.onDeviceLost(() => loop.stop());
  loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});

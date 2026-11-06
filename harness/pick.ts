/**
 * Pick page (ws/pick): six spinning meshes, each registered with the pointer router through a
 * `meshTester` over the same `Float32Array` it uploaded. A click or tap on a mesh tints it; one
 * on the sky clears the tint. Noun-free; the geometry and the camera are what a game would write.
 *
 * - The testers read each `Transform` every call, so the spinning meshes are picked as drawn.
 * - Mesh `f` culls back faces; mesh `b` and `d` are icospheres without an index buffer.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { createPointerRouter, Input, meshTester } from '@thunderclap/engine/input';
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
import type { HarnessPickApi, HarnessPickState } from './pick-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const state: HarnessPickState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  hit: null,
  hitPoint: null,
  hitNormal: null,
  hitDistance: 0,
  selects: 0,
  hover: null,
  screenPositions: {},
  instances: 0,
  culled: 0,
  gpuErrors: 0,
};

interface Geometry {
  vertices: Float32Array;
  indices: Uint16Array | null;
}

/** A unit cube centred on the origin: 24 vertices (a normal per face), 36 indices, white. */
function cubeGeometry(): Geometry {
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

/**
 * An icosphere of radius 0.5 subdivided `level` times, as a plain triangle list (no index
 * buffer; flat normals), counter-clockwise seen from outside. 20 · 4^level triangles.
 */
function icosphereGeometry(level: number): Geometry {
  const t = (1 + Math.sqrt(5)) / 2;
  const base: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((p) => {
    const l = Math.hypot(p[0]!, p[1]!, p[2]!);
    return [p[0]! / l, p[1]! / l, p[2]! / l];
  });
  let tris: number[][][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ].map((f) => f.map((i) => base[i]!));
  const mid = (a: number[], b: number[]): number[] => {
    const m = [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
    const l = Math.hypot(m[0]!, m[1]!, m[2]!);
    return [m[0]! / l, m[1]! / l, m[2]! / l];
  };
  for (let s = 0; s < level; s++) {
    const next: number[][][] = [];
    for (const [a, b, c] of tris as [number[], number[], number[]][]) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    tris = next;
  }
  const vertices = new Float32Array(tris.length * 3 * 12);
  let v = 0;
  for (const tri of tris) {
    const [a, b, c] = tri as [number[], number[], number[]];
    // Flat normal: the face's own.
    const ux = b[0]! - a[0]!;
    const uy = b[1]! - a[1]!;
    const uz = b[2]! - a[2]!;
    const wx = c[0]! - a[0]!;
    const wy = c[1]! - a[1]!;
    const wz = c[2]! - a[2]!;
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    nx /= l;
    ny /= l;
    nz /= l;
    for (const p of tri) {
      vertices[v] = p[0]! * 0.5;
      vertices[v + 1] = p[1]! * 0.5;
      vertices[v + 2] = p[2]! * 0.5;
      vertices[v + 3] = nx;
      vertices[v + 4] = ny;
      vertices[v + 5] = nz;
      vertices[v + 6] = 0;
      vertices[v + 7] = 0;
      vertices[v + 8] = vertices[v + 9] = vertices[v + 10] = vertices[v + 11] = 1;
      v += 12;
    }
  }
  return { vertices, indices: null };
}

const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  // params.x > 0: the picked one glows.
  let glow = in.params.x * vec3f(0.6, 0.5, 0.2);
  o.color = vec4f(in.color.rgb * (engine_lambert(n, in.worldPos) + 0.12 * sky) + glow, 1.0);
  o.emissive = vec4f(glow, 0.0);
  return o;
}`;

/** One pickable thing: its id, geometry, placement, spin axis and colour. */
interface Thing {
  id: string;
  geometry: 'cube' | 'ico';
  transform: Transform;
  params: InstanceParams;
  /** `params.params`, mutable: x > 0 glows. */
  glow: [number, number, number, number];
  axis: [number, number, number];
  rate: number;
  cullBack: boolean;
}

/** Instance params over a tint, with a mutable `params` tuple whose x is the glow. */
function glowing(tint: [number, number, number, number]): Pick<Thing, 'params' | 'glow'> {
  const glow: [number, number, number, number] = [0, 0, 0, 0];
  return { params: { tint, params: glow }, glow };
}

const THINGS: Thing[] = [
  {
    id: 'a',
    geometry: 'cube',
    transform: new Transform({ x: -4, y: 2.6, z: -2, scaleX: 1.6, scaleY: 1.6, scaleZ: 1.6 }),
    ...glowing([1.0, 0.25, 0.2, 1]),
    axis: [0, 1, 0],
    rate: 0.7,
    cullBack: false,
  },
  {
    id: 'b',
    geometry: 'ico',
    transform: new Transform({ x: 0, y: 2.6, z: -2, scaleX: 2, scaleY: 2, scaleZ: 2 }),
    ...glowing([0.2, 0.75, 0.3, 1]),
    axis: [1, 1, 0],
    rate: 0.5,
    cullBack: false,
  },
  {
    id: 'c',
    geometry: 'cube',
    transform: new Transform({ x: 4, y: 2.6, z: -2, scaleX: 2.2, scaleY: 1.1, scaleZ: 1.4 }),
    ...glowing([0.25, 0.45, 1.0, 1]),
    axis: [0, 0, 1],
    rate: 0.6,
    cullBack: false,
  },
  {
    id: 'd',
    geometry: 'ico',
    transform: new Transform({ x: -4, y: 0.4, z: 2, scaleX: 1.4, scaleY: 2.2, scaleZ: 1.4 }),
    ...glowing([0.95, 0.8, 0.2, 1]),
    axis: [0, 1, 0],
    rate: 0.9,
    cullBack: false,
  },
  {
    id: 'e',
    geometry: 'cube',
    transform: new Transform({ x: 0, y: 0.4, z: 2, scaleX: 1.6, scaleY: 1.6, scaleZ: 1.6 }),
    ...glowing([0.85, 0.35, 0.9, 1]),
    axis: [1, 0, 1],
    rate: 0.8,
    cullBack: false,
  },
  {
    id: 'f',
    geometry: 'cube',
    transform: new Transform({ x: 4, y: 0.4, z: 2, scaleX: 1.6, scaleY: 1.6, scaleZ: 1.6 }),
    ...glowing([0.3, 0.85, 0.9, 1]),
    axis: [0, 1, 1],
    rate: 0.65,
    cullBack: true,
  },
];

const EYE = [0, 4.5, 13] as const;
const TARGET = [0, 1.4, 0] as const;
const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine pick demo' });
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
  const geometries = { cube: cubeGeometry(), ico: icosphereGeometry(1) };
  const meshes = {
    cube: renderer.createMesh({
      vertices: geometries.cube.vertices,
      indices: geometries.cube.indices ?? undefined,
      layout: VERTEX_LAYOUT_3D,
      label: 'cube',
    }),
    ico: renderer.createMesh({
      vertices: geometries.ico.vertices,
      layout: VERTEX_LAYOUT_3D,
      label: 'ico',
    }),
  };

  const lights = new Lights();
  lights.ambient.set([0.2, 0.2, 0.22]);
  lights.sun.dir = [-0.45, -1.0, -0.65];
  lights.sun.color = [0.8, 0.8, 0.78];

  // One tester per thing over the CPU copy of the geometry it draws; the router does the rest.
  const router = createPointerRouter<string>({
    camera,
    testers: THINGS.map((t) => {
      const g = geometries[t.geometry];
      return meshTester(t.transform, g.vertices, g.indices, t.id, { cullBack: t.cullBack });
    }),
  });
  const input = new Input({ select: [{ pointer: 'select' }] }, { pointers: router });
  input.attach({ pointerTarget: surface.canvas });
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));

  let picked: Thing | null = null;
  router.on('select', (e) => {
    state.selects++;
    const hit = e.hit;
    if (picked) picked.glow[0] = 0;
    picked = hit ? (THINGS.find((t) => t.id === hit.target) ?? null) : null;
    if (picked) picked.glow[0] = 1;
    state.hit = hit?.target ?? null;
    state.hitPoint = hit ? [hit.point[0], hit.point[1], hit.point[2]] : null;
    state.hitNormal = hit?.normal ? [hit.normal[0], hit.normal[1], hit.normal[2]] : null;
    state.hitDistance = hit?.distance ?? 0;
  });

  const api: HarnessPickApi = {
    state,
    clear() {
      if (picked) picked.glow[0] = 0;
      picked = null;
      state.hit = null;
      state.hitPoint = null;
      state.hitNormal = null;
      state.hitDistance = 0;
      state.selects = 0;
    },
  };
  window.__harnessPick = api;

  let spin = 0;
  const loop = new GameLoop({
    update(dt) {
      input.update();
      state.hover = router.hit?.target ?? null;
      spin += dt;
      for (const t of THINGS)
        t.transform.setAxisAngle(t.axis[0], t.axis[1], t.axis[2], spin * t.rate);
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      for (const t of THINGS) frame.mesh(meshes[t.geometry], lit, t.transform, t.params);
      renderer.endFrame();
      state.frames++;
      state.instances = renderer.stats.instances;
      state.culled = renderer.stats.culled;
      state.gpuErrors = gpuDiagnostics.errorCount;
      for (const t of THINGS) {
        const p = t.transform.position;
        camera.worldToScreen(p.x, p.y, p.z, probePoint);
        state.screenPositions[t.id] = { x: probePoint.x, y: probePoint.y };
      }
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

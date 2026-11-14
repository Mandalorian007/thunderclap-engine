/**
 * Two-views page (ws/two-views, moved onto the render core in ws/core-views): the stereo seam
 * without WebXR. The mesh demo's scene is one static, GPU-culled draw set of the retained core,
 * seen by two eyes as one `union` cull group (D1 §3.5): one view-buffer write, one cull
 * dispatch, one recorded bundle, executed once per eye into the left and right half of one
 * surface (`CoreTarget.viewport`). Each eye is its own `Camera.perspective` offset ±`IPD / 2` on
 * the camera's right axis, with `camera.screen` the left or right half in the unit-square
 * convention and `camera.viewIndex` 0 or 1 (the core writes `view.index` the same). Nothing here
 * is engine code: the geometry and the shader are the mesh demo's (copied, not imported), the
 * eyes are what an XR host would hand a game.
 *
 * A small head-locked block 0.6 m in front of the eyes (`marker`) makes the parallax large enough
 * to sample: it lands at different places in the two halves, while the scene behind it agrees.
 */

import { boot } from '@thunderclap-engine/engine/platform';
import {
  type ArenaAlloc,
  Camera,
  type CameraPoint,
  type CoreTarget,
  type CullGroup,
  createInstanceLayout,
  createRenderCore,
  createRenderView,
  createVertexLayout,
  gpuDiagnostics,
  installGpuErrorLogging,
  setViewFromCamera,
  Transform,
} from '@thunderclap-engine/engine/render';
import type { HarnessViewsState, ViewsEye, ViewsProbe } from './views-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
/** Interpupillary distance, metres: the eyes sit ±0.032 on the right axis. */
const IPD = 0.064;
const MARKER_DISTANCE = 0.6;
const MARKER_SIZE = 0.03;

function eyeState(viewIndex: number, x: number): ViewsEye {
  const p = (): ViewsProbe => ({ x: 0, y: 0 });
  return {
    viewIndex,
    position: [0, 0, 0],
    screen: { x, y: 0, width: 0.5, height: 1 },
    probes: { near: p(), far: p(), ground: p(), marker: p() },
    drawCalls: 0,
  };
}

const state: HarnessViewsState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  ipd: IPD,
  eyes: [eyeState(0, 0), eyeState(1, 0.5)],
  stats: { drawCalls: 0, instances: 0, calls: 0, dispatches: 0, bundleBuilds: 0 },
  gpuErrors: 0,
};
window.__harnessViews = { state };

// ------------------------------------------------------------------ geometry (12 floats/vertex)

/** A unit cube centred on the origin: 24 vertices (a normal per face), 36 indices, white. */
function cubeGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  // Each face: normal, then the tangent pair that spans it (right, up).
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
  // x, y, z, nx, ny, nz, u, v, r, g, b, a
  const vertices = new Float32Array([
    ...[-0.5, 0, 0.5, 0, 1, 0, 0, 1, 1, 1, 1, 1],
    ...[0.5, 0, 0.5, 0, 1, 0, 1, 1, 1, 1, 1, 1],
    ...[0.5, 0, -0.5, 0, 1, 0, 1, 0, 1, 1, 1, 1],
    ...[-0.5, 0, -0.5, 0, 1, 0, 0, 0, 1, 1, 1, 1],
  ]);
  return { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}

// ------------------------------------------------------------------ the shader

/** The mesh demo's vertex: position, normal, uv, colour (12 floats). */
const MESH = createVertexLayout({
  stride: 48,
  attributes: [
    { name: 'position', format: 'float32x3', offset: 0 },
    { name: 'normal', format: 'float32x3', offset: 12 },
    { name: 'uv', format: 'float32x2', offset: 24 },
    { name: 'color', format: 'float32x4', offset: 32 },
  ],
});
/** Per instance: the 3×4 row-major world matrix, the tint, `params` (x > 0: checker). */
const INSTANCE = createInstanceLayout({
  stride: 80,
  attributes: [
    { name: 'row0', format: 'float32x4', offset: 0 },
    { name: 'row1', format: 'float32x4', offset: 16 },
    { name: 'row2', format: 'float32x4', offset: 32 },
    { name: 'tint', format: 'float32x4', offset: 48 },
    { name: 'params', format: 'float32x4', offset: 64 },
  ],
});
const INSTANCE_FLOATS = 20;

/** Lambert + ambient from the world normal; `params.x` > 0 draws a checker from the world position. */
const LIT_WGSL = /* wgsl */ `
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) color: vec3f,
  @location(3) checker: f32,
};
@vertex fn vs(in: VertexIn) -> Out {
  let p = vec4f(in.position, 1.0);
  let w = vec3f(dot(in.row0, p), dot(in.row1, p), dot(in.row2, p));
  let n = vec3f(dot(in.row0.xyz, in.normal), dot(in.row1.xyz, in.normal), dot(in.row2.xyz, in.normal));
  var o: Out;
  o.clip = view.viewProj * vec4f(w, 1.0);
  o.normal = n;
  o.world = w;
  o.color = in.color.rgb * in.tint.rgb;
  o.checker = in.params.x;
  return o;
}
@fragment fn fs(in: Out) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let l = normalize(vec3f(0.45, 1.0, 0.65));
  let diffuse = max(dot(n, l), 0.0);
  var albedo = in.color;
  if (in.checker > 0.0) {
    let cell = floor(in.world.x) + floor(in.world.z);
    albedo *= 0.8 + 0.2 * (cell - 2.0 * floor(cell * 0.5));
  }
  // A faint sky term from above keeps the shadowed faces readable.
  let sky = 0.5 + 0.5 * n.y;
  return vec4f(albedo * (0.18 + 0.12 * sky + 0.8 * diffuse), 1.0);
}`;

// ------------------------------------------------------------------ the eyes

const TARGET = [0, 0.9, 0] as const;
const ORBIT = { yaw: 0, pitch: 0.2, distance: 9 };
const UP = [0, 1, 0] as const;

/** The head: centre eye, forward, right and up (world), recomputed per frame without allocating. */
const head = {
  eye: new Float32Array(3),
  fwd: new Float32Array(3),
  right: new Float32Array(3),
  up: new Float32Array(3),
};
const eyePos = new Float32Array(3);
const eyeTarget = new Float32Array(3);
const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

function normalize(v: Float32Array): void {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  v[0]! /= l;
  v[1]! /= l;
  v[2]! /= l;
}

function cross(out: Float32Array, a: ArrayLike<number>, b: ArrayLike<number>): void {
  out[0] = a[1]! * b[2]! - a[2]! * b[1]!;
  out[1] = a[2]! * b[0]! - a[0]! * b[2]!;
  out[2] = a[0]! * b[1]! - a[1]! * b[0]!;
}

/** Place the head on its orbit and derive its axes: `right` is what the eyes are offset along. */
function placeHead(): void {
  const o = ORBIT;
  const cp = Math.cos(o.pitch);
  const h = head;
  h.eye[0] = TARGET[0] + o.distance * Math.sin(o.yaw) * cp;
  h.eye[1] = TARGET[1] + o.distance * Math.sin(o.pitch);
  h.eye[2] = TARGET[2] + o.distance * Math.cos(o.yaw) * cp;
  for (let k = 0; k < 3; k++) h.fwd[k] = TARGET[k]! - h.eye[k]!;
  normalize(h.fwd);
  cross(h.right, h.fwd, UP);
  normalize(h.right);
  cross(h.up, h.right, h.fwd);
}

/** Place one eye `offset` metres along the head's right axis, looking parallel to the head. */
function placeEye(camera: Camera, offset: number, out: ViewsEye): void {
  const h = head;
  for (let k = 0; k < 3; k++) {
    eyePos[k] = h.eye[k]! + h.right[k]! * offset;
    eyeTarget[k] = eyePos[k]! + h.fwd[k]!;
  }
  camera.lookAt(eyePos, eyeTarget, h.up);
  out.position[0] = eyePos[0]!;
  out.position[1] = eyePos[1]!;
  out.position[2] = eyePos[2]!;
}

function probe(camera: Camera, x: number, y: number, z: number, out: ViewsProbe): void {
  camera.worldToScreen(x, y, z, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

/** One mesh of the scene: its transform, tint and params, its instance and its slot. */
interface Item {
  t: Transform;
  tint: readonly number[];
  checker: number;
  /** Bounding-sphere radius of the unit mesh under the transform's largest scale. */
  radius: number;
  inst: ArenaAlloc;
  slot: number;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine two-views demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { gpu } = res;
  installGpuErrorLogging(gpu.device);
  const core = createRenderCore(gpu);

  // One eye per half: the aspect is the half's, `screen` is the half as a fraction of the
  // surface, `viewIndex` tells the views apart.
  const fovY = (50 * Math.PI) / 180;
  const aspect = LOGICAL.width / 2 / LOGICAL.height;
  const eyes = [0, 1].map((i) => {
    const c = Camera.perspective(fovY, aspect, 0.1, 100);
    Object.assign(c.screen, state.eyes[i as 0 | 1].screen);
    c.viewIndex = i;
    return c;
  }) as [Camera, Camera];
  const views = [createRenderView(), createRenderView()] as const;
  // Both eyes are one cull group: one union-frustum cull, one args set, one bundle.
  const groups: CullGroup[] = [{ views, planes: 'union' }];

  const vertices = core.createArena({ kind: 'vertex', blockBytes: 64 << 10, label: 'meshes' });
  const instances = core.createArena({ kind: 'instance', blockBytes: 4 << 10, label: 'places' });
  const set = core.createDrawSet({
    label: 'scene',
    shader: { code: LIT_WGSL },
    vertexLayout: MESH,
    instanceLayout: INSTANCE,
    vertices,
    instances,
    capacity: 8,
    kind: 'static',
    cull: 'gpu',
  });
  // Both meshes are quads (four vertices, triangles 0 1 2, 0 2 3), so they draw through the
  // core's shared quad index.
  const cubeGeo = cubeGeometry();
  const groundGeo = groundGeometry();
  const cube = vertices.alloc(cubeGeo.vertices.byteLength, 16);
  vertices.write(cube, cubeGeo.vertices);
  const ground = vertices.alloc(groundGeo.vertices.byteLength, 16);
  vertices.write(ground, groundGeo.vertices);

  // The mesh demo's instances: the near block sits at z 1..2 and the far block (drawn after it)
  // fills x -1..1, y 0..3, z -1..0 right behind it. The marker is head-locked, placed per frame.
  const item = (t: Transform, tint: readonly number[], checker: number, flat: boolean): Item => {
    const s = Math.max(t.scale.x, t.scale.y, t.scale.z);
    const inst = instances.alloc(INSTANCE_FLOATS * 4, 16);
    const it: Item = { t, tint, checker, radius: flat ? s * 0.75 : s * 0.87, inst, slot: -1 };
    it.slot = set.add({
      vertices: flat ? ground : cube,
      indexCount: flat ? 6 : 36,
      instances: inst,
      bounds: [t.position.x, t.position.y, t.position.z, it.radius],
    });
    return it;
  };
  const items = [
    item(new Transform({ scaleX: 16, scaleY: 1, scaleZ: 16 }), [0.42, 0.46, 0.36, 1], 1, true),
    item(new Transform({ x: 0, y: 0.5, z: 1.5 }), [1.0, 0.1, 0.06, 1], 0, false),
    item(
      new Transform({ x: 0, y: 1.5, z: -0.5, scaleX: 2, scaleY: 3, scaleZ: 1 }),
      [0.08, 0.28, 1.0, 1],
      0,
      false,
    ),
    item(
      new Transform({ x: -3.2, y: 0.6, z: 0, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 }),
      [0.3, 0.85, 0.35, 1],
      0,
      false,
    ),
    item(
      new Transform({ x: 3.2, y: 0.6, z: 0, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 }),
      [0.95, 0.8, 0.2, 1],
      0,
      false,
    ),
    item(
      new Transform({ scaleX: MARKER_SIZE, scaleY: MARKER_SIZE, scaleZ: MARKER_SIZE }),
      [1.0, 0.12, 1.0, 1],
      0,
      false,
    ),
  ];
  const [, , , left, right, marker] = items as [Item, Item, Item, Item, Item, Item];
  const data = new Float32Array(INSTANCE_FLOATS);
  const writeItem = (it: Item): void => {
    data.set(it.t.world, 0);
    data.set(it.tint, 12);
    data[16] = it.checker;
    instances.write(it.inst, data);
    const p = it.t.position;
    set.setBounds(it.slot, p.x, p.y, p.z, it.radius);
  };
  for (const it of items) writeItem(it);

  const target = (clear: boolean): CoreTarget => ({
    view: undefined as unknown as GPUTextureView,
    format: gpu.format,
    width: 1,
    height: 1,
    // Only the first eye clears; the second loads the colour and draws into its half.
    clear: clear ? { r: 0.05, g: 0.07, b: 0.12, a: 1 } : undefined,
    viewport: { x: 0, y: 0, width: 1, height: 1 },
  });
  const targets = [target(true), target(false)] as const;
  let spin = 0;
  let last = performance.now();
  state.gpu = 'ok';
  state.ready = true;

  const frame = (): void => {
    const now = performance.now();
    spin += Math.min(0.1, (now - last) / 1000);
    last = now;
    placeHead();
    const h = head;
    marker.t.setPosition(
      h.eye[0]! + h.fwd[0]! * MARKER_DISTANCE,
      h.eye[1]! + h.fwd[1]! * MARKER_DISTANCE,
      h.eye[2]! + h.fwd[2]! * MARKER_DISTANCE,
    );
    left.t.setAxisAngle(0, 1, 0, spin * 0.6);
    right.t.setAxisAngle(1, 1, 0, spin * 0.4);
    writeItem(marker);
    writeItem(left);
    writeItem(right);

    const texture = gpu.context.getCurrentTexture();
    const colour = texture.createView();
    const w = texture.width;
    const half = Math.floor(w / 2);
    for (let i = 0; i < 2; i++) {
      const camera = eyes[i]!;
      const eye = state.eyes[i as 0 | 1];
      placeEye(camera, (i === 0 ? -1 : 1) * (IPD / 2), eye);
      setViewFromCamera(views[i]!, camera);
      const t = targets[i]!;
      t.view = colour;
      t.width = w;
      t.height = texture.height;
      const vp = t.viewport!;
      vp.x = i === 0 ? 0 : half;
      vp.y = 0;
      vp.width = i === 0 ? half : w - half;
      vp.height = texture.height;
      probe(camera, 0, 0.75, 2, eye.probes.near);
      probe(camera, 0, 2.5, 0, eye.probes.far);
      probe(camera, 1.2, 0, 3.6, eye.probes.ground);
      const m = marker.t.position;
      probe(camera, m.x, m.y, m.z, eye.probes.marker);
    }
    const encoder = gpu.device.createCommandEncoder();
    core.prepare(encoder, groups);
    for (let i = 0; i < 2; i++) {
      const before = core.stats.bundles + core.stats.directDraws;
      core.draw(encoder, i, targets[i]!);
      state.eyes[i as 0 | 1].drawCalls = core.stats.bundles + core.stats.directDraws - before;
    }
    gpu.device.queue.submit([encoder.finish()]);
    const st = core.stats;
    state.frames++;
    state.stats.drawCalls = state.eyes[0].drawCalls + state.eyes[1].drawCalls;
    state.stats.instances = items.length * 2;
    state.stats.calls = st.calls;
    state.stats.dispatches = st.dispatches;
    state.stats.bundleBuilds = st.bundleBuilds;
    state.gpuErrors = gpuDiagnostics.errorCount;
    requestAnimationFrame(frame);
  };
  res.onDeviceLost(() => {
    state.gpu = 'lost';
  });
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});

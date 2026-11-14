/**
 * Core-decals page (ws/core-decals, B6): `Decals` on the retained render core, drawn in both
 * eyes of a stereo pair. A lit scene (a checkered ground, a tall pillar and a low slab, one
 * static GPU-culled draw set) takes three placed decals from one atlas: a ring on the ground, a
 * splat folded over the pillar's corner (the box projects through the core's depth, so it wraps
 * both faces) and a cross on the slab. `api.set({ scatter })` adds small squares over the ground
 * (the bundle holds: the count lives in an indirect draw), `api.set({ shown })` takes the
 * drawable off the core, and `api.lose()` destroys the device and restores the core on a new
 * one (the decals rebuild and re-upload themselves). Both eyes are one `union` cull group, so
 * the decals are one bundle executed by both halves. Nothing here is a game.
 */

import { Decals } from '@thunderclap-engine/engine/fx';
import { boot } from '@thunderclap-engine/engine/platform';
import {
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
  type TextureLike,
  Transform,
} from '@thunderclap-engine/engine/render';
import type {
  DecalsCoreEye,
  DecalsCoreProbe,
  DecalsCoreSet,
  HarnessDecalsCoreState,
} from './decals-core-state';

const root = document.getElementById('root') as HTMLElement;
const IPD = 0.064;

function eyeState(viewIndex: number, x: number): DecalsCoreEye {
  const p = (): DecalsCoreProbe => ({ x: 0, y: 0 });
  return {
    viewIndex,
    screen: { x, y: 0, width: 0.5, height: 1 },
    bundles: 0,
    passes: 0,
    probes: { floor: p(), corner: p() },
  };
}

const state: HarnessDecalsCoreState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  gpuErrors: 0,
  shown: true,
  live: 0,
  scatter: 0,
  eyes: [eyeState(0, 0), eyeState(1, 0.5)],
  bundleBuilds: 0,
  drawables: 0,
  restores: 0,
};
let apply: (o: DecalsCoreSet) => void = () => {};
const lose: () => Promise<void> = async () => {
  throw new Error('not ready');
};
window.__harnessDecalsCore = { state, set: (o) => apply(o), lose: () => lose() };

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
  g.lineWidth = 16;
  g.beginPath();
  g.arc(half / 2, half / 2, half / 2 - 18, 0, Math.PI * 2);
  g.stroke();
  const cx = half + half / 2;
  const cy = half / 2;
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    g.beginPath();
    g.arc(cx + Math.cos(a) * 24, cy + Math.sin(a) * 24, k % 2 ? 24 : 34, 0, Math.PI * 2);
    g.fill();
  }
  g.fillRect(half / 2 - 14, half + 12, 28, half - 24);
  g.fillRect(12, half + half / 2 - 14, half - 24, 28);
  g.fillRect(half + 12, half + 12, half - 24, half - 24);
  return canvas;
}

function atlasTexture(device: GPUDevice, canvas: HTMLCanvasElement): TextureLike {
  const texture = device.createTexture({
    label: 'decal-atlas',
    size: [canvas.width, canvas.height],
    format: 'rgba8unorm-srgb',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: canvas }, { texture }, [
    canvas.width,
    canvas.height,
  ]);
  return { view: texture.createView(), width: canvas.width, height: canvas.height };
}

// ------------------------------------------------------------------ the shader

const MESH = createVertexLayout({
  stride: 48,
  attributes: [
    { name: 'position', format: 'float32x3', offset: 0 },
    { name: 'normal', format: 'float32x3', offset: 12 },
    { name: 'uv', format: 'float32x2', offset: 24 },
    { name: 'color', format: 'float32x4', offset: 32 },
  ],
});
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

/** Lambert + ambient; `params.x` > 0 draws a fine checker from the world position. */
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
  let l = normalize(vec3f(-0.5, 1.0, 0.7));
  let diffuse = max(dot(n, l), 0.0);
  var albedo = in.color;
  if (in.checker > 0.0) {
    let cell = floor(in.world.x * 2.0) + floor(in.world.z * 2.0);
    albedo *= 0.85 + 0.15 * (cell - 2.0 * floor(cell * 0.5));
  }
  return vec4f(albedo * (0.3 + 0.1 * n.y + 0.7 * diffuse), 1.0);
}`;

const TARGET = [0.3, 0.7, 0.6] as const;
const ORBIT = { yaw: 0.6, pitch: 0.42, distance: 7.5 };
const UP = [0, 1, 0] as const;

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

function placeEye(camera: Camera, offset: number): void {
  const h = head;
  for (let k = 0; k < 3; k++) {
    eyePos[k] = h.eye[k]! + h.right[k]! * offset;
    eyeTarget[k] = eyePos[k]! + h.fwd[k]!;
  }
  camera.lookAt(eyePos, eyeTarget, h.up);
}

function probe(camera: Camera, at: readonly number[], out: DecalsCoreProbe): void {
  camera.worldToScreen(at[0]!, at[1]!, at[2]!, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

/** The pillar: 1.2 wide and deep, 2.4 tall, its +x +z corner at (1.4, ·, 1.2). */
const PILLAR = { x: 0.8, z: 0.6, w: 1.2, h: 2.4 };
const RING_AT = [-1.4, 0, 2.2] as const;
const CORNER_AT = [PILLAR.x + PILLAR.w / 2, 1.3, PILLAR.z + PILLAR.w / 2] as const;
/** The ring's stroke, a little off its centre (the ring is hollow). */
const RING_PROBE = [RING_AT[0] + 0.62, 0, RING_AT[2]] as const;
/** On the pillar's +z face, just left of the corner, inside the splat. */
const CORNER_PROBE = [CORNER_AT[0] - 0.12, CORNER_AT[1], CORNER_AT[2]] as const;

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine core decals demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { gpu } = res;
  installGpuErrorLogging(gpu.device);
  const core = createRenderCore(gpu);

  const fovY = (50 * Math.PI) / 180;
  const eyes = [0, 1].map((i) => {
    const c = Camera.perspective(fovY, 1, 0.1, 100);
    Object.assign(c.screen, state.eyes[i as 0 | 1].screen);
    c.viewIndex = i;
    return c;
  }) as [Camera, Camera];
  const views = [createRenderView(), createRenderView()] as const;
  const groups: CullGroup[] = [{ views, planes: 'union' }];

  // The scene: one static draw set (a ground, the pillar and a slab).
  const vertices = core.createArena({ kind: 'vertex', blockBytes: 64 << 10, label: 'meshes' });
  const instances = core.createArena({ kind: 'instance', blockBytes: 4 << 10, label: 'places' });
  const set = core.createDrawSet({
    label: 'scene',
    shader: { code: LIT_WGSL },
    vertexLayout: MESH,
    instanceLayout: INSTANCE,
    vertices,
    instances,
    capacity: 4,
    kind: 'static',
    cull: 'gpu',
  });
  const cubeGeo = cubeGeometry();
  const groundGeo = groundGeometry();
  const cube = vertices.alloc(cubeGeo.vertices.byteLength, 16);
  const ground = vertices.alloc(groundGeo.vertices.byteLength, 16);
  /** Each arena write, kept to replay after a device restore (the bytes are ours). */
  const writes: (() => void)[] = [];
  const write = (fn: () => void): void => {
    writes.push(fn);
    fn();
  };
  write(() => vertices.write(cube, cubeGeo.vertices));
  write(() => vertices.write(ground, groundGeo.vertices));
  const place = (t: Transform, tint: readonly number[], checker: number, flat: boolean): void => {
    const s = Math.max(t.scale.x, t.scale.y, t.scale.z);
    const inst = instances.alloc(INSTANCE_FLOATS * 4, 16);
    const bytes = new Float32Array(INSTANCE_FLOATS);
    bytes.set(t.world, 0);
    bytes.set(tint, 12);
    bytes[16] = checker;
    write(() => instances.write(inst, bytes));
    const p = t.position;
    set.add({
      vertices: flat ? ground : cube,
      indexCount: flat ? 6 : 36,
      instances: inst,
      bounds: [p.x, p.y, p.z, flat ? s * 0.75 : s * 0.87],
    });
  };
  place(new Transform({ scaleX: 20, scaleY: 1, scaleZ: 20 }), [0.42, 0.47, 0.52, 1], 1, true);
  place(
    new Transform({
      x: PILLAR.x,
      y: PILLAR.h / 2,
      z: PILLAR.z,
      scaleX: PILLAR.w,
      scaleY: PILLAR.h,
      scaleZ: PILLAR.w,
    }),
    [0.86, 0.84, 0.78, 1],
    0,
    false,
  );
  place(
    new Transform({ x: -2.4, y: 0.25, z: -0.6, scaleX: 1.8, scaleY: 0.5, scaleZ: 1.4 }),
    [0.55, 0.38, 0.62, 1],
    0,
    false,
  );

  const canvas = atlasCanvas();
  const decals = new Decals(core, {
    texture: atlasTexture(gpu.device, canvas),
    atlas: { columns: 2, rows: 2 },
    capacity: 4096,
    normalBias: 0.2,
  });
  const placed = () => {
    decals.add({
      ...xyz(RING_AT),
      nx: 0,
      ny: 1,
      nz: 0,
      size: 1.6,
      tile: 0,
      color: [0.1, 0.85, 0.75, 1],
    });
    decals.add({
      ...xyz(CORNER_AT),
      nx: 1,
      ny: 0,
      nz: 1,
      size: 1.3,
      tile: 1,
      color: [1, 0.45, 0.1, 1],
    });
    decals.add({
      x: -2.4,
      y: 0.5,
      z: -0.6,
      nx: 0,
      ny: 1,
      nz: 0,
      size: 1,
      tile: 2,
      color: [1, 0.95, 0.2, 1],
    });
  };
  placed();
  const scattered: number[] = [];
  const scatter = (n: number): void => {
    while (scattered.length > n) decals.remove(scattered.pop()!);
    while (scattered.length < n) {
      const i = scattered.length;
      // A golden-angle spiral over the ground, away from the placed decals' probes.
      const a = i * 2.39996;
      const r = 3.2 + 0.035 * i;
      scattered.push(
        decals.add({
          x: Math.cos(a) * r,
          y: 0,
          z: Math.sin(a) * r - 1,
          nx: 0,
          ny: 1,
          nz: 0,
          size: 0.25,
          tile: 3,
          color: [0.95, 0.95, 1, 0.8],
        }),
      );
    }
    state.scatter = n;
  };

  apply = (o) => {
    if (o.shown !== undefined && o.shown !== state.shown) {
      if (o.shown) core.addDrawable(decals.coreDrawable!);
      else core.removeDrawable(decals.coreDrawable!);
      state.shown = o.shown;
    }
    if (o.scatter !== undefined) scatter(Math.max(0, Math.floor(o.scatter)));
  };

  const target = (clear: boolean): CoreTarget => ({
    view: undefined as unknown as GPUTextureView,
    format: gpu.format,
    width: 1,
    height: 1,
    clear: clear ? { r: 0.08, g: 0.09, b: 0.12, a: 1 } : undefined,
    viewport: { x: 0, y: 0, width: 1, height: 1 },
  });
  const targets = [target(true), target(false)] as const;
  const aspects = [0, 0];
  const paused = false;
  state.gpu = 'ok';
  state.ready = true;

  const frame = (): void => {
    if (paused) return;
    placeHead();
    const texture = gpu.context.getCurrentTexture();
    const colour = texture.createView();
    const w = texture.width;
    const half = Math.floor(w / 2);
    for (let i = 0; i < 2; i++) {
      const camera = eyes[i]!;
      const aspect = (i === 0 ? half : w - half) / texture.height;
      if (aspect !== aspects[i]) {
        aspects[i] = aspect;
        camera.setPerspective(fovY, aspect, 0.1, 100);
      }
      placeEye(camera, (i === 0 ? -1 : 1) * (IPD / 2));
      setViewFromCamera(views[i]!, camera);
      const t = targets[i]!;
      t.view = colour;
      t.width = w;
      t.height = texture.height;
      const vp = t.viewport!;
      vp.x = i === 0 ? 0 : half;
      vp.width = i === 0 ? half : w - half;
      vp.height = texture.height;
      const eye = state.eyes[i as 0 | 1];
      probe(camera, RING_PROBE, eye.probes.floor);
      probe(camera, CORNER_PROBE, eye.probes.corner);
    }
    const encoder = gpu.device.createCommandEncoder();
    core.prepare(encoder, groups);
    for (let i = 0; i < 2; i++) {
      const b = core.stats.bundles;
      const p = core.stats.passes;
      core.draw(encoder, i, targets[i]!);
      state.eyes[i as 0 | 1].bundles = core.stats.bundles - b;
      state.eyes[i as 0 | 1].passes = core.stats.passes - p;
    }
    gpu.device.queue.submit([encoder.finish()]);
    state.frames++;
    state.live = decals.count;
    state.bundleBuilds = core.stats.bundleBuilds;
    state.drawables = core.coreDrawables.length;
    state.gpuErrors = gpuDiagnostics.errorCount;
    requestAnimationFrame(frame);
  };
  res.onDeviceLost(() => {
    if (!paused) state.gpu = 'lost';
  });
  requestAnimationFrame(frame);
}

function xyz(p: readonly number[]): { x: number; y: number; z: number } {
  return { x: p[0]!, y: p[1]!, z: p[2]! };
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});

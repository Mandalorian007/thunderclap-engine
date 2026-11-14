/**
 * Core-effects page (ws/core-effects, B5): world effects on the retained render core, drawn in
 * both eyes of a stereo pair. A lit scene (a ground and four blocks, one static GPU-culled draw
 * set) sits under three core drawables: a `Water` pool with refraction and screen-space
 * reflection from the core's depth and colour copy, a `ParticleSystem` fountain with soft
 * particles, and `Weather` (a desert dust storm by default; `?weather=snow|rain`, or the api).
 * Both eyes are one `union` cull group, so each pass is one recorded bundle executed by both
 * halves of the surface. `api.set({ paused })` freezes every effect so on/off probes compare
 * still pictures. Nothing here is a game: the geometry and shader are the two-views page's.
 */

import {
  ParticleSystem,
  Water,
  WEATHER_DUST_STORM,
  WEATHER_RAIN,
  WEATHER_SNOW,
  Weather,
  type WeatherConfig,
} from '@thunderclap-engine/engine/fx';
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
  Transform,
} from '@thunderclap-engine/engine/render';
import type {
  FxCoreEye,
  FxCoreProbe,
  FxCoreSet,
  FxCoreWeather,
  HarnessFxCoreState,
} from './fx-core-state';

const root = document.getElementById('root') as HTMLElement;
const IPD = 0.064;
const CONFIGS: Record<Exclude<FxCoreWeather, 'off'>, WeatherConfig> = {
  dust: WEATHER_DUST_STORM,
  snow: WEATHER_SNOW,
  rain: WEATHER_RAIN,
};
const query = new URLSearchParams(location.search);
const startWeather = (query.get('weather') ?? 'dust') as FxCoreWeather;

function eyeState(viewIndex: number, x: number): FxCoreEye {
  const p = (): FxCoreProbe => ({ x: 0, y: 0 });
  return {
    viewIndex,
    screen: { x, y: 0, width: 0.5, height: 1 },
    bundles: 0,
    passes: 0,
    probes: { water: p(), fountain: p() },
  };
}

const state: HarnessFxCoreState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  gpuErrors: 0,
  paused: query.has('still'),
  show: { water: true, particles: true },
  weather: { config: startWeather, instances: 0, layers: 0 },
  particlesAlive: 0,
  eyes: [eyeState(0, 0), eyeState(1, 0.5)],
  bundleBuilds: 0,
  drawables: 0,
};
let apply: (o: FxCoreSet) => void = (o) => {
  if (o.paused !== undefined) state.paused = o.paused;
};
window.__harnessFxCore = { state, set: (o) => apply(o) };

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

const TARGET = [0, 0.6, 2] as const;
const ORBIT = { yaw: 0.35, pitch: 0.32, distance: 9 };
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
function placeEye(camera: Camera, offset: number): void {
  const h = head;
  for (let k = 0; k < 3; k++) {
    eyePos[k] = h.eye[k]! + h.right[k]! * offset;
    eyeTarget[k] = eyePos[k]! + h.fwd[k]!;
  }
  camera.lookAt(eyePos, eyeTarget, h.up);
}

function probe(camera: Camera, x: number, y: number, z: number, out: FxCoreProbe): void {
  camera.worldToScreen(x, y, z, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

const WATER_AT = [-1.2, 0, 3.2] as const;
const FOUNTAIN_AT = [1.7, 0.2, 1.3] as const;

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine core effects demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { gpu } = res;
  installGpuErrorLogging(gpu.device);
  // The water's refraction and reflection copy each eye's half of the swapchain: COPY_SRC.
  gpu.context.configure({
    device: gpu.device,
    format: gpu.format,
    alphaMode: 'opaque',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
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

  // The scene: one static draw set (a ground and four blocks).
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
  const cubeGeo = cubeGeometry();
  const groundGeo = groundGeometry();
  const cube = vertices.alloc(cubeGeo.vertices.byteLength, 16);
  vertices.write(cube, cubeGeo.vertices);
  const ground = vertices.alloc(groundGeo.vertices.byteLength, 16);
  vertices.write(ground, groundGeo.vertices);
  const data = new Float32Array(INSTANCE_FLOATS);
  const place = (t: Transform, tint: readonly number[], checker: number, flat: boolean): void => {
    const s = Math.max(t.scale.x, t.scale.y, t.scale.z);
    const radius = flat ? s * 0.75 : s * 0.87;
    const inst = instances.alloc(INSTANCE_FLOATS * 4, 16);
    data.set(t.world, 0);
    data.set(tint, 12);
    data[16] = checker;
    instances.write(inst, data);
    const p = t.position;
    set.add({
      vertices: flat ? ground : cube,
      indexCount: flat ? 6 : 36,
      instances: inst,
      bounds: [p.x, p.y, p.z, radius],
    });
  };
  place(new Transform({ scaleX: 24, scaleY: 1, scaleZ: 24 }), [0.62, 0.52, 0.36, 1], 1, true);
  place(
    new Transform({ x: 0, y: 1.5, z: -0.5, scaleX: 2, scaleY: 3, scaleZ: 1 }),
    [0.08, 0.28, 1, 1],
    0,
    false,
  );
  place(
    new Transform({ x: -3.4, y: 0.6, z: 0.6, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 }),
    [0.3, 0.85, 0.35, 1],
    0,
    false,
  );
  place(
    new Transform({ x: 3.2, y: 0.6, z: 0, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 }),
    [0.95, 0.8, 0.2, 1],
    0,
    false,
  );
  // A red block standing in the pool: the shoreline foam, refraction and its reflection.
  place(
    new Transform({ x: -0.4, y: 0.5, z: 3.2, scaleX: 0.8, scaleY: 1, scaleZ: 0.8 }),
    [1, 0.1, 0.06, 1],
    0,
    false,
  );

  const water = new Water(core, {
    size: [5, 3],
    segments: [20, 12],
    origin: WATER_AT,
    level: 0.35,
    depthFade: 0.8,
  });
  const fountain = new ParticleSystem(core, { capacity: 8192, softness: 0.3, countAlive: true });
  const weather = new Weather(core, startWeather === 'off' ? {} : CONFIGS[startWeather]);
  const shown = { water: true, particles: true, weather: startWeather !== 'off' };
  if (!shown.weather) core.removeDrawable(weather);

  apply = (o) => {
    if (o.paused !== undefined) state.paused = o.paused;
    const toggle = (
      d: Parameters<typeof core.addDrawable>[0],
      on: boolean | undefined,
      was: boolean,
    ) => {
      if (on === undefined || on === was) return was;
      if (on) core.addDrawable(d);
      else core.removeDrawable(d);
      return on;
    };
    shown.water = toggle(water.coreDrawable!, o.water, shown.water);
    shown.particles = toggle(fountain.coreDrawable!, o.particles, shown.particles);
    if (o.weather !== undefined) {
      if (o.weather !== 'off') weather.configure(CONFIGS[o.weather]);
      shown.weather = toggle(weather, o.weather !== 'off', shown.weather);
      state.weather.config = o.weather;
    }
    state.show.water = shown.water;
    state.show.particles = shown.particles;
  };

  const target = (clear: boolean): CoreTarget => ({
    view: undefined as unknown as GPUTextureView,
    format: gpu.format,
    width: 1,
    height: 1,
    clear: clear ? { r: 0.55, g: 0.62, b: 0.72, a: 1 } : undefined,
    viewport: { x: 0, y: 0, width: 1, height: 1 },
  });
  const targets = [target(true), target(false)] as const;
  const burst = {
    x: FOUNTAIN_AT[0],
    y: FOUNTAIN_AT[1],
    z: FOUNTAIN_AT[2],
    angle: Math.PI / 2,
    spread: 0.35,
    speed: [3.5, 5] as [number, number],
    vz: 0,
    life: [1.2, 1.8] as [number, number],
    size: [0.12, 0.22] as [number, number],
    colorStart: [1, 0.55, 0.15, 1],
    colorEnd: [1, 0.15, 0.05, 0],
    gravity: [0, -6, 0] as [number, number, number],
  };
  const aspects = [0, 0];
  let last = performance.now();
  state.gpu = 'ok';
  state.ready = true;

  const frame = (): void => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!state.paused) {
      fountain.emit(burst, 40);
      fountain.update(dt);
      water.update(dt);
      weather.update(dt);
    } else {
      fountain.update(0);
    }
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
      t.texture = texture;
      t.width = w;
      t.height = texture.height;
      const vp = t.viewport!;
      vp.x = i === 0 ? 0 : half;
      vp.width = i === 0 ? half : w - half;
      vp.height = texture.height;
      const eye = state.eyes[i as 0 | 1];
      probe(camera, WATER_AT[0] + 1.2, WATER_AT[1] + 0.35, WATER_AT[2] + 0.4, eye.probes.water);
      probe(camera, FOUNTAIN_AT[0], FOUNTAIN_AT[1] + 0.5, FOUNTAIN_AT[2], eye.probes.fountain);
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
    state.particlesAlive = fountain.alive;
    state.weather.instances = shown.weather ? weather.instances : 0;
    state.weather.layers = weather.layerCount;
    state.bundleBuilds = core.stats.bundleBuilds;
    state.drawables = core.coreDrawables.length;
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

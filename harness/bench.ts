/**
 * Bench page (ws/bench; STATUS row 5): a fixed scene ladder, each rung held for N frames, with
 * per-rung medians of CPU and GPU frame time on `window.__harnessBench.state.results`.
 * `scripts/bench.mjs` runs it with `?rung=all` and writes docs/BENCH.md; e2e/bench.spec.ts runs
 * `?rung=tiny`. Nothing here is engine code: the geometry, the material and the scene are what
 * a game would write.
 *
 * - CPU ms: `performance.now()` around the render callback (`beginFrame` to `endFrame`),
 *   median over the rung's frames after `BENCH_WARMUP`.
 * - GPU ms: `renderer.gpuTimer` (`timestamp-query`) through `renderer.onGpuTime`, median over
 *   the samples that resolve during the measured frames; `null` when the device has no
 *   timestamps. Samples lag their frame by a readback, so a rung's first few are the warm-up's.
 * - Content is deterministic: a seeded field of cubes, fixed `BENCH_DT` instead of the real
 *   frame delta. Only the measurement varies.
 * - Per frame nothing is allocated: transforms, draw params and sample arrays are built once.
 *
 * Query: `?rung=all|tiny|<id>,<id>` (see `benchRungsFor`), `?frames=N` overrides every rung's
 * frame count, `?mode=mesh|batch|list` the submission path of every 3D rung, `?cull=0|1` their
 * `camera.cull`; `?still` keeps presenting the last rung's scene after `done`, so a spec can
 * screenshot it.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { ParticleSystem } from '@thunderclap/engine/fx';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  type DrawParams,
  gpuDiagnostics,
  INSTANCE_PARAM_FLOATS,
  type InstanceBatch,
  type InstanceList,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  type PointLight,
  Renderer,
  supportsTimestamps,
  Transform,
  VERTEX_LAYOUT_3D,
  writeInstanceParams,
} from '@thunderclap/engine/render';
import {
  BENCH_LADDER,
  BENCH_WARMUP,
  type BenchMode,
  type BenchRungDef,
  type BenchRungResult,
  benchModeFor,
  benchRungsFor,
  type HarnessBenchApi,
  type HarnessBenchState,
} from './bench-state';

const root = document.getElementById('root') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
/** The fixed frame delta the scene advances by (s). */
const BENCH_DT = 1 / 60;

const params = new URLSearchParams(location.search);
const framesOverride = Number(params.get('frames')) || 0;
const modeOverride = benchModeFor(params.get('mode'));
const cullParam = params.get('cull');
const cullOverride = cullParam === null ? null : cullParam !== '0' && cullParam !== 'false';
const still = params.has('still');
const rungs = benchRungsFor(params.get('rung')).map((r) => ({
  ...r,
  frames: framesOverride > 0 ? framesOverride : r.frames,
  mode: modeOverride ?? r.mode,
  cull: cullOverride ?? r.cull,
}));

const state: HarnessBenchState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  done: false,
  current: null,
  remaining: rungs.length,
  timestamps: false,
  adapter: { vendor: '', architecture: '', device: '', description: '' },
  userAgent: navigator.userAgent,
  results: [],
  gpuErrors: 0,
  error: null,
  logical: { ...LOGICAL },
  probe: null,
};
const api: HarnessBenchApi = { state, rungs: BENCH_LADDER };
window.__harnessBench = api;

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

// ------------------------------------------------------------------ the material

/** Albedo × the engine lighting block plus a faint sky term from above. */
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(in.color.rgb * (engine_lambert(n, in.worldPos) + 0.12 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

const AMBIENT = [0.18, 0.18, 0.2] as const;
const SUN_DIR = [-0.45, -1.0, -0.65] as const;
const SUN_COLOR = [0.8, 0.8, 0.78] as const;
const LAMP_COLOR = [1.6, 0.9, 0.4] as const;
const LAMP_RADIUS = 14;
const LAMP_RING = 30;
const LAMP_HEIGHT = 4;
const SHADOW = { extent: 40, size: 2048 as const };

// ------------------------------------------------------------------ the scene

/** The cube field: a box the camera looks into from one side, so culling has work to do. */
const FIELD_X = 120;
const FIELD_Y = 14;
const FIELD_Z = 120;
const CUBE_SCALE = 0.8;
const EYE = [0, 18, 60] as const;
const TARGET = [0, 2, -20] as const;
const MAX_INSTANCES = Math.max(...BENCH_LADDER.map((r) => r.count));
const SPRITE_SIZE = 24;

/** A small seeded generator (LCG) so the field is the same on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function median(xs: Float64Array, n: number): number {
  if (n === 0) return 0;
  const sorted = Array.from(xs.subarray(0, n)).sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine bench' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const info = gpu.adapter.info;
  if (info) {
    state.adapter.vendor = info.vendor ?? '';
    state.adapter.architecture = info.architecture ?? '';
    state.adapter.device = info.device ?? '';
    state.adapter.description = info.description ?? '';
  }
  state.timestamps = supportsTimestamps(gpu.device);

  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));
  renderer.timingEvery = 1;

  const camera3d = Camera.perspective(
    (50 * Math.PI) / 180,
    LOGICAL.width / LOGICAL.height,
    0.1,
    500,
  );
  Object.assign(camera3d.screen, { x: 0, y: 0, ...LOGICAL });
  camera3d.lookAt(EYE, TARGET);
  const camera2d = Camera.ortho2d(LOGICAL.width, LOGICAL.height);

  const lit = renderer.createMaterial({ label: 'bench-lit', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });

  // The field, placed once. Every rung draws the first `count` cubes.
  const rand = lcg(0x5eed);
  const transforms: Transform[] = [];
  for (let i = 0; i < MAX_INSTANCES; i++) {
    transforms.push(
      new Transform({
        x: (rand() - 0.5) * FIELD_X,
        y: rand() * FIELD_Y,
        z: (rand() - 0.5) * FIELD_Z,
        scaleX: CUBE_SCALE,
        scaleY: CUBE_SCALE,
        scaleZ: CUBE_SCALE,
      }).setAxisAngle(0, 1, 0, rand() * Math.PI),
    );
  }
  const cubeP: InstanceParams = { tint: [0.75, 0.8, 0.9, 1] };
  // The same cubes as one batch (`frame.meshes`): matrices and params laid out once; a rung sets
  // `count`. And as one retained list (`frame.list`), filled when a list rung starts.
  const matrices = new Float32Array(MAX_INSTANCES * 12);
  const batchParams = new Float32Array(MAX_INSTANCES * INSTANCE_PARAM_FLOATS);
  for (let i = 0; i < MAX_INSTANCES; i++) {
    matrices.set(transforms[i]!.world, i * 12);
    writeInstanceParams(batchParams, i * INSTANCE_PARAM_FLOATS, cubeP, CUBE_SCALE, CUBE_SCALE);
  }
  const batch: InstanceBatch = { count: 0, matrices, params: batchParams };
  let list: InstanceList | null = null;
  const listFor = (count: number): InstanceList => {
    list ??= renderer.createInstanceList(cube, lit, MAX_INSTANCES);
    list.clear();
    for (let i = 0; i < count; i++) list.set(i, transforms[i]!, cubeP);
    return list;
  };

  /**
   * The probe: among the first `count` cubes, the nearest whose centre projects into the middle
   * 60% of the view (the hud sits bottom-left, outside it). Null when none does.
   */
  const probePoint = { x: 0, y: 0, z: 0 };
  function probeFor(count: number): { x: number; y: number } | null {
    let best = -1;
    let bestZ = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      const p = transforms[i]!.position;
      camera3d.worldToScreen(p.x, p.y, p.z, probePoint);
      if (probePoint.z <= 0 || probePoint.z >= 1) continue;
      if (Math.abs(probePoint.x / LOGICAL.width - 0.5) > 0.3) continue;
      if (Math.abs(probePoint.y / LOGICAL.height - 0.5) > 0.3) continue;
      if (probePoint.z < bestZ) {
        bestZ = probePoint.z;
        best = i;
      }
    }
    if (best < 0) return null;
    const p = transforms[best]!.position;
    camera3d.worldToScreen(p.x, p.y, p.z, probePoint);
    return { x: probePoint.x, y: probePoint.y };
  }

  // The sprites, placed once over the logical space.
  const sprites: DrawParams[] = [];
  for (let i = 0; i < MAX_INSTANCES; i++) {
    sprites.push({
      x: rand() * LOGICAL.width,
      y: rand() * LOGICAL.height,
      w: SPRITE_SIZE,
      h: SPRITE_SIZE,
      tint: [0.3 + 0.7 * rand(), 0.3 + 0.7 * rand(), 0.3 + 0.7 * rand(), 1],
    });
  }

  // The lights: a sun and up to MAX_POINT_LIGHTS lamps on a ring, pushed per rung.
  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.dir = SUN_DIR;
  lights.sun.color = SUN_COLOR;
  const lamps: PointLight[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    lamps.push({
      position: new Float32Array([Math.cos(a) * LAMP_RING, LAMP_HEIGHT, Math.sin(a) * LAMP_RING]),
      color: LAMP_COLOR,
      radius: LAMP_RADIUS,
    });
  }

  // World particles: one system per particle rung (the draw covers the capacity, so a shared
  // one would cost the same at every count). Hovering motes with a life longer than the rung.
  const particles = new Map<number, ParticleSystem>();
  for (const r of BENCH_LADDER) {
    if (r.kind === 'particles' && !particles.has(r.count)) {
      particles.set(
        r.count,
        new ParticleSystem(renderer, { space: 'world', capacity: r.count, stretch: 0 }),
      );
    }
  }
  const emitParams = {
    x: 0,
    y: 8,
    z: -20,
    shape: { kind: 'box', width: 80, height: 14, depth: 80 } as const,
    speed: [0.05, 0.1] as const,
    life: [1e4, 1e4] as const,
    size: [0.25, 0.25] as const,
    gravity: [0, 0, 0] as const,
    drag: 0,
    colorStart: [1.2, 0.9, 0.5, 1] as const,
  };

  // Samples for the rung in hand, sized for the longest rung.
  const maxFrames = Math.max(...rungs.map((r) => r.frames));
  const cpuSamples = new Float64Array(maxFrames);
  const gpuSamples = new Float64Array(maxFrames);
  let cpuCount = 0;
  let gpuCount = 0;
  let measuring = false;
  renderer.onGpuTime((ms) => {
    if (measuring && gpuCount < gpuSamples.length) gpuSamples[gpuCount++] = ms;
  });

  let index = -1;
  let rung: BenchRungDef | null = null;
  let rungFrame = 0;
  let system: ParticleSystem | null = null;
  let mode: BenchMode = 'mesh';
  /** After `done` with `?still`: the last rung keeps presenting, unmeasured. */
  let holding = false;

  function start(r: BenchRungDef): void {
    rung = r;
    rungFrame = 0;
    cpuCount = 0;
    gpuCount = 0;
    measuring = false;
    state.current = r.id;
    state.remaining = rungs.length - index - 1;
    const is3d = r.kind !== 'sprites';
    renderer.camera = is3d ? camera3d : camera2d;
    camera3d.cull = r.cull;
    lights.points.length = 0;
    for (let i = 0; i < r.points; i++) lights.points.push(lamps[i]!);
    lights.sun.shadow = r.shadow ? SHADOW : null;
    system = null;
    mode = r.mode;
    state.probe = null;
    if (r.kind === 'particles') {
      system = particles.get(r.count) ?? null;
      if (!system) throw new Error(`bench: no particle system for ${r.count}`);
      system.emit(emitParams, r.count);
    } else if (is3d) {
      if (mode === 'batch') batch.count = r.count;
      if (mode === 'list') listFor(r.count);
      state.probe = probeFor(r.count);
    }
  }

  function finish(r: BenchRungDef): void {
    const shadowed = r.shadow && r.kind !== 'sprites' && r.kind !== 'particles';
    const result: BenchRungResult = {
      id: r.id,
      kind: r.kind,
      mode: r.mode,
      count: r.count,
      frames: cpuCount,
      cpuMs: median(cpuSamples, cpuCount),
      gpuMs: state.timestamps && gpuCount > 0 ? median(gpuSamples, gpuCount) : null,
      instances: renderer.stats.instances,
      culled: renderer.stats.culled,
      shadowDraws: shadowed ? renderer.stats.instances : 0,
      drawCalls: renderer.stats.drawCalls,
      gpuSamples: gpuCount,
    };
    state.results.push(result);
    system?.clear();
  }

  function next(): boolean {
    index++;
    const r = rungs[index];
    if (!r) {
      state.current = null;
      state.remaining = 0;
      state.done = true;
      if (still && rung) {
        holding = true;
        return true;
      }
      rung = null;
      return false;
    }
    start(r);
    return true;
  }

  const loop = new GameLoop(
    {
      update() {},
      render() {
        const r = rung;
        if (!r) return;
        try {
          step(r);
        } catch (err) {
          console.error('[harness]', err);
          state.error = err instanceof Error ? err.message : String(err);
          rung = null;
          state.current = null;
          state.done = true;
          loop.stop();
        }
      },
    },
    { fixed: false },
  );
  res.onDeviceLost(() => loop.stop());

  /** One frame of rung `r`: draw, time, publish, and move on when the rung is done. */
  function step(r: BenchRungDef): void {
    const t0 = performance.now();
    const frame = renderer.beginFrame(state.frames * BENCH_DT, BENCH_DT);
    frame.clear(0.05, 0.07, 0.12);
    frame.lights = lights;
    if (r.kind === 'sprites') {
      for (let i = 0; i < r.count; i++) frame.sprite(null, sprites[i]!);
    } else if (r.kind === 'particles') {
      system!.update(BENCH_DT);
      frame.drawable(system!);
    } else if (mode === 'batch') {
      frame.meshes(cube, lit, batch);
    } else if (mode === 'list') {
      frame.list(list!);
    } else {
      for (let i = 0; i < r.count; i++) frame.mesh(cube, lit, transforms[i]!, cubeP);
    }
    renderer.endFrame();
    const cpu = performance.now() - t0;
    state.frames++;
    if (holding) return;
    state.gpuErrors = gpuDiagnostics.errorCount;
    rungFrame++;
    if (rungFrame > BENCH_WARMUP) {
      measuring = true;
      if (cpuCount < cpuSamples.length) cpuSamples[cpuCount++] = cpu;
    }
    hud.textContent =
      `rung ${r.id} (${index + 1}/${rungs.length}) frame ${rungFrame}/${r.frames}\n` +
      `instances ${renderer.stats.instances} culled ${renderer.stats.culled} ` +
      `draws ${renderer.stats.drawCalls} cpu ${cpu.toFixed(2)}ms`;
    if (rungFrame >= r.frames) {
      measuring = false;
      finish(r);
      if (!next()) loop.stop();
    }
  }

  state.gpu = 'ok';
  state.ready = true;
  if (next()) loop.start();
}

main().catch((err) => {
  console.error('[harness]', err);
  const message = err instanceof Error ? err.message : String(err);
  if (state.ready) state.error = message;
  else state.gpu = `error: ${message}`;
  state.ready = true;
  state.done = true;
});

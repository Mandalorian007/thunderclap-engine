/**
 * Storm page (ws/e25-rain): a game's storm on the retained core, the way Forge Wilds draws it,
 * to measure rain under each anti-aliasing mode and what it costs. A dark sky, a ground writing
 * velocity, a pond (`Water`), and `Weather` with a game's storm (16000 streaks at full density,
 * 2000 splashes) in a pass of its own after the water (so the GPU timer prices it alone), then
 * post as a core pass (`createCorePost`) into the canvas, jittered while TAA runs.
 *
 * Query: `?aa=off|fxaa|taa` (default taa), `?tier=low|medium|high` (the weather density by tier,
 * `weatherTierDensity`; default high), `?weather=off`, `?fast=1` (TAA's fast resolve),
 * `?velocity=0` (the weather writes colour only, as before ws/e25-rain), `?luma=1` (read the canvas back every 4th frame for the mean luma), `?t=` (seconds: the
 * weather's clock frozen there, for side-by-side shots).
 */

import { createSkyPass, Water, Weather, weatherTierDensity } from '@thunderclap-engine/engine/fx';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  createCorePost,
  createPostHost,
  neutralPostSettings,
  PostStack,
} from '@thunderclap-engine/engine/post';
import type { QualityTier } from '@thunderclap-engine/engine/quality';
import {
  Camera,
  createInstanceLayout,
  createRenderCore,
  createRenderView,
  createVertexLayout,
  GpuTimer,
  gpuDiagnostics,
  installGpuErrorLogging,
  setViewFromCamera,
  supportsTimestamps,
} from '@thunderclap-engine/engine/render';
import type { HarnessStormState } from './storm-state';

const root = document.getElementById('root') as HTMLElement;
const QUERY = new URLSearchParams(location.search);
const AA = (['off', 'fxaa', 'taa'] as const).find((a) => a === QUERY.get('aa')) ?? 'taa';
const TIER: QualityTier =
  (['low', 'medium', 'high'] as const).find((t) => t === QUERY.get('tier')) ?? 'high';
const RAIN = QUERY.get('weather') !== 'off';
const LUMA = QUERY.get('luma') === '1';
const FROZEN = QUERY.has('t') ? Number(QUERY.get('t')) : null;

const state: HarnessStormState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  aa: AA,
  tier: TIER,
  density: 0,
  instances: 0,
  timestamps: false,
  gpuSamples: 0,
  gpuMs: 0,
  rainMs: 0,
  passMs: {},
  luma: 0,
  lumaSamples: 0,
  width: 0,
  height: 0,
  gpuErrors: 0,
};
window.__harnessStorm = { state };

/** A unit cube centred on the origin: 6 faces of 4 vertices (x, y, z, 1). */
function cubeVertices(): Float32Array {
  const faces = [
    [0, 0, 1, 1, 0, 0, 0, 1, 0],
    [0, 0, -1, -1, 0, 0, 0, 1, 0],
    [1, 0, 0, 0, 0, -1, 0, 1, 0],
    [-1, 0, 0, 0, 0, 1, 0, 1, 0],
    [0, 1, 0, 1, 0, 0, 0, 0, -1],
    [0, -1, 0, 1, 0, 0, 0, 0, 1],
  ];
  const v = new Float32Array(24 * 4);
  let o = 0;
  for (const f of faces) {
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      for (let k = 0; k < 3; k++) v[o + k] = (f[k]! + sx! * f[3 + k]! + sy! * f[6 + k]!) * 0.5;
      v[o + 3] = 1;
      o += 4;
    }
  }
  return v;
}

const VERTEX = createVertexLayout({
  stride: 16,
  attributes: [{ name: 'position', format: 'float32x4', offset: 0 }],
});
/** Per instance: centre xyz and width, colour rgb and height. */
const INSTANCE = createInstanceLayout({
  stride: 32,
  attributes: [
    { name: 'place', format: 'float32x4', offset: 0 },
    { name: 'tint', format: 'float32x4', offset: 16 },
  ],
});

/** Opaque boxes: colour, velocity. A soft checker so the ground isn't flat. */
const BOX_WGSL = /* wgsl */ `
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
  @location(1) world: vec3f,
};
@vertex fn vs(in: VertexIn) -> Out {
  let size = vec3f(in.place.w, in.tint.w, in.place.w);
  let w = in.place.xyz + in.position.xyz * size;
  var o: Out;
  o.clip = view.viewProj * vec4f(w, 1.0);
  o.color = in.tint.rgb * (0.7 + 0.3 * in.position.y);
  o.world = w;
  return o;
}
struct Frag {
  @location(0) color: vec4f,
  @location(3) velocity: vec4f,
};
@fragment fn fs(in: Out) -> Frag {
  var o: Frag;
  let c = floor(in.world.xz * 0.5);
  let k = 0.85 + 0.15 * fract((c.x + c.y) * 0.5) * 2.0;
  o.color = vec4f(in.color * k, 1.0);
  o.velocity = vec4f(core_velocity(view, in.world), 0.0, 1.0);
  return o;
}`;

/** The storm's light on what falls (a game passes its sky's): Forge's rain tint 1.4 over it. */
const SKY_LIGHT = 0.42;

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Storm' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  const device = gpu.device;
  installGpuErrorLogging(device);
  if (LUMA) {
    // The luma read copies the canvas into a 2D canvas: it must stay readable after the frame.
    gpu.context.configure({
      device,
      format: gpu.format,
      alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
  }
  const core = createRenderCore(gpu, {
    targets: ['emissive', 'roughMetal', 'velocity'],
    passLabels: true,
  });
  core.definePass({ id: 'rain', after: 'transparent', depth: 'read', writes: [] });
  const sky = createSkyPass(core, {
    zenith: [0.1, 0.12, 0.15],
    horizon: [0.22, 0.25, 0.28],
    ground: [0.12, 0.12, 0.12],
    sunSize: 0,
    sunGlow: 0,
    stars: null,
    exposure: 1,
    ambientFloor: 0.2,
  });
  sky.sunDir.set([0.3, -0.8, -0.4]);

  const vertices = core.createArena({ kind: 'vertex', blockBytes: 16 << 10, label: 'cube' });
  const instances = core.createArena({ kind: 'instance', blockBytes: 16 << 10, label: 'boxes' });
  const cube = vertices.alloc(24 * 16, 16);
  vertices.write(cube, cubeVertices());
  const boxes = core.createDrawSet({
    label: 'boxes',
    shader: { code: BOX_WGSL, writes: ['velocity'] },
    vertexLayout: VERTEX,
    instanceLayout: INSTANCE,
    vertices,
    instances,
    capacity: 64,
    kind: 'static',
    cull: 'gpu',
  });
  const add = (b: readonly number[]) => {
    const inst = instances.alloc(32, 16);
    instances.write(inst, new Float32Array(b));
    const r = 0.87 * Math.max(b[3]!, b[7]!);
    boxes.add({
      vertices: cube,
      indexCount: 36,
      instances: inst,
      bounds: [b[0]!, b[1]!, b[2]!, r],
    });
  };
  // Grass to the horizon (top at y 0), a pond's bed sunk in front, a few dark blocks around it.
  add([0, -0.5, -40, 120, 0.11, 0.16, 0.08, 1]);
  add([-35, -0.5, 10, 50, 0.11, 0.16, 0.08, 1]);
  add([35, -0.5, 10, 50, 0.11, 0.16, 0.08, 1]);
  add([0, -0.9, 10, 20, 0.08, 0.07, 0.05, 1]);
  add([-5, 1, -6, 2, 0.2, 0.18, 0.16, 2]);
  add([6, 1.5, -9, 3, 0.18, 0.17, 0.16, 3]);
  add([-12, 2, -14, 2.5, 0.16, 0.15, 0.15, 4]);

  const water = new Water(core, {
    size: 20,
    segments: 1,
    origin: [0, 0, 10],
    level: 0.01,
    depthFade: 1.2,
    foam: null,
    fresnel: 0.3,
    refraction: 0,
    reflectionSteps: 0,
    sunColor: [0, 0, 0],
    skyColor: [0.22, 0.25, 0.28],
    shallowColor: [0.08, 0.1, 0.1],
    deepColor: [0.02, 0.04, 0.05],
  });

  // Forge Wilds' storm: its rain kind and splashes, at the density its tier gives.
  const density = weatherTierDensity(TIER);
  state.density = density;
  const L = SKY_LIGHT;
  const weather = new Weather(core, {
    pass: 'rain',
    velocity: QUERY.get('velocity') !== '0',
    occlusionHeight: 0,
    density,
    layers: [
      {
        shape: 'streak',
        count: 16000,
        radius: 26,
        height: 34,
        speed: 13,
        windFactor: 0.3,
        length: 0.65,
        width: 0.014,
        color: [0.75 * 1.4 * L, 0.82 * 1.4 * L, 0.9 * 1.4 * L],
        alpha: 0.45,
      },
      {
        shape: 'splash',
        count: 2000,
        radius: 14,
        height: 1,
        speed: 1.45,
        length: 0.18,
        color: [1.3 * L, 1.35 * L, 1.4 * L],
        alpha: 0.22,
      },
    ],
    wind: [1.6, 0.6],
  });
  if (!RAIN) core.removeDrawable(weather);

  const host = createPostHost(device, gpu.format);
  // Forge's look: neutral but for an ACES grade, the AA under test.
  const look = neutralPostSettings();
  look.mist.enabled = false;
  look.godRays.enabled = false;
  look.bloom = { ...look.bloom, enabled: false };
  look.grade = { ...look.grade, enabled: true, tonemap: 'aces' };
  look.taa = {
    ...look.taa,
    enabled: AA === 'taa',
    quality: QUERY.get('fast') === '1' ? 'fast' : 'full',
  };
  look.fxaa = { ...look.fxaa, enabled: AA === 'fxaa' };
  const stack = new PostStack(host, look);
  const post = createCorePost(core, stack, { after: 'rain', velocityJitter: 'remove' });

  state.timestamps = supportsTimestamps(device);
  const timer = state.timestamps ? new GpuTimer(device) : null;
  const totals: number[] = [];
  const perPass = new Map<string, number[]>();
  const median = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1] ?? 0;
  timer?.onResult((r) => {
    totals.push(r.totalMs);
    if (totals.length > 120) totals.shift();
    for (const [k, ms] of Object.entries(r.passes)) {
      let a = perPass.get(k);
      if (!a) {
        a = [];
        perPass.set(k, a);
      }
      a.push(ms);
      if (a.length > 120) a.shift();
    }
    state.gpuSamples++;
    state.gpuMs = Math.round(median(totals) * 1000) / 1000;
    const out: Record<string, number> = {};
    let rain = 0;
    for (const [k, a] of perPass) {
      out[k] = Math.round(median(a) * 1000) / 1000;
      if (k.includes('rain')) rain += out[k]!;
    }
    state.passMs = out;
    state.rainMs = rain;
  });

  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 400);
  const view = createRenderView();
  const views = [view];
  let scene: GPUTexture | null = null;
  const target = {
    view: undefined as unknown as GPUTextureView,
    format: 'rgba16float' as GPUTextureFormat,
    width: 1,
    height: 1,
    clear: { r: 0, g: 0, b: 0, a: 1 },
    output: undefined as unknown as GPUTextureView,
    outputFormat: gpu.format,
    timestamps: undefined as
      | ((label: string, pass?: string) => GPURenderPassTimestampWrites | undefined)
      | undefined,
  };
  const stamp = (label: string, pass?: string) => timer!.pass(pass ? `${label} ${pass}` : label);

  // The luma read: a small 2D canvas the frame is scaled into.
  const probe = LUMA ? document.createElement('canvas') : null;
  const probe2d = probe?.getContext('2d', { willReadFrequently: true }) ?? null;
  let lumaSum = 0;
  if (probe) {
    probe.width = 320;
    probe.height = 180;
  }

  state.gpu = 'ok';
  state.ready = true;
  let frameIndex = 0;
  let last = performance.now();
  const frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const { width, height } = surface.backbuffer;
    if (!scene || scene.width !== width || scene.height !== height) {
      scene?.destroy();
      scene = device.createTexture({
        label: 'storm scene',
        size: [width, height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      target.view = scene.createView();
      target.width = width;
      target.height = height;
      host.resize(width, height);
    }
    camera.setPerspective(Math.PI / 3, width / Math.max(1, height), 0.1, 400);
    camera.lookAt([0, 1.7, 22], [0, 0.2, 6]);
    // TAA's sequence once its TAA has run (none on its first frame), into the view and the post.
    const j = AA === 'taa' ? host.jitter?.(frameIndex++) : undefined;
    camera.setJitterTarget(width, height);
    camera.setJitter(j ? j[0] : 0, j ? j[1] : 0);
    post.setJitter(j ? j[0] : 0, j ? j[1] : 0);
    setViewFromCamera(view, camera);
    target.output = gpu.context.getCurrentTexture().createView();
    sky.prepare();
    water.update(dt);
    if (FROZEN === null) weather.update(dt);
    else weather.time = FROZEN;
    post.time = now / 1000;
    post.dt = dt;

    const encoder = device.createCommandEncoder();
    const timed = timer?.begin() ?? false;
    target.timestamps = timed ? stamp : undefined;
    if (timed) timer!.mark(encoder);
    core.prepare(encoder, views);
    core.draw(encoder, 0, target);
    if (timed) timer!.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    if (timed) timer!.afterSubmit();
    if (probe2d && state.frames > 30 && state.frames % 4 === 0) {
      probe2d.drawImage(gpu.context.canvas as HTMLCanvasElement, 0, 0, 320, 180);
      const px = probe2d.getImageData(0, 0, 320, 180).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) {
        sum += 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!;
      }
      lumaSum += sum / (px.length / 4);
      state.lumaSamples++;
      state.luma = Math.round((lumaSum / state.lumaSamples) * 1000) / 1000;
    }
    state.frames++;
    state.instances = RAIN ? weather.instances : 0;
    state.width = width;
    state.height = height;
    state.gpuErrors = gpuDiagnostics.errorCount;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});

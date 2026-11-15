/**
 * Pass-cost page (ws/pass-cost): what a frame of a 3D game on the retained core costs in render
 * passes, attachments and GPU time. The scene is the shape of a voxel game's frame: opaque
 * boxes writing emissive and velocity, a sky pass (`createSkyPass`), a `water` pass after
 * `transparent` that tests depth and writes colour only, an `fx` pass whose `encode` has nothing
 * to draw this frame (a weather layer with no particles), and post as a core pass
 * (`createCorePost`: TAA and bloom) into the canvas.
 *
 * `?cost=1` turns on what ws/pass-cost added, so one build measures both: the water pass
 * declares `writes: []`, the fx pass `encodeWhen: () => false`, and TAA runs one output
 * (`taaAux: false`, the low tier's). The sky pass declares its writes in both modes (it is
 * engine code). `?taa1=0` keeps TAA's two outputs with `?cost=1`.
 */

import { createSkyPass } from '@thunderclap-engine/engine/fx';
import { boot } from '@thunderclap-engine/engine/platform';
import { createCorePost, createPostHost, PostStack } from '@thunderclap-engine/engine/post';
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
import type { HarnessPassCostState } from './pass-cost-state';

const root = document.getElementById('root') as HTMLElement;
const QUERY = new URLSearchParams(location.search);
const COST = QUERY.get('cost') === '1';
const TAA1 = COST && QUERY.get('taa1') !== '0';

const state: HarnessPassCostState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  passes: 0,
  attachments: 0,
  labels: [],
  timestamps: false,
  gpuSamples: 0,
  gpuMs: 0,
  gpuP95: 0,
  passMs: {},
  width: 0,
  height: 0,
  gpuErrors: 0,
};
window.__harnessPassCost = { state };

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

const VS = /* wgsl */ `
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
}`;

/** Opaque boxes: colour, a glow on the bright ones, velocity. */
const BOX_WGSL = `${VS}
struct Frag {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
  @location(3) velocity: vec4f,
};
@fragment fn fs(in: Out) -> Frag {
  var o: Frag;
  o.color = vec4f(in.color, 1.0);
  o.emissive = vec4f(in.color * select(0.0, 3.0, in.color.r > 0.8), 1.0);
  o.velocity = vec4f(core_velocity(view, in.world), 0.0, 1.0);
  return o;
}`;

/** The water: colour only. */
const WATER_WGSL = `${VS}
@fragment fn fs(in: Out) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}`;

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Pass cost' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  const device = gpu.device;
  installGpuErrorLogging(device);
  const core = createRenderCore(gpu, {
    targets: ['emissive', 'roughMetal', 'velocity'],
    passLabels: true,
  });
  core.definePass({
    id: 'water',
    after: 'transparent',
    depth: 'read',
    writes: COST ? [] : undefined,
  });
  let particles = 0;
  core.definePass({
    id: 'fx',
    after: 'water',
    depth: 'read',
    coreTargets: false,
    encodeWhen: COST ? () => particles > 0 : undefined,
    encode: () => {
      // A weather layer with nothing to draw this frame.
      particles = 0;
    },
  });
  const sky = createSkyPass(core, {
    zenith: [0.2, 0.35, 0.7],
    horizon: [0.6, 0.7, 0.85],
    ground: [0.3, 0.28, 0.25],
    sunSize: 0.03,
    sunGlow: 0.4,
    stars: null,
    exposure: 1,
    ambientFloor: 0.2,
  });
  sky.sunDir.set([0.4, -0.6, -0.5]);

  const vertices = core.createArena({ kind: 'vertex', blockBytes: 16 << 10, label: 'cube' });
  const instances = core.createArena({ kind: 'instance', blockBytes: 64 << 10, label: 'boxes' });
  const cube = vertices.alloc(24 * 16, 16);
  vertices.write(cube, cubeVertices());
  const boxes = core.createDrawSet({
    label: 'boxes',
    shader: { code: BOX_WGSL, writes: ['emissive', 'velocity'] },
    vertexLayout: VERTEX,
    instanceLayout: INSTANCE,
    vertices,
    instances,
    capacity: 512,
    kind: 'static',
    cull: 'gpu',
  });
  const water = core.createDrawSet({
    label: 'water',
    shader: { code: WATER_WGSL },
    vertexLayout: VERTEX,
    instanceLayout: INSTANCE,
    vertices,
    instances,
    capacity: 4,
    kind: 'static',
    cull: 'gpu',
    pass: 'water',
  });
  const add = (set: typeof boxes, b: readonly number[]) => {
    const inst = instances.alloc(32, 16);
    instances.write(inst, new Float32Array(b));
    const r = 0.87 * Math.max(b[3]!, b[7]!);
    set.add({ vertices: cube, indexCount: 36, instances: inst, bounds: [b[0]!, b[1]!, b[2]!, r] });
  };
  add(boxes, [0, -0.5, 0, 60, 0.35, 0.3, 0.22, 1]);
  for (let x = -6; x <= 6; x++) {
    for (let z = -6; z <= 6; z++) {
      if ((x + z) % 3 === 0) continue;
      const h = 1 + ((x * 7 + z * 13) & 3);
      const hot = (x * 5 + z * 3) % 7 === 0;
      add(boxes, [x * 3, h / 2, z * 3, 1.4, hot ? 1 : 0.5, hot ? 0.5 : 0.55, 0.5, h]);
    }
  }
  add(water, [0, 0.3, 0, 60, 0.1, 0.3, 0.45, 0.1]);

  const host = createPostHost(device, gpu.format);
  const stack = new PostStack(host, {
    taa: { enabled: true },
    bloom: { enabled: true, intensity: 0.6 },
  });
  if (TAA1) stack.setQuality({ taaAux: false });
  const post = createCorePost(core, stack);

  // GPU time: every frame the timer is free for, per pass label.
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
    const sorted = [...totals].sort((p, q) => p - q);
    state.gpuMs = sorted[sorted.length >> 1]!;
    state.gpuP95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    const out: Record<string, number> = {};
    for (const [k, a] of perPass) out[k] = Math.round(median(a) * 1000) / 1000;
    state.passMs = out;
  });

  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.3, 400);
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

  // Count passes and attachments of a frame.
  let passes = 0;
  let attachments = 0;
  let labels: string[] = [];
  const counted = (enc: GPUCommandEncoder) => {
    const begin = enc.beginRenderPass.bind(enc);
    enc.beginRenderPass = (desc) => {
      if (desc.label !== 'warm') {
        passes++;
        for (const a of desc.colorAttachments) if (a) attachments++;
        labels.push(desc.label ?? '');
      }
      return begin(desc);
    };
    return enc;
  };

  state.gpu = 'ok';
  state.ready = true;
  const start = performance.now();
  const frame = () => {
    const t = (performance.now() - start) / 1000;
    const { width, height } = surface.backbuffer;
    if (!scene || scene.width !== width || scene.height !== height) {
      scene?.destroy();
      scene = device.createTexture({
        label: 'pass-cost scene',
        size: [width, height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      target.view = scene.createView();
      target.width = width;
      target.height = height;
      host.resize(width, height);
    }
    camera.setPerspective(Math.PI / 3, width / Math.max(1, height), 0.3, 400);
    const a = t * 0.2;
    camera.lookAt([Math.sin(a) * 30, 14, Math.cos(a) * 30], [0, 0, 0]);
    setViewFromCamera(view, camera);
    target.output = gpu.context.getCurrentTexture().createView();
    sky.prepare();
    post.time = t;
    post.dt = 1 / 60;

    passes = 0;
    attachments = 0;
    labels = [];
    const encoder = counted(device.createCommandEncoder());
    const timed = timer?.begin() ?? false;
    target.timestamps = timed ? stamp : undefined;
    if (timed) timer!.mark(encoder);
    core.prepare(encoder, views);
    core.draw(encoder, 0, target);
    if (timed) timer!.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    if (timed) timer!.afterSubmit();
    state.frames++;
    state.passes = passes;
    state.attachments = attachments;
    state.labels = labels;
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

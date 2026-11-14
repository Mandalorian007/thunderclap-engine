/**
 * Post cost page (ws/post-fit): a field of lit cubes, some glowing, under a slowly turning camera,
 * through a `PostStack` with TAA, bloom and a LUT (god rays off, the rest of the defaults). Measures `?frames=`
 * frames (default 240) after a 60-frame warm-up and publishes medians on `window.__harnessPostFit`.
 * Run it at the size to measure (iPad: a 2360×1640 viewport at device scale 1); `?scale=` sets the
 * renderer's resolution scale; `?taa=fast` runs TAA's cheaper path (`quality: 'fast'`) and
 * `?taa=off` turns it off (ws/actor-post-fit). `?variants=1` also runs a second stack each frame into an offscreen
 * `rgba16float` target with the ws/post-fit options (a composite hook with a texture and a buffer,
 * linear output, a half-float LUT, no emissive add), so their WGSL compiles on a real GPU
 * (`gpuErrors`). Nothing here is engine code.
 */
import { GameLoop } from '@thunderclap-engine/engine/core';
import { boot } from '@thunderclap-engine/engine/platform';
import { createLutTexture, PostStack } from '@thunderclap-engine/engine/post';
import {
  Camera,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  type PostInputs,
  type PostProcessor,
  Renderer,
  type SceneTargetViewport,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap-engine/engine/render';
import type { HarnessPostFitApi, HarnessPostFitState } from './post-fit-state';

const root = document.getElementById('root') as HTMLElement;
const params = new URLSearchParams(location.search);
const FRAMES = Number(params.get('frames')) || 240;
const WARMUP = 60;
const SCENE_PASSES = new Set(['pre', 'scene', 'shadow', 'shadows']);

const state: HarnessPostFitState = {
  ready: false,
  gpu: 'pending',
  done: false,
  width: 0,
  height: 0,
  frames: 0,
  gpuMs: null,
  postGpuMs: null,
  passes: {},
  cpuMs: 0,
  bindGroupsPerFrame: 0,
  gpuErrors: 0,
};
const api: HarnessPostFitApi = { state };
window.__harnessPostFit = api;

/** A unit cube: 24 vertices (a normal per face), 36 indices, white (12 floats a vertex). */
function cubeGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const axes = [
    [0, 0, 1, 1, 0, 0, 0, 1, 0],
    [0, 0, -1, -1, 0, 0, 0, 1, 0],
    [1, 0, 0, 0, 0, -1, 0, 1, 0],
    [-1, 0, 0, 0, 0, 1, 0, 1, 0],
    [0, 1, 0, 1, 0, 0, 0, 0, -1],
    [0, -1, 0, 1, 0, 0, 0, 0, 1],
  ];
  const vertices = new Float32Array(24 * 12);
  const indices = new Uint16Array(36);
  let v = 0;
  let i = 0;
  for (const a of axes) {
    const base = v / 12;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      for (let k = 0; k < 3; k++) vertices[v + k] = (a[k]! + sx * a[3 + k]! + sy * a[6 + k]!) * 0.5;
      vertices[v + 3] = a[0]!;
      vertices[v + 4] = a[1]!;
      vertices[v + 5] = a[2]!;
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

/** Lit by a fixed direction; `params.x` > 0 glows (emissive), so bloom has something to spread. */
const CUBE_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let k = 0.25 + 0.75 * max(dot(n, normalize(vec3f(0.4, 0.8, 0.3))), 0.0);
  var o: FragOut;
  o.color = vec4f(in.color.rgb * k, 1.0);
  o.emissive = vec4f(in.color.rgb * in.params.x, 1.0);
  return o;
}`;

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}

async function main(): Promise<void> {
  const res = await boot(root, {
    title: 'Engine post cost',
    logicalWidth: 2360,
    logicalHeight: 1640,
    maxPixels: 2360 * 1640,
  });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  const device = gpu.device;
  installGpuErrorLogging(device);
  // Count bind groups the frame creates.
  let groups = 0;
  const createBindGroup = device.createBindGroup.bind(device);
  device.createBindGroup = (d: GPUBindGroupDescriptor) => {
    groups++;
    return createBindGroup(d);
  };
  const renderer = new Renderer(gpu, { logicalWidth: 2360, logicalHeight: 1640 });
  const scale = Number(params.get('scale')) || 1;
  if (scale !== 1) renderer.setResolution({ scale });
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));
  renderer.timingEvery = 1;

  const post = new PostStack(renderer, {
    taa: {
      enabled: params.get('taa') !== 'off',
      quality: params.get('taa') === 'fast' ? 'fast' : 'full',
    },
    bloom: { enabled: true },
    godRays: { enabled: false },
    lut: { size: 16, intensity: 1 },
  });
  post.set({
    lut: { texture: createLutTexture(device, 16, (r, g, b) => [r * 0.9 + b * 0.1, g, b]) },
  });
  renderer.post = post;
  if (params.get('variants') === '1') {
    const hookBuf = device.createBuffer({
      label: 'post-fit-hook-buf',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(hookBuf, 0, new Float32Array([0.9, 1, 1.1, 0]));
    const variant = new PostStack(
      renderer,
      {
        taa: { enabled: true, quality: 'fast' },
        bloom: { enabled: true, emissiveAdd: 0 },
        godRays: { enabled: false },
      },
      {
        format: 'rgba16float',
        toSrgb: false,
        hook: {
          wgsl: /* wgsl */ `
@group(0) @binding(16) var<storage, read> hookBuf0: array<vec4f>;
fn post_hook(uv: vec2f, c: vec3f) -> vec3f {
  let t = textureSampleLevel(hookTex0, samp, uv, 0.0).rgb;
  return c * hookBuf0[0].xyz * t;
}`,
          textures: 1,
          buffers: [hookBuf],
        },
      },
    );
    variant.set({
      lut: {
        size: 16,
        intensity: 1,
        texture: createLutTexture(device, 16, (r, g, b) => [g, r, b], 'rgba16float'),
      },
    });
    let offscreen: GPUTexture | null = null;
    const pair: PostProcessor = {
      resize(w, h) {
        post.resize(w, h);
        variant.resize(w, h);
      },
      encode(
        encoder: GPUCommandEncoder,
        inputs: PostInputs,
        output: GPUTextureView,
        viewport?: SceneTargetViewport,
      ) {
        post.encode(encoder, inputs, output, viewport);
        const w = inputs.color.width;
        const h = inputs.color.height;
        if (!offscreen || offscreen.width !== w || offscreen.height !== h) {
          offscreen?.destroy();
          offscreen = device.createTexture({
            label: 'post-fit-variant-out',
            size: [w, h],
            format: 'rgba16float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          });
        }
        variant.encode(encoder, inputs, offscreen.createView());
      },
    };
    renderer.post = pair;
  }

  const camera = Camera.perspective((60 * Math.PI) / 180, 2360 / 1640, 0.1, 200);
  renderer.camera = camera;
  const mat = renderer.createMaterial({ label: 'post-fit', blend: 'opaque', wgsl: CUBE_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const items: { t: Transform; p: InstanceParams }[] = [];
  let seed = 7;
  const rand = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let z = -12; z <= 12; z++) {
    for (let x = -12; x <= 12; x++) {
      const h = 0.5 + rand() * 3;
      const t = new Transform({ x: x * 2.2, y: h / 2 - 1, z: z * 2.2 });
      t.setScale(1.4, h, 1.4);
      const glow = rand() < 0.12 ? 2 : 0;
      items.push({
        t,
        p: {
          tint: [0.3 + rand() * 0.7, 0.3 + rand() * 0.7, 0.3 + rand() * 0.7, 1],
          params: [glow, 0, 0, 0],
        },
      });
    }
  }

  const gpuAll: number[] = [];
  const gpuPost: number[] = [];
  const cpu: number[] = [];
  const passSamples: Record<string, number[]> = {};
  let frame = 0;
  let groupsMeasured = 0;
  renderer.onGpuTime((ms) => {
    if (frame <= WARMUP || state.done) return;
    gpuAll.push(ms);
    let p = 0;
    for (const [label, t] of Object.entries(renderer.timing.passes)) {
      const list = passSamples[label] ?? [];
      passSamples[label] = list;
      list.push(t);
      if (!SCENE_PASSES.has(label)) p += t;
    }
    gpuPost.push(p);
  });

  state.gpu = 'ok';
  state.ready = true;
  const loop = new GameLoop({
    update() {},
    render(_alpha, time) {
      frame++;
      const a = frame * 0.004;
      camera.lookAt([Math.cos(a) * 30, 14, Math.sin(a) * 30], [0, 0, 0]);
      const g0 = groups;
      const t0 = performance.now();
      const f = renderer.beginFrame(time.realTime, time.frameDt);
      f.clear(0.02, 0.03, 0.06);
      for (const it of items) f.mesh(cube, mat, it.t, it.p);
      renderer.endFrame();
      const dt = performance.now() - t0;
      if (frame > WARMUP && !state.done) {
        cpu.push(dt);
        groupsMeasured += groups - g0;
        state.frames++;
        if (state.frames >= FRAMES) {
          state.width = renderer.width;
          state.height = renderer.height;
          state.gpuMs = gpuAll.length ? median(gpuAll) : null;
          state.postGpuMs = gpuPost.length ? median(gpuPost) : null;
          for (const [k, v] of Object.entries(passSamples)) state.passes[k] = median(v);
          state.cpuMs = median(cpu);
          state.bindGroupsPerFrame = groupsMeasured / state.frames;
          state.gpuErrors = gpuDiagnostics.errorCount;
          state.done = true;
        }
      }
    },
  });
  res.onDeviceLost(() => loop.stop());
  loop.start();
}

main().catch((e: unknown) => {
  state.gpu = e instanceof Error ? e.message : String(e);
  state.ready = true;
});

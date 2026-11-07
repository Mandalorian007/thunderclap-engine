/**
 * fx-4 demo page (ws/fx-4): seeded effects and decals on the depth hook, one mode per load.
 * Noun-free; nothing here is engine code. A probe wraps the post stack: after it runs, a
 * fullscreen pass samples the scene colour into a small `rgba8unorm` target that is read back,
 * so the numbers in `fx4-state.ts` come from this frame's pixels.
 *
 * - `?seed=N` (default 1): an effect from `createEffect(..., { random: createRandom(N) })`
 *   stepped exactly 1/60 s per frame for 120 frames, then frozen. `state.hash` hashes a
 *   256×144 readback of a frame after the freeze: the same seed gives the same picture on
 *   every load, another seed a different one.
 * - `?decalLag`: a cube sliding 0.08 units a frame under a static box decal stamped on its
 *   front face. `state.lagPx` counts the decal's colour outside the cube's front face on one
 *   probe row: 0 on the depth hook (`readsDepth`, the default); `&copy` takes the
 *   `readsDepth: false` fallback (last frame's depth) and the decal trails the cube.
 */
import { createRandom, GameLoop } from '@thunderclap-engine/engine/core';
import { createEffect, Decals, type EffectDesc } from '@thunderclap-engine/engine/fx';
import { boot } from '@thunderclap-engine/engine/platform';
import { PostStack } from '@thunderclap-engine/engine/post';
import {
  Camera,
  type CameraPoint,
  type FullscreenPass,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  type PostInputs,
  type PostProcessor,
  Renderer,
  type SceneTargetViewport,
  type Texture,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap-engine/engine/render';
import type { Fx4Mode, HarnessFx4Api, HarnessFx4State } from './fx4-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const query = new URLSearchParams(location.search);
const mode: Fx4Mode = query.has('decalLag') ? 'decalLag' : 'seed';
const SEED = Math.floor(Number(query.get('seed') ?? 1)) || 1;
const READS_DEPTH = !query.has('copy');
/** Effect steps before the freeze. */
const STEPS = 120;
const CLEAR = [0.05, 0.07, 0.12] as const;

const state: HarnessFx4State = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  mode,
  readbacks: 0,
  gpuErrors: 0,
  seed: SEED,
  steps: 0,
  hash: null,
  lit: 0,
  readsDepth: READS_DEPTH,
  decalMode: null,
  lagPx: 0,
  lagMax: 0,
  decalPx: 0,
  decalMin: Number.POSITIVE_INFINITY,
};
const api: HarnessFx4Api = { state };
window.__harnessFx4 = api;

// ------------------------------------------------------------------ the probe

/** The probe target: 256×144 texels for `?seed`, one row of 512 for `?decalLag`. */
const PROBE_W = mode === 'seed' ? 256 : 512;
const PROBE_H = mode === 'seed' ? 144 : 1;
const PROBE_ROW_BYTES = PROBE_W * 4;
const PROBE_WGSL = /* wgsl */ `
struct Probe { rect: vec4f, size: vec4f };
@group(0) @binding(0) var<uniform> probe: Probe;
@group(0) @binding(1) var probe_sampler: sampler;
@group(0) @binding(2) var color_tex: texture_2d<f32>;
@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let t = in.pos.xy / probe.size.xy;
  let uv = mix(probe.rect.xy, probe.rect.zw, t);
  return textureSampleLevel(color_tex, probe_sampler, uv, 0.0);
}`;

/**
 * Wraps the post stack: after it runs, samples the scene colour over `rect` (uv) into the
 * probe target and copies it into a mappable buffer; `read()` maps it after the submit and
 * hands back the bytes with the `tag` set when that frame's copy was encoded.
 */
class ProbePost implements PostProcessor {
  /** u0, v0, u1, v1, then the probe size. */
  readonly uniforms = new Float32Array([0, 0, 1, 1, PROBE_W, PROBE_H, 0, 0]);
  /** Set by the page before `endFrame`; carried with the readback of that frame. */
  tag = 0;
  readonly bytes = new Uint8Array(PROBE_ROW_BYTES * PROBE_H);
  private readonly pass: FullscreenPass;
  private readonly target: Texture;
  private readonly buffer: GPUBuffer;
  private mapping = false;
  private copied = false;
  private copiedTag = 0;

  constructor(
    renderer: Renderer,
    private readonly inner: PostStack,
  ) {
    this.pass = renderer.createFullscreenPass({
      label: 'fx4-probe',
      wgsl: PROBE_WGSL,
      targets: ['rgba8unorm'],
      uniformBytes: 32,
      textures: 1,
      sampler: 'nearest-clamp',
    });
    this.target = renderer.createRenderTarget({
      width: PROBE_W,
      height: PROBE_H,
      format: 'rgba8unorm',
      label: 'fx4-probe',
    });
    this.buffer = renderer.device.createBuffer({
      label: 'fx4-probe-readback',
      size: PROBE_ROW_BYTES * PROBE_H,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  resize(width: number, height: number): void {
    this.inner.resize(width, height);
  }

  encode(
    encoder: GPUCommandEncoder,
    inputs: PostInputs,
    output: GPUTextureView,
    viewport?: SceneTargetViewport,
  ): void {
    this.inner.encode(encoder, inputs, output, viewport);
    if (this.mapping || this.copied) return;
    this.pass.setUniforms(this.uniforms);
    this.pass.setTexture(0, inputs.color);
    this.pass.encode(encoder, this.target.view);
    encoder.copyTextureToBuffer(
      { texture: this.target.texture },
      { buffer: this.buffer, bytesPerRow: PROBE_ROW_BYTES },
      { width: PROBE_W, height: PROBE_H },
    );
    this.copied = true;
    this.copiedTag = this.tag;
  }

  /** After the frame's submit: map the readback when one was encoded. */
  read(done: (bytes: Uint8Array, tag: number) => void): void {
    if (!this.copied || this.mapping) return;
    this.mapping = true;
    const tag = this.copiedTag;
    this.buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        this.bytes.set(new Uint8Array(this.buffer.getMappedRange()));
        this.buffer.unmap();
        this.mapping = false;
        this.copied = false;
        done(this.bytes, tag);
      },
      () => {
        this.mapping = false;
        this.copied = false;
      },
    );
  }
}

/** FNV-1a over `bytes`, as 8 hex digits. */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

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

/** Flat colour: the vertex colour × tint, unlit, so the probe can classify pixels exactly. */
const FLAT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  var o: FragOut;
  o.color = vec4f(in.color.rgb, 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

/** A white canvas: the decal's whole atlas, tinted by its colour. */
function whiteCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 4;
  const g = c.getContext('2d');
  if (!g) throw new Error('no 2d context');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 4, 4);
  return c;
}

// ------------------------------------------------------------------ the seeded effect

/** Two world-space systems, bursts and a stream, no sub-emitters (their order is atomic). */
const SEEDED: EffectDesc = {
  duration: 1,
  loop: true,
  systems: [
    {
      name: 'burst',
      options: { space: 'world', blend: 'additive', capacity: 2048 },
      emitters: [
        {
          burst: 160,
          params: {
            x: 0,
            y: 0,
            z: 0,
            shape: { kind: 'sphere', radius: 0.4 },
            angle: Math.PI / 2,
            spread: Math.PI,
            speed: [0.6, 2.4],
            life: [1.5, 3],
            size: [0.09, 0.03],
            colorStart: [1, 0.55, 0.2, 1],
            colorEnd: [0.6, 0.1, 0.4, 0],
            gravity: [0, -0.6, 0],
            drag: 0.6,
          },
        },
      ],
    },
    {
      name: 'stream',
      options: { space: 'world', blend: 'additive', capacity: 2048 },
      emitters: [
        {
          rate: 90,
          params: {
            x: 0,
            y: -1,
            z: 0,
            shape: { kind: 'box', width: 3, height: 0.1, depth: 0.5 },
            angle: Math.PI / 2,
            spread: 0.6,
            speed: [0.8, 1.6],
            life: [1, 2],
            size: [0.06, 0.02],
            colorStart: [0.2, 0.7, 1, 1],
            colorEnd: [0.1, 0.2, 0.9, 0],
            gravity: [0, 0.2, 0],
            drag: 0.3,
          },
        },
      ],
    },
  ],
};

// ------------------------------------------------------------------ the decal scene

/** World units the cube slides per frame, and its turning points (a triangle wave). */
const SLIDE = 0.08;
const SLIDE_STEPS = 7;
/** The cube's front face (z) and the camera straight in front of it. */
const FRONT_Z = 0.5;
const EYE = [0, 0, 6] as const;

const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine fx-4 demo' });
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
  const post = new ProbePost(renderer, new PostStack(renderer, { bloom: { enabled: false } }));
  renderer.post = post;

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  camera.lookAt(EYE, [0, 0, 0]);
  renderer.camera = camera;

  let render: (frameIndex: number) => void;

  if (mode === 'seed') {
    const effect = createEffect(renderer, SEEDED, { random: createRandom(SEED) });
    effect.play({ x: 0, y: 0.4, z: 0 });
    render = (f) => {
      // Exactly one fixed step a frame, whatever the display rate; then frozen.
      if (state.steps < STEPS) {
        effect.update(1 / 60);
        state.steps++;
      } else {
        effect.update(0);
      }
      post.tag = state.steps >= STEPS && f > STEPS + 2 ? 1 : 0;
      const frame = renderer.beginFrame(f / 60, 1 / 60);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      effect.draw(frame, 1);
      renderer.endFrame();
      post.read((bytes, tag) => {
        state.readbacks++;
        if (!tag) return;
        let lit = 0;
        for (let i = 0; i < bytes.length; i += 4) {
          if (bytes[i]! + bytes[i + 1]! + bytes[i + 2]! > 3 * 40) lit++;
        }
        state.lit = lit;
        state.hash = fnv1a(bytes);
      });
    };
  } else {
    const flat = renderer.createMaterial({ label: 'flat', blend: 'opaque', wgsl: FLAT_WGSL });
    const cube = renderer.createMesh({
      ...cubeGeometry(),
      layout: VERTEX_LAYOUT_3D,
      label: 'cube',
    });
    const cubeT = new Transform({ x: 0, y: 0, z: 0 });
    const cubeP: InstanceParams = { tint: [0.8, 0.1, 0.1, 1] };
    const decals = new Decals(renderer, {
      texture: renderer.textureFromSource(whiteCanvas(), 'fx4-white'),
      readsDepth: READS_DEPTH,
      mode: 'box',
      normalBias: 0.5,
    });
    decals.add({ x: 0, y: 0, z: FRONT_Z, nx: 0, ny: 0, nz: 1, size: 2.5, color: [0, 1, 0, 1] });
    // The probe row runs through the cube's centre, edge to edge.
    camera.worldToScreen(0, 0, FRONT_Z, probePoint);
    const v = probePoint.y / LOGICAL.height;
    post.uniforms.set([0, v, 1, v]);
    /** Cube x of the frame each readback was taken in, by tag. */
    const xs = new Float64Array(64);
    let step = 0;
    let dir = 1;
    render = (f) => {
      step += dir;
      if (Math.abs(step) >= SLIDE_STEPS) dir = -dir;
      const x = step * SLIDE;
      cubeT.setPosition(x, 0, 0);
      xs[f % xs.length] = x;
      post.tag = f;
      const frame = renderer.beginFrame(f / 60, 1 / 60);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      frame.mesh(cube, flat, cubeT, cubeP);
      frame.drawable(decals, 1);
      renderer.endFrame();
      state.decalMode = decals.activeMode;
      post.read((bytes, tag) => {
        state.readbacks++;
        if (tag < 3) return; // the first frames have no depth to read yet
        const cx = xs[tag % xs.length]!;
        // The cube's front face on the row, in probe texels, one texel of margin each side.
        camera.worldToScreen(cx - 0.5, 0, FRONT_Z, probePoint);
        const left = (probePoint.x / LOGICAL.width) * PROBE_W - 1;
        camera.worldToScreen(cx + 0.5, 0, FRONT_Z, probePoint);
        const right = (probePoint.x / LOGICAL.width) * PROBE_W + 1;
        let outside = 0;
        let inside = 0;
        for (let i = 0; i < PROBE_W; i++) {
          const o = i * 4;
          const green = bytes[o + 1]! > 128 && bytes[o]! < 80 && bytes[o + 2]! < 80;
          if (!green) continue;
          const c = i + 0.5;
          if (c < left || c > right) outside++;
          else inside++;
        }
        const scale = LOGICAL.width / PROBE_W;
        state.lagPx = outside * scale;
        state.decalPx = inside * scale;
        state.lagMax = Math.max(state.lagMax, state.lagPx);
        state.decalMin = Math.min(state.decalMin, state.decalPx);
      });
    };
  }

  const loop = new GameLoop({
    update() {},
    render() {
      render(state.frames);
      state.frames++;
      state.gpuErrors = gpuDiagnostics.errorCount;
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

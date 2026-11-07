/**
 * Render 5 page (ws/render-5): compressed textures, per-instance LOD and the standard
 * material's dissolve on the raw renderer, one mode per flag. Noun-free: the geometry, the
 * lights and the probes are what a game would write.
 *
 * - `?ktx2`: the page builds a 64×64 BC1 KTX2 file in memory (seven mips, one solid colour per
 *   level) and uploads it with `uploadKtx2` onto a turning cube, on the device `boot` made
 *   (`initGpu` asks for every compression feature the adapter has, ws/render-6). Without BC the
 *   typed error is caught: `state.error` names the format and the caps.
 * - `?lod`: 200 rocks (an icosphere chain from `createLodChain`) on a grid running away from the
 *   camera, drawn through one `MeshLod`: `state.lodCounts` and `state.drawCalls` (one draw per
 *   non-empty level). `&instanced` (ws/render-6): the same rocks in one `InstanceList` built on
 *   the `MeshLod`, bucketed per level: `state.instancedDraws` (one draw per non-empty level).
 * - `?dissolve`: a sphere over a ground plane under a shadowing sun, its dissolve amount
 *   cycling 0 → 1 (`state.amount`); the shadow loses the same pixels.
 * - `?mask` (ws/render-6): a checkered `alphaMode: 'mask'` quad and a solid quad held over a
 *   ground plane under a slanted sun, seen from above. A probe after the post stack samples a
 *   32×32 grid inside the masked quad's shadow and one texel each of lit and solid-shadowed
 *   ground: `state.shadowHolePx` counts the grid samples brighter than halfway between the two
 *   (light through the mask's holes).
 * - `?still`: freeze motion (the cube's turn, the dissolve's cycle at 0.5) for screenshots.
 */

import { parseKtx2 } from '@thunderclap-engine/engine/assets';
import { GameLoop } from '@thunderclap-engine/engine/core';
import { box, createLodChain, icosphere, plane } from '@thunderclap-engine/engine/geom';
import { boot } from '@thunderclap-engine/engine/platform';
import { PostStack } from '@thunderclap-engine/engine/post';
import {
  Camera,
  type CameraPoint,
  CompressedTextureError,
  createStandardMaterial,
  type FullscreenPass,
  gpuDiagnostics,
  type InstanceList,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  type Material,
  type Mesh,
  type MeshLod,
  type PostInputs,
  type PostProcessor,
  Renderer,
  type SceneTargetViewport,
  STANDARD_DISSOLVE_OFFSET,
  type Texture,
  Transform,
  uploadKtx2,
} from '@thunderclap-engine/engine/render';
import type { HarnessRender5Api, HarnessRender5State, Render5Mode } from './render5-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const query = new URLSearchParams(location.search);
const mode: Render5Mode = query.has('ktx2')
  ? 'ktx2'
  : query.has('dissolve')
    ? 'dissolve'
    : query.has('mask')
      ? 'mask'
      : 'lod';
const still = query.has('still');
const instanced = mode === 'lod' && query.has('instanced');

const state: HarnessRender5State = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  mode,
  still,
  instanced,
  caps: { bc: false, etc2: false, astc: false },
  format: null,
  uploaded: false,
  mipLevels: 0,
  error: null,
  lodCounts: [],
  drawCalls: 0,
  instances: 0,
  amount: 0,
  instancedDraws: 0,
  shadowHolePx: 0,
  shadowDarkPx: 0,
  shadowSamples: 0,
  litRef: 0,
  darkRef: 0,
  readbacks: 0,
  gpuErrors: 0,
};

let pinnedAmount: number | null = still ? 0.5 : null;
const api: HarnessRender5Api = {
  state,
  setAmount(amount) {
    pinnedAmount = Math.min(1, Math.max(0, amount));
  },
};
window.__harnessRender5 = api;

// ------------------------------------------------------------------ an in-page KTX2 file

/** BC1 (VkFormat 132, BC1_RGB_SRGB_BLOCK) KTX2 bytes: `size`² px, a full mip chain, each level one solid RGB565 colour. */
function bc1Ktx2(size: number, colours: readonly number[]): Uint8Array {
  const levels: Uint8Array[] = [];
  for (let s = size, i = 0; s >= 1; s >>= 1, i++) {
    const blocks = Math.ceil(s / 4) ** 2;
    const data = new Uint8Array(blocks * 8);
    const c = colours[i % colours.length]!;
    for (let b = 0; b < blocks; b++) {
      // color0 = color1 = c, every index 0: the block is c.
      data[b * 8] = c & 0xff;
      data[b * 8 + 1] = c >> 8;
      data[b * 8 + 2] = c & 0xff;
      data[b * 8 + 3] = c >> 8;
    }
    levels.push(data);
  }
  const HEADER = 80;
  const INDEX = 24;
  let at = HEADER + levels.length * INDEX;
  const offsets = levels.map((l) => {
    const o = at;
    at += l.byteLength;
    return o;
  });
  const out = new Uint8Array(at);
  out.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(out.buffer);
  dv.setUint32(12, 132, true); // vkFormat
  dv.setUint32(16, 1, true); // typeSize
  dv.setUint32(20, size, true);
  dv.setUint32(24, size, true);
  dv.setUint32(36, 1, true); // faces
  dv.setUint32(40, levels.length, true);
  for (let i = 0; i < levels.length; i++) {
    dv.setUint32(HEADER + i * INDEX, offsets[i]!, true);
    dv.setUint32(HEADER + i * INDEX + 8, levels[i]!.byteLength, true);
    dv.setUint32(HEADER + i * INDEX + 16, levels[i]!.byteLength, true);
    out.set(levels[i]!, offsets[i]!);
  }
  return out;
}

// RGB565: orange, teal, violet, then greys (the far mips).
const LEVEL_COLOURS = [0xfc00, 0x0410 | 0x001f, 0x801f, 0x8410, 0x630c, 0x4208, 0x2104];

// ------------------------------------------------------------------ ?mask: the shadow probe

/** The probe grid's side, and the probe target: the grid, then one row of two references. */
const GRID = 32;
const PROBE_ROW_BYTES = GRID * 8;
const PROBE_WGSL = /* wgsl */ `
struct Probe { rect: vec4f, refs: vec4f };
@group(0) @binding(0) var<uniform> probe: Probe;
@group(0) @binding(1) var probe_sampler: sampler;
@group(0) @binding(2) var color_tex: texture_2d<f32>;
@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  var uv = mix(probe.rect.xy, probe.rect.zw, in.pos.xy / ${GRID}.0);
  if (u32(in.pos.y) >= ${GRID}u) { uv = select(probe.refs.xy, probe.refs.zw, u32(in.pos.x) == 1u); }
  return textureSampleLevel(color_tex, probe_sampler, uv, 0.0);
}`;

/** IEEE half → number. */
function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? Number.NaN : s * Number.POSITIVE_INFINITY;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

/**
 * Wraps the post stack: after it runs, a fullscreen pass samples the scene colour on a grid
 * over `rect` (uv, y down) and at the two reference uvs into a GRID × (GRID + 1)
 * `rgba16float` target, copied into a mappable buffer that `read()` maps after the submit.
 */
class ShadowProbe implements PostProcessor {
  readonly wantsJitter = false;
  /** Grid rect (u0, v0, u1, v1), then the lit and the dark reference uvs. */
  readonly uv = new Float32Array(8);
  /** Luminance of the last readback, GRID × (GRID + 1) texels. */
  readonly luma = new Float32Array(GRID * (GRID + 1));
  private readonly pass: FullscreenPass;
  private readonly target: Texture;
  private readonly buffer: GPUBuffer;
  private readonly raw = new Uint16Array(GRID * (GRID + 1) * 4);
  private mapping = false;
  private copied = false;

  constructor(
    renderer: Renderer,
    private readonly inner: PostStack,
  ) {
    this.pass = renderer.createFullscreenPass({
      label: 'render5-shadow-probe',
      wgsl: PROBE_WGSL,
      targets: ['rgba16float'],
      uniformBytes: 32,
      textures: 1,
      sampler: 'nearest-clamp',
    });
    this.target = renderer.createRenderTarget({
      width: GRID,
      height: GRID + 1,
      format: 'rgba16float',
      label: 'render5-shadow-probe',
    });
    this.buffer = renderer.device.createBuffer({
      label: 'render5-shadow-probe-readback',
      size: PROBE_ROW_BYTES * (GRID + 1),
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
    if (this.mapping) return;
    this.pass.setUniforms(this.uv);
    this.pass.setTexture(0, inputs.color);
    this.pass.encode(encoder, this.target.view);
    encoder.copyTextureToBuffer(
      { texture: this.target.texture },
      { buffer: this.buffer, bytesPerRow: PROBE_ROW_BYTES },
      { width: GRID, height: GRID + 1 },
    );
    this.copied = true;
  }

  /** After the frame's submit: map the readback when one was encoded; `done` on arrival. */
  read(done: () => void): void {
    if (!this.copied || this.mapping) return;
    this.copied = false;
    this.mapping = true;
    this.buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        this.raw.set(new Uint16Array(this.buffer.getMappedRange()));
        this.buffer.unmap();
        const raw = this.raw;
        for (let i = 0; i < this.luma.length; i++) {
          const o = i * 4;
          this.luma[i] =
            (halfToFloat(raw[o]!) + halfToFloat(raw[o + 1]!) + halfToFloat(raw[o + 2]!)) / 3;
        }
        this.mapping = false;
        done();
      },
      () => {
        this.mapping = false;
      },
    );
  }
}

/** `?mask`: the quads' height, the slanted sun (+x by one per unit down) and the probe area. */
const MASK_HEIGHT = 2.5;
const MASK_SUN: [number, number, number] = [1, -1, 0];
/** The masked quad's shadow lands centred on the origin, the solid quad's at z = 2.6. */
const MASK_QUAD_X = -MASK_HEIGHT;
const SOLID_Z = 2.6;
/** Half the side of the grid probed inside the masked shadow (the quad's half-side is 1). */
const PROBE_HALF = 0.8;
const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

/** A checkered alpha texture: 4 × 4 cells, alternate cells transparent. */
function checkerAlpha(): Uint8Array<ArrayBuffer> {
  const n = 64;
  const data = new Uint8Array(new ArrayBuffer(n * n * 4));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4;
      const on = ((x >> 4) + (y >> 4)) % 2 === 0;
      data[o] = 230;
      data[o + 1] = 120;
      data[o + 2] = 60;
      data[o + 3] = on ? 255 : 0;
    }
  }
  return data;
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine render 5 demo' });
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
  state.caps = { ...renderer.caps.compressed };

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 400);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;

  // LOD thresholds as fractions of the target height, so every matrix row (a phone's short
  // backbuffer, a 1920 desktop's tall one) puts the near rocks on level 0 and the far on 2.
  const lodThresholds = [0, 0];
  const sizeLod = () => {
    const h = surface.backbuffer.height;
    lodThresholds[0] = 0.1 * h;
    lodThresholds[1] = 0.024 * h;
  };

  const lights = new Lights();
  lights.ambient.set([0.25, 0.27, 0.32]);
  lights.sun.direction = [-0.4, -1, -0.35];
  lights.sun.color = [1.1, 1.05, 0.95];

  const draws: { mesh: Mesh | MeshLod; material: Material; t: Transform; p?: InstanceParams }[] =
    [];
  let rocks: InstanceList | null = null;
  let probe: ShadowProbe | null = null;
  let spin: Transform | null = null;
  let dissolve: Material | null = null;
  const amountBuf = new Float32Array(1);

  if (mode === 'ktx2') {
    camera.lookAt([0, 1.2, 3.2], [0, 0, 0]);
    const cube = renderer.createMesh({ ...box({ size: 1.4 }), label: 'cube' });
    let tex = null;
    try {
      tex = uploadKtx2(renderer, parseKtx2(bc1Ktx2(64, LEVEL_COLOURS)), { label: 'bc1' });
      state.format = tex.format;
      state.mipLevels = tex.mipLevels;
      state.uploaded = true;
    } catch (e) {
      if (!(e instanceof CompressedTextureError)) throw e;
      state.format = e.format;
      state.error = e.message;
    }
    const mat = createStandardMaterial(renderer, {
      label: 'ktx2',
      ...(tex ? { baseColor: tex } : {}),
      metallic: 0,
      roughness: 0.7,
    });
    spin = new Transform();
    draws.push({ mesh: cube, material: mat, t: spin });
  } else if (mode === 'lod') {
    sizeLod();
    surface.onResize(sizeLod);
    camera.lookAt([0, 6, 14], [0, 0, -30]);
    const chain = createLodChain(icosphere({ radius: 1, subdivisions: 3 }), [0.25, 0.06]);
    const lod: MeshLod = {
      meshes: chain.map((g, i) => renderer.createMesh({ ...g, label: `rock-lod${i}` })),
      thresholdsPx: lodThresholds,
    };
    const mat = createStandardMaterial(renderer, { label: 'rock', metallic: 0, roughness: 0.9 });
    // `&instanced`: the rocks live in one list on the chain, each picking its own level.
    if (instanced) rocks = renderer.createInstanceList(lod, mat, 200);
    // 200 rocks: 10 across, 20 deep, every 4 units away from the camera.
    for (let i = 0; i < 200; i++) {
      const x = ((i % 10) - 4.5) * 4;
      const z = -Math.floor(i / 10) * 8;
      const t = new Transform({ x, y: 0, z }).setAxisAngle(0, 1, 0, i * 0.7);
      const p: InstanceParams = { tint: [0.55 + (i % 3) * 0.1, 0.5, 0.45, 1] };
      if (rocks) rocks.set(i, t, p);
      else draws.push({ mesh: lod, material: mat, t, p });
    }
  } else if (mode === 'mask') {
    // Seen from straight above, so the ground's probe grid is a screen rect.
    camera.lookAt([0, 9, 0.001], [0, 0, 0]);
    lights.sun.direction = MASK_SUN;
    lights.sun.color = [1.2, 1.15, 1.1];
    lights.ambient.set([0.12, 0.12, 0.14]);
    lights.sun.shadow = { extent: 8 };
    probe = new ShadowProbe(renderer, new PostStack(renderer, { bloom: { enabled: false } }));
    renderer.post = probe;
    const ground = renderer.createMesh({ ...plane({ size: 12 }), label: 'ground' });
    const quad = renderer.createMesh({ ...plane({ size: 2 }), label: 'quad' });
    const groundMat = createStandardMaterial(renderer, {
      label: 'ground',
      metallic: 0,
      roughness: 1,
    });
    const checker = renderer.textureFromPixels({
      width: 64,
      height: 64,
      data: checkerAlpha(),
      label: 'checker-alpha',
    });
    const masked = createStandardMaterial(renderer, {
      label: 'masked',
      baseColor: checker,
      sampler: 'nearest-mip-repeat',
      alphaMode: 'mask',
      alphaCutoff: 0.5,
      metallic: 0,
      roughness: 0.8,
    });
    const solid = createStandardMaterial(renderer, { label: 'solid', metallic: 0, roughness: 0.8 });
    draws.push({ mesh: ground, material: groundMat, t: new Transform() });
    draws.push({
      mesh: quad,
      material: masked,
      t: new Transform({ x: MASK_QUAD_X, y: MASK_HEIGHT }),
    });
    draws.push({
      mesh: quad,
      material: solid,
      t: new Transform({ x: MASK_QUAD_X, y: MASK_HEIGHT, z: SOLID_Z, scaleX: 0.5, scaleZ: 0.5 }),
      p: { tint: [0.3, 0.5, 0.9, 1] },
    });
  } else {
    camera.lookAt([0, 2.5, 5], [0, 0.6, 0]);
    lights.sun.shadow = { extent: 8 };
    const ground = renderer.createMesh({ ...plane({ size: 10 }), label: 'ground' });
    const ball = renderer.createMesh({
      ...icosphere({ radius: 1, subdivisions: 3 }),
      label: 'ball',
    });
    const groundMat = createStandardMaterial(renderer, {
      label: 'ground',
      metallic: 0,
      roughness: 1,
    });
    dissolve = createStandardMaterial(renderer, {
      label: 'dissolve',
      metallic: 0,
      roughness: 0.5,
      dissolve: { amount: 0, edgeColor: [3, 1.2, 0.2], edgeWidth: 0.06, noise: 5 },
    });
    draws.push({ mesh: ground, material: groundMat, t: new Transform() });
    draws.push({
      mesh: ball,
      material: dissolve,
      t: new Transform({ y: 1.1 }),
      p: { tint: [0.4, 0.6, 0.9, 1] },
    });
  }

  const loop = new GameLoop({
    update() {},
    render(_alpha, time) {
      const f = state.frames;
      if (spin && !still) spin.setAxisAngle(0, 1, 0, f * 0.01);
      if (dissolve) {
        const a = pinnedAmount ?? 0.5 - 0.5 * Math.cos(f * 0.02);
        amountBuf[0] = a;
        dissolve.setUniforms(amountBuf, STANDARD_DISSOLVE_OFFSET * 4);
        state.amount = a;
      }
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      for (const d of draws) frame.mesh(d.mesh, d.material, d.t, d.p);
      if (rocks) frame.list(rocks);
      if (probe) {
        // Grid corners and the two references, as uvs of the camera's logical screen.
        const uv = probe.uv;
        const at = (x: number, z: number, i: number) => {
          camera.worldToScreen(x, 0, z, probePoint);
          uv[i] = probePoint.x / LOGICAL.width;
          uv[i + 1] = probePoint.y / LOGICAL.height;
        };
        at(-PROBE_HALF, -PROBE_HALF, 0);
        at(PROBE_HALF, PROBE_HALF, 2);
        at(3.5, -3, 4); // lit ground, clear of both shadows
        at(0, SOLID_Z, 6); // the solid quad's shadow
      }
      renderer.endFrame();
      if (probe) {
        const p = probe;
        p.read(() => {
          const lit = p.luma[GRID * GRID]!;
          const dark = p.luma[GRID * GRID + 1]!;
          const mid = 0.5 * (lit + dark);
          let holes = 0;
          let shade = 0;
          for (let i = 0; i < GRID * GRID; i++) {
            if (p.luma[i]! > mid) holes++;
            else shade++;
          }
          state.litRef = lit;
          state.darkRef = dark;
          state.shadowHolePx = holes;
          state.shadowDarkPx = shade;
          state.shadowSamples = GRID * GRID;
          state.readbacks++;
        });
      }
      state.frames++;
      state.instancedDraws = rocks ? renderer.stats.drawCalls : 0;
      state.drawCalls = renderer.stats.drawCalls;
      state.instances = renderer.stats.instances;
      const lc = renderer.stats.lodCounts;
      if (state.lodCounts.length !== lc.length) state.lodCounts.length = lc.length;
      for (let i = 0; i < lc.length; i++) state.lodCounts[i] = lc[i]!;
      state.gpuErrors = gpuDiagnostics.errorCount;
    },
  });
  res.onDeviceLost(() => loop.stop());
  gpu.device.lost.then(() => loop.stop());
  loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});

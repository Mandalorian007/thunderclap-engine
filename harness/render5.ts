/**
 * Render 5 page (ws/render-5): compressed textures, per-instance LOD and the standard
 * material's dissolve on the raw renderer, one mode per flag. Noun-free: the geometry, the
 * lights and the probes are what a game would write.
 *
 * - `?ktx2`: the page builds a 64×64 BC1 KTX2 file in memory (seven mips, one solid colour per
 *   level), asks a fresh adapter for its compression features, and uploads the file with
 *   `uploadKtx2` onto a turning cube. Without BC the typed error is caught: `state.error` names
 *   the format and the caps.
 * - `?lod`: 200 rocks (an icosphere chain from `createLodChain`) on a grid running away from the
 *   camera, drawn through one `MeshLod`: `state.lodCounts` and `state.drawCalls` (one draw per
 *   non-empty level).
 * - `?dissolve`: a sphere over a ground plane under a shadowing sun, its dissolve amount
 *   cycling 0 → 1 (`state.amount`); the shadow loses the same pixels.
 * - `?still`: freeze motion (the cube's turn, the dissolve's cycle at 0.5) for screenshots.
 */

import { parseKtx2 } from '@thunderclap/engine/assets';
import { GameLoop } from '@thunderclap/engine/core';
import { box, createLodChain, icosphere, plane } from '@thunderclap/engine/geom';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  CompressedTextureError,
  compressionFeatures,
  createStandardMaterial,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  type Material,
  type Mesh,
  type MeshLod,
  Renderer,
  type RendererGpu,
  STANDARD_DISSOLVE_OFFSET,
  Transform,
  uploadKtx2,
} from '@thunderclap/engine/render';
import type { HarnessRender5Api, HarnessRender5State, Render5Mode } from './render5-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const query = new URLSearchParams(location.search);
const mode: Render5Mode = query.has('ktx2') ? 'ktx2' : query.has('dissolve') ? 'dissolve' : 'lod';
const still = query.has('still');

const state: HarnessRender5State = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  mode,
  still,
  caps: { bc: false, etc2: false, astc: false },
  format: null,
  uploaded: false,
  mipLevels: 0,
  error: null,
  lodCounts: [],
  drawCalls: 0,
  instances: 0,
  amount: 0,
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

/**
 * A device with every compression feature the adapter offers. An adapter hands out one device,
 * so the page asks for a second adapter instead of the one `boot` used.
 */
async function compressedGpu(base: RendererGpu): Promise<RendererGpu> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return base;
  const device = await adapter.requestDevice({ requiredFeatures: compressionFeatures(adapter) });
  base.context.configure({ device, format: base.format, alphaMode: 'opaque' });
  return { device, context: base.context, format: base.format };
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine render 5 demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface } = res;
  const gpu = mode === 'ktx2' ? await compressedGpu(res.gpu) : res.gpu;
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
  lights.sun.dir = [-0.4, -1, -0.35];
  lights.sun.color = [1.1, 1.05, 0.95];

  const draws: { mesh: Mesh | MeshLod; material: Material; t: Transform; p?: InstanceParams }[] =
    [];
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
    // 200 rocks: 10 across, 20 deep, every 4 units away from the camera.
    for (let i = 0; i < 200; i++) {
      const x = ((i % 10) - 4.5) * 4;
      const z = -Math.floor(i / 10) * 8;
      draws.push({
        mesh: lod,
        material: mat,
        t: new Transform({ x, y: 0, z }).setAxisAngle(0, 1, 0, i * 0.7),
        p: { tint: [0.55 + (i % 3) * 0.1, 0.5, 0.45, 1] },
      });
    }
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
      renderer.endFrame();
      state.frames++;
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

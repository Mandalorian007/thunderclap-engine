/**
 * Assets demo page (harness/assets.html): a 12-entry manifest served from an in-memory map (PNGs
 * encoded in the page, a GLB from gltf-writer.ts, a WAV, a JSON and a text) goes through
 * `createBundle` with a `read` that never touches the network; a progress bar follows
 * `progress`, and the packed atlas is drawn as sprites by the 2D renderer with its uv rects.
 * `?slow` delays each read 50–200 ms, `?fail=one` makes one read throw, `?cancel` cancels after
 * the first asset.
 */
import {
  type BundleProgress,
  createBundle,
  defineManifest,
  type ReadResult,
} from '@thunderclap-engine/engine/assets';
import { GameLoop } from '@thunderclap-engine/engine/core';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  type DrawParams,
  gpuDiagnostics,
  installGpuErrorLogging,
  type Material,
  Renderer,
} from '@thunderclap-engine/engine/render';
import type { HarnessAssetsState } from './assets-state';
import { buildSampleGlb, encodePng } from './gltf-writer';

const root = document.getElementById('root') as HTMLElement;
const fill = document.getElementById('fill') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const CLEAR = [0.05, 0.07, 0.12] as const;
const params = new URLSearchParams(location.search);

const state: HarnessAssetsState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  flags: {
    slow: params.has('slow') || params.has('cancel'),
    fail: params.get('fail'),
    cancel: params.has('cancel'),
  },
  progress: { loaded: 0, failed: 0, total: 0, bytes: 0, bytesTotal: null, fraction: 0 },
  loaded: [],
  errors: [],
  atlasSize: { width: 0, height: 0 },
  rectCount: 0,
  spritePixel: { x: 0, y: 0, name: 'red', color: [220, 40, 40] },
  decoded: {
    json: null,
    text: null,
    bytes: 0,
    audioFrames: 0,
    gltfMeshes: 0,
    textureArrayLayers: 0,
    imageWidth: 0,
  },
  reads: 0,
  done: false,
  settled: false,
  loadError: null,
  cancelled: false,
  gpuErrors: 0,
};
window.__harnessAssets = { state };

// ------------------------------------------------------------------ the "files" (built here)

type Rgba = readonly [number, number, number, number];
const SPRITES: Record<string, { w: number; h: number; color: Rgba }> = {
  red: { w: 32, h: 32, color: [220, 40, 40, 255] },
  green: { w: 24, h: 40, color: [40, 200, 60, 255] },
  blue: { w: 48, h: 16, color: [40, 80, 230, 255] },
  yellow: { w: 20, h: 20, color: [240, 220, 40, 255] },
  magenta: { w: 12, h: 12, color: [220, 40, 200, 255] },
  cyan: { w: 36, h: 28, color: [40, 210, 220, 255] },
};

function pngBlob(w: number, h: number, color: Rgba): Blob {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set(color, i * 4);
  const png = encodePng(w, h, rgba);
  return new Blob([png.slice().buffer as ArrayBuffer], { type: 'image/png' });
}

/** 0.1 s of a 440 Hz sine, 16-bit mono PCM at 8 kHz. */
function wav(): ArrayBuffer {
  const rate = 8000;
  const frames = 800;
  const buf = new ArrayBuffer(44 + frames * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + frames * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    v.setInt16(44 + i * 2, Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 12000), true);
  }
  return buf;
}

function buildFiles(): Map<string, ArrayBuffer | Blob> {
  const files = new Map<string, ArrayBuffer | Blob>();
  for (const [name, s] of Object.entries(SPRITES))
    files.set(`${name}.png`, pngBlob(s.w, s.h, s.color));
  files.set('orange.png', pngBlob(32, 32, [240, 140, 30, 255]));
  files.set('scene.glb', buildSampleGlb());
  files.set('blip.wav', wav());
  files.set('config.json', new TextEncoder().encode('{"lives":3,"title":"assets"}').buffer);
  files.set('credits.txt', new Blob(['made in the page']));
  files.set('raw.bin', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer);
  return files;
}

const manifest = defineManifest({
  tex: { kind: 'texture', uri: 'red.png' },
  tex2: { kind: 'texture', uri: 'green.png', options: { mips: false } },
  tex3: { kind: 'texture', uri: 'blue.png' },
  tiles: { kind: 'texture-array', uris: ['red.png', 'orange.png'] },
  scene: { kind: 'gltf', uri: 'scene.glb' },
  blip: { kind: 'audio', uri: 'blip.wav' },
  config: { kind: 'json', uri: 'config.json' },
  copy: { kind: 'text', uri: 'config.json' },
  credits: { kind: 'text', uri: 'credits.txt' },
  raw: { kind: 'bytes', uri: 'raw.bin' },
  icon: { kind: 'image', uri: 'green.png' },
  sprites: {
    kind: 'atlas',
    uris: Object.fromEntries(Object.keys(SPRITES).map((n) => [n, `${n}.png`])) as Record<
      keyof typeof SPRITES,
      string
    >,
    options: { padding: 2, extrude: 1 },
  },
});

// ------------------------------------------------------------------------------------- page

function copyProgress(p: BundleProgress): void {
  state.progress = { ...p };
  fill.style.width = `${Math.round(p.fraction * 100)}%`;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine assets demo' });
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

  // The game's part: a `read` over bytes it already has. Deterministic delays with `?slow`.
  const files = buildFiles();
  let seed = 7;
  const read = (uri: string): Promise<ReadResult> => {
    state.reads++;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const delay = state.flags.slow ? 50 + (seed % 151) : 0;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (state.flags.fail === 'one' && uri === 'credits.txt') {
          reject(new Error(`harness: refused ${uri}`));
          return;
        }
        const data = files.get(uri);
        if (!data) reject(new Error(`harness: no file ${uri}`));
        else resolve({ data, total: data instanceof Blob ? data.size : data.byteLength });
      }, delay);
    });
  };

  // Audio decodes before any gesture through an offline context.
  const audio = new OfflineAudioContext(1, 1, 8000);
  const bundle = createBundle(manifest, { read, renderer, audio, concurrency: 4 });
  bundle.on('progress', copyProgress);
  bundle.on('asset', ({ key }) => {
    state.loaded.push(key);
    if (state.flags.cancel && state.loaded.length === 1) {
      bundle.cancel();
      state.cancelled = true;
    }
  });
  bundle.on('error', () => {
    state.errors = bundle.errors.map((e) => ({ key: e.key, uri: e.uri, message: e.message }));
  });
  bundle.on('done', () => {
    state.done = true;
  });

  const sprites: { material: Material | null; draws: DrawParams[] } = { material: null, draws: [] };

  const loop = new GameLoop({
    update() {},
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      if (sprites.material) for (const d of sprites.draws) frame.sprite(sprites.material, d);
      renderer.endFrame();
      state.frames++;
      state.gpuErrors = gpuDiagnostics.errorCount;
    },
  });
  res.onDeviceLost(() => loop.stop());
  loop.start();
  state.gpu = 'ok';
  state.ready = true;

  try {
    await bundle.load();
  } catch (e) {
    state.loadError = e instanceof Error ? e.message : String(e);
  }
  copyProgress(bundle.progress);

  if (bundle.has('sprites')) {
    const atlas = bundle.get('sprites');
    state.atlasSize = { width: atlas.layout.width, height: atlas.layout.height };
    state.rectCount = Object.keys(atlas.rects).length;
    sprites.material = renderer.createSpriteMaterial({
      texture: atlas.texture,
      label: 'atlas',
      sampler: 'nearest-clamp',
    });
    // A row of sprites across the middle, each scaled 4×, sampling its own uv rect.
    const names = Object.keys(SPRITES);
    const step = LOGICAL.width / (names.length + 1);
    names.forEach((name, i) => {
      const r = atlas.rects[name]!;
      const x = step * (i + 1);
      const y = LOGICAL.height * 0.5;
      sprites.draws.push({ x, y, w: r.w * 4, h: r.h * 4, uv: [r.u0, r.v0, r.u1, r.v1] });
      if (name === state.spritePixel.name) {
        state.spritePixel.x = x;
        state.spritePixel.y = y;
      }
    });
  }
  if (bundle.has('config')) state.decoded.json = bundle.get('config');
  if (bundle.has('credits')) state.decoded.text = bundle.get('credits');
  if (bundle.has('raw')) state.decoded.bytes = bundle.get('raw').byteLength;
  if (bundle.has('blip')) state.decoded.audioFrames = bundle.get('blip').length;
  if (bundle.has('scene')) state.decoded.gltfMeshes = bundle.get('scene').meshes.length;
  if (bundle.has('tiles')) state.decoded.textureArrayLayers = bundle.get('tiles').layers;
  if (bundle.has('icon')) state.decoded.imageWidth = bundle.get('icon').width;
  state.settled = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});

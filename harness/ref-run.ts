/**
 * The page behind every harness/ref-<scene>.html (E-041 A4): boots WebGPU, builds the scene the
 * file name names (`ref-board.html` → `board`) at `?size=` (else its default) and steps it on
 * the fixed clock, once a rAF. After `prepare` (voxel meshing in a Worker), frames
 * `BENCH_WARMUP` to `BENCH_FRAMES` are measured as `pnpm bench` measures a rung: the median of
 * `performance.now()` around the frame, the median `renderer.onGpuTime` sample. The results,
 * `renderer.stats` at `REF_STATS_FRAME` and (hud) the DOM work of a measured frame go on
 * `window.__harnessRef`.
 */
import { GameLoop } from '@thunderclap-engine/engine/core';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  gpuDiagnostics,
  installGpuErrorLogging,
  Renderer,
  supportsTimestamps,
} from '@thunderclap-engine/engine/render';
import { createVoxelMesher } from '@thunderclap-engine/engine/voxel';
import { BENCH_FRAMES, BENCH_WARMUP } from './bench-state';
import type { HarnessRefState } from './ref-state';
import {
  countDom,
  createRefScene,
  REF_DEFAULT_SIZE,
  REF_SCENE_IDS,
  REF_STATS_FRAME,
  type RefSceneId,
} from './ref-scenes';

const root = document.getElementById('root') as HTMLElement;
const name = /ref-([a-z]+)\.html$/.exec(location.pathname)?.[1] ?? '';
const id = (REF_SCENE_IDS as readonly string[]).includes(name) ? (name as RefSceneId) : null;
const sizeQuery = Number(new URLSearchParams(location.search).get('size'));

const state: HarnessRefState = {
  ready: false,
  gpu: 'pending',
  scene: name,
  size: id ? sizeQuery || REF_DEFAULT_SIZE[id] : 0,
  frames: 0,
  done: false,
  measured: 0,
  cpuMs: 0,
  cpuP95Ms: 0,
  gpuMs: null,
  gpuSamples: 0,
  timestamps: false,
  stats: null,
  dom: null,
  adapter: { vendor: '', architecture: '', device: '', description: '' },
  userAgent: navigator.userAgent,
  gpuErrors: 0,
};
window.__harnessRef = { state };

function sorted(xs: Float64Array, n: number): number[] {
  return Array.from(xs.subarray(0, n)).sort((a, b) => a - b);
}

async function main(): Promise<void> {
  if (!id) throw new Error(`ref: no scene for '${location.pathname}'`);
  const res = await boot(root, { title: `Engine reference scene: ${id}` });
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

  const scene = createRefScene(id, renderer, {
    size: state.size,
    parent: root,
    mesher: (grid) =>
      createVoxelMesher(grid, {
        worker: new Worker(new URL('./voxel-worker.ts', import.meta.url), { type: 'module' }),
      }),
  });
  const measuredFrames = BENCH_FRAMES - BENCH_WARMUP;
  const cpu = new Float64Array(measuredFrames);
  const gpuMs = new Float64Array(measuredFrames);
  let cpuCount = 0;
  let gpuCount = 0;
  let measuring = false;
  renderer.onGpuTime((ms) => {
    if (measuring && gpuCount < gpuMs.length) gpuMs[gpuCount++] = ms;
  });
  const dom = id === 'hud' ? countDom(root) : null;
  let prepared = false;

  const loop = new GameLoop({
    update() {},
    render() {
      if (!prepared) {
        prepared = scene.prepare();
        return;
      }
      const i = state.frames;
      if (i === BENCH_WARMUP) {
        measuring = true;
        dom?.start();
      }
      const t0 = performance.now();
      scene.step(i);
      const ms = performance.now() - t0;
      if (measuring && cpuCount < cpu.length) cpu[cpuCount++] = ms;
      if (i === REF_STATS_FRAME) {
        const s = renderer.stats;
        state.stats = {
          drawCalls: s.drawCalls,
          triangles: s.triangles,
          instances: s.instances,
          culled: s.culled,
          shadowDraws: s.shadowDraws,
          passes: s.passes,
        };
      }
      state.frames = i + 1;
      state.gpuErrors = gpuDiagnostics.errorCount;
      if (measuring && cpuCount === cpu.length) {
        measuring = false;
        const c = sorted(cpu, cpuCount);
        const mid = cpuCount >> 1;
        state.cpuMs = cpuCount % 2 ? c[mid]! : (c[mid - 1]! + c[mid]!) / 2;
        state.cpuP95Ms = c[Math.min(cpuCount - 1, Math.floor(cpuCount * 0.95))]!;
        if (state.timestamps && gpuCount > 0) {
          const g = sorted(gpuMs, gpuCount);
          const gm = gpuCount >> 1;
          state.gpuMs = gpuCount % 2 ? g[gm]! : (g[gm - 1]! + g[gm]!) / 2;
        }
        state.gpuSamples = gpuCount;
        state.measured = cpuCount;
        if (dom) {
          const d = dom.stop();
          state.dom = { writes: d.writes / cpuCount, reads: d.reads / cpuCount };
        }
        state.done = true;
      }
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

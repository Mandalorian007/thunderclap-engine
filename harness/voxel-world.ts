/**
 * Voxel-world page (ws/voxel-draw, scene S4): a streamed block world on the retained core through
 * `createVoxelWorld` of `@thunderclap-engine/engine/voxel`. The page generates hills, sea, trees
 * and caves column by column, nearest first, under a per-frame budget, and puts each section's
 * bytes (a run-length codec of its own) into the world; mesher Workers mesh them, the world
 * uploads them into three static GPU-culled sets and cave culling hides what the camera cannot
 * reach. Once settled, a frame is one view write, three cull dispatches and three bundles at any
 * radius.
 *
 * `?radius=N` (default 16), `?workers=N` (default up to 4), `?still` parks the camera. Nothing
 * here is engine code beyond `boot`, the core and the voxel world.
 */
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  createRenderCore,
  createRenderView,
  gpuDiagnostics,
  installGpuErrorLogging,
  setViewFromCamera,
} from '@thunderclap-engine/engine/render';
import {
  createVoxelWorld,
  defineBlockTable,
  defineVoxelFormat,
  type MesherPort,
  sectionIndex,
  workerMesherPort,
} from '@thunderclap-engine/engine/voxel';
import { encodeRuns, RUNS_CODEC } from './voxel-world-codec';
import type { HarnessVoxelWorldState } from './voxel-world-state';

const root = document.getElementById('root') as HTMLElement;
const params = new URLSearchParams(location.search);
const radius = Math.max(1, Math.min(32, Number(params.get('radius') ?? 16) | 0));
const workerCount = Math.max(
  1,
  Math.min(
    8,
    Number(params.get('workers') ?? Math.min(4, (navigator.hardwareConcurrency || 4) - 1)) | 0,
  ),
);
const still = params.has('still');

const state: HarnessVoxelWorldState = {
  ready: false,
  gpu: 'pending',
  radius,
  workers: workerCount,
  frames: 0,
  gpuErrors: 0,
  settled: false,
  settleFrames: 0,
  settleMs: 0,
  sections: 0,
  drawn: 0,
  hidden: 0,
  opaqueQuads: 0,
  foliageQuads: 0,
  liquidQuads: 0,
  vertexBytes: 0,
  calls: 0,
  held: 0,
  heldCalls: 0,
  bundles: 0,
  dispatches: 0,
  bundleBuilds: 0,
  maxStreamFrameMs: 0,
  maxUpdateMs: 0,
  cpuMs: 0,
};
window.__harnessVoxelWorld = { state };

const AIR = 0;
const STONE = 1;
const DIRT = 2;
const GRASS = 3;
const SAND = 4;
const WATER = 5;
const TUFT = 6;
const LEAVES = 7;
const WOOD = 8;
const format = defineVoxelFormat({
  sectionSize: 16,
  blocks: defineBlockTable([
    { class: 'none' },
    { class: 'opaque' },
    { class: 'opaque' },
    { class: 'opaque' },
    { class: 'opaque' },
    { class: 'liquid' },
    { class: 'cross' },
    { class: 'foliage' },
    { class: 'opaque' },
  ]),
});
const S = format.size;
/** Section rows 0..5: the world is 96 blocks tall. */
const ROWS = 6;
const SEA = 30;

/** A small deterministic hash in [0, 1). */
function rand(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function heightAt(x: number, z: number): number {
  return Math.round(
    34 +
      9 * Math.sin(x * 0.031) * Math.cos(z * 0.027) +
      5 * Math.sin(x * 0.083 + z * 0.061) +
      2 * Math.cos(z * 0.17 - x * 0.05),
  );
}

/** Tunnels: where two slow waves cross near zero. */
function caveAt(x: number, y: number, z: number): boolean {
  const a = Math.sin(x * 0.11) + Math.sin(z * 0.13 + y * 0.07) + Math.sin(y * 0.19);
  const b = Math.cos(z * 0.09) + Math.cos(x * 0.07 - y * 0.11);
  return Math.abs(a) < 0.22 && Math.abs(b) < 0.5;
}

const heights = new Int32Array(S * S);
const trees = new Int32Array(4); // per column: the tree's x, z, ground (or −1)
const cells = new Uint32Array(S * S * S);

/** One section's cells; `heights` and `trees` hold its column. */
function fillSection(sx: number, sy: number, sz: number): void {
  for (let y = 0; y < S; y++) {
    const wy = sy * S + y;
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const wx = sx * S + x;
        const wz = sz * S + z;
        const h = heights[z * S + x]!;
        let id = AIR;
        if (wy < h) {
          id = wy === h - 1 ? (h <= SEA + 1 ? SAND : GRASS) : wy > h - 4 ? DIRT : STONE;
          if (wy > 2 && wy < h - 1 && caveAt(wx, wy, wz)) id = AIR;
        } else if (wy < SEA) id = WATER;
        else if (wy === h && h > SEA + 1 && rand(wx, wz) < 0.06) id = TUFT;
        if (trees[2]! >= 0) {
          const dx = wx - trees[0]!;
          const dz = wz - trees[1]!;
          const top = trees[2]! + 5;
          if (dx === 0 && dz === 0 && wy >= trees[2]! && wy < top) id = WOOD;
          else if (
            id === AIR &&
            Math.abs(wy - top) <= 2 &&
            dx * dx + dz * dz + (wy - top) ** 2 <= 6
          )
            id = LEAVES;
        }
        cells[sectionIndex(S, x, y, z)] = id;
      }
    }
  }
}

function prepareColumn(sx: number, sz: number): void {
  for (let z = 0; z < S; z++)
    for (let x = 0; x < S; x++) heights[z * S + x] = heightAt(sx * S + x, sz * S + z);
  // One tree per column at most, kept 3 cells from the edges so its leaves stay inside.
  trees[2] = -1;
  if (rand(sx * 31, sz * 17) < 0.55) {
    const tx = 3 + Math.floor(rand(sx, sz * 7) * (S - 6));
    const tz = 3 + Math.floor(rand(sx * 5, sz) * (S - 6));
    const g = heights[tz * S + tx]!;
    if (g > SEA + 1) {
      trees[0] = sx * S + tx;
      trees[1] = sz * S + tz;
      trees[2] = g;
    }
  }
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Voxel world' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const core = createRenderCore(gpu);
  const workers: MesherPort[] = [];
  for (let i = 0; i < workerCount; i++)
    workers.push(
      workerMesherPort(
        new Worker(new URL('./voxel-world-worker.ts', import.meta.url), { type: 'module' }),
      ),
    );
  const world = createVoxelWorld(core, {
    format,
    codec: RUNS_CODEC,
    workers,
    minSectionY: 0,
    maxSectionY: ROWS - 1,
    radius,
    label: 'S4',
  });
  // The columns to generate, nearest first: the radius and one ring past it, so every section
  // inside has its neighbours.
  const columns: number[] = [];
  const reach = radius + 1;
  for (let z = -reach; z <= reach; z++) for (let x = -reach; x <= reach; x++) columns.push(x, z);
  const order = Array.from({ length: columns.length / 2 }, (_, i) => i).sort(
    (a, b) =>
      Math.hypot(columns[a * 2]!, columns[a * 2 + 1]!) -
      Math.hypot(columns[b * 2]!, columns[b * 2 + 1]!),
  );
  let next = 0;

  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.3, 2000);
  const view = createRenderView();
  const views = [view];
  const times: number[] = [];
  const target = {
    view: undefined as unknown as GPUTextureView,
    format: gpu.format,
    width: 1,
    height: 1,
    clear: { r: 0.62, g: 0.72, b: 0.82, a: 1 },
  };
  state.gpu = 'ok';
  state.ready = true;
  const start = performance.now();
  const eye = [8, 64, 8] as [number, number, number];
  const look = [0, 0, 0] as [number, number, number];

  const frame = () => {
    const now = performance.now();
    // The game's side of streaming: generate and put sections for at most 6 ms.
    while (next < order.length && performance.now() - now < 6) {
      const c = order[next++]!;
      const sx = columns[c * 2]!;
      const sz = columns[c * 2 + 1]!;
      prepareColumn(sx, sz);
      for (let sy = 0; sy < ROWS; sy++) {
        fillSection(sx, sy, sz);
        world.putSection(sx, sy, sz, encodeRuns(cells));
      }
    }
    const t = still ? 0 : (now - start) / 1000;
    const { width, height } = surface.backbuffer;
    camera.setPerspective(Math.PI / 3, width / Math.max(1, height), 0.3, 2000);
    const a = t * 0.1;
    look[0] = eye[0] + Math.cos(a) * 10;
    look[1] = eye[1] - 3;
    look[2] = eye[2] + Math.sin(a) * 10;
    camera.lookAt(eye, look);
    setViewFromCamera(view, camera);
    const texture = gpu.context.getCurrentTexture();
    target.view = texture.createView();
    target.width = texture.width;
    target.height = texture.height;
    // The engine's share of the frame: world.update, prepare and draw.
    const t0 = performance.now();
    world.update(eye[0], eye[1], eye[2]);
    const encoder = gpu.device.createCommandEncoder();
    core.prepare(encoder, views);
    core.draw(encoder, 0, target);
    gpu.device.queue.submit([encoder.finish()]);
    const ms = performance.now() - t0;
    times.push(ms);
    if (times.length > 60) times.shift();
    const settled = next >= order.length && world.settled;
    const st = core.stats;
    const ws = world.stats;
    state.calls = st.calls;
    state.bundles = st.bundles;
    state.dispatches = st.dispatches;
    state.bundleBuilds = st.bundleBuilds;
    if (!state.settled) {
      // Frame 0 compiles the pipelines; it is not a streaming hitch.
      if (state.frames > 0) state.maxStreamFrameMs = Math.max(state.maxStreamFrameMs, ms);
      if (settled) {
        state.settled = true;
        state.settleFrames = state.frames;
        state.settleMs = Math.round(performance.now() - start);
      }
    } else if (!world.visibility.throttled) {
      // Held: settled, and no cave-culling search waiting on its throttle.
      state.held++;
      state.heldCalls = st.calls;
    }
    state.maxUpdateMs = ws.maxUpdateMs;
    state.sections = ws.sections;
    state.drawn = ws.drawn;
    state.hidden = ws.hidden;
    state.opaqueQuads = ws.opaqueQuads;
    state.foliageQuads = ws.foliageQuads;
    state.liquidQuads = ws.liquidQuads;
    state.vertexBytes = ws.vertexBytes;
    state.cpuMs = [...times].sort((p, q) => p - q)[times.length >> 1]!;
    state.gpuErrors = gpuDiagnostics.errorCount;
    state.frames++;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((e: unknown) => {
  state.gpu = e instanceof Error ? e.message : String(e);
  state.ready = true;
});

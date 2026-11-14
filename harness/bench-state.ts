/**
 * What the bench page (harness/bench.html) publishes on `window.__harnessBench` for
 * `scripts/bench.mjs` and e2e/bench.spec.ts. Shared by the page (harness/bench.ts), the spec
 * and (by shape, it is plain JS) the script.
 */

export type BenchKind = 'instances' | 'lights' | 'shadow' | 'sprites' | 'particles';

/**
 * How the 3D kinds submit their cubes: `mesh` is one `frame.mesh` per cube, `batch` one
 * `frame.meshes` with the matrices and params in typed arrays, `list` one `frame.list` of a
 * retained `InstanceList` filled when the rung starts (ws/batch-submit). Sprites and particles
 * ignore it.
 */
export type BenchMode = 'mesh' | 'batch' | 'list';

/** One rung of the ladder: a scene configuration the page holds for `frames` frames. */
export interface BenchRungDef {
  /** Stable id, the `?rung=` value: `instances-10k-cull`, `lights-8`, `sprites-50k`, ... */
  id: string;
  kind: BenchKind;
  /** Submission path of the 3D kinds; `?mode=` overrides it for every rung. */
  mode: BenchMode;
  /** Mesh instances drawn (3D kinds), sprites (`sprites`) or particles alive (`particles`). */
  count: number;
  /** `camera.cull` for the 3D kinds (sprites are never culled). */
  cull: boolean;
  /** Point lights in `Lights.points`. */
  points: number;
  /** Whether `lights.sun.shadow` is set. */
  shadow: boolean;
  /** Frames rendered; the first `BENCH_WARMUP` are not measured. */
  frames: number;
}

export interface BenchRungResult {
  id: string;
  kind: BenchKind;
  /** The submission path the rung ran with (after `?mode=`). */
  mode: BenchMode;
  /** The rung's `count`: instances submitted, sprites, or particles alive. */
  count: number;
  /** Measured frames (after warm-up). */
  frames: number;
  /** Median of `performance.now()` around the render callback (`beginFrame` to `endFrame`). */
  cpuMs: number;
  /** Median `GpuTimerResult.totalMs` over the samples that resolved during the rung; null without `timestamp-query`. */
  gpuMs: number | null;
  /** `renderer.stats.instances` on the last frame (sprites and meshes drawn, after culling; a particle system is a drawable and counts 0). */
  instances: number;
  /** `renderer.stats.culled` on the last frame. */
  culled: number;
  /**
   * Instances drawn into the sun's shadow map: `instances` when the rung's sun casts a shadow
   * (the shadow pass draws every opaque caster the scene pass draws), else 0.
   */
  shadowDraws: number;
  /** `renderer.stats.drawCalls` on the last frame. */
  drawCalls: number;
  /** GPU samples that resolved during the rung (0 when `gpuMs` is null). */
  gpuSamples: number;
}

export interface BenchAdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

export interface HarnessBenchState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented, over every rung. */
  frames: number;
  /** True once the last requested rung finished (or a rung threw: see `error`). */
  done: boolean;
  /** Id of the rung running now, null before the first and after the last. */
  current: string | null;
  /** Rungs still to run after `current`. */
  remaining: number;
  /** `supportsTimestamps(device)`: whether `gpuMs` can be measured. */
  timestamps: boolean;
  /** `GPUAdapter.info` of the booted adapter (empty strings when the browser hides it). */
  adapter: BenchAdapterInfo;
  userAgent: string;
  /** Finished rungs, in ladder order. */
  results: BenchRungResult[];
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
  /** Message of the first error a rung threw, else null. */
  error: string | null;
  /** The camera's `screen`: logical px the `probe` is in. */
  logical: { width: number; height: number };
  /**
   * Screen position (logical px) of the centre of the current rung's cube nearest the camera
   * among those projecting inside the middle of the view, so a spec can sample a drawn cube and
   * not the sky; null for the 2D and particle kinds or when no cube qualifies.
   */
  probe: { x: number; y: number } | null;
}

export interface HarnessBenchApi {
  state: HarnessBenchState;
  /** The ladder the page knows, in order. */
  rungs: BenchRungDef[];
}

/** Frames at the start of a rung that are rendered but not measured (pipelines, uploads). */
export const BENCH_WARMUP = 20;
/** Frames per rung on the full ladder, warm-up included. */
export const BENCH_FRAMES = 140;
/** The spec's rung: 100 instances for 30 frames. */
export const BENCH_TINY_FRAMES = 30;

function rung(
  id: string,
  kind: BenchKind,
  count: number,
  opts: Partial<Pick<BenchRungDef, 'mode' | 'cull' | 'points' | 'shadow' | 'frames'>> = {},
): BenchRungDef {
  return {
    id,
    kind,
    mode: opts.mode ?? 'mesh',
    count,
    cull: opts.cull ?? true,
    points: opts.points ?? 0,
    shadow: opts.shadow ?? false,
    frames: opts.frames ?? BENCH_FRAMES,
  };
}

/**
 * The ladder (STATUS row 5): instances with culling on and off through each submission path,
 * point lights, the sun shadow, 2D sprites and world particles. The lights and shadow rungs
 * draw 10k culled instances through `frame.mesh`.
 */
export const BENCH_LADDER: BenchRungDef[] = [
  rung('instances-1k-cull', 'instances', 1_000),
  rung('instances-1k', 'instances', 1_000, { cull: false }),
  rung('instances-10k-cull', 'instances', 10_000),
  rung('instances-10k', 'instances', 10_000, { cull: false }),
  rung('instances-50k-cull', 'instances', 50_000),
  rung('instances-50k', 'instances', 50_000, { cull: false }),
  rung('batch-10k-cull', 'instances', 10_000, { mode: 'batch' }),
  rung('batch-10k', 'instances', 10_000, { mode: 'batch', cull: false }),
  rung('batch-50k-cull', 'instances', 50_000, { mode: 'batch' }),
  rung('batch-50k', 'instances', 50_000, { mode: 'batch', cull: false }),
  rung('list-10k', 'instances', 10_000, { mode: 'list', cull: false }),
  rung('list-50k', 'instances', 50_000, { mode: 'list', cull: false }),
  rung('lights-0', 'lights', 10_000, { points: 0 }),
  rung('lights-8', 'lights', 10_000, { points: 8 }),
  rung('lights-16', 'lights', 10_000, { points: 16 }),
  rung('shadow-off', 'shadow', 10_000, { shadow: false }),
  rung('shadow-on', 'shadow', 10_000, { shadow: true }),
  rung('sprites-10k', 'sprites', 10_000),
  rung('sprites-50k', 'sprites', 50_000),
  rung('particles-10k', 'particles', 10_000),
  rung('particles-100k', 'particles', 100_000),
];

/** `?rung=tiny`: what e2e/bench.spec.ts runs on `desktop-1280`. */
export const BENCH_TINY: BenchRungDef = rung('tiny', 'instances', 100, {
  frames: BENCH_TINY_FRAMES,
});

/**
 * The reference scenes' rungs (E-041 A4, docs/BENCH.md "Reference scenes"): each is a page of its
 * own (`harness/<page>?<query>`), timed by e2e/ref-scenes.spec.ts the way a ladder rung is (the
 * `ref-*` pages: `BENCH_WARMUP` frames, then the median over the rest of `BENCH_FRAMES`). The
 * `core-*` rungs time B1's retained core page (harness/core.html), which keeps its own median CPU
 * time of the last 60 frames and no GPU time.
 */
export interface RefRungDef {
  id: string;
  page: string;
  query: string;
}

export const REF_RUNGS: readonly RefRungDef[] = [
  { id: 'ref-board', page: 'ref-board.html', query: '' },
  { id: 'ref-characters', page: 'ref-characters.html', query: '' },
  { id: 'ref-characters-256', page: 'ref-characters.html', query: 'size=256' },
  { id: 'ref-arena', page: 'ref-arena.html', query: '' },
  { id: 'ref-voxel', page: 'ref-voxel.html', query: '' },
  { id: 'ref-voxel-16', page: 'ref-voxel.html', query: 'size=16' },
  { id: 'ref-stereo', page: 'ref-stereo.html', query: '' },
  { id: 'ref-hud', page: 'ref-hud.html', query: '' },
  { id: 'core-1.5k', page: 'core.html', query: 'sets=1500' },
  { id: 'core-6k', page: 'core.html', query: 'sets=6000' },
];

/** Rungs for a `?rung=` value: `all`, `tiny`, or ids separated by commas. Unknown ids throw. */
export function benchRungsFor(query: string | null): BenchRungDef[] {
  if (!query || query === 'all') return BENCH_LADDER;
  return query.split(',').map((id) => {
    if (id === 'tiny') return BENCH_TINY;
    const r = BENCH_LADDER.find((d) => d.id === id);
    if (!r) throw new Error(`bench: unknown rung '${id}'`);
    return r;
  });
}

/** A `?mode=` value, or null for none; anything else throws. */
export function benchModeFor(query: string | null): BenchMode | null {
  if (query === null || query === '') return null;
  if (query === 'mesh' || query === 'batch' || query === 'list') return query;
  throw new Error(`bench: unknown mode '${query}'`);
}

declare global {
  interface Window {
    __harnessBench?: HarnessBenchApi;
  }
}

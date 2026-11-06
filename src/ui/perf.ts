/**
 * Frame-cost readout (ws/perf-overlay): a monitor that keeps the last N frame times and copies
 * the renderer's counters into one plain object, and a small DOM overlay that shows those
 * numbers with a sparkline. Quality validation needs to see the cost on screen; demos, the
 * bench and e2e read the same numbers without the DOM.
 *
 * ```ts
 * const perf = createPerfMonitor();
 * const hud = createPerfOverlay(perf, { parent: stageEl, corner: 'tr' });
 * // each frame, after renderer.endFrame():
 * state.perf = perf.sample(renderer);
 * hud.update();
 * ```
 *
 * The monitor is pure (no DOM, no GPU): `begin`/`end` bracket the CPU frame when the caller
 * wants an exact span, otherwise `sample` measures the interval between its own calls. Steady
 * state allocates nothing: the ring, the stats object and the count and pass records are reused;
 * a new counter or pass label adds a key once.
 */

import { h } from './dom';

/** What `PerfMonitor.sample` reads: the renderer's counters, its timing and its scale. */
export interface PerfSource {
  /**
   * `Renderer.stats` (any object; `RenderStats` has no index signature): every own numeric
   * field is a counter (`drawCalls`, `instances`, `culled`, …).
   */
  readonly stats: object;
  /** `Renderer.timing`: the last GPU sample, by pass when the device has `timestamp-query`. */
  readonly timing?: {
    readonly gpuMs: number;
    readonly passes: Readonly<Record<string, number>>;
    readonly samples: number;
  };
  /** `Renderer.timingEvery`: how often the renderer samples GPU time (0 = never). */
  timingEvery?: number;
  /** `Renderer.resolutionScale`: effective scene-target scale vs the output. */
  readonly resolutionScale?: number;
}

export interface PerfFrameStats {
  /** Last frame time (ms). */
  last: number;
  /** Mean over the filled part of the ring (ms). */
  avg: number;
  /** 95th percentile over the filled part of the ring (ms). */
  p95: number;
  /** Largest sample in the ring (ms). */
  max: number;
  /** `1000 / avg`, 0 while nothing has been sampled. */
  fps: number;
}

export interface PerfGpuStats {
  /** GPU time of the renderer's last sample (ms). */
  total: number;
  /** Per pass label, ms; empty when the device has no `timestamp-query`. */
  passes: Record<string, number>;
}

/** The numbers, as one plain JSON-safe object (the monitor reuses it; copy to keep one). */
export interface PerfSample {
  frame: PerfFrameStats;
  /** `null` until the renderer has delivered a GPU time sample. */
  gpu: PerfGpuStats | null;
  /**
   * Every numeric field of `source.stats`, read by key each frame (never a fixed set), plus
   * `draws` as an alias of `drawCalls` when the source has that counter.
   */
  counts: Record<string, number>;
  resolutionScale: number;
  /** `performance.memory.usedJSHeapSize` (bytes) where the browser exposes it; else absent. */
  memory?: number;
  /** Frames sampled since creation or `reset()`. */
  samples: number;
  /** How many slots of `history` hold a frame time (`min(samples, window)`). */
  filled: number;
  /** The ring's length (frames). */
  window: number;
}

export interface PerfMonitorOptions {
  /** Frames kept in `history` and used for `avg`, `p95` and `max`. Default 120. */
  window?: number;
  /**
   * When `sample` finds the source's `timingEvery` at 0, it sets it to this so GPU times arrive.
   * Default 1 (the renderer keeps one sample in flight at a time anyway). 0 leaves it alone.
   */
  gpuEvery?: number;
  /** Clock (ms). Default `performance.now`. */
  now?: () => number;
}

export interface PerfMonitor extends PerfSample {
  /** Mark the start of the CPU frame. Optional: without it `sample` times the frame interval. */
  begin(nowMs?: number): void;
  /** Mark the end of the CPU frame; the span since `begin` is the next frame time. */
  end(nowMs?: number): void;
  /**
   * Read the source once per frame, after `renderer.endFrame()`. Pushes the frame time into
   * `history` and refreshes every field. Returns this monitor's `PerfSample` (the same object).
   */
  sample(source: PerfSource): PerfSample;
  /** Frame times (ms), a ring of `window` slots; `filled` says how many hold data. */
  readonly history: Float32Array;
  /** Index of the slot the next frame time goes into (the oldest sample while the ring is full). */
  readonly head: number;
  /** Forget every sample. */
  reset(): void;
}

const DEFAULT_WINDOW = 120;

interface PerfMemory {
  usedJSHeapSize?: number;
}

/** `performance.memory.usedJSHeapSize` where it exists (Chromium); never throws. */
function usedHeap(): number | undefined {
  try {
    const mem = (globalThis.performance as { memory?: PerfMemory } | undefined)?.memory;
    const used = mem?.usedJSHeapSize;
    return typeof used === 'number' && Number.isFinite(used) ? used : undefined;
  } catch {
    return undefined;
  }
}

export function createPerfMonitor(opts: PerfMonitorOptions = {}): PerfMonitor {
  const window = Math.max(1, Math.floor(opts.window ?? DEFAULT_WINDOW));
  const gpuEvery = opts.gpuEvery ?? 1;
  const now = opts.now ?? (() => performance.now());
  const history = new Float32Array(window);
  const sorted = new Float32Array(window);
  let head = 0;
  let filled = 0;
  let samples = 0;
  /** `begin` time, or NaN when `begin` was not called since the last sample. */
  let beginAt = Number.NaN;
  /** Frame time from `end`, or NaN when `end` was not called since the last sample. */
  let ended = Number.NaN;
  /** The clock at the previous `sample`, for the interval fallback. */
  let lastSampleAt = Number.NaN;

  const frame: PerfFrameStats = { last: 0, avg: 0, p95: 0, max: 0, fps: 0 };
  const gpu: PerfGpuStats = { total: 0, passes: {} };
  const counts: Record<string, number> = {};

  const monitor: PerfMonitor = {
    frame,
    gpu: null,
    counts,
    resolutionScale: 1,
    memory: undefined,
    samples: 0,
    filled: 0,
    window,
    history,
    get head() {
      return head;
    },
    begin(nowMs = now()) {
      beginAt = nowMs;
    },
    end(nowMs = now()) {
      if (Number.isNaN(beginAt)) return;
      ended = Math.max(0, nowMs - beginAt);
      beginAt = Number.NaN;
    },
    sample(source) {
      const t = now();
      let ms: number;
      if (!Number.isNaN(ended)) {
        ms = ended;
        ended = Number.NaN;
      } else if (!Number.isNaN(beginAt)) {
        // `begin` without `end`: the span up to this call.
        ms = Math.max(0, t - beginAt);
        beginAt = Number.NaN;
      } else {
        ms = Number.isNaN(lastSampleAt) ? 0 : Math.max(0, t - lastSampleAt);
      }
      lastSampleAt = t;

      history[head] = ms;
      head = (head + 1) % window;
      if (filled < window) filled++;
      samples++;
      monitor.samples = samples;
      monitor.filled = filled;

      // Frame statistics over the filled part of the ring.
      let sum = 0;
      let max = 0;
      for (let i = 0; i < filled; i++) {
        const v = history[i]!;
        sum += v;
        if (v > max) max = v;
        sorted[i] = v;
      }
      // Unfilled slots sort last, so no subarray view is made per frame.
      for (let i = filled; i < window; i++) sorted[i] = Number.POSITIVE_INFINITY;
      sorted.sort();
      frame.last = ms;
      frame.avg = sum / filled;
      frame.max = max;
      frame.p95 = sorted[Math.min(filled - 1, Math.floor(0.95 * filled))]!;
      frame.fps = frame.avg > 0 ? 1000 / frame.avg : 0;

      // Counters, by key.
      const stats = source.stats as Record<string, unknown>;
      for (const k in stats) {
        const v = stats[k];
        if (typeof v === 'number') counts[k] = v;
      }
      if (typeof stats.drawCalls === 'number' && typeof stats.draws !== 'number') {
        counts.draws = stats.drawCalls;
      }

      // GPU time, once the renderer samples it.
      const timing = source.timing;
      if (timing && gpuEvery > 0 && source.timingEvery === 0) source.timingEvery = gpuEvery;
      if (timing && timing.samples > 0) {
        gpu.total = timing.gpuMs;
        const passes = timing.passes;
        for (const k in passes) {
          const v = passes[k];
          if (typeof v === 'number') gpu.passes[k] = v;
        }
        monitor.gpu = gpu;
      } else {
        monitor.gpu = null;
      }

      const scale = source.resolutionScale;
      monitor.resolutionScale = typeof scale === 'number' && Number.isFinite(scale) ? scale : 1;
      monitor.memory = usedHeap();
      return monitor;
    },
    reset() {
      history.fill(0);
      head = 0;
      filled = 0;
      samples = 0;
      beginAt = Number.NaN;
      ended = Number.NaN;
      lastSampleAt = Number.NaN;
      frame.last = frame.avg = frame.p95 = frame.max = frame.fps = 0;
      gpu.total = 0;
      for (const k in gpu.passes) delete gpu.passes[k];
      for (const k in counts) delete counts[k];
      monitor.gpu = null;
      monitor.samples = 0;
      monitor.filled = 0;
      monitor.resolutionScale = 1;
      monitor.memory = undefined;
    },
  };
  return monitor;
}

// ------------------------------------------------------------------------------------ overlay

export type PerfCorner = 'tl' | 'tr' | 'bl' | 'br';

export interface PerfOverlayOptions {
  /** Which corner of the parent. Default `'tl'`. */
  corner?: PerfCorner;
  /** Draw the frame-time sparkline. Default true. */
  graph?: boolean;
  /**
   * Element to mount into (positioned: the overlay is `position: absolute` inside it). Default:
   * `document.body`, where the overlay is `position: fixed`.
   */
  parent?: HTMLElement;
  /** Redraw the numbers every N `update()` calls. Default 10. The graph redraws with them. */
  updateEvery?: number;
}

export interface PerfOverlay {
  /** The overlay root (`.tc-perf`), `aria-hidden`, `pointer-events: none`. */
  readonly el: HTMLElement;
  /** Call once a frame after `monitor.sample`; redraws every `updateEvery` calls. */
  update(): void;
  show(): void;
  hide(): void;
  toggle(): void;
  readonly visible: boolean;
  destroy(): void;
}

const STYLE_ATTR = 'perf';

/**
 * Theme tokens with fallbacks (`defaultTheme`'s values), so the overlay reads the same on a
 * page without a `.tc-overlay` root. Sizes are CSS px: this is a debug readout, not game UI.
 */
const CSS = /* css */ `
.tc-perf { position: absolute; z-index: 1000; margin: 8px; padding: 6px 8px; min-width: 180px;
  pointer-events: none; user-select: none; -webkit-user-select: none; box-sizing: border-box;
  font-family: var(--tc-font-mono, ui-monospace, Menlo, Consolas, monospace); font-size: 11px; line-height: 1.35;
  color: var(--tc-color-text, #ece6d8); background: var(--tc-color-surface, rgba(18, 21, 30, 0.94));
  border: 1px solid var(--tc-color-border, rgba(224, 180, 90, 0.35)); border-radius: var(--tc-radius-s, 6px);
  white-space: pre; font-variant-numeric: tabular-nums; }
.tc-perf[hidden] { display: none; }
.tc-perf[data-fixed] { position: fixed; }
.tc-perf[data-corner^="t"] { top: 0; }
.tc-perf[data-corner^="b"] { bottom: 0; }
.tc-perf[data-corner$="l"] { left: 0; }
.tc-perf[data-corner$="r"] { right: 0; }
.tc-perf-head { color: var(--tc-color-accent, #e0b45a); }
.tc-perf-dim { color: var(--tc-color-text-muted, #a7a091); }
.tc-perf-graph { display: block; width: 100%; height: 36px; margin-top: 4px; }
`;

const GRAPH_W = 240;
const GRAPH_H = 36;
/** The graph's floor: two 60 Hz frames, so a steady 16.7 ms sits at half height. */
const GRAPH_MIN_MS = 1000 / 30;

function fmt(ms: number): string {
  return ms >= 100 ? ms.toFixed(0) : ms.toFixed(ms >= 10 ? 1 : 2);
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}

export function createPerfOverlay(
  monitor: PerfMonitor,
  opts: PerfOverlayOptions = {},
): PerfOverlay {
  const parent = opts.parent ?? document.body;
  const doc = parent.ownerDocument;
  const updateEvery = Math.max(1, Math.floor(opts.updateEvery ?? 10));
  const graph = opts.graph ?? true;
  if (!doc.querySelector(`style[data-tc="${STYLE_ATTR}"]`)) {
    doc.head.append(h('style', { 'data-tc': STYLE_ATTR }, CSS));
  }
  const head = h('div', { class: 'tc-perf-head' });
  const body = h('div', { class: 'tc-perf-body' });
  const canvas = graph
    ? h('canvas', { class: 'tc-perf-graph', width: GRAPH_W, height: GRAPH_H })
    : null;
  const el = h(
    'div',
    {
      class: 'tc-perf',
      'aria-hidden': 'true',
      dataset: { corner: opts.corner ?? 'tl' },
      'data-fixed': !opts.parent,
    },
    head,
    body,
    canvas,
  );
  parent.append(el);
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas?.getContext('2d') ?? null;
  } catch {
    ctx = null;
  }
  let tick = 0;
  let destroyed = false;

  const drawGraph = (): void => {
    if (!ctx || !canvas) return;
    const w = canvas.width;
    const hgt = canvas.height;
    ctx.clearRect(0, 0, w, hgt);
    const n = monitor.filled;
    const win = monitor.window;
    if (n === 0) return;
    let max = GRAPH_MIN_MS;
    const hist = monitor.history;
    for (let i = 0; i < n; i++) if (hist[i]! > max) max = hist[i]!;
    // 16.7 ms guide.
    const guide = hgt - (hgt * (1000 / 60)) / max;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(0, Math.round(guide), w, 1);
    // Oldest to newest, left to right; a full ring starts at `head`.
    const start = n < win ? 0 : monitor.head;
    const barW = w / win;
    ctx.fillStyle = 'rgba(224, 180, 90, 0.85)';
    for (let i = 0; i < n; i++) {
      const v = hist[(start + i) % win]!;
      const bh = Math.max(1, (hgt * v) / max);
      ctx.fillRect(i * barW, hgt - bh, Math.max(1, barW - 0.5), bh);
    }
  };

  const render = (): void => {
    const f = monitor.frame;
    head.textContent = `${fmt(f.avg)} ms  ${f.fps.toFixed(0)} fps`;
    let text = `cpu  last ${fmt(f.last)}  p95 ${fmt(f.p95)}  max ${fmt(f.max)}`;
    const g = monitor.gpu;
    if (g) {
      text += `\ngpu  ${fmt(g.total)} ms`;
      for (const k in g.passes) {
        const v = g.passes[k]!;
        if (v > 0.005) text += `\n  ${k.padEnd(10)} ${fmt(v)}`;
      }
    } else {
      text += '\ngpu  –';
    }
    const c = monitor.counts;
    const parts: string[] = [];
    for (const k in c) {
      if (k === 'draws' && 'drawCalls' in c) continue;
      parts.push(`${k} ${c[k]}`);
    }
    if (parts.length > 0) text += `\n${parts.join('  ')}`;
    text += `\nscale ${monitor.resolutionScale.toFixed(2)}`;
    if (monitor.memory !== undefined) text += `  heap ${fmtBytes(monitor.memory)}`;
    body.textContent = text;
    drawGraph();
  };

  render();

  const show = (): void => {
    el.hidden = false;
    tick = updateEvery - 1;
  };
  const hide = (): void => {
    el.hidden = true;
  };
  return {
    el,
    update() {
      if (destroyed || el.hidden) return;
      if (++tick < updateEvery) return;
      tick = 0;
      render();
    },
    show,
    hide,
    toggle() {
      if (el.hidden) show();
      else hide();
    },
    get visible() {
      return !el.hidden && el.isConnected;
    },
    destroy() {
      destroyed = true;
      el.remove();
    },
  };
}

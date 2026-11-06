// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createPerfMonitor, createPerfOverlay, type PerfOverlay, type PerfSource } from './perf';

/** A fake renderer: `RenderStats`-shaped counters plus the timing the renderer exposes. */
function fakeSource(
  stats: Record<string, number> = { drawCalls: 3, instances: 50, drawables: 0, culled: 7 },
): PerfSource & {
  stats: Record<string, number>;
  timing: { gpuMs: number; passes: Record<string, number>; samples: number };
} {
  return {
    stats,
    timing: { gpuMs: 0, passes: {}, samples: 0 },
    timingEvery: 0,
    resolutionScale: 0.75,
  };
}

/** A clock the test steps. */
function clock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    tick(ms: number) {
      t += ms;
    },
  };
}

describe('createPerfMonitor', () => {
  it('measures the interval between samples when begin/end are not used', () => {
    const c = clock();
    const m = createPerfMonitor({ window: 4, now: c.now });
    const src = fakeSource();
    m.sample(src); // first: no interval yet
    expect(m.frame.last).toBe(0);
    c.tick(16);
    m.sample(src);
    expect(m.frame.last).toBe(16);
    c.tick(20);
    const s = m.sample(src);
    expect(s).toBe(m);
    expect(s.frame.last).toBe(20);
    expect(s.frame.avg).toBeCloseTo((0 + 16 + 20) / 3, 5);
    expect(s.frame.max).toBe(20);
    expect(s.frame.fps).toBeCloseTo(1000 / s.frame.avg, 5);
  });

  it('uses the begin/end span when given, with explicit or clock times', () => {
    const c = clock();
    const m = createPerfMonitor({ window: 8, now: c.now });
    const src = fakeSource();
    m.begin(100);
    m.end(112.5);
    c.tick(500); // the wall clock moved far more than the frame span
    m.sample(src);
    expect(m.frame.last).toBe(12.5);
    m.begin();
    c.tick(4);
    m.end();
    m.sample(src);
    expect(m.frame.last).toBe(4);
    // begin without end: the span up to the sample.
    m.begin();
    c.tick(7);
    m.sample(src);
    expect(m.frame.last).toBe(7);
  });

  it('keeps a ring of `window` frames and reports avg, p95 and max over it', () => {
    const m = createPerfMonitor({ window: 20 });
    const src = fakeSource();
    expect(m.history.length).toBe(20);
    expect(m.window).toBe(20);
    // 25 frames: 1..25 ms. The ring keeps 6..25.
    for (let i = 1; i <= 25; i++) {
      m.begin(0);
      m.end(i);
      m.sample(src);
    }
    expect(m.samples).toBe(25);
    expect(m.filled).toBe(20);
    expect(m.head).toBe(5);
    const kept = [...m.history].sort((a, b) => a - b);
    expect(kept[0]).toBe(6);
    expect(kept[19]).toBe(25);
    expect(m.frame.max).toBe(25);
    expect(m.frame.avg).toBeCloseTo((6 + 25) / 2, 5);
    // Sorted 6..25: index floor(0.95 * 20) = 19 → 25.
    expect(m.frame.p95).toBe(25);
    expect(m.frame.last).toBe(25);
  });

  it('p95 ignores the unfilled part of the ring', () => {
    const m = createPerfMonitor({ window: 100 });
    const src = fakeSource();
    const times = [5, 5, 5, 5, 5, 5, 5, 5, 5, 40];
    for (const t of times) {
      m.begin(0);
      m.end(t);
      m.sample(src);
    }
    expect(m.filled).toBe(10);
    // index floor(0.95 * 10) = 9 → the 40 ms spike.
    expect(m.frame.p95).toBe(40);
    expect(m.frame.avg).toBeCloseTo(8.5, 5);
    expect(Number.isFinite(m.frame.p95)).toBe(true);
  });

  it('copies every numeric counter by key and aliases draws to drawCalls', () => {
    const m = createPerfMonitor();
    const src = fakeSource({ drawCalls: 4, instances: 9, culled: 2, shadowDraws: 6 });
    m.sample(src);
    expect(m.counts).toEqual({ drawCalls: 4, instances: 9, culled: 2, shadowDraws: 6, draws: 4 });
    // A counter that appears later (another workstream's `batches`) is picked up, never hard-coded.
    src.stats.batches = 3;
    src.stats.instances = 11;
    m.sample(src);
    expect(m.counts.batches).toBe(3);
    expect(m.counts.instances).toBe(11);
    expect(m.counts.draws).toBe(4);
    // A source that has `draws` itself keeps it.
    const m2 = createPerfMonitor();
    m2.sample(fakeSource({ draws: 1, drawCalls: 2 }));
    expect(m2.counts.draws).toBe(1);
  });

  it('reports gpu as null until the source has a sample, then copies total and passes', () => {
    const m = createPerfMonitor({ gpuEvery: 4 });
    const src = fakeSource();
    m.sample(src);
    expect(m.gpu).toBeNull();
    // It switched the renderer's sampling on, since it was off.
    expect(src.timingEvery).toBe(4);
    src.timing.gpuMs = 2.5;
    src.timing.passes = { pre: 0.1, scene: 2.0, composite: 0.4 };
    src.timing.samples = 1;
    const s = m.sample(src);
    expect(s.gpu).toEqual({ total: 2.5, passes: { pre: 0.1, scene: 2.0, composite: 0.4 } });
    const passes = s.gpu!.passes;
    src.timing.passes.scene = 1.5;
    m.sample(src);
    // Reused objects: same record, fresh values.
    expect(m.gpu!.passes).toBe(passes);
    expect(passes.scene).toBe(1.5);
  });

  it('leaves timingEvery alone when the caller set it or gpuEvery is 0', () => {
    const src = fakeSource();
    src.timingEvery = 7;
    createPerfMonitor().sample(src);
    expect(src.timingEvery).toBe(7);
    const off = fakeSource();
    createPerfMonitor({ gpuEvery: 0 }).sample(off);
    expect(off.timingEvery).toBe(0);
    // A source without timing (a fake) never throws.
    const bare: PerfSource = { stats: { drawCalls: 1 } };
    const m = createPerfMonitor();
    expect(() => m.sample(bare)).not.toThrow();
    expect(m.gpu).toBeNull();
    expect(m.resolutionScale).toBe(1);
  });

  it('reads the resolution scale and omits memory where the browser has none', () => {
    const m = createPerfMonitor();
    const s = m.sample(fakeSource());
    expect(s.resolutionScale).toBe(0.75);
    const hasMemory = 'memory' in performance;
    if (!hasMemory) {
      expect(s.memory).toBeUndefined();
      expect(JSON.parse(JSON.stringify(s))).not.toHaveProperty('memory');
    } else {
      expect(typeof s.memory).toBe('number');
    }
  });

  it('is JSON-safe (what a harness page exposes) and reset() forgets everything', () => {
    const m = createPerfMonitor({ window: 3 });
    const src = fakeSource();
    src.timing.samples = 1;
    src.timing.gpuMs = 1;
    src.timing.passes.scene = 1;
    m.begin(0);
    m.end(8);
    m.sample(src);
    const json = JSON.parse(JSON.stringify(m));
    expect(json.frame.last).toBe(8);
    expect(json.counts.draws).toBe(3);
    expect(json.gpu.total).toBe(1);
    expect(json.filled).toBe(1);
    expect(json.window).toBe(3);
    m.reset();
    expect(m.samples).toBe(0);
    expect(m.filled).toBe(0);
    expect(m.head).toBe(0);
    expect([...m.history]).toEqual([0, 0, 0]);
    expect(m.frame).toEqual({ last: 0, avg: 0, p95: 0, max: 0, fps: 0 });
    expect(m.gpu).toBeNull();
    expect(m.counts).toEqual({});
  });

  it('allocates no new objects per frame in steady state', () => {
    const m = createPerfMonitor({ window: 5 });
    const src = fakeSource();
    src.timing.samples = 1;
    src.timing.passes.scene = 1;
    m.sample(src);
    const frame = m.frame;
    const counts = m.counts;
    const gpu = m.gpu;
    for (let i = 0; i < 50; i++) {
      m.begin(0);
      m.end(i);
      m.sample(src);
    }
    expect(m.frame).toBe(frame);
    expect(m.counts).toBe(counts);
    expect(m.gpu).toBe(gpu);
    expect(m.filled).toBe(5);
  });
});

describe('createPerfOverlay', () => {
  let overlay: PerfOverlay | null = null;
  afterEach(() => {
    overlay?.destroy();
    overlay = null;
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  function stepped(m = createPerfMonitor({ window: 10 }), n = 12) {
    const src = fakeSource();
    for (let i = 1; i <= n; i++) {
      m.begin(0);
      m.end(i);
      m.sample(src);
    }
    return m;
  }

  it('mounts an aria-hidden, pointer-transparent box in the corner with the numbers and a canvas', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const m = stepped();
    overlay = createPerfOverlay(m, { parent, corner: 'br', updateEvery: 1 });
    const el = overlay.el;
    expect(el.parentElement).toBe(parent);
    expect(el.classList.contains('tc-perf')).toBe(true);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.dataset.corner).toBe('br');
    expect(el.hasAttribute('data-fixed')).toBe(false);
    expect(el.querySelector('canvas.tc-perf-graph')).not.toBeNull();
    const style = document.head.querySelector('style[data-tc="perf"]');
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain('pointer-events: none');
    expect(style!.textContent).toContain('var(--tc-font-mono');
    expect(style!.textContent).toContain('var(--tc-color-text');
    // Numbers after an update: frame times 3..12, mean 7.5.
    overlay.update();
    expect(el.textContent).toContain('7.50 ms');
    expect(el.textContent).toContain('133 fps');
    expect(el.textContent).toContain('drawCalls 3');
    expect(el.textContent).toContain('instances 50');
    expect(el.textContent).toContain('culled 7');
    expect(el.textContent).toContain('scale 0.75');
    expect(el.textContent).toContain('gpu  –');
    expect(overlay.visible).toBe(true);
  });

  it('defaults to a fixed box on <body> with no graph when graph is false', () => {
    overlay = createPerfOverlay(createPerfMonitor(), { graph: false });
    expect(overlay.el.parentElement).toBe(document.body);
    expect(overlay.el.hasAttribute('data-fixed')).toBe(true);
    expect(overlay.el.dataset.corner).toBe('tl');
    expect(overlay.el.querySelector('canvas')).toBeNull();
    // One stylesheet per document.
    createPerfOverlay(createPerfMonitor(), { graph: false }).destroy();
    expect(document.head.querySelectorAll('style[data-tc="perf"]').length).toBe(1);
  });

  it('redraws every updateEvery calls and shows GPU passes', () => {
    const m = createPerfMonitor({ window: 10 });
    const src = fakeSource();
    overlay = createPerfOverlay(m, { parent: document.body, updateEvery: 3 });
    const before = overlay.el.textContent;
    src.timing.samples = 1;
    src.timing.gpuMs = 3.25;
    src.timing.passes = { pre: 0.2, scene: 2.5, bloom: 0.55, tiny: 0.001 };
    m.begin(0);
    m.end(10);
    m.sample(src);
    overlay.update();
    overlay.update();
    expect(overlay.el.textContent).toBe(before);
    overlay.update();
    const text = overlay.el.textContent ?? '';
    expect(text).not.toBe(before);
    expect(text).toContain('gpu  3.25 ms');
    expect(text).toContain('scene');
    expect(text).toContain('2.50');
    expect(text).toContain('bloom');
    expect(text).not.toContain('tiny');
  });

  it('show, hide and toggle; a hidden overlay skips work; destroy removes it', () => {
    const m = stepped();
    overlay = createPerfOverlay(m, { parent: document.body, updateEvery: 1 });
    overlay.hide();
    expect(overlay.visible).toBe(false);
    expect(overlay.el.hidden).toBe(true);
    const text = overlay.el.textContent;
    stepped(m, 5);
    overlay.update();
    expect(overlay.el.textContent).toBe(text);
    overlay.toggle();
    expect(overlay.visible).toBe(true);
    overlay.update();
    expect(overlay.el.textContent).not.toBe(text);
    overlay.toggle();
    expect(overlay.visible).toBe(false);
    overlay.show();
    expect(overlay.visible).toBe(true);
    overlay.destroy();
    expect(overlay.el.isConnected).toBe(false);
    expect(overlay.visible).toBe(false);
    expect(() => overlay!.update()).not.toThrow();
  });
});

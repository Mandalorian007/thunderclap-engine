// The frame governor on synthetic frame traces, ported from Forge Wilds' test/governor.test.ts:
// it sheds within 2 s of frames missing for the GPU's sake, not for the main thread's or a capped
// frame rate's, restores after 20 s clean, changes at most once every 2 s (and a few times a
// minute), and holds a step shed for 5 minutes once it failed twice.
import { describe, expect, it } from 'vitest';
import { DynamicResolution } from '../render/dynamic-resolution';
import { createGovernor, type Governor, type GovernorChange } from './governor';
import { dynamicResolutionKnob, stepKnob, toggleKnob } from './knobs';

/** A governor with three one-step knobs, recording what is applied. */
function ladder() {
  const applied: string[] = [];
  const g = createGovernor({
    rungs: ['precipitation', 'splashes', 'cloud shadows'].map((name, i) =>
      toggleKnob(name, (shed) => applied.push(`${shed ? '-' : '+'}${name}`), i + 1),
    ),
  });
  return { g, applied };
}

interface Trace {
  interval: number;
  cpu: number;
  latency?: number | null;
}

/** Frames at a steady interval for `ms`, from `t`; the time after and the changes made. */
function run(
  g: Governor,
  t: number,
  ms: number,
  f: Trace,
): { t: number; changes: GovernorChange[] } {
  const changes: GovernorChange[] = [];
  const end = t + ms;
  let i = 0;
  while (t < end) {
    t += f.interval;
    const c = g.frame(t, f.interval, f.cpu, i++ % 8 === 0 ? (f.latency ?? null) : null);
    if (c) changes.push(c);
  }
  return { t, changes };
}

const GOOD: Trace = { interval: 1000 / 60, cpu: 4, latency: 10 };
/** GPU-bound: every frame misses a vsync, the main thread had time, the GPU didn't. */
const GPU_BOUND: Trace = { interval: 1000 / 30, cpu: 4, latency: 30 };

describe('createGovernor (ported traces)', () => {
  it("sheds within 2 s of frames missing for the GPU's sake, cheapest first", () => {
    const { g, applied } = ladder();
    let { t } = run(g, 0, 5000, GOOD);
    expect(g.shed).toBe(0);
    const bad = run(g, t, 2500, GPU_BOUND);
    t = bad.t;
    expect(bad.changes.length).toBe(1);
    expect(bad.changes[0]!.at - 5000).toBeLessThanOrEqual(2100 + 1000 / 30);
    expect(applied).toEqual(['-precipitation']);
    const more = run(g, t, 2500, GPU_BOUND);
    expect(more.changes.length).toBe(1);
    expect(more.changes[0]!.at - bad.changes[0]!.at).toBeGreaterThanOrEqual(2000);
    expect(applied).toEqual(['-precipitation', '-splashes']);
    expect(g.line).toBe('governor: shed precipitation, splashes');
  });

  it("doesn't shed for the main thread's stalls, a capped frame rate or gaps", () => {
    const { g } = ladder();
    let r = run(g, 0, 10_000, { interval: 1000 / 30, cpu: 25, latency: 30 });
    expect(r.changes.length).toBe(0);
    r = run(g, r.t, 10_000, { interval: 1000 / 30, cpu: 3, latency: 5 });
    expect(r.changes.length).toBe(0);
    r = run(g, r.t, 10_000, { interval: 400, cpu: 1, latency: 30 });
    expect(r.changes.length).toBe(0);
    expect(g.shed).toBe(0);
  });

  it('restores after 20 s clean, one at a time, the last shed first', () => {
    const { g, applied } = ladder();
    const { t } = run(g, 0, 6200, GPU_BOUND);
    expect(g.shed).toBe(3);
    const back = run(g, t, 19_000, GOOD);
    expect(back.changes.length).toBe(0);
    const after = run(g, back.t, 2000, GOOD);
    expect(after.changes.length).toBe(1);
    expect(after.changes[0]!.dir).toBe('up');
    expect(g.shed).toBe(2);
    expect(applied.at(-1)).toBe('+cloud shadows');
    run(g, after.t, 80_000, GOOD);
    expect(g.shed).toBe(0);
    expect(g.line).toBe('governor: full quality');
  });

  it('an oscillating trace changes at most once every 2 s and four times a minute', () => {
    const { g } = ladder();
    const all: GovernorChange[] = [];
    let t = 0;
    for (let k = 0; k < 6; k++) {
      let r = run(g, t, 3000, GPU_BOUND);
      all.push(...r.changes);
      r = run(g, r.t, 25_000, GOOD);
      all.push(...r.changes);
      t = r.t;
    }
    for (let i = 1; i < all.length; i++)
      expect(all[i]!.at - all[i - 1]!.at).toBeGreaterThanOrEqual(2000);
    for (const c of all) {
      expect(all.filter((d) => d.at >= c.at && d.at < c.at + 60_000).length).toBeLessThanOrEqual(4);
    }
    const { g: h } = ladder();
    const swings: GovernorChange[] = [];
    t = 0;
    for (let k = 0; k < 24; k++) {
      swings.push(...run(h, t, 2500, GPU_BOUND).changes);
      t += 2500;
      swings.push(...run(h, t, 2500, GOOD).changes);
      t += 2500;
    }
    expect(swings.every((c) => c.dir === 'down')).toBe(true);
    expect(swings.length).toBeLessThanOrEqual(3);
  });

  it('a step that failed twice within 2 minutes stays shed for 5 minutes', () => {
    const { g } = ladder();
    let t = run(g, 0, 2200, GPU_BOUND).t;
    expect(g.shed).toBe(1);
    for (let k = 0; k < 2; k++) {
      t = run(g, t, 40_000, GOOD).t;
      expect(g.shed).toBe(0);
      t = run(g, t, 4500, GPU_BOUND).t;
      expect(g.shed).toBeGreaterThanOrEqual(1);
      if (g.shed > 1) g.set(1, t);
    }
    t = run(g, t, 240_000, GOOD).t;
    expect(g.shed).toBe(1);
    t = run(g, t, 70_000, GOOD).t;
    expect(g.shed).toBe(0);
  });
});

describe('createGovernor: knobs', () => {
  it('steps a multi-step knob to its limit before the next, by cost', () => {
    let count = 4;
    const log: string[] = [];
    const g = createGovernor({
      rungs: [
        toggleKnob('shadows', (s) => log.push(`shadows ${s}`), 5),
        stepKnob({
          name: 'particles',
          get: () => count,
          set: (v) => (count = v),
          min: 2,
          max: 4,
          step: 1,
          cost: 1,
        }),
      ],
    });
    expect(g.knobs.map((k) => k.name)).toEqual(['particles', 'shadows']);
    g.set(3);
    expect(count).toBe(2);
    expect(log).toEqual(['shadows true']);
    expect(g.shed).toBe(3);
    expect(g.line).toBe('governor: shed particles ×2, shadows');
    g.set(10); // every knob at its limit: stays at 3
    expect(g.shed).toBe(3);
    g.set(1);
    expect(log).toEqual(['shadows true', 'shadows false']);
    expect(count).toBe(3);
  });

  it('a removed knob gives back every step it took', () => {
    let v = 10;
    const g = createGovernor();
    const off = g.register(
      stepKnob({ name: 'distance', get: () => v, set: (x) => (v = x), min: 4, max: 10, step: 2 }),
    );
    g.register(toggleKnob('fog', () => {}, 2));
    g.set(4);
    expect(v).toBe(4);
    off();
    expect(v).toBe(10);
    expect(g.shed).toBe(1);
    expect(g.knobs.map((k) => k.name)).toEqual(['fog']);
  });

  it('off, or with no knobs, it judges nothing', () => {
    const g = createGovernor();
    expect(run(g, 0, 10_000, GPU_BOUND).changes).toEqual([]);
    const { g: h } = ladder();
    h.enabled = false;
    expect(run(h, 0, 10_000, GPU_BOUND).changes).toEqual([]);
    expect(h.line).toBe('governor off');
  });

  it('steps dynamic resolution down under a synthetic GPU load and back up when it clears', () => {
    const dr = new DynamicResolution({ minScale: 0.5, maxScale: 1 });
    const scales: number[] = [];
    const g = createGovernor({
      rungs: [dynamicResolutionKnob(dr, { apply: (s) => scales.push(s) })],
    });
    // A synthetic load: the GPU's frame time scales with the pixels drawn (scale²); 1.0 costs 30 ms.
    let t = 0;
    const tick = (ms: number) => {
      const end = t + ms;
      let i = 0;
      while (t < end) {
        const gpu = 30 * dr.scale * dr.scale;
        const interval = gpu > 1000 / 60 ? 2 * (1000 / 60) : 1000 / 60;
        t += interval;
        g.frame(t, interval, 3, i++ % 8 === 0 ? gpu : null);
      }
    };
    tick(15_000);
    // 0.7² × 30 = 14.7 ms fits a 16.7 ms frame: it stops there (until a clean spell probes back up).
    expect(dr.scale).toBeCloseTo(0.7);
    expect(scales).toEqual([0.9, 0.8, 0.7]);
    // The load clears (1.0 costs 8 ms): it climbs back, one step per clean spell.
    for (let k = 0; k < 4; k++) {
      const end = t + 22_000;
      while (t < end) {
        t += 1000 / 60;
        g.frame(t, 1000 / 60, 3, null);
      }
    }
    expect(dr.scale).toBeCloseTo(1);
    expect(g.shed).toBe(0);
  });
});

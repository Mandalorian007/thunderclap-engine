import { describe, expect, it } from 'vitest';
import { DynamicResolution } from './dynamic-resolution';
import { sceneSize } from './renderer';

/** Run a constant-cost "scene" whose GPU time scales with pixels; returns scales seen. */
function run(
  dr: DynamicResolution,
  costAtFull: (t: number) => number,
  ms: number,
  t0 = 0,
  dt = 100,
): number[] {
  const seen: number[] = [];
  for (let t = t0; t < t0 + ms; t += dt) {
    seen.push(dr.sample(costAtFull(t) * dr.scale ** 2, t));
  }
  return seen;
}

describe('DynamicResolution', () => {
  it('holds full scale when under budget', () => {
    const dr = new DynamicResolution();
    const seen = run(dr, () => 9, 20_000);
    expect(new Set(seen)).toEqual(new Set([1]));
  });

  it('does not react to a short spike', () => {
    const dr = new DynamicResolution();
    const seen = run(dr, (t) => (t >= 2000 && t < 2500 ? 30 : 9), 10_000);
    expect(Math.min(...seen)).toBe(1);
  });

  it('drops under sustained load and settles without pumping', () => {
    const dr = new DynamicResolution({ minScale: 0.5 });
    const seen = run(dr, () => 20, 60_000);
    const final = seen.at(-1)!;
    expect(final).toBeLessThan(1);
    // Settled: no changes in the last 30 s.
    expect(new Set(seen.slice(-300)).size).toBe(1);
    // And the settled scale is under budget.
    expect(20 * final ** 2).toBeLessThanOrEqual(dr.budgetMs);
    // Monotone: never went back up then down.
    let changes = 0;
    for (let i = 1; i < seen.length; i++) if (seen[i] !== seen[i - 1]) changes++;
    expect(changes).toBeLessThanOrEqual(3);
  });

  it('recovers slowly after the load goes away', () => {
    const dr = new DynamicResolution({ minScale: 0.5 });
    run(dr, () => 24, 10_000);
    const low = dr.scale;
    expect(low).toBeLessThan(0.8);
    const after = run(dr, () => 8, 2_500, 10_000);
    expect(Math.max(...after)).toBe(low); // not within 2.5 s
    run(dr, () => 8, 40_000, 12_500);
    expect(dr.scale).toBe(1);
  });

  it('does not oscillate at the edge', () => {
    // Full res costs 15 ms (just over 14); 0.9 costs 12.2 (under 14 × 0.85 = 11.9? no: over).
    const dr = new DynamicResolution();
    const seen = run(dr, () => 15.5, 120_000);
    let changes = 0;
    for (let i = 1; i < seen.length; i++) if (seen[i] !== seen[i - 1]) changes++;
    expect(changes).toBeLessThanOrEqual(3);
  });

  it('reports saturation at the floor', () => {
    const dr = new DynamicResolution({ minScale: 0.6 });
    run(dr, () => 80, 20_000);
    expect(dr.scale).toBeCloseTo(0.6);
    expect(dr.saturated).toBe(true);
  });

  it('ignores junk samples', () => {
    const dr = new DynamicResolution();
    expect(dr.sample(Number.NaN, 0)).toBe(1);
    expect(dr.sample(-1, 0)).toBe(1);
    expect(dr.estimateMs).toBe(-1);
  });
});

describe('sceneSize', () => {
  const full = { scale: 1, maxPixels: Number.POSITIVE_INFINITY };

  it('is the output size at scale 1', () => {
    expect(sceneSize(2560, 1440, full)).toEqual({ width: 2560, height: 1440, scale: 1 });
  });

  it('applies the pixel budget', () => {
    const s = sceneSize(2560, 1440, { scale: 1, maxPixels: 1280 * 720 });
    expect(s.width).toBe(1280);
    expect(s.height).toBe(720);
    expect(s.scale).toBe(0.5);
  });

  it('combines scale and budget, keeping even sizes', () => {
    const s = sceneSize(1920, 1080, { scale: 0.85, maxPixels: Number.POSITIVE_INFINITY });
    expect(s.width % 2).toBe(0);
    expect(s.height % 2).toBe(0);
    expect(s.width).toBeCloseTo(1632, -1);
    const b = sceneSize(1920, 1080, { scale: 0.9, maxPixels: 1280 * 720 });
    expect(b.width * b.height).toBeLessThanOrEqual(1280 * 722);
  });

  it('clamps the scale to [0.25, 1]', () => {
    expect(sceneSize(800, 600, { scale: 3, maxPixels: Number.POSITIVE_INFINITY }).width).toBe(800);
    expect(sceneSize(800, 600, { scale: 0.01, maxPixels: Number.POSITIVE_INFINITY }).width).toBe(
      200,
    );
  });
});

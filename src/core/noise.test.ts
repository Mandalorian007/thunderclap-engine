import { describe, expect, it } from 'vitest';
import { createNoise, type NoiseFn } from './noise';

const noise = createNoise('noise');
const fns: [string, NoiseFn][] = [
  ['value2', noise.value2],
  ['value3', noise.value3],
  ['perlin2', noise.perlin2],
  ['perlin3', noise.perlin3],
  ['simplex2', noise.simplex2],
  ['simplex3', noise.simplex3],
];

/** A deterministic scatter of sample points over a few hundred lattice cells. */
function* points(n: number): Generator<[number, number, number]> {
  for (let i = 0; i < n; i++) {
    yield [
      ((i * 0.6180339) % 37) - 18.3,
      ((i * 0.4142135) % 29) - 9.7,
      ((i * 0.7320508) % 23) - 4.1,
    ];
  }
}

describe('createNoise', () => {
  it.each(fns)('%s stays in [-1, 1] and uses the span', (_name, fn) => {
    let min = Infinity;
    let max = -Infinity;
    for (const [x, y, z] of points(20000)) {
      const v = fn(x, y, z);
      expect(Number.isFinite(v)).toBe(true);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThanOrEqual(-1);
    expect(max).toBeLessThanOrEqual(1);
    expect(max - min).toBeGreaterThan(0.8);
  });

  it.each(fns)('%s is continuous: adjacent samples differ by a bounded amount', (_name, fn) => {
    const h = 1e-3;
    let worst = 0;
    for (const [x, y, z] of points(4000)) {
      const v = fn(x, y, z);
      worst = Math.max(
        worst,
        Math.abs(fn(x + h, y, z) - v),
        Math.abs(fn(x, y + h, z) - v),
        Math.abs(fn(x, y, z + h) - v),
      );
    }
    // Gradients stay below ~10 per unit; a jump at a cell edge would show as ~1.
    expect(worst).toBeLessThan(0.01);
  });

  it('is deterministic per seed and differs between seeds', () => {
    const a = createNoise(7);
    const b = createNoise(7);
    const c = createNoise(8);
    let differ = 0;
    for (const [x, y, z] of points(200)) {
      expect(a.perlin3(x, y, z)).toBe(b.perlin3(x, y, z));
      expect(a.simplex2(x, y)).toBe(b.simplex2(x, y));
      expect(a.value3(x, y, z)).toBe(b.value3(x, y, z));
      if (a.simplex3(x, y, z) !== c.simplex3(x, y, z)) differ++;
    }
    expect(differ).toBeGreaterThan(190);
  });

  it('perlin is 0 on the lattice', () => {
    expect(noise.perlin2(3, -5)).toBe(0);
    expect(noise.perlin3(1, 2, -7)).toBe(0);
  });

  it('fbm with one octave equals the base and stays in range', () => {
    const one = { octaves: 1 };
    const five = { octaves: 5, lacunarity: 2.1, gain: 0.55 };
    for (const [x, y, z] of points(500)) {
      expect(noise.fbm(noise.perlin3, x, y, z, one)).toBe(noise.perlin3(x, y, z));
      expect(noise.fbm(noise.value2, x, y, undefined, one)).toBe(noise.value2(x, y));
      const v = noise.fbm(noise.simplex2, x, y, 0, five);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
    // Defaults: four octaves, not the base.
    expect(noise.fbm(noise.perlin2, 0.3, 0.7)).not.toBe(noise.perlin2(0.3, 0.7));
  });

  it('pins the harness field (harness/core2.ts ?noise; e2e/core2.spec.ts asserts the same)', () => {
    const n = createNoise('core2');
    const opts = { octaves: 5, lacunarity: 2, gain: 0.5 };
    let h = 0x811c9dc5;
    for (let r = 0; r < 72; r++) {
      for (let c = 0; c < 128; c++) {
        const v = n.fbm(n.perlin3, (c + 0.5) / 16, (r + 0.5) / 16, 0, opts);
        h = Math.imul(h ^ (Math.round(v * 1e4) | 0), 0x01000193);
      }
    }
    expect(h >>> 0).toBe(CORE2_NOISE_CHECKSUM);
  });
});

const CORE2_NOISE_CHECKSUM = 3460057681;

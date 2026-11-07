import { describe, expect, it } from 'vitest';
import { hash2, hash2f, hash3, hash3f } from './hash';
import { seedKey } from './random';

const N = 256;

/** Mean and lag-1 correlations (along each grid axis) of `f` over an N×N grid. */
function stats(f: (a: number, b: number) => number): { mean: number; lagA: number; lagB: number } {
  const v = new Float64Array(N * N);
  let sum = 0;
  for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) sum += v[a + N * b] = f(a, b);
  const mean = sum / (N * N);
  let varSum = 0;
  let covA = 0;
  let covB = 0;
  for (let b = 0; b < N; b++) {
    for (let a = 0; a < N; a++) {
      const d = v[a + N * b]! - mean;
      varSum += d * d;
      if (a + 1 < N) covA += d * (v[a + 1 + N * b]! - mean);
      if (b + 1 < N) covB += d * (v[a + N * (b + 1)]! - mean);
    }
  }
  const pairs = N * (N - 1);
  const variance = varSum / (N * N);
  return { mean, lagA: covA / pairs / variance, lagB: covB / pairs / variance };
}

describe('hash2 / hash3', () => {
  it('pins golden values', () => {
    expect([hash2(0, 0, 0), hash2(1337, 3, -7), hash2('level-3', 10, 20)]).toEqual([
      2381976349, 1667731467, 189765882,
    ]);
    expect([hash3(0, 0, 0, 0), hash3(42, 1, 2, 3), hash3('cave', -5, 9, 100)]).toEqual([
      1372096600, 1129999541, 3452799249,
    ]);
  });

  it('returns uint32s and floats in [0, 1)', () => {
    for (let i = -50; i < 50; i++) {
      const u = hash2(i, i * 7, -i);
      expect(Number.isInteger(u) && u >= 0 && u <= 0xffffffff).toBe(true);
      const f = hash3f(i, i, -i, i * 3);
      expect(f >= 0 && f < 1).toBe(true);
    }
    expect(hash2f(9, 4, 5)).toBe(hash2(9, 4, 5) / 4294967296);
    expect(hash3f(9, 4, 5, 6)).toBe(hash3(9, 4, 5, 6) / 4294967296);
  });

  it('uses the Random seed hash and truncates its inputs', () => {
    expect(hash2('level-3', 1, 2)).toBe(hash2(seedKey('level-3'), 1, 2));
    expect(hash3(-1, 1, 2, 3)).toBe(hash3(0xffffffff, 1, 2, 3));
    expect(hash2(5, 2.9, -0.5)).toBe(hash2(5, 2, 0));
    expect(hash3(5, 2.9, -1.5, 7.01)).toBe(hash3(5, 2, -1, 7));
    // 1.5 is not an integer seed, so it is FNV-hashed as a string, like createRandom(1.5).
    expect(hash2(1.5, 0, 0)).toBe(hash2('1.5', 0, 0));
  });

  it('separates seeds, axes and dimensions', () => {
    expect(hash2(1, 2, 3)).not.toBe(hash2(2, 2, 3));
    expect(hash2(1, 2, 3)).not.toBe(hash2(1, 3, 2));
    expect(hash3(1, 2, 0, 3)).not.toBe(hash2(1, 2, 3));
    expect(hash3(1, 1, 2, 3)).not.toBe(hash3(1, 1, 3, 2));
  });

  it('has an unbiased mean and no lag-1 correlation over a 256×256 grid', () => {
    // n = 65536 uniforms: the mean's sd is 0.0011 and a lag-1 correlation's about 0.004.
    const cases = [
      stats((x, z) => hash2f(7, x, z)),
      stats((x, z) => hash2f('terrain', x - 128, z - 128)),
      stats((x, z) => hash3f(7, x, 0, z)),
      stats((x, y) => hash3f(7, x, y, 11)),
      stats((y, z) => hash3f(7, -3, y, z)),
    ];
    for (const s of cases) {
      expect(Math.abs(s.mean - 0.5)).toBeLessThan(0.006);
      expect(Math.abs(s.lagA)).toBeLessThan(0.02);
      expect(Math.abs(s.lagB)).toBeLessThan(0.02);
    }
  });

  it('spreads each bit evenly over a grid (no stuck low bits)', () => {
    const ones = new Int32Array(32);
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const u = hash2(3, x, z);
        for (let b = 0; b < 32; b++) ones[b]! += (u >>> b) & 1;
      }
    }
    for (let b = 0; b < 32; b++) expect(Math.abs(ones[b]! / (N * N) - 0.5)).toBeLessThan(0.01);
  });
});

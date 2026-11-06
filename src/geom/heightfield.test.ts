import { describe, expect, it } from 'vitest';
import { GEOMETRY_FLOATS } from './geometry';
import {
  createHeightfield,
  type Heightfield,
  heightAt,
  heightfieldGeometry,
  normalAt,
  raycastHeightfield,
  rayHeightfield,
} from './heightfield';

const F = GEOMETRY_FLOATS;

/** A 3×3 field with hand-set corners: a step up along x, a bump in the middle. */
function sample(): Heightfield {
  const hf = createHeightfield(3, 3, { scale: [2, 0.5, 2], origin: [-2, 1, -2] });
  // biome-ignore format: grid
  hf.heights.set([
    0, 1, 2,
    0, 4, 2,
    0, 1, 2,
  ]);
  return hf;
}

/** A plane sloping up along x: height = x (in grid units). */
function slope(n = 5): Heightfield {
  const hf = createHeightfield(n, n);
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) hf.heights[z * n + x] = x;
  return hf;
}

describe('createHeightfield', () => {
  it('sizes the heights and copies scale and origin', () => {
    const hf = createHeightfield(4, 3);
    expect(hf.heights.length).toBe(12);
    expect(hf.scale).toEqual([1, 1, 1]);
    expect(hf.origin).toEqual([0, 0, 0]);
    expect(() => createHeightfield(1, 3)).toThrow(/at least 2×2/);
    expect(() => createHeightfield(2, 2, { heights: new Float32Array(3) })).toThrow(/expected 4/);
  });
});

describe('heightAt', () => {
  it('returns the samples at the grid points, in world units', () => {
    const hf = sample();
    expect(heightAt(hf, -2, -2)).toBe(1); // h 0 → origin.y + 0 × 0.5
    expect(heightAt(hf, 0, 0)).toBe(1 + 4 * 0.5);
    expect(heightAt(hf, 2, -2)).toBe(1 + 2 * 0.5);
  });

  it('is bilinear between them', () => {
    const hf = sample();
    // Midway between (0,0)=0 and (1,0)=1 along x on the first row: 0.5.
    expect(heightAt(hf, -1, -2)).toBeCloseTo(1 + 0.5 * 0.5, 6);
    // Centre of the first cell: (0 + 1 + 0 + 4) / 4 = 1.25.
    expect(heightAt(hf, -1, -1)).toBeCloseTo(1 + 1.25 * 0.5, 6);
    // Quarter of the way: (1-u)(1-v)h00 + u(1-v)h10 + (1-u)v h01 + uv h11 with u = v = 0.25.
    const u = 0.25;
    const h = (1 - u) * (1 - u) * 0 + u * (1 - u) * 1 + (1 - u) * u * 0 + u * u * 4;
    expect(heightAt(hf, -2 + 0.5, -2 + 0.5)).toBeCloseTo(1 + h * 0.5, 6);
  });

  it('clamps outside the field to the edge', () => {
    const hf = sample();
    expect(heightAt(hf, -10, 0)).toBe(heightAt(hf, -2, 0));
    expect(heightAt(hf, 10, 10)).toBe(heightAt(hf, 2, 2));
  });
});

describe('normalAt', () => {
  it('is up on flat ground and tilts against a slope, unit length', () => {
    const flat = createHeightfield(3, 3);
    const n = normalAt(flat, 1, 1, [0, 0, 0]);
    expect(n).toEqual([0, 1, 0]);
    const s = slope();
    const m = normalAt(s, 2, 2, new Float32Array(3));
    // Height = x: the normal is (-1, 1, 0) / √2.
    expect(m[0]).toBeCloseTo(-Math.SQRT1_2, 5);
    expect(m[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(m[2]).toBeCloseTo(0, 5);
  });

  it('accounts for the scale', () => {
    const s = slope();
    s.scale[0] = 2; // the same rise over twice the run: slope 1/2
    const m = normalAt(s, 4, 4, [0, 0, 0]);
    expect(m[0] / m[1]).toBeCloseTo(-0.5, 5);
  });
});

describe('raycastHeightfield', () => {
  it('hits a slope at the analytic distance and writes the hit point', () => {
    const s = slope();
    // From (0, 3, 2) straight down -x at 45°: dir (1, -1, 0)/√2 meets y = x at x = 1.5.
    const d = Math.SQRT1_2;
    const out: [number, number, number] = [0, 0, 0];
    const t = raycastHeightfield(s, { origin: [0, 3, 2], dir: [d, -d, 0] }, out);
    expect(t).toBeCloseTo(1.5 * Math.SQRT2, 6);
    expect(out[0]).toBeCloseTo(1.5, 6);
    expect(out[1]).toBeCloseTo(1.5, 6);
    expect(out[2]).toBeCloseTo(2, 6);
    // Vertically down onto the slope from above.
    expect(raycastHeightfield(s, { origin: [2.5, 10, 1.3], dir: [0, -1, 0] })).toBeCloseTo(7.5, 6);
  });

  it('misses above the field and when it never reaches the footprint', () => {
    const s = slope();
    expect(raycastHeightfield(s, { origin: [0, 10, 2], dir: [1, 0, 0] })).toBe(-1);
    expect(raycastHeightfield(s, { origin: [0, 10, 2], dir: [0, 1, 0] })).toBe(-1);
    expect(raycastHeightfield(s, { origin: [-5, 0.5, 2], dir: [-1, 0, 0] })).toBe(-1);
    expect(raycastHeightfield(s, { origin: [2, 1, -5], dir: [0, 0, -1] })).toBe(-1);
  });

  it('lands exactly on the bilinear surface inside a curved cell', () => {
    const hf = sample();
    const out = new Float64Array(3);
    // Down through the bump's first cell, off its diagonal, in world units (scale 2, 0.5, 2).
    const t = raycastHeightfield(hf, { origin: [-1.4, 20, -0.6], dir: [0, -1, 0] }, out);
    expect(t).toBeGreaterThan(0);
    expect(out[1]).toBeCloseTo(heightAt(hf, -1.4, -0.6), 6);
    expect(20 - t).toBeCloseTo(out[1]!, 6);
    // A slanted ray through the same cell also lands on heightAt.
    const dir = [0.3, -1, 0.2];
    const l = Math.hypot(dir[0]!, dir[1]!, dir[2]!);
    const t2 = raycastHeightfield(
      hf,
      { origin: [-1.9, 6, -1.8], dir: [dir[0]! / l, dir[1]! / l, dir[2]! / l] },
      out,
    );
    expect(t2).toBeGreaterThan(0);
    expect(out[1]).toBeCloseTo(heightAt(hf, out[0]!, out[2]!), 5);
  });

  it('walks cells across the field and enters from outside the footprint', () => {
    const s = slope(9);
    // From outside at x = -3, flying low across: height = x, ray y = 0.5 + 0.1 (x + 3) meets
    // y = x where x = 0.5 + 0.1x + 0.3 → x = 0.8 / 0.9.
    const dir = [1, 0.1, 0];
    const l = Math.hypot(dir[0]!, dir[1]!, dir[2]!);
    const t = raycastHeightfield(s, { origin: [-3, 0.5, 4.4], dir: [1 / l, 0.1 / l, 0] });
    const x = 0.8 / 0.9;
    expect(t).toBeCloseTo((x + 3) * l, 5);
    // Diagonally across many cells from above the far corner.
    const o: [number, number, number] = [7.9, 9, 7.9];
    const d2 = [-1, -2, -1].map((c) => c / Math.sqrt(6));
    const out: [number, number, number] = [0, 0, 0];
    const t3 = raycastHeightfield(s, { origin: o, dir: d2 }, out);
    expect(t3).toBeGreaterThan(0);
    expect(out[1]).toBeCloseTo(heightAt(s, out[0], out[2]), 5);
  });

  it('hits from below as well', () => {
    const s = slope();
    expect(raycastHeightfield(s, { origin: [2, -5, 2], dir: [0, 1, 0] })).toBeCloseTo(7, 6);
  });
});

describe('heightfieldGeometry', () => {
  it('has one vertex per sample at the world positions, up-facing cells, tight bounds', () => {
    const hf = sample();
    const g = heightfieldGeometry(hf);
    expect(g.vertices.length / F).toBe(9);
    expect(g.indices.length).toBe(4 * 6);
    expect(g.indices).toBeInstanceOf(Uint16Array);
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        const o = (j * 3 + i) * F;
        expect(g.vertices[o]).toBe(-2 + i * 2);
        expect(g.vertices[o + 2]).toBe(-2 + j * 2);
        expect(g.vertices[o + 1]).toBeCloseTo(heightAt(hf, -2 + i * 2, -2 + j * 2), 6);
        expect(g.vertices[o + 6]).toBeCloseTo(i / 2, 6);
        expect(g.vertices[o + 7]).toBeCloseTo(j / 2, 6);
        expect(g.vertices[o + 4]).toBeGreaterThan(0);
      }
    }
    // Every triangle faces up.
    const v = g.vertices;
    for (let t = 0; t < g.indices.length; t += 3) {
      const a = g.indices[t]! * F;
      const b = g.indices[t + 1]! * F;
      const c = g.indices[t + 2]! * F;
      const abx = v[b]! - v[a]!;
      const aby = v[b + 1]! - v[a + 1]!;
      const abz = v[b + 2]! - v[a + 2]!;
      const acx = v[c]! - v[a]!;
      const acy = v[c + 1]! - v[a + 1]!;
      const acz = v[c + 2]! - v[a + 2]!;
      expect(abz * acx - abx * acz).toBeGreaterThan(0);
      void aby;
      void acy;
    }
    // Heights 0..4 × 0.5 over origin y 1: y spans 1..3.
    expect(g.bounds.center).toEqual([0, 2, 0]);
    expect(g.bounds.radius).toBeCloseTo(Math.hypot(2, 1, 2), 5);
  });

  it('promotes to 32-bit indices past 65535 samples and builds flat normals on request', () => {
    const big = createHeightfield(300, 300);
    const g = heightfieldGeometry(big);
    expect(g.indices).toBeInstanceOf(Uint32Array);
    expect(g.vertices.length / F).toBe(90000);
    expect(g.indices.length).toBe(299 * 299 * 6);
    const flat = heightfieldGeometry(slope(3), { flat: true });
    expect(flat.vertices.length / F).toBe(4 * 6);
    for (let o = 0; o < flat.vertices.length; o += F) {
      expect(flat.vertices[o + 3]).toBeCloseTo(-Math.SQRT1_2, 5);
      expect(flat.vertices[o + 4]).toBeCloseTo(Math.SQRT1_2, 5);
    }
  });
});

describe('rayHeightfield (ws/ergo-3d)', () => {
  it('is raycastHeightfield with origin and dir arrays, hit point in out', () => {
    const s = slope();
    const d = Math.SQRT1_2;
    const out = new Float32Array(3);
    const t = rayHeightfield(s, [0, 3, 2], new Float32Array([d, -d, 0]), out);
    expect(t).toBeCloseTo(raycastHeightfield(s, { origin: [0, 3, 2], dir: [d, -d, 0] }), 5);
    expect(out[0]).toBeCloseTo(1.5, 5);
    expect(out[1]).toBeCloseTo(1.5, 5);
    expect(rayHeightfield(s, [0, 10, 2], [0, 1, 0])).toBe(-1);
  });
});

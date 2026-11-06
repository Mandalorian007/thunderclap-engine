import { describe, expect, it } from 'vitest';
import { type Profile2D, profileArea2, triangulate } from './triangulate';

/** Twice the signed area of the triangles `tris` indexes into `p`. */
function triArea2(p: Profile2D, tris: Uint16Array | Uint32Array): number {
  let a = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const i = tris[t]! * 2;
    const j = tris[t + 1]! * 2;
    const k = tris[t + 2]! * 2;
    a += (p[j]! - p[i]!) * (p[k + 1]! - p[i + 1]!) - (p[j + 1]! - p[i + 1]!) * (p[k]! - p[i]!);
  }
  return a;
}

describe('triangulate', () => {
  it('fans a convex polygon into n - 2 counter-clockwise triangles of the same area', () => {
    const square = [0, 0, 1, 0, 1, 1, 0, 1];
    const tris = triangulate(square);
    expect(tris).toBeInstanceOf(Uint16Array);
    expect(tris.length).toBe(6);
    expect(triArea2(square, tris)).toBeCloseTo(profileArea2(square), 10);
    for (let t = 0; t < tris.length; t += 3) {
      const [i, j, k] = [tris[t]! * 2, tris[t + 1]! * 2, tris[t + 2]! * 2];
      const a =
        (square[j]! - square[i]!) * (square[k + 1]! - square[i + 1]!) -
        (square[j + 1]! - square[i + 1]!) * (square[k]! - square[i]!);
      expect(a).toBeGreaterThan(0);
    }
  });

  it('handles a concave outline (an L and a star) without triangles outside it', () => {
    const L = [0, 0, 2, 0, 2, 1, 1, 1, 1, 2, 0, 2];
    const tris = triangulate(L);
    expect(tris.length).toBe((6 - 2) * 3);
    expect(triArea2(L, tris)).toBeCloseTo(profileArea2(L), 10);
    // Every triangle's centroid lies inside the L (x < 1 or y < 1).
    for (let t = 0; t < tris.length; t += 3) {
      let cx = 0;
      let cy = 0;
      for (let k = 0; k < 3; k++) {
        cx += L[tris[t + k]! * 2]! / 3;
        cy += L[tris[t + k]! * 2 + 1]! / 3;
      }
      expect(cx < 1 || cy < 1).toBe(true);
    }
    const star: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 1 : 0.4;
      const a = (i / 10) * Math.PI * 2;
      star.push(r * Math.cos(a), r * Math.sin(a));
    }
    const st = triangulate(star);
    expect(st.length).toBe(8 * 3);
    expect(triArea2(star, st)).toBeCloseTo(profileArea2(star), 10);
  });

  it('accepts a clockwise outline and still winds counter-clockwise', () => {
    const cw = [0, 0, 0, 1, 1, 1, 1, 0];
    expect(profileArea2(cw)).toBeLessThan(0);
    const tris = triangulate(cw);
    expect(tris.length).toBe(6);
    expect(triArea2(cw, tris)).toBeCloseTo(-profileArea2(cw), 10);
  });

  it('drops collinear and repeated points as zero-area ears', () => {
    const withMid = [0, 0, 0.5, 0, 1, 0, 1, 1, 0, 1]; // a square with a point mid-bottom
    const tris = triangulate(withMid);
    expect(triArea2(withMid, tris)).toBeCloseTo(profileArea2(withMid), 10);
    expect(tris.length % 3).toBe(0);
    expect(tris.length).toBeGreaterThanOrEqual(6);
    const repeated = [0, 0, 1, 0, 1, 0, 1, 1, 0, 1];
    const rt = triangulate(repeated);
    expect(triArea2(repeated, rt)).toBeCloseTo(profileArea2(repeated), 10);
  });

  it('returns nothing for fewer than three points and 32-bit indices past 65535', () => {
    expect(triangulate([0, 0, 1, 1]).length).toBe(0);
    const n = 70000;
    // Float64 points: float32 rounding on a 70000-gon makes half its corners reflex, which the
    // ear test then has to walk (see `triangulate` docs).
    const big: number[] = new Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      big[i * 2] = Math.cos(a) * 1000;
      big[i * 2 + 1] = Math.sin(a) * 1000;
    }
    const tris = triangulate(big);
    expect(tris).toBeInstanceOf(Uint32Array);
    expect(tris.length).toBeGreaterThan(0);
    expect(tris.length % 3).toBe(0);
  });
});

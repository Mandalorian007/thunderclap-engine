/**
 * TAA (ws/post-3): the jitter sequence is bounded and zero-mean over a cycle, the
 * reprojection matrix maps this frame's clip point to where the previous frame saw it, and
 * the blend weight is clamped.
 */
import { describe, expect, it } from 'vitest';
import { mat4 } from '../core/math';
import { halton, TAA_MAX_FEEDBACK, Taa, taaBlendWeight, taaReprojection } from './taa';

describe('TAA jitter', () => {
  it('halton: the base-2 and base-3 radical inverses', () => {
    expect([1, 2, 3, 4].map((i) => halton(i, 2))).toEqual([0.5, 0.25, 0.75, 0.125]);
    expect([1, 2, 3].map((i) => halton(i, 3))).toEqual([1 / 3, 2 / 3, 1 / 9]);
  });

  for (const samples of [8, 16] as const) {
    it(`over ${samples} samples: every offset within ±0.5 px, mean near zero, no two equal`, () => {
      const taa = new Taa(samples);
      let sx = 0;
      let sy = 0;
      const seen = new Set<string>();
      for (let f = 0; f < samples; f++) {
        const [x, y] = taa.jitter(f);
        expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(y)).toBeLessThanOrEqual(0.5);
        seen.add(`${x},${y}`);
        sx += x;
        sy += y;
      }
      expect(seen.size).toBe(samples);
      expect(Math.abs(sx / samples)).toBeLessThan(0.1);
      expect(Math.abs(sy / samples)).toBeLessThan(0.1);
      // The cycle repeats and the returned pair is reused (no allocation per frame).
      const a = taa.jitter(0);
      const [x0, y0] = a;
      expect(taa.jitter(samples)).toBe(a);
      expect([a[0], a[1]]).toEqual([x0, y0]);
    });
  }

  it('blend weight clamps to 0..TAA_MAX_FEEDBACK', () => {
    expect(taaBlendWeight(0.9)).toBe(0.9);
    expect(taaBlendWeight(2)).toBe(TAA_MAX_FEEDBACK);
    expect(taaBlendWeight(-1)).toBe(0);
    expect(taaBlendWeight(Number.NaN)).toBe(0);
  });
});

describe('TAA reprojection', () => {
  const proj = mat4.perspective(mat4.create(), 1, 16 / 9, 0.1, 100);
  const vp = (eye: [number, number, number]) =>
    mat4.multiply(
      mat4.create(),
      proj,
      mat4.lookAt(mat4.create(), eye, [eye[0], eye[1], eye[2] - 10], [0, 1, 0]),
    );
  const clip = new Float32Array(3);

  it('is the identity for a still camera', () => {
    const cur = vp([0, 0, 0]);
    const inv = mat4.invert(mat4.create(), cur)!;
    const m = taaReprojection(mat4.create(), cur, inv);
    for (let i = 0; i < 16; i++) expect(m[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 4);
  });

  it('maps a point seen at the centre now to where the previous camera saw it', () => {
    const prev = vp([0, 0, 0]);
    const cur = vp([1, 0, 0]); // the camera slid right; the point moved left on screen
    const inv = mat4.invert(mat4.create(), cur)!;
    const m = taaReprojection(mat4.create(), prev, inv);
    // World point (1, 0, -10) is dead centre for the current camera (looking down -z from x=1).
    // `transformPoint` divides by w: `clip` holds NDC.
    mat4.transformPoint(clip, cur, 1, 0, -10);
    expect(clip[0]).toBeCloseTo(0, 5);
    const ndcZ = clip[2]!;
    mat4.transformPoint(clip, m, 0, 0, ndcZ);
    const [rx, ry] = [clip[0]!, clip[1]!];
    // The previous camera at x=0 saw it to the right of centre.
    expect(rx).toBeGreaterThan(0.005);
    expect(Math.abs(ry)).toBeLessThan(1e-4);
    // And the same as projecting the world point directly through the previous matrix.
    mat4.transformPoint(clip, prev, 1, 0, -10);
    expect(rx).toBeCloseTo(clip[0]!, 4);
  });
});

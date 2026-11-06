/** SSR (ws/post-3): the march step and the fades the shader mirrors. */
import { describe, expect, it } from 'vitest';
import { ssrEdgeFade, ssrRoughnessFade, ssrStep } from './ssr';

describe('SSR helpers', () => {
  it('step: the longest ray split into the step budget, never degenerate', () => {
    expect(ssrStep(20, 32)).toBeCloseTo(0.625);
    expect(ssrStep(20, 0)).toBe(20);
    expect(ssrStep(0, 32)).toBeGreaterThan(0);
  });

  it('edge fade: 1 inside, smooth to 0 at the border, 0 outside', () => {
    expect(ssrEdgeFade(0.5, 0.5, 0.15)).toBe(1);
    expect(ssrEdgeFade(0.15, 0.5, 0.15)).toBe(1);
    expect(ssrEdgeFade(0.075, 0.5, 0.15)).toBeCloseTo(0.5);
    expect(ssrEdgeFade(0.5, 0.0375, 0.15)).toBeCloseTo(0.15625);
    expect(ssrEdgeFade(0, 0.5, 0.15)).toBe(0);
    expect(ssrEdgeFade(-0.1, 0.5, 0.15)).toBe(0);
    expect(ssrEdgeFade(0.5, 1.1, 0.15)).toBe(0);
    // A zero width is a hard cut.
    expect(ssrEdgeFade(0.001, 0.5, 0)).toBe(1);
    // Monotonic toward the border.
    let last = 1;
    for (let u = 0.15; u >= 0; u -= 0.01) {
      const f = ssrEdgeFade(u, 0.5, 0.15);
      expect(f).toBeLessThanOrEqual(last);
      last = f;
    }
  });

  it('roughness fade: 1 for a mirror, 0 at the cutoff and beyond', () => {
    expect(ssrRoughnessFade(0, 0.6)).toBe(1);
    expect(ssrRoughnessFade(0.3, 0.6)).toBeCloseTo(0.75);
    expect(ssrRoughnessFade(0.6, 0.6)).toBe(0);
    expect(ssrRoughnessFade(1, 0.6)).toBe(0);
  });
});

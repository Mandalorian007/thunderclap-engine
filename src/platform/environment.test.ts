import { afterEach, describe, expect, it, vi } from 'vitest';
import { isReducedMotion, prefersReducedMotion } from './environment'; // deprecated-alias test

const winWith = (reduce: boolean) =>
  ({
    matchMedia: (q: string) => ({ matches: reduce && q === '(prefers-reduced-motion: reduce)' }),
  }) as unknown as Window;

describe('isReducedMotion', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the given window', () => {
    expect(isReducedMotion(winWith(true))).toBe(true);
    expect(isReducedMotion(winWith(false))).toBe(false);
  });

  it('reads the global matchMedia by default, and is false without one', () => {
    expect(isReducedMotion()).toBe(false);
    vi.stubGlobal('matchMedia', winWith(true).matchMedia);
    expect(isReducedMotion()).toBe(true);
    expect(prefersReducedMotion()).toBe(true); // deprecated-alias test
  });
});

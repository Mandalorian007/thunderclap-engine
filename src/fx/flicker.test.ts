import { describe, expect, it } from 'vitest';
import { flicker, pulse, valueNoise1 } from './flicker';

describe('valueNoise1', () => {
  it('stays in [0,1] and is continuous', () => {
    let prev = valueNoise1(0);
    for (let x = 0; x < 50; x += 0.01) {
      const v = valueNoise1(x, 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (x > 0) expect(Math.abs(v - prev)).toBeLessThan(0.1);
      prev = v;
    }
  });

  it('is deterministic per seed', () => {
    expect(valueNoise1(4.2, 1)).toBe(valueNoise1(4.2, 1));
    expect(valueNoise1(4.2, 1)).not.toBe(valueNoise1(4.2, 2));
  });
});

describe('flicker', () => {
  it('stays within base*(1-amount)..base', () => {
    for (let t = 0; t < 20; t += 0.013) {
      const v = flicker(t, { amount: 0.4, base: 2, seed: 7 });
      expect(v).toBeGreaterThanOrEqual(2 * 0.6 - 1e-9);
      expect(v).toBeLessThanOrEqual(2);
    }
  });
});

describe('pulse', () => {
  it('hits min at phase 0 and max at half period', () => {
    expect(pulse(0, { period: 2, min: 0.2, max: 1 })).toBeCloseTo(0.2);
    expect(pulse(1, { period: 2, min: 0.2, max: 1 })).toBeCloseTo(1);
  });
});

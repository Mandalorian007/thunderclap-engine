import { describe, expect, it } from 'vitest';
import { projectedSizePx, selectLod } from './lod';

const FOV = Math.PI / 2; // tan(fov / 2) = 1: projected px = radius · height / distance

describe('projectedSizePx', () => {
  it('is the diameter over the view height', () => {
    expect(projectedSizePx(1, 10, FOV, 1000)).toBeCloseTo(100, 9);
    expect(projectedSizePx(1, 0, FOV, 1000)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('selectLod', () => {
  const thresholds = [200, 100, 50];
  const pick = (d: number) => selectLod(4, 1, d, FOV, 1000, thresholds);

  it('steps at the exact thresholds', () => {
    expect(pick(5)).toBe(0); // 200 px: exactly level 0's threshold
    expect(pick(5.0001)).toBe(1);
    expect(pick(10)).toBe(1); // 100 px
    expect(pick(10.0001)).toBe(2);
    expect(pick(20)).toBe(2); // 50 px
    expect(pick(20.0001)).toBe(3);
  });

  it('clamps at both ends', () => {
    expect(pick(0)).toBe(0);
    expect(pick(0.01)).toBe(0);
    expect(pick(1e9)).toBe(3);
    // Fewer levels than thresholds: never past the last level.
    expect(selectLod(2, 1, 1e9, FOV, 1000, thresholds)).toBe(1);
    expect(selectLod(2, 1, 10, FOV, 1000, thresholds)).toBe(1);
    // More levels than thresholds: the unthresholded tail is unreachable but the last.
    expect(selectLod(6, 1, 1e9, FOV, 1000, thresholds)).toBe(5);
    expect(selectLod(0, 1, 1, FOV, 1000, thresholds)).toBe(0);
    expect(selectLod(1, 1, 1e9, FOV, 1000, thresholds)).toBe(0);
  });

  it('takes the level list itself', () => {
    expect(selectLod([{}, {}, {}], 1, 10, FOV, 1000, thresholds)).toBe(1);
  });
});

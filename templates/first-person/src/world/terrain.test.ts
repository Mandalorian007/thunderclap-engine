import { describe, expect, it } from 'vitest';
import {
  createTerrain,
  findLandmarks,
  heightAt,
  LAYER_GRASS,
  LAYER_ROCK,
  LAYER_SAND,
  LAYER_SNOW,
  layerForSide,
  layerForTop,
  MAX_HEIGHT,
  MIN_HEIGHT,
  SEED,
  surfaceY,
  WORLD_SIZE,
} from './terrain';

describe('terrain', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = createTerrain(7, 32);
    const b = createTerrain(7, 32);
    const c = createTerrain(8, 32);
    expect(a.heights).toEqual(b.heights);
    expect(a.heights).not.toEqual(c.heights);
  });

  it('keeps every column between MIN_HEIGHT and MAX_HEIGHT and varies', () => {
    const t = createTerrain(1, 48);
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    for (const h of t.heights) {
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    expect(lo).toBeGreaterThanOrEqual(MIN_HEIGHT);
    expect(hi).toBeLessThanOrEqual(MAX_HEIGHT);
    expect(hi - lo).toBeGreaterThanOrEqual(4);
  });

  it('reads 0 outside the field and the column top inside', () => {
    const t = createTerrain(3, 16);
    expect(heightAt(t, -1, 0)).toBe(0);
    expect(heightAt(t, 0, 16)).toBe(0);
    expect(heightAt(t, 5, 9)).toBe(t.heights[9 * 16 + 5]);
    expect(surfaceY(t, 5.7, 9.2)).toBe(heightAt(t, 5, 9));
  });

  it('the shipped seed keeps the height range and spawns on solid ground', () => {
    // createNoise's field, not the old hand-rolled value noise: the shape moved, the band did not.
    const t = createTerrain(SEED);
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    for (const h of t.heights) {
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    expect(lo).toBeGreaterThanOrEqual(MIN_HEIGHT);
    expect(hi).toBeLessThanOrEqual(MAX_HEIGHT);
    expect(hi - lo).toBeGreaterThanOrEqual(6);
    // `respawn` stands the player on the middle column's top: a column above the shore sand.
    const mid = WORLD_SIZE / 2;
    expect(heightAt(t, mid, mid)).toBeGreaterThan(MIN_HEIGHT + 1);
    expect(surfaceY(t, mid + 0.5, mid + 0.5)).toBe(heightAt(t, mid, mid));
  });

  it('assigns layers by height', () => {
    expect(layerForTop(MIN_HEIGHT)).toBe(LAYER_SAND);
    expect(layerForTop(Math.floor((MIN_HEIGHT + MAX_HEIGHT) / 2))).toBe(LAYER_GRASS);
    expect(layerForTop(MAX_HEIGHT)).toBe(LAYER_SNOW);
    expect(layerForSide(MIN_HEIGHT)).toBe(LAYER_SAND);
    expect(layerForSide(MAX_HEIGHT)).toBe(LAYER_ROCK);
  });

  it('finds the summit, the hollow and a distant cairn', () => {
    const t = createTerrain(11, 40);
    const [summit, hollow, cairn] = findLandmarks(t);
    for (const h of t.heights) {
      expect(h).toBeLessThanOrEqual(summit.height);
      expect(h).toBeGreaterThanOrEqual(hollow.height);
    }
    expect(heightAt(t, summit.x, summit.z)).toBe(summit.height);
    expect(heightAt(t, cairn.x, cairn.z)).toBe(cairn.height);
    expect(Math.hypot(cairn.x - summit.x, cairn.z - summit.z)).toBeGreaterThanOrEqual(20);
    expect(new Set([summit.name, hollow.name, cairn.name]).size).toBe(3);
  });
});

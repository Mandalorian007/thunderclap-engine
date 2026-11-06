/**
 * Level-of-detail picking: which entry of a LOD chain to draw for an object at a distance, by
 * the height its bounding sphere covers on screen. Pure arithmetic, no allocation.
 */
import type { Geometry } from './geometry';

/**
 * A LOD chain: `geometries[0]` is the full mesh and each later entry coarser (`createLodChain`
 * builds one); `meshes` the GPU meshes made from them, parallel, when the caller keeps them
 * here; `thresholdsPx[i]` the smallest on-screen height, in pixels, at which level `i` still
 * draws (descending; a missing entry means level `i` only draws as the last level).
 */
export interface LodChain<M = unknown> {
  geometries: readonly Geometry[];
  meshes?: readonly M[];
  thresholdsPx: readonly number[];
}

/**
 * Pixels a bounding sphere of `boundsRadius` covers vertically at `distance` from a perspective
 * camera with vertical field of view `fovY` (radians) drawing `viewportHeight` pixels: its
 * diameter over the view height at that distance. A distance of 0 or less is `Infinity`.
 */
export function projectedSizePx(
  boundsRadius: number,
  distance: number,
  fovY: number,
  viewportHeight: number,
): number {
  if (!(distance > 0)) return Number.POSITIVE_INFINITY;
  return (boundsRadius * viewportHeight) / (distance * Math.tan(fovY * 0.5));
}

/**
 * The level to draw: the first `i` whose `thresholdsPx[i]` the projected size reaches
 * (`>=`, so a size exactly on a threshold takes that level), else the last level. `chain` is the
 * level list (only its length is read: a chain's `geometries` or `meshes`) or the level count.
 * Clamped to `0 .. count - 1`; a count below 1 returns 0.
 */
export function selectLod(
  chain: readonly unknown[] | number,
  boundsRadius: number,
  distance: number,
  fovY: number,
  viewportHeight: number,
  thresholdsPx: readonly number[],
): number {
  const count = typeof chain === 'number' ? chain : chain.length;
  const last = Math.max(0, count - 1);
  const px = projectedSizePx(boundsRadius, distance, fovY, viewportHeight);
  const n = Math.min(last, thresholdsPx.length);
  for (let i = 0; i < n; i++) {
    if (px >= thresholdsPx[i]!) return i;
  }
  return last;
}

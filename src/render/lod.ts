/**
 * Per-instance level-of-detail picking for `frame.mesh` (ws/render-5). A `MeshLod` is geom's
 * `LodChain` with its GPU meshes (`createLodChain` + `renderer.createMesh` per geometry): the
 * renderer picks a level per instance from the projected height of its bounding sphere, the
 * way `selectLod` does, with a hysteresis band so an instance on a boundary does not flicker.
 * Pure arithmetic, no allocation.
 */
import type { LodChain } from '../geom/lod';
import type { Mesh, MeshDesc } from './mesh';

/**
 * A LOD chain the renderer draws: `meshes[0]` the full mesh, each later one coarser, and
 * `thresholdsPx[i]` the smallest on-screen height (target px) at which level `i` still draws
 * (descending; geom's `LodChain` with its `meshes` filled is one). The draw's bounding sphere
 * is `meshes[0].bounds` through the instance matrix.
 */
export type MeshLod = Pick<LodChain<Mesh>, 'thresholdsPx'> & {
  readonly meshes: readonly Mesh[];
};

/**
 * What `renderer.createMeshLod` takes (ws/api-render): geom's `LodChain` as `createLodChain`
 * builds it (`geometries` with level 0 the full one, `thresholdsPx` one fewer than the
 * levels, or as many), plus a label prefix for the meshes (`<label>-lod<i>`).
 */
export interface MeshLodDesc {
  geometries: readonly MeshDesc[];
  thresholdsPx: readonly number[];
  /** Mesh label prefix. Default `'lod'`. */
  label?: string;
}

/** A `MeshLod` that keeps the geometries it was built from: a full geom `LodChain<Mesh>`. */
export type MeshLodChain = MeshLod & {
  readonly geometries: readonly MeshDesc[];
};

/** True when `m` is a `MeshLod` rather than a single `Mesh`. */
export function isMeshLod(m: Mesh | MeshLod): m is MeshLod {
  return (m as MeshLod).thresholdsPx !== undefined;
}

/** Default `Renderer.lodHysteresis`: a 10 % band around each threshold. */
export const DEFAULT_LOD_HYSTERESIS = 0.1;

/**
 * Height in target px that a sphere of world radius `radius` covers at world distance
 * `distance` through `proj` (column-major, the camera's projection) on a viewport `viewportH`
 * px tall: `radius · viewportH · proj[5] / distance` for a perspective projection (geom's
 * `projectedSizePx`, `proj[5]` being `1 / tan(fovY / 2)`), `radius · viewportH · proj[5]` for an
 * orthographic one (distance plays no part). A non-positive distance is `Infinity`.
 */
export function lodSizePx(
  radius: number,
  distance: number,
  proj: ArrayLike<number>,
  viewportH: number,
): number {
  const f = proj[5]!;
  if (proj[11] === 0) return radius * viewportH * Math.abs(f);
  if (!(distance > 0)) return Number.POSITIVE_INFINITY;
  return (radius * viewportH * Math.abs(f)) / distance;
}

/**
 * The level for an instance whose sphere covers `sizePx`, out of `count` levels with
 * `thresholds` (`selectLod`'s rule: the first `i` with `sizePx >= thresholds[i]`, else the last
 * level), held at `prev` (the level it drew last frame; -1 for none) while the size stays
 * inside a band of `hysteresis` (a fraction) around the boundary: it goes coarser only once
 * `sizePx < thresholds[prev] · (1 - hysteresis)` and finer only to a level `i` with
 * `sizePx >= thresholds[i] · (1 + hysteresis)`.
 */
export function pickLodLevel(
  sizePx: number,
  thresholds: readonly number[],
  count: number,
  prev: number,
  hysteresis: number,
): number {
  const last = Math.max(0, count - 1);
  const n = Math.min(last, thresholds.length);
  let level = last;
  for (let i = 0; i < n; i++) {
    if (sizePx >= thresholds[i]!) {
      level = i;
      break;
    }
  }
  if (prev < 0 || prev > last || !(hysteresis > 0) || level === prev) return level;
  if (level > prev) {
    // Coarser: hold while the size is still within the band below prev's threshold.
    return prev < n && sizePx >= thresholds[prev]! * (1 - hysteresis) ? prev : level;
  }
  // Finer: the finest level whose threshold the size clears by the band, else stay.
  for (let i = level; i < prev; i++) {
    if (sizePx >= thresholds[i]! * (1 + hysteresis)) return i;
  }
  return prev;
}

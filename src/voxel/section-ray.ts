/**
 * Block picking through a streamed world: Amanatides & Woo's DDA over a cell probe, so it
 * walks a `SectionStore` (or anything else) without building a grid. Pure, no allocation.
 */
import { FACE_CLASS } from './blocks';
import type { VoxelHit } from './ray';
import type { SectionStore } from './store';

/** What a probe says of a cell: walk on, stop with a hit, or stop because it is not known. */
export const RAY_PASS = 0;
export const RAY_HIT = 1;
export const RAY_UNKNOWN = -1;

/**
 * Walk the ray from (`ox`, `oy`, `oz`) along (`dx`, `dy`, `dz`) up to `maxDist` (units of the
 * direction's length), asking `probe` of each cell it enters (the start cell first). Returns
 * `RAY_HIT` and fills `out` at the first cell the probe hits, `RAY_UNKNOWN` (with `out.distance`
 * where it stopped) at the first unknown one, or `RAY_PASS` when it ran out of distance.
 */
export function raycastCells(
  probe: (x: number, y: number, z: number) => number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  out: VoxelHit,
): number {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / dz);
  let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? x + 1 - ox : ox - x) * tDeltaX;
  let tMaxY = stepY === 0 ? Infinity : (stepY > 0 ? y + 1 - oy : oy - y) * tDeltaY;
  let tMaxZ = stepZ === 0 ? Infinity : (stepZ > 0 ? z + 1 - oz : oz - z) * tDeltaZ;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;
  const steps = Math.ceil(3 * maxDist * Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))) + 3;
  for (let i = 0; i < steps; i++) {
    const r = probe(x, y, z);
    if (r !== RAY_PASS) {
      out.distance = t;
      if (r === RAY_UNKNOWN) return RAY_UNKNOWN;
      out.x = x;
      out.y = y;
      out.z = z;
      out.nx = nx;
      out.ny = ny;
      out.nz = nz;
      out.px = x + nx;
      out.py = y + ny;
      out.pz = z + nz;
      return RAY_HIT;
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      t = tMaxX;
      x += stepX;
      tMaxX += tDeltaX;
      nx = -stepX;
      ny = 0;
      nz = 0;
    } else if (tMaxY < tMaxZ) {
      t = tMaxY;
      y += stepY;
      tMaxY += tDeltaY;
      nx = 0;
      ny = -stepY;
      nz = 0;
    } else {
      t = tMaxZ;
      z += stepZ;
      tMaxZ += tDeltaZ;
      nx = 0;
      ny = 0;
      nz = -stepZ;
    }
    if (t > maxDist) return RAY_PASS;
  }
  return RAY_PASS;
}

/**
 * Make a probe for `raycastCells` over a store: a cell hits when `hits(cell)` (default: its
 * block is neither `none` nor `liquid`), a cell of a missing section is unknown. Make it once
 * and reuse it: it allocates nothing per call.
 */
export function sectionRayProbe(
  store: SectionStore,
  hits?: (cell: number) => boolean,
): (x: number, y: number, z: number) => number {
  const { idShift, idMask } = store.format;
  const faceClass = store.format.blocks.faceClass;
  const solid =
    hits ??
    ((cell: number): boolean => {
      const c = faceClass[(cell >>> idShift) & idMask] ?? FACE_CLASS.opaque;
      return c !== FACE_CLASS.none && c !== FACE_CLASS.liquid;
    });
  return (x, y, z) => {
    const cell = store.cellAt(x, y, z);
    if (cell === undefined) return RAY_UNKNOWN;
    return solid(cell) ? RAY_HIT : RAY_PASS;
  };
}

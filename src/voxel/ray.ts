/**
 * Block picking: a ray walked cell by cell through a `VoxelGrid` (Amanatides & Woo's DDA).
 * Grid units are world units with the grid's corner at the origin; a world placed elsewhere
 * subtracts its origin from the ray first. Pure, no allocation.
 */
import type { VoxelGrid } from './grid';

/** What `raycastVoxels` fills on a hit. */
export interface VoxelHit {
  /** The solid cell hit. */
  x: number;
  y: number;
  z: number;
  /** Outward normal of the face entered (one unit axis; all zero when the ray starts inside a block). */
  nx: number;
  ny: number;
  nz: number;
  /** The empty cell in front of that face: where a placed block goes (the hit cell itself when inside). */
  px: number;
  py: number;
  pz: number;
  /** Ray parameter of the hit, in units of the direction's length (world units for a unit direction). */
  distance: number;
}

/** A hit record to fill. */
export function createVoxelHit(): VoxelHit {
  return { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, distance: 0 };
}

/**
 * Walk the ray from (`ox`, `oy`, `oz`) along (`dx`, `dy`, `dz`) up to `maxDist` (in units of
 * the direction's length) through `grid`, returning true and filling `out` at the first
 * non-air cell. Cells outside the grid are air. A ray starting inside a block hits it at
 * distance 0 with a zero normal.
 */
export function raycastVoxels(
  grid: VoxelGrid,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  out: VoxelHit,
): boolean {
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
  // Every step crosses one cell boundary; the ray crosses at most one per axis per unit of
  // travel along that axis, so `3 * maxDist + 3` steps cover the whole distance.
  const steps = Math.ceil(3 * maxDist * Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))) + 3;
  for (let i = 0; i < steps; i++) {
    if (grid.inBounds(x, y, z) && grid.data[grid.index(x, y, z)] !== 0) {
      out.x = x;
      out.y = y;
      out.z = z;
      out.nx = nx;
      out.ny = ny;
      out.nz = nz;
      out.px = x + nx;
      out.py = y + ny;
      out.pz = z + nz;
      out.distance = t;
      return true;
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
    if (t > maxDist) return false;
  }
  return false;
}

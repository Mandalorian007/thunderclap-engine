/**
 * Area types on a `NavMesh`: every polygon carries one byte (`mesh.area`, 0 by default) that a
 * query multiplies its step cost by (`areaCost`) or filters on (`areaMask`). `markArea` stamps a
 * box or a convex polygon onto the polygons whose centre it holds; a bake takes the same shapes
 * as `areas`. Area 255 is reserved for dynamic obstacles and is never walked.
 */
import type { NavMesh, NavPoint3 } from './navmesh';

/** The area byte dynamic obstacles stamp; every query treats it as blocked. */
export const OBSTACLE_AREA = 255;

/** An axis-aligned box on the XZ plane, with an optional height band. */
export interface AreaBox {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Polygons whose centre lies outside `[minY, maxY]` are left alone. Default: any height. */
  minY?: number;
  maxY?: number;
}

/** A convex polygon on the XZ plane: `x, z` pairs in either winding, with an optional height band. */
export interface AreaPolygon {
  points: ArrayLike<number>;
  minY?: number;
  maxY?: number;
}

export type AreaShape = AreaBox | AreaPolygon;

/** One stamp of a bake's `areas` list. */
export interface AreaStamp {
  shape: AreaShape;
  /** The area byte, 0..254 (255 is reserved for obstacles). */
  area: number;
}

/** Per-area cost multipliers (256 entries; `Infinity` excludes an area) with every area at 1. */
export function createAreaCosts(fill = 1): Float32Array {
  return new Float32Array(256).fill(fill);
}

/** Per-area walkability (256 entries; 0 excludes an area) with every area allowed. */
export function createAreaMask(allow = 1): Uint8Array {
  return new Uint8Array(256).fill(allow);
}

/** Whether `(x, z)` lies inside the shape (edges included) and `y` within its height band. */
export function areaShapeContains(shape: AreaShape, x: number, y: number, z: number): boolean {
  if (shape.minY !== undefined && y < shape.minY) return false;
  if (shape.maxY !== undefined && y > shape.maxY) return false;
  if ('points' in shape) {
    const pts = shape.points;
    const n = pts.length >> 1;
    if (n < 3) return false;
    // Inside a convex polygon when the point is on the same side of every edge.
    let sign = 0;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const ax = pts[i * 2]!;
      const az = pts[i * 2 + 1]!;
      const bx = pts[j * 2]!;
      const bz = pts[j * 2 + 1]!;
      const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
      if (cross === 0) continue;
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }
  return x >= shape.minX && x <= shape.maxX && z >= shape.minZ && z <= shape.maxZ;
}

const centre: NavPoint3 = { x: 0, y: 0, z: 0 };

/**
 * Sets `mesh.area[p] = area` for every polygon whose centre lies inside `shape`; polygons
 * carrying the obstacle area (255) are left alone. Bumps `mesh.version` when any changed.
 * Returns the number of polygons stamped. Edit-time; allocation-free.
 */
export function markArea(mesh: NavMesh, shape: AreaShape, area: number): number {
  const a = Math.max(0, Math.min(254, Math.floor(area)));
  let minX: number;
  let minZ: number;
  let maxX: number;
  let maxZ: number;
  if ('points' in shape) {
    minX = minZ = Number.POSITIVE_INFINITY;
    maxX = maxZ = Number.NEGATIVE_INFINITY;
    const pts = shape.points;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const x = pts[i]!;
      const z = pts[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  } else {
    minX = shape.minX;
    minZ = shape.minZ;
    maxX = shape.maxX;
    maxZ = shape.maxZ;
  }
  let stamped = 0;
  let changed = false;
  const count = mesh.polysInBox(minX, minZ, maxX, maxZ);
  const found = mesh.polysFound;
  for (let i = 0; i < count; i++) {
    const p = found[i]!;
    mesh.polyCenter(p, centre);
    if (!areaShapeContains(shape, centre.x, centre.y, centre.z)) continue;
    if (mesh.area[p] === OBSTACLE_AREA) continue;
    stamped++;
    if (mesh.area[p] !== a) {
      mesh.area[p] = a;
      changed = true;
    }
  }
  if (changed) mesh.version++;
  return stamped;
}

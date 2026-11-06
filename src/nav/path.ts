/**
 * `NavPath`: a reusable list of world XZ waypoints, and `followPath`, which turns one into a
 * desired velocity per tick. Allocation-free after the path's capacity settles.
 */
import type { NavPoint } from './grid';

export interface NavPath {
  /** Waypoints as world `x, z` pairs; `length * 2` floats are valid. Grows in place as needed. */
  points: Float32Array;
  /** Waypoints in the path (0 when no path). */
  length: number;
  /** Index of the waypoint `followPath` is heading for. */
  cursor: number;
  /** `grid.version` when the path was found; differs from the grid's once the grid was edited. */
  version: number;
}

/** A path with room for `capacity` waypoints (grows on demand). */
export function createNavPath(capacity = 64): NavPath {
  return { points: new Float32Array(Math.max(1, capacity) * 2), length: 0, cursor: 0, version: -1 };
}

/** Makes room for `count` waypoints (1.5× growth), keeping the floats already there. */
export function reservePath(path: NavPath, count: number): void {
  const need = count * 2;
  if (path.points.length >= need) return;
  const next = new Float32Array(Math.max(need, Math.ceil(path.points.length * 1.5)));
  next.set(path.points);
  path.points = next;
}

/** Empties the path (`length` 0, `cursor` 0); the buffer stays. */
export function clearPath(path: NavPath): void {
  path.length = 0;
  path.cursor = 0;
}

/** Writes waypoint `i` into `out`. */
export function pathPoint(path: NavPath, i: number, out: NavPoint): NavPoint {
  out.x = path.points[i * 2]!;
  out.z = path.points[i * 2 + 1]!;
  return out;
}

/** The sum of the segment lengths, world units. */
export function pathDistance(path: NavPath): number {
  const p = path.points;
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = p[i * 2]! - p[i * 2 - 2]!;
    const dz = p[i * 2 + 1]! - p[i * 2 - 1]!;
    d += Math.sqrt(dx * dx + dz * dz);
  }
  return d;
}

export type FollowResult = 'moving' | 'arrived';

/**
 * Heads for `path.points[path.cursor]` at `speed`: the cursor advances when `position` is within
 * `arriveRadius` of its waypoint, and the last waypoint reached is `'arrived'` with a zero
 * velocity. `outVelocity` is the desired velocity (world units per second), full speed until the
 * end (pair with `steer.arrive` for a slow-down). An empty path is `'arrived'`.
 */
export function followPath(
  path: NavPath,
  position: Readonly<NavPoint>,
  speed: number,
  arriveRadius: number,
  outVelocity: NavPoint,
): FollowResult {
  const n = path.length;
  if (n === 0) {
    outVelocity.x = 0;
    outVelocity.z = 0;
    return 'arrived';
  }
  if (path.cursor >= n) path.cursor = n - 1;
  const r2 = arriveRadius * arriveRadius;
  const p = path.points;
  let dx = p[path.cursor * 2]! - position.x;
  let dz = p[path.cursor * 2 + 1]! - position.z;
  while (dx * dx + dz * dz <= r2) {
    if (path.cursor >= n - 1) {
      outVelocity.x = 0;
      outVelocity.z = 0;
      return 'arrived';
    }
    path.cursor++;
    dx = p[path.cursor * 2]! - position.x;
    dz = p[path.cursor * 2 + 1]! - position.z;
  }
  const d = Math.sqrt(dx * dx + dz * dz);
  outVelocity.x = (dx / d) * speed;
  outVelocity.z = (dz / d) * speed;
  return 'moving';
}

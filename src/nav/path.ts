/**
 * `NavPath`: a reusable list of world XZ waypoints, `followPath`, which turns one into a
 * desired velocity per tick, and string pulling (`smoothPath` over `hasLineOfWalkable`, both
 * honouring the grid's edge-cost hook). Allocation-free after the path's capacity settles.
 */
import type { EdgeCost, NavCell, NavGrid, NavPoint } from './grid';

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

export interface LineOfWalkableOptions {
  /**
   * The step-cost hook the line honours per cell pair it crosses: a pair the hook blocks
   * (`Infinity`) breaks the line, so a one-way ledge is never cut across. Default: the grid's own
   * `edgeCost`; `null` opts out (walkability only).
   */
  edgeCost?: EdgeCost | null;
}

/**
 * True when a straight segment between the centres of two cells crosses walkable cells only
 * (a supercover walk: a segment through a corner needs both cells beside the corner walkable,
 * so it never slips between two diagonal walls) and no cell pair along it is blocked by the
 * edge-cost hook (the grid's, or `opts.edgeCost`; `null` ignores hooks). Both endpoints must be
 * walkable. Allocation-free.
 */
export function hasLineOfWalkable(
  grid: NavGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  opts?: LineOfWalkableOptions,
): boolean {
  if (!grid.isWalkable(x0, y0) || !grid.isWalkable(x1, y1)) return false;
  const hook = opts === undefined || opts.edgeCost === undefined ? grid.edgeCost : opts.edgeCost;
  const width = grid.width;
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x1 > x0 ? 1 : -1;
  const sy = y1 > y0 ? 1 : -1;
  // Integer DDA: the next vertical boundary is crossed at t = (ix + 0.5) / dx, the next
  // horizontal one at (iy + 0.5) / dy; both scaled by 2·dx·dy so the comparison is exact.
  let ix = 0;
  let iy = 0;
  while (ix < dx || iy < dy) {
    const from = y * width + x;
    const tx = (2 * ix + 1) * dy;
    const ty = (2 * iy + 1) * dx;
    if (ix < dx && (iy >= dy || tx < ty)) {
      x += sx;
      ix++;
    } else if (iy < dy && (ix >= dx || ty < tx)) {
      y += sy;
      iy++;
    } else {
      // Exactly through a corner: both cells beside it must be open, then step diagonally.
      if (!grid.isWalkable(x + sx, y) || !grid.isWalkable(x, y + sy)) return false;
      x += sx;
      y += sy;
      ix++;
      iy++;
    }
    if (!grid.isWalkable(x, y)) return false;
    if (hook) {
      const e = hook(from, y * width + x, grid);
      if (e === Infinity || Number.isNaN(e)) return false;
    }
  }
  return true;
}

const sa: NavCell = { x: 0, y: 0 };
const sb: NavCell = { x: 0, y: 0 };

/**
 * String pulling: drops every waypoint that a straight line of walkable cells can skip, in
 * place, so a staircase of cell centres becomes a few straight legs. A leg never crosses a cell
 * pair the edge-cost hook blocks (`hasLineOfWalkable` with `opts`), so a bend at a cliff stays.
 * On a 4-neighbour grid a leg never leaves its row or column: only collinear waypoints are
 * dropped, so the path keeps every corner and makes no diagonal cut. `path.cursor` is reset to
 * 0. Returns the path. Allocation-free.
 */
export function smoothPath(grid: NavGrid, path: NavPath, opts?: LineOfWalkableOptions): NavPath {
  const n = path.length;
  path.cursor = 0;
  if (n < 3) return path;
  const p = path.points;
  let write = 1;
  if (grid.neighbours === 4) {
    for (let i = 1; i < n - 1; i++) {
      const ax = p[i * 2]! - p[write * 2 - 2]!;
      const az = p[i * 2 + 1]! - p[write * 2 - 1]!;
      const bx = p[i * 2 + 2]! - p[i * 2]!;
      const bz = p[i * 2 + 3]! - p[i * 2 + 1]!;
      // Keep the waypoint when the run bends (the cross product of the two legs is not zero).
      if (ax * bz - az * bx !== 0) {
        p[write * 2] = p[i * 2]!;
        p[write * 2 + 1] = p[i * 2 + 1]!;
        write++;
      }
    }
    p[write * 2] = p[n * 2 - 2]!;
    p[write * 2 + 1] = p[n * 2 - 1]!;
    path.length = write + 1;
    return path;
  }
  let anchor = 0;
  while (anchor < n - 1) {
    grid.toCell(p[anchor * 2]!, p[anchor * 2 + 1]!, sa);
    // The furthest waypoint visible from the anchor; the next one is always reachable.
    let far = anchor + 1;
    for (let j = n - 1; j > anchor + 1; j--) {
      grid.toCell(p[j * 2]!, p[j * 2 + 1]!, sb);
      if (hasLineOfWalkable(grid, sa.x, sa.y, sb.x, sb.y, opts)) {
        far = j;
        break;
      }
    }
    p[write * 2] = p[far * 2]!;
    p[write * 2 + 1] = p[far * 2 + 1]!;
    write++;
    anchor = far;
  }
  path.length = write;
  return path;
}

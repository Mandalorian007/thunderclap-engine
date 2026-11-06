/**
 * A flow field: one Dijkstra from a set of goal cells gives every cell its distance and the
 * direction to step, so any number of agents share one build. Arrays are sized to the grid once.
 */
import type { Cell, NavGrid, NavPoint } from './grid';
import { CellHeap } from './heap';

export interface FlowField {
  readonly grid: NavGrid;
  /** `grid.version` at the last `build`, or -1 before the first; stale when the grid moved on. */
  readonly version: number;
  /** Cost-weighted distance to the nearest goal per cell (row-major); `Infinity` unreachable. */
  readonly distances: Float32Array;
  /**
   * Unit direction per cell (`x, z` pairs, row-major) towards the cheapest neighbour; zero at
   * a goal, an unwalkable cell or an unreachable one.
   */
  readonly directions: Float32Array;
  /** Dijkstra from `goals` (cells; unwalkable or out-of-grid ones are skipped). */
  build(goals: ArrayLike<Readonly<Cell>>): void;
  /** The step direction at a cell into `out` (zero outside the grid). */
  direction(cx: number, cy: number, out: NavPoint): NavPoint;
  /** The step direction under a world point into `out`. */
  directionAt(worldX: number, worldZ: number, out: NavPoint): NavPoint;
  /** Cost-weighted distance from a cell to the nearest goal (`Infinity` when unreachable). */
  distance(cx: number, cy: number): number;
}

const SQRT2 = Math.SQRT2;
const NX = [1, -1, 0, 0, 1, 1, -1, -1];
const NY = [0, 0, 1, -1, 1, -1, 1, -1];

class Field implements FlowField {
  readonly grid: NavGrid;
  readonly distances: Float32Array;
  readonly directions: Float32Array;
  version = -1;
  private readonly key: Float64Array;
  private readonly heap: CellHeap;

  constructor(grid: NavGrid) {
    this.grid = grid;
    const n = grid.size;
    this.distances = new Float32Array(n).fill(Infinity);
    this.directions = new Float32Array(n * 2);
    this.key = new Float64Array(n);
    this.heap = new CellHeap(n, this.key);
  }

  build(goals: ArrayLike<Readonly<Cell>>): void {
    const grid = this.grid;
    const width = grid.width;
    const height = grid.height;
    const costs = grid.costs;
    const dist = this.key;
    const heap = this.heap;
    dist.fill(Infinity);
    heap.clear();
    for (let i = 0; i < goals.length; i++) {
      const c = goals[i]!;
      if (!grid.isWalkable(c.x, c.y)) continue;
      const gi = c.y * width + c.x;
      dist[gi] = 0;
      heap.pushOrDecrease(gi);
    }
    while (heap.size > 0) {
      const cur = heap.pop();
      const cx = cur % width;
      const cy = (cur - cx) / width;
      const dc = dist[cur]!;
      for (let d = 0; d < 8; d++) {
        const nx = cx + NX[d]!;
        const ny = cy + NY[d]!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        const nc = costs[ni]!;
        if (nc <= 0) continue;
        let step: number;
        if (d < 4) {
          step = nc;
        } else {
          if (costs[cy * width + nx]! <= 0 || costs[ny * width + cx]! <= 0) continue;
          step = SQRT2 * nc;
        }
        const nd = dc + step;
        if (nd >= dist[ni]!) continue;
        dist[ni] = nd;
        heap.pushOrDecrease(ni);
      }
    }
    // Directions: towards the lowest neighbour (a diagonal only when its corners are open).
    const dirs = this.directions;
    const out = this.distances;
    for (let cy = 0; cy < height; cy++) {
      for (let cx = 0; cx < width; cx++) {
        const i = cy * width + cx;
        const own = dist[i]!;
        out[i] = own;
        let best = own;
        let bd = -1;
        if (own > 0 && own < Infinity) {
          for (let d = 0; d < 8; d++) {
            const nx = cx + NX[d]!;
            const ny = cy + NY[d]!;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const ni = ny * width + nx;
            if (costs[ni]! <= 0) continue;
            if (d >= 4 && (costs[cy * width + nx]! <= 0 || costs[ny * width + cx]! <= 0)) continue;
            const nd = dist[ni]!;
            if (nd < best) {
              best = nd;
              bd = d;
            }
          }
        }
        if (bd < 0) {
          dirs[i * 2] = 0;
          dirs[i * 2 + 1] = 0;
        } else if (bd < 4) {
          dirs[i * 2] = NX[bd]!;
          dirs[i * 2 + 1] = NY[bd]!;
        } else {
          dirs[i * 2] = NX[bd]! * Math.SQRT1_2;
          dirs[i * 2 + 1] = NY[bd]! * Math.SQRT1_2;
        }
      }
    }
    this.version = grid.version;
  }

  direction(cx: number, cy: number, out: NavPoint): NavPoint {
    if (!this.grid.inBounds(cx, cy)) {
      out.x = 0;
      out.z = 0;
      return out;
    }
    const i = (cy * this.grid.width + cx) * 2;
    out.x = this.directions[i]!;
    out.z = this.directions[i + 1]!;
    return out;
  }

  directionAt(worldX: number, worldZ: number, out: NavPoint): NavPoint {
    const g = this.grid;
    const cx = Math.floor((worldX - g.origin.x) / g.cellSize);
    const cy = Math.floor((worldZ - g.origin.z) / g.cellSize);
    return this.direction(cx, cy, out);
  }

  distance(cx: number, cy: number): number {
    if (!this.grid.inBounds(cx, cy)) return Infinity;
    return this.distances[cy * this.grid.width + cx]!;
  }
}

/** A flow field over `grid`, unbuilt (every distance `Infinity`) until `build(goals)`. */
export function createFlowField(grid: NavGrid): FlowField {
  return new Field(grid);
}

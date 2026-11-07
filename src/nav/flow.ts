/**
 * A flow field: one Dijkstra from a set of goal cells gives every cell its distance and the
 * direction to step, so any number of agents share one build. Arrays are sized to the grid once;
 * the goals are kept, so `update()` recomputes in place after the grid or the goals move.
 */
import type { NavCell, NavGrid, NavPoint } from './grid';
import { edgeCostOf, NEIGHBOUR_X, NEIGHBOUR_Y, stepLength } from './grid';
import { CellHeap } from './heap';

/**
 * A flow direction with the cost of the step it points along: what `findPath` charges for the
 * same move (`(1 | √2) × cost(dest)` plus the edge cost). 0 at a goal, `Infinity` off the field
 * (an unwalkable, unreachable or out-of-grid cell).
 */
export interface FlowDirection extends NavPoint {
  cost: number;
}

export interface FlowFieldOptions {
  /** Goal cells (row-major indices) to build from at once; the field is built immediately. */
  goals?: ArrayLike<number>;
}

export interface FlowField {
  readonly grid: NavGrid;
  /** `grid.version` at the last build, or -1 before the first; stale when the grid moved on. */
  readonly version: number;
  /** True when the grid was edited (or touched) since the last build; `update()` clears it. */
  readonly stale: boolean;
  /** The goal indices of the last build (`goalCount` of them; sized to the grid). */
  readonly goals: Int32Array;
  readonly goalCount: number;
  /** Cost-weighted distance to the nearest goal per cell (row-major); `Infinity` unreachable. */
  readonly distances: Float32Array;
  /**
   * Unit direction per cell (`x, z` pairs, row-major) towards the cheapest neighbour; zero at
   * a goal, an unwalkable cell or an unreachable one. Only the grid's neighbourhood is used, so
   * a 4-neighbour grid never gives a diagonal.
   */
  readonly directions: Float32Array;
  /**
   * Per cell, the cost of the step `directions` points along (`findPath`'s charge for it): 0 at
   * a goal, `Infinity` where the direction is zero. Summed along a walk it equals `distances`.
   */
  readonly stepCosts: Float32Array;
  /** Dijkstra from `goals` (cells; unwalkable or out-of-grid ones are skipped). */
  build(goals: ArrayLike<Readonly<NavCell>>): void;
  /** Dijkstra from `goals` given as row-major indices (unwalkable or out-of-grid are skipped). */
  setGoals(goals: ArrayLike<number>): void;
  /** Recomputes from the kept goals, in place: after a grid edit, or to clear `stale`. */
  update(): void;
  /**
   * The step direction at a cell into `out` (zero outside the grid). An `out` with a `cost`
   * field (`FlowDirection`) also receives the step's cost (`Infinity` off the field).
   */
  direction<T extends NavPoint>(cx: number, cy: number, out: T): T;
  /** The step direction under a world point into `out`; a `FlowDirection` gets the step cost too. */
  directionAt<T extends NavPoint>(worldX: number, worldZ: number, out: T): T;
  /** Cost-weighted distance from a cell to the nearest goal (`Infinity` when unreachable). */
  distance(cx: number, cy: number): number;
}

const NX = NEIGHBOUR_X;
const NY = NEIGHBOUR_Y;

class Field implements FlowField {
  readonly grid: NavGrid;
  readonly distances: Float32Array;
  readonly directions: Float32Array;
  readonly stepCosts: Float32Array;
  readonly goals: Int32Array;
  goalCount = 0;
  version = -1;
  private readonly key: Float64Array;
  private readonly heap: CellHeap;

  constructor(grid: NavGrid) {
    this.grid = grid;
    const n = grid.size;
    this.distances = new Float32Array(n).fill(Infinity);
    this.directions = new Float32Array(n * 2);
    this.stepCosts = new Float32Array(n).fill(Infinity);
    this.goals = new Int32Array(n);
    this.key = new Float64Array(n);
    this.heap = new CellHeap(n, this.key);
  }

  get stale(): boolean {
    return this.version !== this.grid.version;
  }

  build(goals: ArrayLike<Readonly<NavCell>>): void {
    const grid = this.grid;
    let count = 0;
    for (let i = 0; i < goals.length && count < this.goals.length; i++) {
      const c = goals[i]!;
      if (!grid.inBounds(c.x, c.y)) continue;
      this.goals[count++] = c.y * grid.width + c.x;
    }
    this.goalCount = count;
    this.update();
  }

  setGoals(goals: ArrayLike<number>): void {
    const size = this.grid.size;
    let count = 0;
    for (let i = 0; i < goals.length && count < this.goals.length; i++) {
      const gi = goals[i]!;
      if (!(gi >= 0 && gi < size)) continue;
      this.goals[count++] = gi;
    }
    this.goalCount = count;
    this.update();
  }

  update(): void {
    const grid = this.grid;
    const width = grid.width;
    const height = grid.height;
    const costs = grid.costs;
    const dirs8 = grid.neighbours;
    const dist = this.key;
    const heap = this.heap;
    const hooked = grid.edgeCost !== undefined;
    dist.fill(Infinity);
    heap.clear();
    for (let i = 0; i < this.goalCount; i++) {
      const gi = this.goals[i]!;
      if (costs[gi]! <= 0) continue;
      dist[gi] = 0;
      heap.pushOrDecrease(gi);
    }
    while (heap.size > 0) {
      const cur = heap.pop();
      const cx = cur % width;
      const cy = (cur - cx) / width;
      const dc = dist[cur]!;
      // The search runs from the goals outward, so the edge is walked the other way: from the
      // neighbour into `cur`. The hook sees it in that order, so a one-way ledge works.
      for (let d = 0; d < dirs8; d++) {
        const len = stepLength(grid, cx, cy, d);
        if (len === Infinity) continue;
        const ni = (cy + NY[d]!) * width + cx + NX[d]!;
        const nd = dc + len * costs[ni]! + (hooked ? edgeCostOf(grid, ni, cur) : 0);
        if (nd >= dist[ni]!) continue;
        dist[ni] = nd;
        heap.pushOrDecrease(ni);
      }
    }
    // Directions: towards the lowest neighbour (a diagonal only when its corners are open).
    // With an edge-cost hook the step itself counts, so a one-way ledge is never pointed at:
    // the neighbour minimising step + distance, which equals the cell's own distance.
    const dirs = this.directions;
    const steps = this.stepCosts;
    const out = this.distances;
    for (let cy = 0; cy < height; cy++) {
      for (let cx = 0; cx < width; cx++) {
        const i = cy * width + cx;
        const own = dist[i]!;
        out[i] = own;
        let best = own;
        let bd = -1;
        if (own > 0 && own < Infinity) {
          const own0 = costs[i]!;
          for (let d = 0; d < dirs8; d++) {
            const nx = cx + NX[d]!;
            const ny = cy + NY[d]!;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const ni = ny * width + nx;
            if (costs[ni]! <= 0) continue;
            if (d >= 4 && (costs[cy * width + nx]! <= 0 || costs[ny * width + cx]! <= 0)) continue;
            if (hooked) {
              const e = edgeCostOf(grid, i, ni);
              if (e === Infinity) continue;
              const nd = dist[ni]! + (d < 4 ? own0 : own0 * Math.SQRT2) + e;
              // The minimum equals `own` exactly (same sum Dijkstra made); first tie wins.
              if (nd < best || (bd < 0 && nd <= own)) {
                best = nd;
                bd = d;
              }
            } else {
              const nd = dist[ni]!;
              if (nd < best) {
                best = nd;
                bd = d;
              }
            }
          }
        }
        if (bd < 0) {
          dirs[i * 2] = 0;
          dirs[i * 2 + 1] = 0;
          steps[i] = own === 0 ? 0 : Infinity;
        } else {
          const ni = (cy + NY[bd]!) * width + cx + NX[bd]!;
          // What A* charges for this step: its length × the destination's cost, plus the hook.
          steps[i] =
            (bd < 4 ? 1 : Math.SQRT2) * costs[ni]! + (hooked ? edgeCostOf(grid, i, ni) : 0);
          if (bd < 4) {
            dirs[i * 2] = NX[bd]!;
            dirs[i * 2 + 1] = NY[bd]!;
          } else {
            dirs[i * 2] = NX[bd]! * Math.SQRT1_2;
            dirs[i * 2 + 1] = NY[bd]! * Math.SQRT1_2;
          }
        }
      }
    }
    this.version = grid.version;
  }

  direction<T extends NavPoint>(cx: number, cy: number, out: T): T {
    if (!this.grid.inBounds(cx, cy)) {
      out.x = 0;
      out.z = 0;
      if ('cost' in out) (out as FlowDirection).cost = Infinity;
      return out;
    }
    const i = cy * this.grid.width + cx;
    out.x = this.directions[i * 2]!;
    out.z = this.directions[i * 2 + 1]!;
    if ('cost' in out) (out as FlowDirection).cost = this.stepCosts[i]!;
    return out;
  }

  directionAt<T extends NavPoint>(worldX: number, worldZ: number, out: T): T {
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

/**
 * A flow field over `grid`: unbuilt (every distance `Infinity`, `version` -1) until
 * `build(goals)` or `setGoals(goals)`, or built at once from `opts.goals`.
 */
export function createFlowField(grid: NavGrid, opts: FlowFieldOptions = {}): FlowField {
  const f = new Field(grid);
  if (opts.goals) f.setGoals(opts.goals);
  return f;
}

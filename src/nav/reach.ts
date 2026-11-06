/**
 * Bounded reachability: Dijkstra from one or more start cells that stops at a cost budget and
 * keeps every parent, so a turn-based or tile game asks "where can this unit move" and "by which
 * path" from one query. The result lives in a `Reach` sized to the grid once and reused.
 */
import type { NavGrid } from './grid';
import { NEIGHBOUR_X, NEIGHBOUR_Y, stepCost } from './grid';
import { CellHeap } from './heap';
import { type NavPath, reservePath } from './path';

export interface Reach {
  readonly grid: NavGrid;
  /** Cells reached by the last query (the starts included). */
  readonly count: number;
  /** The reached cells' row-major indices, in order of increasing distance; `count` are valid. */
  readonly cells: Int32Array;
  /** Cost-weighted distance from the nearest start per grid cell; `Infinity` when not reached. */
  readonly distances: Float32Array;
  /** The cell each reached cell was entered from; -1 at a start or an unreached cell. */
  readonly parents: Int32Array;
  /** The budget of the last query. */
  readonly budget: number;
  /** `grid.version` at the last query, or -1 before the first. */
  readonly version: number;
  /** True when the grid was edited since the last query. */
  readonly stale: boolean;
  /** True when the cell was reached within the budget (a start counts). */
  has(index: number): boolean;
  /**
   * Walks the parents from the nearest start to `index` into `path` (world cell centres, like
   * `findPath`; `cursor` 0, `version` stamped). False, with an empty path, when not reached.
   */
  pathTo(index: number, path: NavPath): boolean;
  /** Calls `fn` for every reached cell, nearest first. */
  forEach(fn: (index: number, distance: number) => void): void;
}

class ReachImpl implements Reach {
  readonly grid: NavGrid;
  readonly cells: Int32Array;
  readonly distances: Float32Array;
  readonly parents: Int32Array;
  count = 0;
  budget = 0;
  version = -1;
  readonly heap: CellHeap;

  constructor(grid: NavGrid) {
    this.grid = grid;
    const n = grid.size;
    this.cells = new Int32Array(n);
    this.distances = new Float32Array(n).fill(Infinity);
    this.parents = new Int32Array(n).fill(-1);
    this.heap = new CellHeap(n, this.distances);
  }

  get stale(): boolean {
    return this.version !== this.grid.version;
  }

  has(index: number): boolean {
    return index >= 0 && index < this.grid.size && this.distances[index]! < Infinity;
  }

  pathTo(index: number, path: NavPath): boolean {
    path.length = 0;
    path.cursor = 0;
    path.version = this.version;
    if (!this.has(index)) return false;
    const parents = this.parents;
    let count = 0;
    for (let i = index; i >= 0; i = parents[i]!) count++;
    reservePath(path, count);
    const grid = this.grid;
    const width = grid.width;
    const cs = grid.cellSize;
    const ox = grid.origin.x;
    const oz = grid.origin.z;
    const p = path.points;
    let k = count - 1;
    for (let i = index; i >= 0; i = parents[i]!, k--) {
      const x = i % width;
      const y = (i - x) / width;
      p[k * 2] = ox + (x + 0.5) * cs;
      p[k * 2 + 1] = oz + (y + 0.5) * cs;
    }
    path.length = count;
    return true;
  }

  forEach(fn: (index: number, distance: number) => void): void {
    for (let i = 0; i < this.count; i++) {
      const c = this.cells[i]!;
      fn(c, this.distances[c]!);
    }
  }

  /** Forgets the last query's cells only (the untouched rest is still `Infinity` / -1). */
  reset(): void {
    for (let i = 0; i < this.count; i++) {
      const c = this.cells[i]!;
      this.distances[c] = Infinity;
      this.parents[c] = -1;
    }
    this.count = 0;
    this.heap.clear();
  }
}

/** A reusable reachability result sized to `grid`; pass it to `reachable` as `out`. */
export function createReach(grid: NavGrid): Reach {
  return new ReachImpl(grid);
}

const reachFor = new WeakMap<NavGrid, ReachImpl>();

function seed(r: ReachImpl, gi: number): void {
  if (!(gi >= 0 && gi < r.grid.size) || r.grid.costs[gi]! <= 0 || r.distances[gi] === 0) return;
  r.distances[gi] = 0;
  r.parents[gi] = -1;
  r.heap.pushOrDecrease(gi);
}

/**
 * Dijkstra from `start` (a row-major index, or several) over the grid's neighbourhood with its
 * edge costs, stopping at `budget` (inclusive: a cell whose cost equals the budget is reached).
 * Writes into `out`, or into one `Reach` kept per grid when omitted, and returns it; nothing
 * allocates after the first query on a grid. Unwalkable or out-of-grid starts are skipped. The
 * cells in `out.cells` come nearest first, so the heap order doubles as a frontier order.
 */
export function reachable(
  grid: NavGrid,
  start: number | ArrayLike<number>,
  budget: number,
  out?: Reach,
): Reach {
  let r: ReachImpl;
  if (out) {
    if (out.grid !== grid) throw new Error('nav: reach belongs to another grid');
    r = out as ReachImpl;
  } else {
    const cached = reachFor.get(grid);
    if (cached) {
      r = cached;
    } else {
      r = new ReachImpl(grid);
      reachFor.set(grid, r);
    }
  }
  r.reset();
  r.budget = budget;
  r.version = grid.version;
  const width = grid.width;
  const dist = r.distances;
  const parents = r.parents;
  const cells = r.cells;
  const heap = r.heap;
  const dirs = grid.neighbours;
  if (typeof start === 'number') {
    seed(r, start);
  } else {
    for (let i = 0; i < start.length; i++) seed(r, start[i]!);
  }
  let count = 0;
  while (heap.size > 0) {
    const cur = heap.pop();
    cells[count++] = cur;
    const cx = cur % width;
    const cy = (cur - cx) / width;
    const dc = dist[cur]!;
    for (let d = 0; d < dirs; d++) {
      const step = stepCost(grid, cur, cx, cy, d);
      if (step === Infinity) continue;
      const nd = dc + step;
      if (nd > budget) continue;
      const ni = (cy + NEIGHBOUR_Y[d]!) * width + cx + NEIGHBOUR_X[d]!;
      if (nd >= dist[ni]!) continue;
      dist[ni] = nd;
      parents[ni] = cur;
      heap.pushOrDecrease(ni);
    }
  }
  r.count = count;
  return r;
}

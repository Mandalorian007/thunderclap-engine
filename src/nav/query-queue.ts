/**
 * A path queue: requests are tickets, `update()` spends a fixed budget of A* pops per call on
 * them in order (one search in flight at a time, the budget left over flowing to the next
 * ticket), so a hundred agents asking for routes at once cost the same per frame as one. Works
 * over a `NavMesh` (a `MeshSearch`) or a `NavGrid` (a sliced copy of `findPath`'s A*, same
 * expansions, same paths). Grid paths are string-pulled when asked. A search whose target
 * changed version under it restarts. Every array is allocated at creation.
 */
import type { FindPathOptions } from './astar';
import { type Cell, type NavGrid, NEIGHBOUR_X, NEIGHBOUR_Y, stepCost } from './grid';
import { CellHeap } from './heap';
import { clearPath3, type FindMeshPathOptions, MeshSearch, type NavPath3 } from './mesh/mesh-path';
import { NavMesh, type NavPoint3 } from './mesh/navmesh';
import { type NavPath, reservePath, smoothPath } from './path';

export type PathStatus = 'pending' | 'done' | 'failed' | 'none';

export interface PathQueueOptions {
  /** How many tickets may wait or be in flight at once. */
  maxQueries: number;
  /** A* pops spent per `update()`, shared by the tickets it works on. Default 256. */
  iterationsPerUpdate?: number;
}

export interface PathRequestOptions extends FindMeshPathOptions, FindPathOptions {
  /** Grid only: string-pull the path (`smoothPath`) when it is done. Default false. */
  smooth?: boolean;
}

export interface PathQueue {
  /** Tickets waiting or in flight. */
  readonly pending: number;
  /** Tickets finished since creation (done or failed). */
  readonly finished: number;
  /**
   * Queues a search from `from` to `to` into `out` (a `NavPath3` on a mesh, a `NavPath` on a
   * grid). Grid ends are cells. Returns the ticket (> 0), or -1 when the queue is full. `out`
   * is written only when the ticket completes (`'done'`), and never after a cancel.
   */
  request(
    from: Readonly<NavPoint3> | Readonly<Cell>,
    to: Readonly<NavPoint3> | Readonly<Cell>,
    out: NavPath3 | NavPath,
    opts?: PathRequestOptions,
  ): number;
  /** Spends the budget; returns the pops used. */
  update(): number;
  /** `'pending'` while queued or in flight, `'done'`/`'failed'` once finished, `'none'` for an unknown or cancelled ticket. */
  status(ticket: number): PathStatus;
  /** Drops a ticket; its `out` is left untouched. False when the ticket is unknown. */
  cancel(ticket: number): boolean;
  /** Called once per finished ticket (within `update`) with its outcome. */
  onDone: ((ticket: number, ok: boolean, out: NavPath3 | NavPath) => void) | null;
}

interface Ticket {
  id: number;
  state: PathStatus;
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
  out: NavPath3 | NavPath | null;
  opts: PathRequestOptions | undefined;
}

const SQRT2 = Math.SQRT2;

function heuristic(x: number, y: number, tx: number, ty: number, diagonal: boolean): number {
  const dx = x > tx ? x - tx : tx - x;
  const dy = y > ty ? y - ty : ty - y;
  if (!diagonal) return dx + dy;
  return dx > dy ? dx + (SQRT2 - 1) * dy : dy + (SQRT2 - 1) * dx;
}

/** `findPath`'s A*, resumable: identical expansion order, so identical paths. */
class GridSearch {
  readonly grid: NavGrid;
  state: 'idle' | 'running' | 'found' | 'failed' = 'idle';
  version = -1;
  private readonly g: Float64Array;
  private readonly f: Float64Array;
  private readonly parent: Int32Array;
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  private readonly heap: CellHeap;
  private stamp = 0;
  private goal = -1;
  private tx = 0;
  private ty = 0;
  private diagonal = true;
  private weight = 1;
  private maxExpand = 0;
  private maxCost = Number.POSITIVE_INFINITY;
  private expanded = 0;

  constructor(grid: NavGrid) {
    this.grid = grid;
    const n = grid.size;
    this.g = new Float64Array(n);
    this.f = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heap = new CellHeap(n, this.f);
  }

  begin(from: Readonly<Cell>, to: Readonly<Cell>, opts?: FindPathOptions): boolean {
    const grid = this.grid;
    this.version = grid.version;
    this.state = 'failed';
    this.expanded = 0;
    if (!grid.isWalkable(from.x, from.y) || !grid.isWalkable(to.x, to.y)) return false;
    this.diagonal = opts?.diagonal ?? grid.neighbours === 8;
    this.maxExpand = opts?.maxExpand ?? grid.size;
    this.maxCost = opts?.maxCost ?? Infinity;
    this.weight = opts?.heuristicWeight ?? 1;
    this.stamp = (this.stamp + 1) >>> 0 || 1;
    this.heap.clear();
    const width = grid.width;
    this.tx = to.x;
    this.ty = to.y;
    const start = from.y * width + from.x;
    this.goal = to.y * width + to.x;
    this.g[start] = 0;
    this.f[start] = this.weight * heuristic(from.x, from.y, to.x, to.y, this.diagonal);
    this.parent[start] = -1;
    this.seen[start] = this.stamp;
    this.heap.pushOrDecrease(start);
    this.state = 'running';
    return true;
  }

  step(maxPops: number): number {
    if (this.state !== 'running') return 0;
    const { grid, g, f, parent, seen, closed, heap, stamp, goal, tx, ty, diagonal, weight } = this;
    const maxCost = this.maxCost;
    const width = grid.width;
    const dirs = diagonal ? 8 : 4;
    let pops = 0;
    while (pops < maxPops) {
      if (heap.size === 0) {
        this.state = 'failed';
        break;
      }
      const cur = heap.pop();
      pops++;
      if (cur === goal) {
        this.state = 'found';
        break;
      }
      if (++this.expanded > this.maxExpand) {
        this.state = 'failed';
        break;
      }
      closed[cur] = stamp;
      const cx = cur % width;
      const cy = (cur - cx) / width;
      const gc = g[cur]!;
      for (let d = 0; d < dirs; d++) {
        const step = stepCost(grid, cur, cx, cy, d);
        if (step === Infinity) continue;
        const nx = cx + NEIGHBOUR_X[d]!;
        const ny = cy + NEIGHBOUR_Y[d]!;
        const ni = ny * width + nx;
        if (closed[ni] === stamp) continue;
        const ng = gc + step;
        if (ng > maxCost) continue;
        if (seen[ni] === stamp && ng >= g[ni]!) continue;
        seen[ni] = stamp;
        g[ni] = ng;
        f[ni] = ng + weight * heuristic(nx, ny, tx, ty, diagonal);
        parent[ni] = cur;
        heap.pushOrDecrease(ni);
      }
    }
    return pops;
  }

  finish(out: NavPath): boolean {
    out.length = 0;
    out.cursor = 0;
    out.version = this.version;
    if (this.state !== 'found') return false;
    const { grid, parent, goal } = this;
    const width = grid.width;
    let count = 0;
    for (let i = goal; i >= 0; i = parent[i]!) count++;
    reservePath(out, count);
    const p = out.points;
    const cs = grid.cellSize;
    const ox = grid.origin.x;
    const oz = grid.origin.z;
    let k = count - 1;
    for (let i = goal; i >= 0; i = parent[i]!, k--) {
      const x = i % width;
      const y = (i - x) / width;
      p[k * 2] = ox + (x + 0.5) * cs;
      p[k * 2 + 1] = oz + (y + 0.5) * cs;
    }
    out.length = count;
    this.state = 'idle';
    return true;
  }
}

/** A queue of path searches over a mesh or a grid, sliced across `update()` calls. */
export function createPathQueue(target: NavMesh | NavGrid, opts: PathQueueOptions): PathQueue {
  const max = Math.max(1, opts.maxQueries);
  const budget = Math.max(1, opts.iterationsPerUpdate ?? 256);
  const mesh = target instanceof NavMesh ? target : null;
  const grid = mesh ? null : (target as NavGrid);
  const meshSearch = mesh ? new MeshSearch(mesh) : null;
  const gridSearch = grid ? new GridSearch(grid) : null;
  // A ring of tickets in request order; finished tickets keep their state until their slot is reused.
  const ring: Ticket[] = [];
  for (let i = 0; i < max; i++) {
    ring.push({
      id: 0,
      state: 'none',
      fx: 0,
      fy: 0,
      fz: 0,
      tx: 0,
      ty: 0,
      tz: 0,
      out: null,
      opts: undefined,
    });
  }
  let head = 0; // the oldest pending ticket's slot
  let tail = 0; // the next free slot
  let pending = 0;
  /** Slots taken, cancelled ones included until the ring reaches them. */
  let occupied = 0;
  let finished = 0;
  let nextId = 1;
  /** The ticket id the in-flight search belongs to, 0 when none. */
  let inFlight = 0;
  const from3: NavPoint3 = { x: 0, y: 0, z: 0 };
  const to3: NavPoint3 = { x: 0, y: 0, z: 0 };
  const fromCell: Cell = { x: 0, y: 0 };
  const toCell: Cell = { x: 0, y: 0 };

  const find = (ticket: number): Ticket | undefined => {
    if (ticket <= 0) return undefined;
    for (let i = 0; i < max; i++) {
      const t = ring[i]!;
      if (t.id === ticket) return t;
    }
    return undefined;
  };

  const begin = (t: Ticket): boolean => {
    inFlight = t.id;
    if (meshSearch) {
      from3.x = t.fx;
      from3.y = t.fy;
      from3.z = t.fz;
      to3.x = t.tx;
      to3.y = t.ty;
      to3.z = t.tz;
      return meshSearch.begin(from3, to3, t.opts);
    }
    fromCell.x = t.fx;
    fromCell.y = t.fy;
    toCell.x = t.tx;
    toCell.y = t.ty;
    return gridSearch!.begin(fromCell, toCell, t.opts);
  };

  const queue: PathQueue = {
    get pending() {
      return pending;
    },
    get finished() {
      return finished;
    },
    onDone: null,
    request(from, to, out, reqOpts) {
      if (occupied >= max) return -1;
      const t = ring[tail]!;
      tail = tail + 1 === max ? 0 : tail + 1;
      t.id = nextId++;
      t.state = 'pending';
      t.fx = from.x;
      t.fy = from.y;
      t.fz = 'z' in from ? from.z : 0;
      t.tx = to.x;
      t.ty = to.y;
      t.tz = 'z' in to ? to.z : 0;
      t.out = out;
      t.opts = reqOpts;
      pending++;
      occupied++;
      return t.id;
    },
    update() {
      let left = budget;
      while (left > 0 && occupied > 0) {
        const t = ring[head]!;
        if (t.state !== 'pending') {
          // Cancelled: skip the slot.
          head = head + 1 === max ? 0 : head + 1;
          occupied--;
          continue;
        }
        const search = meshSearch ?? gridSearch!;
        let ok: boolean;
        if (inFlight !== t.id || search.version !== target.version) {
          ok = begin(t);
        } else {
          ok = true;
        }
        if (ok && search.state === 'running') {
          left -= search.step(left);
          if (search.state === 'running') break; // budget spent; resume next update
        }
        const done =
          search.state === 'found' &&
          (meshSearch
            ? meshSearch.finish(t.out as NavPath3)
            : gridSearch!.finish(t.out as NavPath));
        if (done && gridSearch && t.opts?.smooth) smoothPath(grid!, t.out as NavPath);
        if (!done && t.out) {
          if (meshSearch) clearPath3(t.out as NavPath3);
          else {
            (t.out as NavPath).length = 0;
            (t.out as NavPath).cursor = 0;
          }
        }
        search.state = 'idle';
        inFlight = 0;
        t.state = done ? 'done' : 'failed';
        head = head + 1 === max ? 0 : head + 1;
        pending--;
        occupied--;
        finished++;
        const out = t.out!;
        t.out = null;
        t.opts = undefined;
        queue.onDone?.(t.id, done, out);
      }
      return budget - left;
    },
    status(ticket) {
      const t = find(ticket);
      return t ? t.state : 'none';
    },
    cancel(ticket) {
      const t = find(ticket);
      if (t?.state !== 'pending') return false;
      t.state = 'none';
      t.out = null;
      t.opts = undefined;
      pending--;
      if (inFlight === ticket) inFlight = 0;
      return true;
    },
  };
  return queue;
}

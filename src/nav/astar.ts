/**
 * A* over a `NavGrid` into a `NavPath`, and string pulling over the result. The open heap,
 * scores and parents are allocated once per grid (the first query is the warm-up) and reused by
 * every query after it.
 */
import { type Cell, hasLineOfWalkable, type NavGrid } from './grid';
import { CellHeap } from './heap';
import { type NavPath, reservePath } from './path';

export interface FindPathOptions {
  /** Allow the eight-neighbour moves (√2 steps). Default true. */
  diagonal?: boolean;
  /**
   * Corner cutting is never allowed: a diagonal step needs both cells beside it walkable, so a
   * path never squeezes between two diagonal walls. The option exists to say so in a call.
   */
  cutCorners?: false;
  /** Give up (return false) after expanding this many cells. Default: the whole grid. */
  maxExpand?: number;
}

const SQRT2 = Math.SQRT2;
/** Neighbour offsets: the four orthogonal first, then the four diagonal. */
const NX = [1, -1, 0, 0, 1, 1, -1, -1];
const NY = [0, 0, 1, -1, 1, -1, 1, -1];

interface Scratch {
  g: Float64Array;
  f: Float64Array;
  parent: Int32Array;
  /** `seen[i] === stamp`: `g[i]` and `parent[i]` are this query's. */
  seen: Uint32Array;
  /** `closed[i] === stamp`: expanded this query. */
  closed: Uint32Array;
  heap: CellHeap;
  stamp: number;
}

const scratchFor = new WeakMap<NavGrid, Scratch>();

/** Octile distance with diagonals, Manhattan without: admissible for cell costs ≥ 1. */
function heuristic(x: number, y: number, tx: number, ty: number, diagonal: boolean): number {
  const dx = x > tx ? x - tx : tx - x;
  const dy = y > ty ? y - ty : ty - y;
  if (!diagonal) return dx + dy;
  return dx > dy ? dx + (SQRT2 - 1) * dy : dy + (SQRT2 - 1) * dx;
}

function scratch(grid: NavGrid): Scratch {
  let s = scratchFor.get(grid);
  if (!s) {
    const n = grid.size;
    const f = new Float64Array(n);
    s = {
      g: new Float64Array(n),
      f,
      parent: new Int32Array(n),
      seen: new Uint32Array(n),
      closed: new Uint32Array(n),
      heap: new CellHeap(n, f),
      stamp: 0,
    };
    scratchFor.set(grid, s);
  }
  return s;
}

/**
 * Finds the cheapest walkable route from cell `from` to cell `to` and writes its cell centres,
 * in world XZ, into `out` (`out.cursor` 0, `out.version` = `grid.version`). Returns false, with
 * `out.length` 0, when either end is unwalkable or outside the grid, when no route exists, or
 * when `maxExpand` is hit. A step costs its length (1 or √2) times the destination cell's cost;
 * the octile (or Manhattan) heuristic is admissible for costs ≥ 1. `from === to` is a one-point
 * path. Allocates nothing after the grid's first query, except to grow `out`.
 */
export function findPath(
  grid: NavGrid,
  from: Readonly<Cell>,
  to: Readonly<Cell>,
  out: NavPath,
  opts: FindPathOptions = {},
): boolean {
  out.length = 0;
  out.cursor = 0;
  out.version = grid.version;
  if (!grid.isWalkable(from.x, from.y) || !grid.isWalkable(to.x, to.y)) return false;
  const diagonal = opts.diagonal ?? true;
  const maxExpand = opts.maxExpand ?? grid.size;
  const width = grid.width;
  const height = grid.height;
  const costs = grid.costs;
  const s = scratch(grid);
  const { g, f, parent, seen, closed, heap } = s;
  // Stamps wrap at 2^32; a wrap to 0 would alias a stale entry, so skip 0.
  s.stamp = (s.stamp + 1) >>> 0 || 1;
  const stamp = s.stamp;
  heap.clear();

  const tx = to.x;
  const ty = to.y;
  const start = from.y * width + from.x;
  const goal = ty * width + tx;
  g[start] = 0;
  f[start] = heuristic(from.x, from.y, tx, ty, diagonal);
  parent[start] = -1;
  seen[start] = stamp;
  heap.pushOrDecrease(start);

  const dirs = diagonal ? 8 : 4;
  let expanded = 0;
  let found = false;
  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === goal) {
      found = true;
      break;
    }
    if (++expanded > maxExpand) break;
    closed[cur] = stamp;
    const cx = cur % width;
    const cy = (cur - cx) / width;
    const gc = g[cur]!;
    for (let d = 0; d < dirs; d++) {
      const nx = cx + NX[d]!;
      const ny = cy + NY[d]!;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      const nc = costs[ni]!;
      if (nc <= 0 || closed[ni] === stamp) continue;
      let step: number;
      if (d < 4) {
        step = nc;
      } else {
        // No corner cutting: both orthogonal neighbours of the diagonal must be open.
        if (costs[cy * width + nx]! <= 0 || costs[ny * width + cx]! <= 0) continue;
        step = SQRT2 * nc;
      }
      const ng = gc + step;
      if (seen[ni] === stamp && ng >= g[ni]!) continue;
      seen[ni] = stamp;
      g[ni] = ng;
      f[ni] = ng + heuristic(nx, ny, tx, ty, diagonal);
      parent[ni] = cur;
      heap.pushOrDecrease(ni);
    }
  }
  if (!found) return false;

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
  return true;
}

const sa: Cell = { x: 0, y: 0 };
const sb: Cell = { x: 0, y: 0 };

/**
 * String pulling: drops every waypoint that a straight line of walkable cells can skip, in
 * place, so a staircase of cell centres becomes a few straight legs. `path.cursor` is reset to 0.
 * Returns the path. Allocation-free.
 */
export function smoothPath(grid: NavGrid, path: NavPath): NavPath {
  const n = path.length;
  path.cursor = 0;
  if (n < 3) return path;
  const p = path.points;
  let write = 1;
  let anchor = 0;
  while (anchor < n - 1) {
    grid.toCell(p[anchor * 2]!, p[anchor * 2 + 1]!, sa);
    // The furthest waypoint visible from the anchor; the next one is always reachable.
    let far = anchor + 1;
    for (let j = n - 1; j > anchor + 1; j--) {
      grid.toCell(p[j * 2]!, p[j * 2 + 1]!, sb);
      if (hasLineOfWalkable(grid, sa.x, sa.y, sb.x, sb.y)) {
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

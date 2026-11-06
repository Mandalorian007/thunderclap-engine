/**
 * The navigation grid: a field of cells over the XZ plane, each walkable or not and with a cost
 * multiplier. The grid is the one thing every query reads; `version` increments on every edit so
 * a cached path or flow field can tell it is stale. No game nouns: cells, costs, world points.
 */

/** A cell coordinate (`x` across, `y` down the grid; integers inside the grid). Mutable, reused. */
export interface Cell {
  x: number;
  y: number;
}

/** A point on the world XZ plane. `y` (height) is the game's or `geom`'s job. Mutable, reused. */
export interface NavPoint {
  x: number;
  z: number;
}

export interface NavGridOptions {
  /** Cells across. */
  width: number;
  /** Cells down. */
  height: number;
  /** World units per cell side. */
  cellSize: number;
  /** World XZ of the grid's corner (cell 0,0's min corner). Default the origin. */
  origin?: Readonly<NavPoint>;
  /** Initial walkability per cell. Default: every cell walkable. */
  walkable?: (x: number, y: number) => boolean;
  /** Initial cost multiplier per cell (≥ 0; 1 is plain ground). Default 1. */
  cost?: (x: number, y: number) => number;
  /**
   * An extra cost for the step between two cells (row-major indices), added to the step's
   * length × destination cost: a climb penalty, a one-way ledge. `Infinity` blocks the edge in
   * that direction only; negative values are clamped to 0. Honoured by `findPath`,
   * `createFlowField` and `reachable`; absent, a step costs its length × destination cost.
   * Called per expanded edge, so keep it a lookup. Call `grid.touch()` when its inputs change.
   */
  edgeCost?: EdgeCost;
  /** Moves per cell: 8 (king moves, √2 diagonals; default) or 4 (orthogonal only). */
  neighbours?: 4 | 8;
}

/** The step-cost hook: `(fromIndex, toIndex, grid) => cost ≥ 0`, `Infinity` to block. */
export type EdgeCost = (fromIndex: number, toIndex: number, grid: NavGrid) => number;

export interface NavGrid {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  readonly origin: Readonly<NavPoint>;
  /** Increments on every `setWalkable`, `setCost` or `touch` that changes the grid. */
  readonly version: number;
  /** The step-cost hook given at creation, or undefined. */
  readonly edgeCost: EdgeCost | undefined;
  /** Moves per cell, 4 or 8; every query defaults to it. */
  readonly neighbours: 4 | 8;
  /** Cell count (`width * height`). */
  readonly size: number;
  /**
   * Cost multiplier per cell, row-major (`y * width + x`); 0 marks an unwalkable cell. Read it
   * directly in hot loops; write through `setWalkable` and `setCost` so `version` moves.
   */
  readonly costs: Float32Array;
  /** Sets walkability by cell or by row-major index; a cell made walkable gets cost 1. */
  setWalkable(x: number, y: number, walkable: boolean): void;
  setWalkable(index: number, walkable: boolean): void;
  /** Sets the cost multiplier (clamped to ≥ 0) by cell or by index; 0 makes it unwalkable. */
  setCost(x: number, y: number, cost: number): void;
  setCost(index: number, cost: number): void;
  /**
   * Bumps `version` without changing a cell: for when what `edgeCost` reads has changed, so
   * cached paths, fields and reaches read as stale.
   */
  touch(): void;
  /** False outside the grid. */
  isWalkable(x: number, y: number): boolean;
  /** The cost multiplier, or 0 outside the grid. */
  costAt(x: number, y: number): number;
  inBounds(x: number, y: number): boolean;
  /** Row-major index of a cell (no bounds check). */
  index(x: number, y: number): number;
  /** The cell under a world point (clamped into the grid). Returns `out`. */
  toCell(worldX: number, worldZ: number, out: Cell): Cell;
  /** The world centre of a cell. Returns `out`. */
  toWorld(cx: number, cy: number, out: NavPoint): NavPoint;
}

class Grid implements NavGrid {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  readonly origin: Readonly<NavPoint>;
  readonly size: number;
  readonly costs: Float32Array;
  readonly edgeCost: EdgeCost | undefined;
  readonly neighbours: 4 | 8;
  version = 0;

  constructor(opts: NavGridOptions) {
    if (opts.neighbours !== undefined && opts.neighbours !== 4 && opts.neighbours !== 8) {
      throw new Error('nav: neighbours must be 4 or 8');
    }
    this.edgeCost = opts.edgeCost;
    this.neighbours = opts.neighbours ?? 8;
    const width = Math.floor(opts.width);
    const height = Math.floor(opts.height);
    if (!(width > 0) || !(height > 0)) throw new Error('nav: grid width and height must be ≥ 1');
    if (!(opts.cellSize > 0) || !Number.isFinite(opts.cellSize)) {
      throw new Error('nav: cellSize must be a positive number');
    }
    this.width = width;
    this.height = height;
    this.cellSize = opts.cellSize;
    this.origin = { x: opts.origin?.x ?? 0, z: opts.origin?.z ?? 0 };
    this.size = width * height;
    this.costs = new Float32Array(this.size);
    const walkable = opts.walkable;
    const cost = opts.cost;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const w = walkable ? walkable(x, y) : true;
        const c = cost ? clampCost(cost(x, y)) : 1;
        this.costs[y * width + x] = w ? c : 0;
      }
    }
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  isWalkable(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.costs[y * this.width + x]! > 0;
  }

  costAt(x: number, y: number): number {
    return this.inBounds(x, y) ? this.costs[y * this.width + x]! : 0;
  }

  setWalkable(a: number, b: number | boolean, c?: boolean): void {
    let i: number;
    let walkable: boolean;
    if (c === undefined) {
      i = a;
      walkable = b as boolean;
      if (!(i >= 0 && i < this.size)) return;
    } else {
      if (!this.inBounds(a, b as number)) return;
      i = (b as number) * this.width + a;
      walkable = c;
    }
    const was = this.costs[i]! > 0;
    if (was === walkable) return;
    this.costs[i] = walkable ? 1 : 0;
    this.version++;
  }

  setCost(a: number, b: number, c?: number): void {
    let i: number;
    let cost: number;
    if (c === undefined) {
      i = a;
      cost = b;
      if (!(i >= 0 && i < this.size)) return;
    } else {
      if (!this.inBounds(a, b)) return;
      i = b * this.width + a;
      cost = c;
    }
    const v = clampCost(cost);
    if (this.costs[i] === v) return;
    this.costs[i] = v;
    this.version++;
  }

  touch(): void {
    this.version++;
  }

  toCell(worldX: number, worldZ: number, out: Cell): Cell {
    const cx = Math.floor((worldX - this.origin.x) / this.cellSize);
    const cy = Math.floor((worldZ - this.origin.z) / this.cellSize);
    out.x = cx < 0 ? 0 : cx >= this.width ? this.width - 1 : cx;
    out.y = cy < 0 ? 0 : cy >= this.height ? this.height - 1 : cy;
    return out;
  }

  toWorld(cx: number, cy: number, out: NavPoint): NavPoint {
    out.x = this.origin.x + (cx + 0.5) * this.cellSize;
    out.z = this.origin.z + (cy + 0.5) * this.cellSize;
    return out;
  }
}

function clampCost(c: number): number {
  return Number.isFinite(c) && c > 0 ? c : 0;
}

/** Neighbour offsets shared by every query: the four orthogonal first, then the four diagonal. */
export const NEIGHBOUR_X = [1, -1, 0, 0, 1, 1, -1, -1] as const;
export const NEIGHBOUR_Y = [0, 0, 1, -1, 1, -1, 1, -1] as const;

/**
 * The cost of stepping from cell `from` to its neighbour `to` in direction `d` (an index into
 * `NEIGHBOUR_X`): the step's length (1 or √2) × the destination's cost multiplier, plus the
 * grid's `edgeCost` if any. `Infinity` when the step is blocked: an unwalkable destination, a
 * diagonal whose two orthogonal neighbours are not both walkable (no corner cutting), or an
 * edge the hook blocks. `from` and `to` are row-major indices; `fx`, `fy` are `from`'s cell.
 */
export function stepCost(grid: NavGrid, from: number, fx: number, fy: number, d: number): number {
  const len = stepLength(grid, fx, fy, d);
  if (len === Infinity) return Infinity;
  const to = (fy + NEIGHBOUR_Y[d]!) * grid.width + fx + NEIGHBOUR_X[d]!;
  return len * grid.costs[to]! + edgeCostOf(grid, from, to);
}

/**
 * The length of the step from cell `fx, fy` in direction `d`: 1, √2, or `Infinity` when the
 * destination is outside the grid or unwalkable, or the diagonal would cut a corner.
 */
export function stepLength(grid: NavGrid, fx: number, fy: number, d: number): number {
  const width = grid.width;
  const nx = fx + NEIGHBOUR_X[d]!;
  const ny = fy + NEIGHBOUR_Y[d]!;
  if (nx < 0 || ny < 0 || nx >= width || ny >= grid.height) return Infinity;
  const costs = grid.costs;
  if (costs[ny * width + nx]! <= 0) return Infinity;
  if (d < 4) return 1;
  if (costs[fy * width + nx]! <= 0 || costs[ny * width + fx]! <= 0) return Infinity;
  return Math.SQRT2;
}

/** The hook's term for the edge `from → to`: 0 without a hook or below zero, `Infinity` to block. */
export function edgeCostOf(grid: NavGrid, from: number, to: number): number {
  const hook = grid.edgeCost;
  if (!hook) return 0;
  const e = hook(from, to, grid);
  if (e === Infinity || Number.isNaN(e)) return Infinity;
  return Math.max(e, 0);
}

/** Builds a grid; every cell walkable at cost 1 unless the callbacks say otherwise. */
export function createNavGrid(opts: NavGridOptions): NavGrid {
  return new Grid(opts);
}

/**
 * True when a straight segment between the centres of two cells crosses walkable cells only
 * (a supercover walk: a segment through a corner needs both cells beside the corner walkable,
 * so it never slips between two diagonal walls). Both endpoints must be walkable.
 */
export function hasLineOfWalkable(
  grid: NavGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  if (!grid.isWalkable(x0, y0) || !grid.isWalkable(x1, y1)) return false;
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
  }
  return true;
}

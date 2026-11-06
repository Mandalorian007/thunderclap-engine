/**
 * `slideTiles`: a 2D box moved against a tile grid, the platformer case. Axis-separated: each
 * sub-step (at most half a tile) moves x then y and pushes the box out of what it entered.
 * Solid tiles block from every side; one-way tiles only hold a box falling onto them from above;
 * moving platforms (`movers`) are solid boxes that also carry what stands on them.
 *
 * Screen convention: y grows downward, so `+dy` falls, "ground" is below (`y + h`) and a
 * ceiling above (`y`). A `GridSource` maps its column `x` and row `z` to tile `(cx, cy)`, its
 * `origin` `[x, z]` to the world x, y of tile (0, 0). Pure arithmetic: no allocation per call.
 */
import { type GridSource, gridSolid } from './grid';

/** What a tile is: `TILE_EMPTY`, `TILE_SOLID` or `TILE_ONE_WAY`. */
export type TileKind = number;
export const TILE_EMPTY = 0;
export const TILE_SOLID = 1;
/** Holds only from above: a box rising or moving sideways passes through. */
export const TILE_ONE_WAY = 2;

/** A tile map by query: `solidAt(cx, cy)` for any tile, `cellSize` wide, (0, 0) at `origin`. */
export interface TileQuery {
  cellSize: number;
  /** World x, y of tile (0, 0)'s top-left corner. Default `[0, 0]`. */
  origin?: readonly [number, number];
  solidAt(cx: number, cy: number): TileKind;
}

/** A box: top-left corner and size. */
export interface TileBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A moving platform's box this tick and how far it moved since the last one. */
export interface TileMover extends TileBox {
  dx: number;
  dy: number;
}

export interface TileSlideOptions {
  /** One-way tiles hold a falling box. Default true; false drops through them. */
  oneWay?: boolean;
  /**
   * A box on the ground blocked sideways climbs a ledge up to this high (world units) instead
   * of stopping. Default 0.
   */
  stepUp?: number;
  /** Moving platforms: solid, and a box landing on one rides it (`riding`, then `carryBy`). */
  movers?: readonly TileMover[];
}

/** Where `slideTiles` left the box, and what it touched. `createTileSlideResult` makes one. */
export interface TileSlideResult {
  x: number;
  y: number;
  /** The displacement made, carry included (`x - box.x`, `y - box.y`). */
  dx: number;
  dy: number;
  /** Resting on a solid or one-way tile, or a mover, at the end of the move. */
  onGround: boolean;
  hitCeiling: boolean;
  hitWall: boolean;
  /** Index into `movers` of the platform the box stands on, or -1. */
  riding: number;
  /**
   * A carry queued by `carryBy`, applied (against the tiles) before the next `slideTiles`
   * moves the box with this result, then cleared.
   */
  carried: { dx: number; dy: number };
}

export function createTileSlideResult(): TileSlideResult {
  return {
    x: 0,
    y: 0,
    dx: 0,
    dy: 0,
    onGround: false,
    hitCeiling: false,
    hitWall: false,
    riding: -1,
    carried: { dx: 0, dy: 0 },
  };
}

/**
 * Queue `mover`'s motion this tick into `result.carried`, for the next `slideTiles` with that
 * result to apply first. Call it with the platform the box rode last tick
 * (`movers[result.riding]`), after the platforms move and before the box does. Returns `result`.
 */
export function carryBy(
  result: TileSlideResult,
  mover: { readonly dx: number; readonly dy: number },
): TileSlideResult {
  result.carried.dx += mover.dx;
  result.carried.dy += mover.dy;
  return result;
}

const EPS = 0.001;

// The query being run: module scratch so the helpers take no closures (no allocation per call).
let grid: GridSource | TileQuery | null = null;
let size = 1;
let ox = 0;
let oy = 0;
let oneWay = true;
const NO_MOVERS: readonly TileMover[] = [];
const NO_OPTIONS: TileSlideOptions = {};
let movers: readonly TileMover[] = NO_MOVERS;

function kind(cx: number, cy: number): TileKind {
  const g = grid!;
  if ('solidAt' in g) return g.solidAt(cx, cy);
  return gridSolid(g, cx, cy) ? TILE_SOLID : TILE_EMPTY;
}

function overlaps(r: TileSlideResult, w: number, h: number, m: TileBox): boolean {
  return r.x < m.x + m.w && r.x + w > m.x && r.y < m.y + m.h && r.y + h > m.y;
}

/** A solid tile anywhere in the box at (x, y)? */
function blockedAt(x: number, y: number, w: number, h: number): boolean {
  const c0 = Math.floor((x + EPS - ox) / size);
  const c1 = Math.floor((x + w - EPS - ox) / size);
  const r0 = Math.floor((y + EPS - oy) / size);
  const r1 = Math.floor((y + h - EPS - oy) / size);
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) if (kind(c, r) === TILE_SOLID) return true;
  return false;
}

/** Push the box out of a solid column it entered moving `dir` along x. True on a hit. */
function resolveX(
  r: TileSlideResult,
  w: number,
  h: number,
  dir: number,
  stepUp: number,
  grounded: boolean,
): boolean {
  if (dir === 0) return false;
  let hit = false;
  const top = Math.floor((r.y + EPS - oy) / size);
  const bottom = Math.floor((r.y + h - EPS - oy) / size);
  const col =
    dir > 0 ? Math.floor((r.x + w - EPS - ox) / size) : Math.floor((r.x + EPS - ox) / size);
  let highest = Number.POSITIVE_INFINITY;
  for (let row = top; row <= bottom; row++) {
    if (kind(col, row) === TILE_SOLID) {
      highest = row;
      break;
    }
  }
  if (highest !== Number.POSITIVE_INFINITY) {
    // A ledge low enough to step onto, with room above it?
    const rise = r.y + h - (oy + highest * size);
    if (grounded && stepUp > 0 && rise <= stepUp + EPS && !blockedAt(r.x, r.y - rise, w, h)) {
      r.y -= rise;
    } else {
      r.x = dir > 0 ? ox + col * size - w : ox + (col + 1) * size;
      hit = true;
    }
  }
  for (let i = 0; i < movers.length; i++) {
    const m = movers[i]!;
    if (!overlaps(r, w, h, m)) continue;
    // Only a clearly sideways overlap is a wall (standing on top is not).
    if (Math.min(r.y + h - m.y, m.y + m.h - r.y) <= 2 * EPS) continue;
    r.x = dir > 0 ? m.x - w : m.x + m.w;
    hit = true;
  }
  return hit;
}

function resolveY(r: TileSlideResult, w: number, h: number, dir: number): void {
  if (dir === 0) return;
  const left = Math.floor((r.x + EPS - ox) / size);
  const right = Math.floor((r.x + w - EPS - ox) / size);
  if (dir > 0) {
    const row = Math.floor((r.y + h - EPS - oy) / size);
    const rowTop = oy + row * size;
    const prevBottom = r.y + h - dir;
    for (let c = left; c <= right; c++) {
      const k = kind(c, row);
      if (k === TILE_SOLID || (oneWay && k === TILE_ONE_WAY && prevBottom <= rowTop + EPS)) {
        r.y = rowTop - h;
        r.onGround = true;
        break;
      }
    }
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i]!;
      if (!overlaps(r, w, h, m)) continue;
      // Land when the feet were at or above the platform's top before this step (its previous
      // top, as it is moving too).
      if (prevBottom <= m.y - m.dy + EPS) {
        r.y = m.y - h;
        r.onGround = true;
        r.riding = i;
      }
    }
  } else {
    const row = Math.floor((r.y + EPS - oy) / size);
    for (let c = left; c <= right; c++) {
      if (kind(c, row) === TILE_SOLID) {
        r.y = oy + (row + 1) * size;
        r.hitCeiling = true;
        break;
      }
    }
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i]!;
      if (!overlaps(r, w, h, m)) continue;
      if (r.y < m.y + m.h && r.y > m.y) {
        r.y = m.y + m.h;
        r.hitCeiling = true;
      }
    }
  }
}

/** At rest vertically: anything right under the feet? */
function probeGround(r: TileSlideResult, w: number, h: number): void {
  const feet = r.y + h;
  const row = Math.floor((feet + EPS - oy) / size);
  if (Math.abs(oy + row * size - feet) <= EPS) {
    const left = Math.floor((r.x + EPS - ox) / size);
    const right = Math.floor((r.x + w - EPS - ox) / size);
    for (let c = left; c <= right; c++) {
      const k = kind(c, row);
      if (k === TILE_SOLID || (oneWay && k === TILE_ONE_WAY)) {
        r.onGround = true;
        break;
      }
    }
  }
  for (let i = 0; i < movers.length; i++) {
    const m = movers[i]!;
    if (Math.abs(m.y - feet) <= EPS && r.x < m.x + m.w && r.x + w > m.x) {
      r.onGround = true;
      r.riding = i;
    }
  }
}

/**
 * Move `box` by `(dx, dy)` against `tiles` (a `GridSource` or a `TileQuery`), writing where it
 * ended and what it touched into `out` (returned). A carry queued in `out.carried` (`carryBy`)
 * is applied first and cleared. The box is never moved more than half a tile per sub-step, so
 * it cannot tunnel; a box sliding along a floor or wall of separate tiles never catches on their
 * seams (each axis only tests the tiles ahead of its leading edge, inset by a small epsilon).
 * `box` itself is not changed: copy `out.x`, `out.y` back.
 */
export function slideTiles(
  tiles: GridSource | TileQuery,
  box: TileBox,
  dx: number,
  dy: number,
  out: TileSlideResult,
  opts: TileSlideOptions = NO_OPTIONS,
): TileSlideResult {
  grid = tiles;
  size = tiles.cellSize;
  if (!(size > 0)) throw new Error(`collide: slideTiles needs a positive cellSize, got ${size}`);
  ox = tiles.origin?.[0] ?? 0;
  oy = tiles.origin?.[1] ?? 0;
  oneWay = opts.oneWay ?? true;
  movers = opts.movers ?? NO_MOVERS;
  const stepUp = opts.stepUp ?? 0;
  const { w, h } = box;
  const wasGrounded = out.onGround;
  out.x = box.x;
  out.y = box.y;
  out.onGround = false;
  out.hitCeiling = false;
  out.hitWall = false;
  out.riding = -1;

  // The carry: moves with the platform, still blocked by walls (the platform itself skipped by
  // standing on it, as `resolveX` ignores a top contact).
  const cx = out.carried.dx;
  const cy = out.carried.dy;
  out.carried.dx = 0;
  out.carried.dy = 0;
  if (cx !== 0 || cy !== 0) {
    out.x += cx;
    out.y += cy;
    resolveX(out, w, h, cx, 0, false);
    if (cy < 0) {
      // Lifted: a ceiling stops it.
      const r = Math.floor((out.y + EPS - oy) / size);
      const l = Math.floor((out.x + EPS - ox) / size);
      const rr = Math.floor((out.x + w - EPS - ox) / size);
      for (let c = l; c <= rr; c++) {
        if (kind(c, r) === TILE_SOLID) {
          out.y = oy + (r + 1) * size;
          out.hitCeiling = true;
          break;
        }
      }
    }
  }

  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (size / 2)));
  const sx = dx / steps;
  const sy = dy / steps;
  let grounded = wasGrounded || cx !== 0 || cy !== 0;
  for (let i = 0; i < steps; i++) {
    if (sx !== 0 && !out.hitWall) {
      out.x += sx;
      if (resolveX(out, w, h, sx, stepUp, grounded)) out.hitWall = true;
    }
    if (sy !== 0 && !(out.onGround && sy > 0) && !(out.hitCeiling && sy < 0)) {
      out.y += sy;
      resolveY(out, w, h, sy);
      if (out.onGround) grounded = true;
    }
  }
  if (!out.onGround && dy >= 0) probeGround(out, w, h);
  out.dx = out.x - box.x;
  out.dy = out.y - box.y;
  grid = null;
  movers = NO_MOVERS;
  return out;
}

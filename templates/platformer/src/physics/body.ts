/**
 * AABB vs tile-grid collision. Pure: no DOM, no time, no allocation after construction.
 *
 * A body is a top-left box with a velocity. `moveBody` hands the motion to the engine's
 * `slideTiles` (`@thunderclap/engine/geom`): sub-stepped (never more than half a tile per step),
 * X then Y against solid tiles, one-way tiles (only when falling onto them from above) and moving
 * platforms (solid boxes that also carry what stands on them). This file maps the level onto the
 * engine's tile kinds and keeps the velocity in step with what was hit.
 */
import {
  carryBy,
  createTileSlideResult,
  slideTiles,
  TILE_EMPTY,
  TILE_ONE_WAY,
  TILE_SOLID,
  type TileQuery,
  type TileSlideOptions,
  type TileSlideResult,
} from '@thunderclap/engine/geom';
import { kindAt, type Level, ONE_WAY, SOLID, TILE } from '../levels/format';

export interface Body {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  /** Standing on something this tick (set by `moveBody`). */
  grounded: boolean;
  /** Index into the `movers` array the body stands on, or -1. */
  riding: number;
  /** Hit a wall / ceiling this tick (set by `moveBody`). */
  hitWall: boolean;
  hitCeiling: boolean;
  /** The engine's slide state for this body (the carry queue lives here). */
  readonly slide: TileSlideResult;
}

/** A moving platform's box for this tick, and how far it moved since the last one. */
export interface MoverBox {
  x: number;
  y: number;
  w: number;
  h: number;
  dx: number;
  dy: number;
}

export function createBody(x: number, y: number, w: number, h: number): Body {
  return {
    x,
    y,
    w,
    h,
    vx: 0,
    vy: 0,
    grounded: false,
    riding: -1,
    hitWall: false,
    hitCeiling: false,
    slide: createTileSlideResult(),
  };
}

// The level being queried: one object, retargeted per call (no allocation per move).
let current: Level | null = null;
const tiles: TileQuery = {
  cellSize: TILE,
  solidAt(cx, cy) {
    const k = kindAt(current!, cx, cy);
    return k === SOLID ? TILE_SOLID : k === ONE_WAY ? TILE_ONE_WAY : TILE_EMPTY;
  },
};
const opts: { movers: readonly MoverBox[] } & TileSlideOptions = { movers: [] };

/**
 * Moves `body` by its velocity over `dt`, resolving against `level` and `movers`. A body already
 * riding a mover is carried by that mover's delta first, so it keeps up with it. Sets `grounded`,
 * `riding`, `hitWall`, `hitCeiling`; zeroes the velocity component that hit something.
 */
export function moveBody(body: Body, level: Level, movers: readonly MoverBox[], dt: number): void {
  const r = body.slide;
  const m = body.riding >= 0 ? movers[body.riding] : undefined;
  if (m) carryBy(r, m);
  r.onGround = body.grounded;
  current = level;
  opts.movers = movers;
  slideTiles(tiles, body, body.vx * dt, body.vy * dt, r, opts);
  current = null;
  body.x = r.x;
  body.y = r.y;
  body.grounded = r.onGround;
  body.riding = r.riding;
  body.hitWall = r.hitWall;
  body.hitCeiling = r.hitCeiling;
  if (r.hitWall) body.vx = 0;
  if ((r.onGround && body.vy >= 0) || r.hitCeiling) body.vy = 0;
}

/** True when any tile of `kind` touches the body's box (shrunk by `inset` px). */
export function touchesKind(body: Body, level: Level, kind: number, inset = 4): boolean {
  const left = Math.floor((body.x + inset) / TILE);
  const right = Math.floor((body.x + body.w - inset) / TILE);
  const top = Math.floor((body.y + inset) / TILE);
  const bottom = Math.floor((body.y + body.h - inset) / TILE);
  for (let r = top; r <= bottom; r++) {
    for (let c = left; c <= right; c++) if (kindAt(level, c, r) === kind) return true;
  }
  return false;
}

/** True when the body's box overlaps the tile at `(col, row)`. */
export function touchesTile(body: Body, col: number, row: number, inset = 8): boolean {
  const x0 = col * TILE + inset;
  const y0 = row * TILE + inset;
  const x1 = (col + 1) * TILE - inset;
  const y1 = (row + 1) * TILE - inset;
  return body.x < x1 && body.x + body.w > x0 && body.y < y1 && body.y + body.h > y0;
}

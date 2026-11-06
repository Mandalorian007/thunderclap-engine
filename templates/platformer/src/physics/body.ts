/**
 * AABB vs tile-grid collision. Pure: no engine, no DOM, no allocation after construction.
 *
 * A body is a top-left box with a velocity. `moveBody` sub-steps the motion (never more than half a
 * tile per step), resolving X then Y against solid tiles, one-way tiles (only when falling onto
 * them from above) and moving platforms (solid boxes that also carry what stands on them).
 *
 * The engine does not ship a 2D slide helper on `main` yet (ws/collide's `slide2` is in flight);
 * this file is what the template had to write instead.
 */
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
  };
}

const EPS = 0.001;
const MAX_STEP = TILE / 2;

/**
 * Moves `body` by its velocity over `dt`, resolving against `level` and `movers`. A body already
 * riding a mover is carried by that mover's delta first, so it keeps up with it. Sets `grounded`,
 * `riding`, `hitWall`, `hitCeiling`; zeroes the velocity component that hit something.
 */
export function moveBody(body: Body, level: Level, movers: readonly MoverBox[], dt: number): void {
  // Carry: a body on a mover moves with it before its own motion, and the mover may push it up.
  if (body.riding >= 0) {
    const m = movers[body.riding];
    if (m) {
      body.x += m.dx;
      body.y += m.dy;
      resolveX(body, level, m.dx, movers, -1);
    }
  }
  body.grounded = false;
  body.riding = -1;
  body.hitWall = false;
  body.hitCeiling = false;

  const dx = body.vx * dt;
  const dy = body.vy * dt;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / MAX_STEP));
  const sx = dx / steps;
  const sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    if (sx !== 0) {
      body.x += sx;
      if (resolveX(body, level, sx, movers, -1)) {
        body.vx = 0;
        body.hitWall = true;
      }
    }
    body.y += sy;
    resolveY(body, level, sy, movers);
    if (body.grounded && sy >= 0) {
      body.vy = 0;
    } else if (body.hitCeiling) {
      body.vy = 0;
    }
  }
  // Standing still vertically: still check what is underneath so `grounded` stays true at rest.
  if (dy === 0) probeGround(body, level, movers);
}

/** True when a solid blocks the body's horizontal position; pushes the body out. */
function resolveX(
  body: Body,
  level: Level,
  dir: number,
  movers: readonly MoverBox[],
  skipMover: number,
): boolean {
  let hit = false;
  const top = Math.floor((body.y + EPS) / TILE);
  const bottom = Math.floor((body.y + body.h - EPS) / TILE);
  if (dir > 0) {
    const col = Math.floor((body.x + body.w - EPS) / TILE);
    for (let r = top; r <= bottom; r++) {
      if (kindAt(level, col, r) === SOLID) {
        body.x = col * TILE - body.w;
        hit = true;
        break;
      }
    }
  } else if (dir < 0) {
    const col = Math.floor((body.x + EPS) / TILE);
    for (let r = top; r <= bottom; r++) {
      if (kindAt(level, col, r) === SOLID) {
        body.x = (col + 1) * TILE;
        hit = true;
        break;
      }
    }
  }
  for (let i = 0; i < movers.length; i++) {
    if (i === skipMover) continue;
    const m = movers[i]!;
    if (!overlaps(body, m)) continue;
    // Only push sideways when the overlap is clearly horizontal (standing on top is not a wall).
    const fromTop = body.y + body.h - m.y;
    const fromBottom = m.y + m.h - body.y;
    if (Math.min(fromTop, fromBottom) <= 2 * EPS) continue;
    if (dir > 0) body.x = m.x - body.w;
    else if (dir < 0) body.x = m.x + m.w;
    else continue;
    hit = true;
  }
  return hit;
}

function resolveY(body: Body, level: Level, dir: number, movers: readonly MoverBox[]): void {
  const left = Math.floor((body.x + EPS) / TILE);
  const right = Math.floor((body.x + body.w - EPS) / TILE);
  if (dir > 0) {
    const row = Math.floor((body.y + body.h - EPS) / TILE);
    const prevBottom = body.y + body.h - dir;
    for (let c = left; c <= right; c++) {
      const k = kindAt(level, c, row);
      if (k === SOLID || (k === ONE_WAY && prevBottom <= row * TILE + EPS)) {
        body.y = row * TILE - body.h;
        body.grounded = true;
        break;
      }
    }
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i]!;
      if (!overlaps(body, m)) continue;
      // Land when the feet were at or above the mover's top before this step (its previous top
      // when it is moving).
      if (prevBottom <= m.y - m.dy + EPS) {
        body.y = m.y - body.h;
        body.grounded = true;
        body.riding = i;
      }
    }
  } else if (dir < 0) {
    const row = Math.floor((body.y + EPS) / TILE);
    for (let c = left; c <= right; c++) {
      if (kindAt(level, c, row) === SOLID) {
        body.y = (row + 1) * TILE;
        body.hitCeiling = true;
        break;
      }
    }
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i]!;
      if (!overlaps(body, m)) continue;
      if (body.y < m.y + m.h && body.y > m.y) {
        body.y = m.y + m.h;
        body.hitCeiling = true;
      }
    }
  }
}

/** At rest: is there ground right under the feet? */
function probeGround(body: Body, level: Level, movers: readonly MoverBox[]): void {
  const left = Math.floor((body.x + EPS) / TILE);
  const right = Math.floor((body.x + body.w - EPS) / TILE);
  const feet = body.y + body.h;
  const row = Math.floor((feet + EPS) / TILE);
  if (Math.abs(row * TILE - feet) <= EPS) {
    for (let c = left; c <= right; c++) {
      const k = kindAt(level, c, row);
      if (k === SOLID || k === ONE_WAY) {
        body.grounded = true;
        break;
      }
    }
  }
  for (let i = 0; i < movers.length; i++) {
    const m = movers[i]!;
    if (Math.abs(m.y - feet) <= EPS && body.x < m.x + m.w && body.x + body.w > m.x) {
      body.grounded = true;
      body.riding = i;
    }
  }
}

function overlaps(b: Body, m: MoverBox): boolean {
  return (
    b.x < m.x + m.w - EPS && b.x + b.w > m.x + EPS && b.y < m.y + m.h - EPS && b.y + b.h > m.y + EPS
  );
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

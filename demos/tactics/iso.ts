/**
 * The isometric projection and its inverse. Both are the demo's: the engine draws an ortho2d
 * camera over sprites in design px and knows nothing about diamonds.
 *
 * A tile `(tx, ty)` at elevation `e` has its diamond centre at
 *   x = ORIGIN_X + (tx - ty) * TW / 2
 *   y = ORIGIN_Y + (tx + ty) * TH / 2 - e * EH
 * so tile space maps to a square grid turned 45° and squashed 2:1. The inverse tries each
 * elevation from the top down and keeps the first whose tile really has that height, so a
 * pointer over a raised tile's top lands on it and not on the flat tile the same pixel would
 * cover at ground level.
 */

/** Tiles per side. */
export const MAP = 24;
/** Diamond width and height in design px. */
export const TW = 64;
export const TH = 32;
/** One elevation step in design px. */
export const EH = 16;
/** Design space (the default `createGame` design). */
export const DESIGN_W = 1920;
export const DESIGN_H = 1080;
/** World position of tile (0, 0)'s diamond centre at elevation 0. */
export const ORIGIN_X = DESIGN_W / 2;
export const ORIGIN_Y = (DESIGN_H - MAP * TH) / 2 + TH / 2 + EH;

export interface Vec2 {
  x: number;
  y: number;
}

export function tileToWorld(tx: number, ty: number, elevation: number, out: Vec2): Vec2 {
  out.x = ORIGIN_X + ((tx - ty) * TW) / 2;
  out.y = ORIGIN_Y + ((tx + ty) * TH) / 2 - elevation * EH;
  return out;
}

/** Fractional tile coordinates of a world point assuming elevation `elevation` (centre = integer). */
export function worldToTileAt(wx: number, wy: number, elevation: number, out: Vec2): Vec2 {
  const a = (wx - ORIGIN_X) / (TW / 2);
  const b = (wy - ORIGIN_Y + elevation * EH) / (TH / 2);
  out.x = (a + b) / 2;
  out.y = (b - a) / 2;
  return out;
}

/**
 * The tile under a world point, elevation-aware: the highest elevation whose tile at that
 * height contains the point wins. Writes -1, -1 when the point is off the map.
 */
export function worldToTile(
  wx: number,
  wy: number,
  elevationAt: (tx: number, ty: number) => number,
  maxElevation: number,
  out: Vec2,
): Vec2 {
  for (let e = maxElevation; e >= 0; e--) {
    worldToTileAt(wx, wy, e, out);
    const tx = Math.round(out.x);
    const ty = Math.round(out.y);
    if (tx < 0 || ty < 0 || tx >= MAP || ty >= MAP) continue;
    if (elevationAt(tx, ty) === e) {
      out.x = tx;
      out.y = ty;
      return out;
    }
  }
  out.x = -1;
  out.y = -1;
  return out;
}

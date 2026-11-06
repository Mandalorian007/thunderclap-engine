/**
 * Isometric (2:1 diamond) projection and its inverse (ws/ergo-2d-2): the maths every
 * isometric game rewrote. Tile space `(tx, ty)` is a square grid turned 45° and squashed to
 * `tileW × tileH` diamonds; elevation `elev` lifts a tile `elevH × elev` px up the screen.
 *
 *   x = originX + (tx - ty) × tileW / 2
 *   y = originY + (tx + ty) × tileH / 2 - elev × elevH
 *
 * Pure arithmetic in the caller's 2D space (a layer's logical px, a camera's world px): no
 * camera, no map, no allocation (`out` params). `isoInverseProbe` is the pointer-to-tile rule
 * a tactics map needs (the highest elevation whose tile really is that tall wins) and
 * `isoHiddenBy` tells when a tile's top disappears behind a taller front neighbour.
 */

export interface IsoOptions {
  /** Diamond width and height in px (2:1 is the classic; any ratio works). */
  tileW: number;
  tileH: number;
  /** Px one elevation step lifts a tile. Default `tileH / 2`. */
  elevH?: number;
  /** Position of tile `(0, 0)`'s diamond centre at elevation 0. Default `(0, 0)`. */
  originX?: number;
  originY?: number;
}

/** A point `toScreen` / `toTile` fill: any `{ x, y }` (a `CameraPoint`, a `Vec2`). */
export interface IsoPoint {
  x: number;
  y: number;
}

/** Tile heights for `isoInverseProbe` and `isoHiddenBy`: off the map, return a negative number. */
export type IsoHeightAt = (tx: number, ty: number) => number;

/**
 * Depth weight of one elevation step in `Iso.depth`: a tile's key is `tx + ty + elev × this`,
 * so elevations under 256 never cross into the next diagonal.
 */
export const ISO_ELEV_DEPTH = 1 / 256;

export interface Iso {
  readonly tileW: number;
  readonly tileH: number;
  readonly elevH: number;
  /** Tile `(0, 0)`'s diamond centre at elevation 0. Mutate in place to move the whole lattice. */
  originX: number;
  originY: number;
  /** Diamond centre of tile `(tx, ty)` (fractional allowed) at `elev`, into `out`. */
  toScreen(tx: number, ty: number, elev: number, out: IsoPoint): IsoPoint;
  /**
   * Fractional tile coordinates of screen point `(sx, sy)` assuming the ground there is at
   * `elev`, into `out`. Tile centres are integers: round to pick the tile.
   */
  toTile(sx: number, sy: number, elev: number, out: IsoPoint): IsoPoint;
  /**
   * Painter's-order key: back to front along `tx + ty`, then `elev × ISO_ELEV_DEPTH`. Equal
   * for the tiles of one diagonal, which never overlap on screen.
   */
  depth(tx: number, ty: number, elev: number): number;
}

/** Make an `Iso`. Allocates the object once; everything on it is allocation-free. */
export function createIso(opts: IsoOptions): Iso {
  const { tileW, tileH } = opts;
  if (!(tileW > 0 && tileH > 0)) throw new Error('createIso: tileW and tileH must be > 0');
  const elevH = opts.elevH ?? tileH / 2;
  const hw = tileW / 2;
  const hh = tileH / 2;
  const iso: Iso = {
    tileW,
    tileH,
    elevH,
    originX: opts.originX ?? 0,
    originY: opts.originY ?? 0,
    toScreen(tx, ty, elev, out) {
      out.x = iso.originX + (tx - ty) * hw;
      out.y = iso.originY + (tx + ty) * hh - elev * elevH;
      return out;
    },
    toTile(sx, sy, elev, out) {
      const a = (sx - iso.originX) / hw;
      const b = (sy - iso.originY + elev * elevH) / hh;
      out.x = (a + b) / 2;
      out.y = (b - a) / 2;
      return out;
    },
    depth(tx, ty, elev) {
      return tx + ty + elev * ISO_ELEV_DEPTH;
    },
  };
  return iso;
}

/**
 * The tile under screen point `(sx, sy)` on a map with elevation: tries every elevation from
 * `maxElev` down to 0 and keeps the first tile whose `heightAt` is that elevation, so a pointer
 * over a raised tile's top lands on it and not on the flat tile the same pixel would cover at
 * ground level. Writes the tile into `out` and returns true; writes `(-1, -1)` and returns
 * false when no tile matches (off the map, or over a riser between levels).
 */
export function isoInverseProbe(
  iso: Iso,
  sx: number,
  sy: number,
  heightAt: IsoHeightAt,
  maxElev: number,
  out: IsoPoint,
): boolean {
  for (let e = Math.floor(maxElev); e >= 0; e--) {
    iso.toTile(sx, sy, e, out);
    const tx = Math.floor(out.x + 0.5);
    const ty = Math.floor(out.y + 0.5);
    if (heightAt(tx, ty) === e) {
      out.x = tx;
      out.y = ty;
      return true;
    }
  }
  out.x = -1;
  out.y = -1;
  return false;
}

/**
 * True when the whole top of tile `(tx, ty)` (at `heightAt(tx, ty)`) is covered by taller front
 * neighbours: a column (top diamond plus the wall down to the ground) whose top is at least
 * `tileH` px above ours covers our half of the diamond on its side, so the diagonal front
 * neighbour `(tx + 1, ty + 1)` hides the top alone and `(tx + 1, ty)` with `(tx, ty + 1)` hide
 * it together. With the default `elevH` that is two elevation steps; one step covers the lower
 * quarter and leaves the top visible. Off-map neighbours (negative height) hide nothing.
 */
export function isoHiddenBy(iso: Iso, tx: number, ty: number, heightAt: IsoHeightAt): boolean {
  const e = heightAt(tx, ty);
  if (e < 0) return false;
  const lift = iso.tileH / iso.elevH;
  if (heightAt(tx + 1, ty + 1) - e >= lift) return true;
  return heightAt(tx + 1, ty) - e >= lift && heightAt(tx, ty + 1) - e >= lift;
}

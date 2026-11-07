/**
 * Tile layer (ws/ergo-2d): a `columns × rows` grid of tiles from one atlas texture, drawn as one
 * `Mesh` in one `frame.mesh` call. Each tile is a quad whose UVs select an atlas cell; `set` and
 * `fill` rewrite tiles in a preallocated vertex array and `draw` uploads only the dirty range
 * (one `writeBuffer`), so a 2D game keeps no per-tile `DrawParams` and allocates nothing per
 * frame. Tile `-1` is empty: its quad collapses to zero area.
 *
 * The mesh is authored in logical px: tile `(col, row)` spans `col × tileW .. (col + 1) × tileW`
 * by `row × tileH .. (row + 1) × tileH`. `origin` places the layer's top-left corner and `scale`
 * sizes it; they become the draw's `DrawParams` (`x, y, w, h`), so nothing in the frame changes.
 *
 * Painter mode (ws/ergo-2d-2, `order: 'painter'`): the tiles of each diagonal `col + row` form
 * one band (one mesh), bands draw back to front at `order = base + col + row`, `elevation` lifts
 * a tile `elevH × elev` px, and `diamond` lays the quads on an `Iso` lattice. The tiles of one
 * diagonal never overlap on screen, so a sprite drawn at `order = base + layer.depthOf(tx, ty)`
 * lands over its tile and under the band in front of it. `'grid'` (the default) is the single
 * mesh above and is untouched.
 */
import type { Iso } from '../geom/iso';
import { ISO_ELEV_DEPTH } from '../geom/iso';
import type { DrawParams, Frame, InstanceParams } from './frame';
import type { Material } from './material';
import { type Mesh, VERTEX_FLOATS, VERTEX_LAYOUT_2D } from './mesh';
import type { Renderer } from './renderer';

/** `'grid'`: one mesh, row-major. `'painter'`: one mesh per diagonal, drawn back to front. */
export type TileLayerOrder = 'grid' | 'painter';

export interface TileLayerOptions {
  /** The material drawn with (usually `renderer.createSpriteMaterial({ texture: atlasTexture })`). */
  material: Material;
  /** One tile's quad size in logical px (at `scale` 1). */
  tileW: number;
  tileH: number;
  /** Grid size in tiles. */
  columns: number;
  rows: number;
  /** The atlas grid: how many cells across and down the texture holds. Tile indices are row-major. */
  atlas: { cols: number; rows: number };
  /** Starts every tile at this index (default -1: empty). */
  fill?: number;
  label?: string;
  /** Draw order (see the module comment). Default `'grid'`. */
  order?: TileLayerOrder;
  /**
   * Elevation of tile `(col, row)` in steps, read when the tile is set or filled and on
   * `refresh`; each step lifts the quad `elevH` px. Painter mode only. Default 0 everywhere.
   */
  elevation?: (col: number, row: number) => number;
  /** Px per elevation step. Default `iso.elevH` with `diamond`, else `tileH / 2`. */
  elevH?: number;
  /**
   * Lay the tiles on `iso`'s lattice: tile `(col, row)`'s quad is `tileW × tileH` with the
   * diamond centre `iso.toScreen(col, row, elev)` at `tileW / 2, iso.tileH / 2` from its top-left,
   * so a quad taller than `iso.tileH` hangs a wall below its top. Painter mode only; needs `iso`.
   */
  diamond?: boolean;
  /** The lattice for `diamond` (its origin is in the layer's own px, before `origin`). */
  iso?: Iso;
}

export interface TileLayer {
  readonly columns: number;
  readonly rows: number;
  readonly tileW: number;
  readonly tileH: number;
  readonly order: TileLayerOrder;
  /** Logical-px position of the layer's top-left corner; mutate in place. */
  readonly origin: { x: number; y: number };
  /** Size multiplier (1 = `tileW × tileH` px per tile). */
  scale: number;
  /** Set tile `(col, row)` to atlas cell `tileIndex`, or `-1` to empty it. Out of range: ignored. */
  set(col: number, row: number, tileIndex: number): void;
  /** Atlas cell at `(col, row)`, `-1` when empty or out of range. */
  get(col: number, row: number): number;
  /** Set every tile, row-major (`columns × rows` entries; shorter lists leave the rest alone). */
  fill(tiles: Int16Array | readonly number[]): void;
  /** Tiles that are not empty. */
  readonly count: number;
  /** The layer's mesh (`'grid'`), or its first band (`'painter'`). */
  readonly mesh: Mesh;
  /** Every mesh: one for `'grid'`, one per diagonal `col + row` for `'painter'`. */
  readonly meshes: readonly Mesh[];
  /** Elevation steps the layer last read for `(col, row)` (0 out of range or in grid mode). */
  elevationAt(col: number, row: number): number;
  /**
   * Re-read `elevation` for one tile, or every tile, and move the quads whose height changed.
   * No-op without an `elevation` callback.
   */
  refresh(col?: number, row?: number): void;
  /**
   * Painter's-order key of tile `(tx, ty)` at `elev` (default: its last read elevation):
   * `tx + ty + elev × ISO_ELEV_DEPTH`, the same key as `Iso.depth`. A sprite drawn with
   * `order: base + depthOf(tx, ty)` (submitted after `draw`) renders over that tile's band and
   * under the next; `base` is the `order` given to `draw`.
   */
  depthOf(tx: number, ty: number, elev?: number): number;
  /**
   * Upload the tiles changed since the last draw and record one `frame.mesh` draw per mesh at
   * `origin` and `scale`. `params` (tint, order, layers, emissive, `params`, `uniforms`, shadow
   * flags) are copied onto the layer's own `DrawParams`; its `uv` is never used. In painter mode
   * band `b` draws at `(params.order ?? 0) + b`, and empty bands are skipped.
   */
  draw(frame: Frame, params?: InstanceParams): void;
  destroy(): void;
}

const VERTS_PER_TILE = 4;
const INDICES_PER_TILE = 6;
const TILE_FLOATS = VERTS_PER_TILE * VERTEX_FLOATS;

/** One mesh of the layer: every tile in `'grid'`, one diagonal in `'painter'`. */
interface Band {
  mesh: Mesh;
  vertices: Float32Array;
  slots: number;
  /** Dirty slot range, inclusive; `dirtyMin > dirtyMax` means clean. */
  dirtyMin: number;
  dirtyMax: number;
  /** Non-empty tiles in the band. */
  count: number;
}

/** Make a `TileLayer` on `renderer`. Allocates once: call it at load time. */
export function createTileLayer(renderer: Renderer, opts: TileLayerOptions): TileLayer {
  const { columns, rows, tileW, tileH, material } = opts;
  if (!(columns > 0 && rows > 0)) throw new Error('createTileLayer: columns and rows must be > 0');
  if (!(opts.atlas.cols > 0 && opts.atlas.rows > 0)) {
    throw new Error('createTileLayer: atlas.cols and atlas.rows must be > 0');
  }
  const order: TileLayerOrder = opts.order ?? 'grid';
  const painter = order === 'painter';
  const diamond = painter && opts.diamond === true;
  const iso = opts.iso ?? null;
  if (diamond && !iso) throw new Error('createTileLayer: diamond needs opts.iso');
  const elevationOf = painter ? (opts.elevation ?? null) : null;
  const elevH = opts.elevH ?? (diamond && iso ? iso.elevH : tileH / 2);
  const tileCount = columns * rows;
  const atlasCols = opts.atlas.cols;
  const atlasRows = opts.atlas.rows;
  const tiles = new Int16Array(tileCount).fill(-1);
  const elevs = new Float32Array(tileCount);
  const label = opts.label ?? 'tile-layer';
  const width = columns * tileW;
  const height = rows * tileH;
  const device = renderer.device;
  const stride = VERTEX_LAYOUT_2D.stride;
  const isoPt = { x: 0, y: 0 };

  // Band and slot of every tile: grid is one band in row-major order; painter is one band per
  // diagonal `col + row`, its tiles by `col` (they never overlap, so the order inside is free).
  const bandCount = painter ? columns + rows - 1 : 1;
  const bandOf = new Int32Array(tileCount);
  const slotOf = new Int32Array(tileCount);
  const bandSlots = new Int32Array(bandCount);
  for (let t = 0; t < tileCount; t++) {
    const col = t % columns;
    const row = (t - col) / columns;
    const b = painter ? col + row : 0;
    bandOf[t] = b;
    slotOf[t] = painter ? bandSlots[b]! : t;
    bandSlots[b]!++;
  }

  let bounds: { center: [number, number, number]; radius: number };
  if (diamond && iso) {
    // The lattice's bounding box at elevation 0 (lifts stay inside the extra tileH of margin).
    const cs = [0, columns - 1, 0, columns - 1];
    const rs = [0, 0, rows - 1, rows - 1];
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 4; i++) {
      iso.toScreen(cs[i]!, rs[i]!, 0, isoPt);
      minX = Math.min(minX, isoPt.x - tileW / 2);
      maxX = Math.max(maxX, isoPt.x + tileW / 2);
      minY = Math.min(minY, isoPt.y - tileH);
      maxY = Math.max(maxY, isoPt.y + tileH);
    }
    bounds = {
      center: [(minX + maxX) / 2, (minY + maxY) / 2, 0],
      radius: Math.hypot(maxX - minX, maxY - minY) / 2,
    };
  } else {
    bounds = { center: [width / 2, height / 2, 0], radius: Math.hypot(width, height) / 2 };
  }

  const bands: Band[] = [];
  const meshes: Mesh[] = [];
  for (let b = 0; b < bandCount; b++) {
    const slots = bandSlots[b]!;
    const vertices = new Float32Array(slots * TILE_FLOATS);
    bands.push({
      mesh: null as unknown as Mesh,
      vertices,
      slots,
      dirtyMin: slots,
      dirtyMax: -1,
      count: 0,
    });
  }
  // Every tile starts collapsed (empty): positions at its corner, white, atlas cell 0.
  for (let t = 0; t < tileCount; t++) writeTile(t, -1);
  for (let b = 0; b < bandCount; b++) {
    const band = bands[b]!;
    const vertexCount = band.slots * VERTS_PER_TILE;
    const indices =
      vertexCount > 0xffff
        ? new Uint32Array(band.slots * INDICES_PER_TILE)
        : new Uint16Array(band.slots * INDICES_PER_TILE);
    for (let s = 0; s < band.slots; s++) {
      const v = s * VERTS_PER_TILE;
      const o = s * INDICES_PER_TILE;
      indices[o] = v;
      indices[o + 1] = v + 1;
      indices[o + 2] = v + 2;
      indices[o + 3] = v;
      indices[o + 4] = v + 2;
      indices[o + 5] = v + 3;
    }
    band.mesh = renderer.createMesh({
      label: painter ? `${label}-${b}` : label,
      layout: VERTEX_LAYOUT_2D,
      vertices: band.vertices,
      indices,
      autoBounds: false,
      bounds,
    });
    meshes.push(band.mesh);
  }
  let count = 0;
  const dp: DrawParams = { x: 0, y: 0, w: 1, h: 1 };

  function writeTile(t: number, tileIndex: number): void {
    const col = t % columns;
    const row = (t - col) / columns;
    let x0: number;
    let y0: number;
    if (diamond && iso) {
      iso.toScreen(col, row, elevs[t]!, isoPt);
      x0 = isoPt.x - tileW / 2;
      y0 = isoPt.y - iso.tileH / 2;
    } else {
      x0 = col * tileW;
      y0 = row * tileH - (painter ? elevs[t]! * elevH : 0);
    }
    let x1 = x0 + tileW;
    let y1 = y0 + tileH;
    let u0 = 0;
    let v0 = 0;
    let u1 = 0;
    let v1 = 0;
    if (tileIndex >= 0) {
      const ac = tileIndex % atlasCols;
      const ar = (tileIndex - ac) / atlasCols;
      u0 = ac / atlasCols;
      v0 = ar / atlasRows;
      u1 = (ac + 1) / atlasCols;
      v1 = (ar + 1) / atlasRows;
    } else {
      // Empty: zero area, so nothing is rasterised.
      x1 = x0;
      y1 = y0;
    }
    const vertices = bands[bandOf[t]!]!.vertices;
    let o = slotOf[t]! * TILE_FLOATS;
    o = writeVertex(vertices, o, x0, y0, u0, v0);
    o = writeVertex(vertices, o, x1, y0, u1, v0);
    o = writeVertex(vertices, o, x1, y1, u1, v1);
    writeVertex(vertices, o, x0, y1, u0, v1);
  }

  function writeVertex(
    vertices: Float32Array,
    o: number,
    x: number,
    y: number,
    u: number,
    v: number,
  ): number {
    vertices[o] = x;
    vertices[o + 1] = y;
    vertices[o + 2] = u;
    vertices[o + 3] = v;
    vertices[o + 4] = 1;
    vertices[o + 5] = 1;
    vertices[o + 6] = 1;
    vertices[o + 7] = 1;
    return o + VERTEX_FLOATS;
  }

  function markDirty(t: number): void {
    const band = bands[bandOf[t]!]!;
    const s = slotOf[t]!;
    if (s < band.dirtyMin) band.dirtyMin = s;
    if (s > band.dirtyMax) band.dirtyMax = s;
  }

  function readElevation(t: number): boolean {
    if (!elevationOf) return false;
    const col = t % columns;
    const row = (t - col) / columns;
    const e = elevationOf(col, row);
    if (e === elevs[t]) return false;
    elevs[t] = e;
    return true;
  }

  function setTile(t: number, tileIndex: number): void {
    const next = tileIndex >= 0 ? Math.min(tileIndex, atlasCols * atlasRows - 1) : -1;
    const prev = tiles[t]!;
    const lifted = readElevation(t);
    if (prev === next && !lifted) return;
    const band = bands[bandOf[t]!]!;
    if (prev < 0 && next >= 0) {
      count++;
      band.count++;
    } else if (prev >= 0 && next < 0) {
      count--;
      band.count--;
    }
    tiles[t] = next;
    writeTile(t, next);
    markDirty(t);
  }

  function upload(band: Band): void {
    if (band.dirtyMin > band.dirtyMax) return;
    const first = band.dirtyMin * VERTS_PER_TILE;
    const n = (band.dirtyMax - band.dirtyMin + 1) * VERTS_PER_TILE;
    const vertices = band.vertices;
    device.queue.writeBuffer(
      band.mesh.vertexBuffer,
      first * stride,
      vertices.buffer,
      vertices.byteOffset + first * stride,
      n * stride,
    );
    band.dirtyMin = band.slots;
    band.dirtyMax = -1;
  }

  const layer: TileLayer = {
    columns,
    rows,
    tileW,
    tileH,
    order,
    origin: { x: 0, y: 0 },
    scale: 1,
    mesh: meshes[0]!,
    meshes,
    get count() {
      return count;
    },
    set(col, row, tileIndex) {
      if (col < 0 || row < 0 || col >= columns || row >= rows) return;
      setTile(row * columns + col, tileIndex);
    },
    get(col, row) {
      if (col < 0 || row < 0 || col >= columns || row >= rows) return -1;
      return tiles[row * columns + col]!;
    },
    fill(list) {
      const n = Math.min(list.length, tileCount);
      for (let t = 0; t < n; t++) setTile(t, list[t]!);
    },
    elevationAt(col, row) {
      if (col < 0 || row < 0 || col >= columns || row >= rows) return 0;
      return elevs[row * columns + col]!;
    },
    refresh(col, row) {
      if (!elevationOf) return;
      if (col !== undefined && row !== undefined) {
        if (col < 0 || row < 0 || col >= columns || row >= rows) return;
        const t = row * columns + col;
        if (readElevation(t)) {
          writeTile(t, tiles[t]!);
          markDirty(t);
        }
        return;
      }
      for (let t = 0; t < tileCount; t++) {
        if (readElevation(t)) {
          writeTile(t, tiles[t]!);
          markDirty(t);
        }
      }
    },
    depthOf(tx, ty, elev) {
      const e =
        elev ?? (tx < 0 || ty < 0 || tx >= columns || ty >= rows ? 0 : elevs[ty * columns + tx]!);
      return tx + ty + e * ISO_ELEV_DEPTH;
    },
    draw(frame, params) {
      dp.x = layer.origin.x;
      dp.y = layer.origin.y;
      dp.w = layer.scale;
      dp.h = layer.scale;
      dp.tint = params?.tint;
      dp.params = params?.params;
      dp.emissive = params?.emissive;
      dp.castShadow = params?.castShadow;
      dp.receiveShadow = params?.receiveShadow;
      dp.uniforms = params?.uniforms;
      dp.layers = params?.layers;
      const base = params?.order;
      for (let b = 0; b < bandCount; b++) {
        const band = bands[b]!;
        upload(band);
        if (painter && band.count === 0) continue;
        dp.order = painter ? (base ?? 0) + b : base;
        frame.mesh(band.mesh, material, dp);
      }
    },
    destroy() {
      for (const m of meshes) m.destroy();
    },
  };
  if (opts.fill !== undefined && opts.fill >= 0) {
    for (let t = 0; t < tileCount; t++) setTile(t, opts.fill);
  }
  return layer;
}

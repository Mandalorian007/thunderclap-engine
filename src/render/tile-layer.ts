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
 */
import type { DrawParams, Frame, InstanceParams } from './frame';
import type { Material } from './material';
import { type Mesh, VERTEX_FLOATS, VERTEX_LAYOUT_2D } from './mesh';
import type { Renderer } from './renderer';

export interface TileLayerOptions {
  /** The material drawn with (usually `renderer.createSpriteMaterial(atlasTexture)`). */
  material: Material;
  /** One tile's size in logical px (at `scale` 1). */
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
}

export interface TileLayer {
  readonly columns: number;
  readonly rows: number;
  readonly tileW: number;
  readonly tileH: number;
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
  /** The layer's single mesh. */
  readonly mesh: Mesh;
  /**
   * Upload the tiles changed since the last draw and record one `frame.mesh` draw at `origin`
   * and `scale`. `params` (tint, order, layers, emissive, `params`, `uniforms`, shadow flags)
   * are copied onto the layer's own `DrawParams`; its `uv` is never used.
   */
  draw(frame: Frame, params?: InstanceParams): void;
  destroy(): void;
}

const VERTS_PER_TILE = 4;
const INDICES_PER_TILE = 6;
const TILE_FLOATS = VERTS_PER_TILE * VERTEX_FLOATS;

/** Make a `TileLayer` on `renderer`. Allocates once: call it at load time. */
export function createTileLayer(renderer: Renderer, opts: TileLayerOptions): TileLayer {
  const { columns, rows, tileW, tileH, material } = opts;
  if (!(columns > 0 && rows > 0)) throw new Error('createTileLayer: columns and rows must be > 0');
  if (!(opts.atlas.cols > 0 && opts.atlas.rows > 0)) {
    throw new Error('createTileLayer: atlas.cols and atlas.rows must be > 0');
  }
  const tileCount = columns * rows;
  const atlasCols = opts.atlas.cols;
  const atlasRows = opts.atlas.rows;
  const tiles = new Int16Array(tileCount).fill(-1);
  const vertices = new Float32Array(tileCount * TILE_FLOATS);
  const vertexCount = tileCount * VERTS_PER_TILE;
  const indices =
    vertexCount > 0xffff
      ? new Uint32Array(tileCount * INDICES_PER_TILE)
      : new Uint16Array(tileCount * INDICES_PER_TILE);
  for (let t = 0; t < tileCount; t++) {
    const v = t * VERTS_PER_TILE;
    const o = t * INDICES_PER_TILE;
    indices[o] = v;
    indices[o + 1] = v + 1;
    indices[o + 2] = v + 2;
    indices[o + 3] = v;
    indices[o + 4] = v + 2;
    indices[o + 5] = v + 3;
  }
  // Every tile starts collapsed (empty): positions at its corner, white, atlas cell 0.
  for (let t = 0; t < tileCount; t++) writeTile(t, -1);
  const width = columns * tileW;
  const height = rows * tileH;
  const mesh = renderer.createMesh({
    label: opts.label ?? 'tile-layer',
    layout: VERTEX_LAYOUT_2D,
    vertices,
    indices,
    autoBounds: false,
    bounds: { center: [width / 2, height / 2, 0], radius: Math.hypot(width, height) / 2 },
  });
  const device = renderer.device;
  const stride = VERTEX_LAYOUT_2D.stride;
  // Dirty tile range, inclusive; `dirtyMin > dirtyMax` means clean.
  let dirtyMin = tileCount;
  let dirtyMax = -1;
  let count = 0;
  const dp: DrawParams = { x: 0, y: 0, w: 1, h: 1 };

  function writeTile(t: number, tileIndex: number): void {
    const col = t % columns;
    const row = (t - col) / columns;
    const x0 = col * tileW;
    const y0 = row * tileH;
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
    let o = t * TILE_FLOATS;
    o = writeVertex(o, x0, y0, u0, v0);
    o = writeVertex(o, x1, y0, u1, v0);
    o = writeVertex(o, x1, y1, u1, v1);
    writeVertex(o, x0, y1, u0, v1);
  }

  function writeVertex(o: number, x: number, y: number, u: number, v: number): number {
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

  function setTile(t: number, tileIndex: number): void {
    const next = tileIndex >= 0 ? Math.min(tileIndex, atlasCols * atlasRows - 1) : -1;
    const prev = tiles[t]!;
    if (prev === next) return;
    if (prev < 0) count++;
    else if (next < 0) count--;
    tiles[t] = next;
    writeTile(t, next);
    if (t < dirtyMin) dirtyMin = t;
    if (t > dirtyMax) dirtyMax = t;
  }

  function upload(): void {
    if (dirtyMin > dirtyMax) return;
    const first = dirtyMin * VERTS_PER_TILE;
    const n = (dirtyMax - dirtyMin + 1) * VERTS_PER_TILE;
    device.queue.writeBuffer(
      mesh.vertexBuffer,
      first * stride,
      vertices.buffer,
      vertices.byteOffset + first * stride,
      n * stride,
    );
    dirtyMin = tileCount;
    dirtyMax = -1;
  }

  const layer: TileLayer = {
    columns,
    rows,
    tileW,
    tileH,
    origin: { x: 0, y: 0 },
    scale: 1,
    mesh,
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
    draw(frame, params) {
      upload();
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
      dp.order = params?.order;
      frame.mesh(mesh, material, dp);
    },
    destroy() {
      mesh.destroy();
    },
  };
  if (opts.fill !== undefined && opts.fill >= 0) {
    for (let t = 0; t < tileCount; t++) setTile(t, opts.fill);
  }
  return layer;
}

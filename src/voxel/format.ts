/**
 * `VoxelFormat`: everything the mesher needs to know about a game's world that is not a cell,
 * in one plain-data object (section size, block table, vertex schema, cell layout, sky light
 * falloff). It crosses to mesher Workers by structured clone; the codec, being code, is
 * imported by the Worker script instead.
 */
import type { BlockTable, CellField, CellLayout } from './blocks';
import { defineVertexSchema, type VertexSchema, vertexField } from './schema';

/** Options for `defineVoxelFormat`. */
export interface VoxelFormatOptions {
  /** Cells per section side, 2..32. Default 16. */
  sectionSize?: number;
  blocks: BlockTable;
  /** Default `defineVertexSchema()` (the engine's fields only). */
  vertex?: VertexSchema;
  cell?: CellLayout;
  /** Sky light lost per block below a column's top. Default 3. */
  skyFalloff?: number;
  /** The same through liquid under a column whose top is liquid (sea water). Default 1. */
  liquidSkyFalloff?: number;
}

/** A compiled format (see `defineVoxelFormat`). */
export interface VoxelFormat {
  readonly size: number;
  readonly blocks: BlockTable;
  readonly vertex: VertexSchema;
  readonly idShift: number;
  readonly idMask: number;
  readonly cellFields: readonly CellField[];
  readonly skyFalloff: number;
  readonly liquidSkyFalloff: number;
}

/**
 * Check and bundle a world's format. Throws when the schema's `x`, `y`, `z` cannot hold the
 * section size (a corner sits at 0..size), when a cell field names no vertex field, or when
 * the id bits exceed 16.
 */
export function defineVoxelFormat(opts: VoxelFormatOptions): VoxelFormat {
  const size = opts.sectionSize ?? 16;
  if (!Number.isInteger(size) || size < 2 || size > 32) {
    throw new RangeError(`sectionSize must be 2..32, got ${size}`);
  }
  const vertex = opts.vertex ?? defineVertexSchema();
  for (const axis of ['x', 'y', 'z']) {
    const f = vertexField(vertex, axis);
    if (!f) throw new Error(`the vertex schema needs a '${axis}' field`);
    if (f.mask < size) {
      throw new RangeError(`vertex field '${axis}' (${f.bits} bits) cannot hold ${size}`);
    }
  }
  const idShift = opts.cell?.idShift ?? 0;
  const idBits = opts.cell?.idBits ?? 16;
  if (idBits < 1 || idBits > 16 || idShift < 0 || idShift + idBits > 32) {
    throw new RangeError(`cell id must be 1..16 bits inside a u32, got ${idBits} at ${idShift}`);
  }
  const cellFields = opts.cell?.fields ?? [];
  for (const f of cellFields) {
    if (!vertexField(vertex, f.name)) {
      throw new Error(`cell field '${f.name}' names no field of the vertex schema`);
    }
  }
  return {
    size,
    blocks: opts.blocks,
    vertex,
    idShift,
    idMask: (1 << idBits) - 1,
    cellFields: cellFields.map((f) => ({ ...f })),
    skyFalloff: opts.skyFalloff ?? 3,
    liquidSkyFalloff: opts.liquidSkyFalloff ?? 1,
  };
}

const XZ_BIAS = 2 ** 20;
const XZ_SPAN = 2 ** 21;
const Y_BIAS = 2 ** 10;
const Y_SPAN = 2 ** 11;

/**
 * One number for a section's coordinates (x and z in −2²⁰..2²⁰−1, y in −1024..1023): a Map
 * key with no allocation. `sectionKeyX/Y/Z` take it apart.
 */
export function sectionKey(sx: number, sy: number, sz: number): number {
  return ((sx + XZ_BIAS) * XZ_SPAN + (sz + XZ_BIAS)) * Y_SPAN + (sy + Y_BIAS);
}

export function sectionKeyY(key: number): number {
  return (key % Y_SPAN) - Y_BIAS;
}

export function sectionKeyZ(key: number): number {
  return (Math.floor(key / Y_SPAN) % XZ_SPAN) - XZ_BIAS;
}

export function sectionKeyX(key: number): number {
  return Math.floor(key / Y_SPAN / XZ_SPAN) - XZ_BIAS;
}

/** A cell's index in a section of side `size`: x fastest, then z, then y. */
export function sectionIndex(size: number, x: number, y: number, z: number): number {
  return x + z * size + y * size * size;
}

/**
 * The game's section codec: how bytes a section arrived as become cells. `decode` writes
 * `size³` cells into `out` and returns null, or returns the one cell a uniform section holds
 * (and need not touch `out`).
 */
export interface SectionCodec {
  decode(bytes: Uint8Array, out: Uint32Array): number | null;
}

/**
 * The engine's own trivial codec, for tests, tools and a world built in memory: the bytes are
 * the cells as little-endian u32s (`size³ × 4` bytes), or one u32 for a uniform section.
 */
export const RAW_SECTION_CODEC: SectionCodec = {
  decode(bytes, out) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength === 4) return view.getUint32(0, true);
    const n = bytes.byteLength >>> 2;
    if (n !== out.length)
      throw new RangeError(`raw section holds ${n} cells, expected ${out.length}`);
    for (let i = 0; i < n; i++) out[i] = view.getUint32(i * 4, true);
    return null;
  },
};

/** Cells into `RAW_SECTION_CODEC` bytes (one u32 when every cell is the same). */
export function encodeRawSection(cells: Uint32Array): Uint8Array {
  let uniform = true;
  for (let i = 1; i < cells.length && uniform; i++) if (cells[i] !== cells[0]) uniform = false;
  const n = uniform ? 1 : cells.length;
  const out = new Uint8Array(n * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) view.setUint32(i * 4, cells[i], true);
  return out;
}

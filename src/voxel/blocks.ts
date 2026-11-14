/**
 * Block tables and cell layouts for streamed voxel sections: what each block id draws as and
 * how light passes it, declared as data. A game numbers its blocks (an id is the index of its
 * entry) and names nothing here; the engine reads only the face class, light cost, emission,
 * light hue, cutout inset, cross quads and the game's own vertex fields.
 */

/**
 * How a block's faces are drawn.
 *
 * - `none`: no faces and hides nothing (air, or a block the game draws itself as a model).
 * - `opaque`: a full cube; hides the faces against it, takes ambient occlusion, stops light.
 * - `liquid`: faces into the liquid stream, hidden only against opaque blocks and itself.
 * - `cutout`: a cube drawn in its own cell's light with no ambient occlusion, never merged; an
 *   `inset` draws it smaller than its cell and then shows all six faces.
 * - `foliage`: faces into the foliage stream, none between two foliage blocks.
 * - `cross`: `quads` quads standing in the cell (crossed plants), into the foliage stream; the
 *   shader places them (see the README's *Section vertices*).
 */
export type FaceClass = 'none' | 'opaque' | 'liquid' | 'cutout' | 'foliage' | 'cross';

/** Face classes as the compiled table stores them. */
export const FACE_CLASS = {
  none: 0,
  opaque: 1,
  liquid: 2,
  cutout: 3,
  foliage: 4,
  cross: 5,
} as const satisfies Record<FaceClass, number>;

/** One block id, as the game declares it. */
export interface BlockDef {
  class: FaceClass;
  /**
   * What light loses passing into this block, 0 (stops it) to 15. Default by class: `opaque`
   * 0, `liquid` 2, `foliage` 3, everything else 1.
   */
  lightCost?: number;
  /** Block light it gives off, 0..15. Default 0. */
  emission?: number;
  /** Which of the game's light colours its block light takes, 0..7. Default 0. */
  hue?: number;
  /** A `cutout` or `cross` block drawn smaller than its cell, in 1/32 block, 0..31. Default 0. */
  inset?: number;
  /** A `cross` block's quad count, 1..7. Default 2 (two crossed on the diagonals). */
  quads?: number;
  /**
   * The game's vertex fields with a constant value for this block (names from its
   * `VertexSchema`), written into every vertex the block emits. Faces of blocks with different
   * values never merge; they are different ids anyway.
   */
  fields?: Readonly<Record<string, number>>;
}

/** Options for `defineBlockTable`. */
export interface BlockTableOptions {
  /**
   * Where two block lights of about the same strength meet: the hue their blend takes, as
   * `[a, b, mixed]` triples (both orders apply). Without an entry the brighter hue wins.
   */
  hueMix?: readonly (readonly [number, number, number])[];
}

/** Hue count a table's `hueMix` covers (3 bits of hue). */
export const LIGHT_HUES = 8;
/** `BlockTable.hueMix` entry for no blend. */
export const NO_HUE_MIX = 255;

/**
 * A compiled block table: one entry per id in typed arrays, plain data so it crosses to a
 * Worker by structured clone. Ids at or past `count` mesh as opaque cubes.
 */
export interface BlockTable {
  readonly count: number;
  readonly faceClass: Uint8Array;
  readonly lightCost: Uint8Array;
  readonly emission: Uint8Array;
  readonly hue: Uint8Array;
  readonly inset: Uint8Array;
  readonly quads: Uint8Array;
  /** `LIGHT_HUES²` entries, `a * LIGHT_HUES + b`, `NO_HUE_MIX` for none. */
  readonly hueMix: Uint8Array;
  /** Whether any block gives off light (a world without emitters skips the block light flood). */
  readonly emissive: boolean;
  /** The game's per-block vertex fields, by id (`null` for none). */
  readonly fields: readonly (Readonly<Record<string, number>> | null)[];
}

function clampInt(v: number, lo: number, hi: number, what: string): number {
  if (!Number.isInteger(v) || v < lo || v > hi) {
    throw new RangeError(`${what} must be an integer in ${lo}..${hi}, got ${v}`);
  }
  return v;
}

function defaultLightCost(c: FaceClass): number {
  if (c === 'opaque') return 0;
  if (c === 'liquid') return 2;
  if (c === 'foliage') return 3;
  return 1;
}

/** Compile the game's block declarations (id = index) into a `BlockTable`. */
export function defineBlockTable(
  blocks: readonly BlockDef[],
  opts: BlockTableOptions = {},
): BlockTable {
  const n = blocks.length;
  if (n === 0 || n > 0x10000) throw new RangeError(`a block table holds 1..65536 ids, got ${n}`);
  const faceClass = new Uint8Array(n);
  const lightCost = new Uint8Array(n);
  const emission = new Uint8Array(n);
  const hue = new Uint8Array(n);
  const inset = new Uint8Array(n);
  const quads = new Uint8Array(n);
  const fields: (Readonly<Record<string, number>> | null)[] = [];
  let emissive = false;
  for (let id = 0; id < n; id++) {
    const b = blocks[id];
    const cls = FACE_CLASS[b.class];
    if (cls === undefined) throw new RangeError(`block ${id}: unknown face class '${b.class}'`);
    faceClass[id] = cls;
    lightCost[id] = clampInt(
      b.lightCost ?? defaultLightCost(b.class),
      0,
      15,
      `block ${id} lightCost`,
    );
    emission[id] = clampInt(b.emission ?? 0, 0, 15, `block ${id} emission`);
    if (emission[id] > 0) emissive = true;
    hue[id] = clampInt(b.hue ?? 0, 0, LIGHT_HUES - 1, `block ${id} hue`);
    inset[id] = clampInt(b.inset ?? 0, 0, 31, `block ${id} inset`);
    quads[id] = clampInt(b.quads ?? 2, 1, 7, `block ${id} quads`);
    fields.push(b.fields ? { ...b.fields } : null);
  }
  const hueMix = new Uint8Array(LIGHT_HUES * LIGHT_HUES).fill(NO_HUE_MIX);
  for (const [a, b, m] of opts.hueMix ?? []) {
    clampInt(a, 0, LIGHT_HUES - 1, 'hueMix hue');
    clampInt(b, 0, LIGHT_HUES - 1, 'hueMix hue');
    clampInt(m, 0, LIGHT_HUES - 1, 'hueMix blend');
    hueMix[a * LIGHT_HUES + b] = m;
    hueMix[b * LIGHT_HUES + a] = m;
  }
  return { count: n, faceClass, lightCost, emission, hue, inset, quads, hueMix, emissive, fields };
}

/**
 * Where the block id sits in a cell (a cell is one u32 the game's codec writes), and which of
 * the cell's other bits reach the vertices.
 */
export interface CellLayout {
  /** The id's lowest bit. Default 0. */
  idShift?: number;
  /** The id's width, 1..16 bits. Default 16. */
  idBits?: number;
  /**
   * Cell bits copied into a vertex field of every face the cell emits (a facing, a "placed by
   * a player" flag). Faces whose values differ never merge. `fromFacing`: a face also takes the
   * value (OR) from the `none` cell it faces (a flag set on dug-out air marks the faces it
   * exposed).
   */
  fields?: readonly CellField[];
}

/** One cell bitfield the mesher copies into a vertex field. */
export interface CellField {
  /** The vertex field it writes (a name in the `VertexSchema`). */
  name: string;
  shift: number;
  bits: number;
  fromFacing?: boolean;
}

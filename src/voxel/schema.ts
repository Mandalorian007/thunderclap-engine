/**
 * `VertexSchema`: a section vertex is two u32 words, laid out as declared bitfields. The
 * engine's fields (position, face, ambient occlusion, sky and block light, block id) come by
 * default; a game adds its own (a ripeness, a "worked" flag) and may place any field itself.
 * From one schema come the CPU packing the mesher uses (`vertexFieldSlot`, `unpackSectionVertex`)
 * and the WGSL `decode_voxel_vertex` include a material reads it with (`vertexSchemaWgsl`), so
 * the two never drift. No WGSL `override`: the layout is baked into the generated source.
 */

/** A vertex field as declared: `word` and `shift` place it; without them it is placed first-fit. */
export interface VertexFieldDef {
  /** A WGSL identifier (`[A-Za-z_][A-Za-z0-9_]*`). */
  name: string;
  /** Width in bits, 1..32. */
  bits: number;
  word?: 0 | 1;
  shift?: number;
}

/** A placed field. `mask` is `2^bits - 1` as an unsigned number. */
export interface VertexField {
  readonly name: string;
  readonly bits: number;
  readonly word: 0 | 1;
  readonly shift: number;
  readonly mask: number;
}

/** A compiled schema: plain data, so it crosses to a Worker by structured clone. */
export interface VertexSchema {
  readonly fields: readonly VertexField[];
}

/**
 * The engine's fields (D1 §2.8): position within the section `x y z` (5 bits each: 0..16 on a
 * 16-block section), `face` (3: 0 −x, 1 +x, 2 −y, 3 +y, 4 −z, 5 +z, 6 a cross quad), `ao`
 * (2: 0 darkest .. 3 open), `sky` (6: smooth sky light 0..60), `block` (5: smooth block light
 * 0..30, half levels) and `id` (12: the block id). They fill word 0's low 31 bits and word 1's
 * low 12; a game's fields fill the rest.
 */
export const VOXEL_VERTEX_DEFAULTS: readonly VertexFieldDef[] = [
  { name: 'x', bits: 5 },
  { name: 'y', bits: 5 },
  { name: 'z', bits: 5 },
  { name: 'face', bits: 3 },
  { name: 'ao', bits: 2 },
  { name: 'sky', bits: 6 },
  { name: 'block', bits: 5 },
  { name: 'id', bits: 12 },
];

/**
 * Optional fields the mesher also fills when a schema declares them (none by default):
 * `side` (3: which side of its cell a corner is on per axis, 1 = high; on a cross quad, its
 * corner across and up), `quad` (3: a cross quad's index), `inset` (5: a cutout's or cross
 * block's inset in 1/32 block) and `hue` (3: the block light's colour index).
 */
export const VOXEL_VERTEX_OPTIONAL: readonly VertexFieldDef[] = [
  { name: 'side', bits: 3 },
  { name: 'quad', bits: 3 },
  { name: 'inset', bits: 5 },
  { name: 'hue', bits: 3 },
];

/** Options for `defineVertexSchema`. */
export interface VertexSchemaOptions {
  /** Prepend `VOXEL_VERTEX_DEFAULTS` (a field of the same name in `fields` replaces one). Default true. */
  defaults?: boolean;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WORDS = [0, 1] as const;

/**
 * Compile a vertex layout. Fields with `word` and `shift` are placed there; the rest, in
 * order, take the first gap that holds them (word 0 first). Throws on an overlap, a field past
 * bit 31, a duplicate or bad name, or a layout that does not fit 64 bits.
 */
export function defineVertexSchema(
  fields: readonly VertexFieldDef[] = [],
  opts: VertexSchemaOptions = {},
): VertexSchema {
  const own = new Map<string, VertexFieldDef>();
  for (const f of fields) {
    if (own.has(f.name)) throw new Error(`vertex field '${f.name}' declared twice`);
    own.set(f.name, f);
  }
  const all: VertexFieldDef[] = [];
  if (opts.defaults !== false) {
    for (const d of VOXEL_VERTEX_DEFAULTS) all.push(own.get(d.name) ?? d);
    for (const f of fields) if (!VOXEL_VERTEX_DEFAULTS.some((d) => d.name === f.name)) all.push(f);
  } else {
    all.push(...fields);
  }
  const used = [0, 0];
  const placed = new Map<string, VertexField>();
  const take = (f: VertexFieldDef, word: 0 | 1, shift: number): void => {
    const span = f.bits === 32 ? 0xffffffff : ((1 << f.bits) - 1) << shift;
    if ((used[word] & span) !== 0) {
      throw new Error(`vertex field '${f.name}' overlaps another at word ${word} bit ${shift}`);
    }
    used[word] = (used[word] | span) >>> 0;
    const mask = f.bits === 32 ? 0xffffffff : ((1 << f.bits) - 1) >>> 0;
    placed.set(f.name, { name: f.name, bits: f.bits, word, shift, mask });
  };
  for (const f of all) {
    if (!IDENT.test(f.name))
      throw new Error(`vertex field name '${f.name}' is not a WGSL identifier`);
    if (!Number.isInteger(f.bits) || f.bits < 1 || f.bits > 32) {
      throw new RangeError(`vertex field '${f.name}' bits must be 1..32, got ${f.bits}`);
    }
    if (f.word === undefined && f.shift === undefined) continue;
    const word = f.word ?? 0;
    const shift = f.shift ?? 0;
    if (word !== 0 && word !== 1)
      throw new RangeError(`vertex field '${f.name}' word must be 0 or 1`);
    if (!Number.isInteger(shift) || shift < 0 || shift + f.bits > 32) {
      throw new RangeError(`vertex field '${f.name}' does not fit word ${word} at bit ${shift}`);
    }
    take(f, word, shift);
  }
  for (const f of all) {
    if (placed.has(f.name)) continue;
    let done = false;
    for (const word of WORDS) {
      for (let shift = 0; !done && shift + f.bits <= 32; shift++) {
        const span = f.bits === 32 ? 0xffffffff : ((1 << f.bits) - 1) << shift;
        if ((used[word] & span) === 0) {
          take(f, word, shift);
          done = true;
        }
      }
      if (done) break;
    }
    if (!done)
      throw new RangeError(`vertex field '${f.name}' (${f.bits} bits) does not fit in 64 bits`);
  }
  return { fields: all.map((f) => placed.get(f.name)!) };
}

/** The placed field called `name`, or undefined when the schema lacks it. */
export function vertexField(schema: VertexSchema, name: string): VertexField | undefined {
  for (const f of schema.fields) if (f.name === name) return f;
  return undefined;
}

/**
 * Write `value` into field `f` of the vertex at `words[at]`, `words[at + 1]` (ORed: start
 * from zeroed words). A missing field writes nothing.
 */
export function packVertexField(
  words: Uint32Array,
  at: number,
  f: VertexField | undefined,
  value: number,
): void {
  if (!f) return;
  const i = at + f.word;
  words[i] = (words[i] | ((value & f.mask) << f.shift)) >>> 0;
}

/** Read field `f` of a vertex's two words. A missing field reads 0. */
export function vertexFieldValue(f: VertexField | undefined, w0: number, w1: number): number {
  if (!f) return 0;
  const w = f.word === 0 ? w0 : w1;
  return f.bits === 32 ? w >>> 0 : (w >>> f.shift) & f.mask;
}

/** Every field of a vertex by name, into `out` (a reused object, for tests and tools). */
export function unpackSectionVertex(
  schema: VertexSchema,
  w0: number,
  w1: number,
  out: Record<string, number> = {},
): Record<string, number> {
  for (const f of schema.fields) out[f.name] = vertexFieldValue(f, w0, w1);
  return out;
}

/** Options for `vertexSchemaWgsl`. */
export interface VertexSchemaWgslOptions {
  /** The struct's name. Default `VoxelVertex`. */
  struct?: string;
  /** The decode function's name. Default `decode_voxel_vertex`. */
  fn?: string;
}

/**
 * The WGSL include for a schema: a struct of one `u32` per field (declaration order) and
 * `fn decode_voxel_vertex(w0: u32, w1: u32) -> VoxelVertex`. No bindings, no entry points, no
 * `override`.
 */
export function vertexSchemaWgsl(schema: VertexSchema, opts: VertexSchemaWgslOptions = {}): string {
  const struct = opts.struct ?? 'VoxelVertex';
  const fn = opts.fn ?? 'decode_voxel_vertex';
  const lines: string[] = [`struct ${struct} {`];
  for (const f of schema.fields) lines.push(`  ${f.name}: u32,`);
  lines.push('}', '', `fn ${fn}(w0: u32, w1: u32) -> ${struct} {`, `  var v: ${struct};`);
  for (const f of schema.fields) {
    const w = f.word === 0 ? 'w0' : 'w1';
    let expr: string;
    if (f.bits === 32) expr = w;
    else if (f.shift === 0) expr = `${w} & ${f.mask}u`;
    else if (f.shift + f.bits === 32) expr = `${w} >> ${f.shift}u`;
    else expr = `(${w} >> ${f.shift}u) & ${f.mask}u`;
    lines.push(`  v.${f.name} = ${expr};`);
  }
  lines.push('  return v;', '}', '');
  return lines.join('\n');
}

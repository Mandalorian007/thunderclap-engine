/**
 * B24: a format's per-cell rules (`VoxelFormatOptions.cellRules`): cell fields set and remapped
 * by a neighbour test, vertex bits OR'ed into a cell's cross quads (in a liquid too, never into
 * the liquid's faces), plain data across a structured clone, and no change without a match.
 */
import { describe, expect, it } from 'vitest';
import { type CellRule, defineBlockTable } from './blocks';
import { defineVoxelFormat } from './format';
import { defineVertexSchema, unpackSectionVertex, VOXEL_VERTEX_OPTIONAL } from './schema';
import { SECTION_VERTEX_WORDS, type SectionMesh, SectionMesher } from './section-mesher';
import { HEIGHT_OPEN, type SectionInput } from './sources';

const STONE = 1;
const WATER = 2;
const KELP = 3;
const LOG = 4;
const VINE = 5;
const TABLE = 6;

const VERTEX = defineVertexSchema([
  ...VOXEL_VERTEX_OPTIONAL.filter((f) => !['inset', 'hue', 'solid'].includes(f.name)),
  { name: 'far', bits: 1 },
  { name: 'facing', bits: 3 },
  { name: 'worked', bits: 1 },
]);

function format(cellRules?: CellRule[]) {
  return defineVoxelFormat({
    sectionSize: 8,
    blocks: defineBlockTable([
      { class: 'none' },
      { class: 'opaque' },
      { class: 'liquid' },
      { class: 'cross', quads: 2, liquid: WATER, farPatch: true },
      { class: 'opaque' },
      { class: 'cross', quads: 2 },
      { class: 'opaque' },
    ]),
    vertex: VERTEX,
    cell: {
      idBits: 9,
      fields: [
        { name: 'facing', shift: 12, bits: 3 },
        { name: 'worked', shift: 15, bits: 1 },
        { name: 'side', shift: 19, bits: 3 },
      ],
    },
    cellRules,
  });
}

const P = 10;
function volume(cells: [number, number, number, number][]): SectionInput {
  const blocks = new Uint32Array(P ** 3);
  for (const [x, y, z, v] of cells) blocks[x + 1 + (z + 1) * P + (y + 1) * P * P] = v;
  return { sx: 0, sy: 0, sz: 0, blocks, heights: new Int32Array(P * P).fill(HEIGHT_OPEN) };
}

/** One per quad (its first vertex). */
function verts(buf: ArrayBuffer): Record<string, number>[] {
  const w = new Uint32Array(buf);
  const out: Record<string, number>[] = [];
  for (let o = 0; o < w.length; o += 4 * SECTION_VERTEX_WORDS) {
    out.push(unpackSectionVertex(VERTEX, w[o], w[o + 1], {}));
  }
  return out;
}

function bytes(m: SectionMesh): number[][] {
  return [m.opaque, m.liquid, m.foliage].map((b) => [...new Uint32Array(b)]);
}

/** Water y 0..2 over x, z 2..4, kelp at (3, 0..1, 3); a vine pair at (6, 0..1, 6); a log and a table. */
function world(): SectionInput {
  const cells: [number, number, number, number][] = [];
  for (let y = 0; y <= 2; y++)
    for (let z = 2; z <= 4; z++) for (let x = 2; x <= 4; x++) cells.push([x, y, z, WATER]);
  cells.push([3, 0, 3, KELP], [3, 1, 3, KELP]);
  cells.push([6, 0, 6, VINE], [6, 1, 6, VINE]);
  cells.push([0, 0, 0, LOG | (6 << 12)], [0, 4, 0, TABLE | (1 << 15)], [7, 7, 7, STONE]);
  return volume(cells);
}

describe('cell rules (B24)', () => {
  it('a rule that matches no cell leaves the mesh byte for byte', () => {
    const plain = new SectionMesher(format()).mesh(world());
    const idle = new SectionMesher(
      format([{ blocks: [STONE], when: { at: [0, 1, 0], ids: [VINE] }, set: { worked: 1 } }]),
    ).mesh(world());
    expect(bytes(idle)).toEqual(bytes(plain));
    expect(format().cellRules).toBeUndefined();
  });

  it('sets a field where the cell below is the same block', () => {
    const m = new SectionMesher(
      format([{ blocks: [VINE], when: { at: [0, -1, 0], same: true }, set: { side: 4 } }]),
    ).mesh(world(), { greedy: false });
    const vines = verts(m.foliage).filter((v) => v.id === VINE);
    expect(vines.length).toBe(4);
    expect(vines.filter((v) => v.side! & 4).every((v) => v.y === 1)).toBe(true);
    expect(vines.filter((v) => v.y === 1).every((v) => v.side! & 4)).toBe(true);
  });

  it('ORs bits into a wet cross block’s quads and far patch, never the liquid’s faces', () => {
    const input = world();
    const m = new SectionMesher(
      format([{ blocks: [KELP], when: { at: [0, -1, 0], same: true }, quads: { side: 4 } }]),
    ).mesh(input, { greedy: false });
    const kelp = verts(m.foliage).filter((v) => v.id === KELP);
    expect(kelp.length).toBe(5);
    const upper = kelp.filter((v) => v.y === 1);
    expect(upper.length).toBe(3);
    expect(upper.every((v) => (v.side! & 4) === 4)).toBe(true);
    expect(upper.filter((v) => v.far === 1).length).toBe(1);
    expect(kelp.filter((v) => v.y === 0).every((v) => (v.side! & 4) === 0)).toBe(true);
    const plain = new SectionMesher(format()).mesh(input, { greedy: false });
    expect(m.liquid).toEqual(plain.liquid);
    expect(m.opaque).toEqual(plain.opaque);
    // The cells the game sent are not touched.
    expect(input.blocks).toEqual(world().blocks);
  });

  it('clears a field on a block, and remaps another through a table', () => {
    const m = new SectionMesher(
      format([
        { blocks: [TABLE], set: { worked: 0 } },
        { blocks: [LOG], map: { facing: [1, 1, 2, 3, 5, 5, 5, 5] } },
      ]),
    ).mesh(world());
    const op = verts(m.opaque);
    expect(op.filter((v) => v.id === TABLE).every((v) => v.worked === 0)).toBe(true);
    expect(op.filter((v) => v.id === LOG).every((v) => v.facing === 5)).toBe(true);
    const plain = verts(new SectionMesher(format()).mesh(world()).opaque);
    expect(plain.filter((v) => v.id === TABLE).every((v) => v.worked === 1)).toBe(true);
    expect(plain.filter((v) => v.id === LOG).every((v) => v.facing === 6)).toBe(true);
  });

  it('a `not` test, rules in order, and the format across a structured clone (a Worker)', () => {
    const f = format([
      { blocks: [VINE], when: { at: [0, 1, 0], ids: [VINE], not: true }, set: { facing: 2 } },
      { blocks: [VINE], map: { facing: [0, 0, 7] } },
    ]);
    const m = new SectionMesher(f).mesh(world(), { greedy: false });
    const vines = verts(m.foliage).filter((v) => v.id === VINE);
    expect(vines.filter((v) => v.y === 1).every((v) => v.facing === 7)).toBe(true);
    expect(vines.filter((v) => v.y === 0).every((v) => v.facing === 0)).toBe(true);
    const cloned = new SectionMesher(structuredClone(f)).mesh(world(), { greedy: false });
    expect(bytes(cloned)).toEqual(bytes(m));
  });

  it('throws on a rule naming no cell field, no vertex field, or a far neighbour', () => {
    expect(() => format([{ blocks: [LOG], set: { ripe: 1 } }])).toThrow(/no cell field/);
    expect(() => format([{ blocks: [LOG], map: { id: [1] } }])).toThrow(/no cell field/);
    expect(() => format([{ blocks: [KELP], quads: { glow: 1 } }])).toThrow(/vertex schema/);
    expect(() => format([{ blocks: [LOG], when: { at: [0, 2, 0], same: true } }])).toThrow(
      RangeError,
    );
  });
});

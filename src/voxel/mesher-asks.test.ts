/**
 * ws/scene-read-fit: the section mesher's opt-in shapes a game asked for: cross blocks standing
 * in a liquid with far patches, a cell field derived from the neighbours, cross blocks at
 * `leafLod` 2, tiered counting through the padding, and a cap and order for parts.
 */
import { describe, expect, it } from 'vitest';
import { defineBlockTable } from './blocks';
import { defineVoxelFormat } from './format';
import { defineVertexSchema, unpackSectionVertex, VOXEL_VERTEX_OPTIONAL } from './schema';
import { SECTION_VERTEX_WORDS, SectionMesher } from './section-mesher';
import { HEIGHT_OPEN, type SectionInput } from './sources';

const AIR = 0;
const STONE = 1;
const WATER = 2;
const KELP = 3;
const LOG = 4;
const GRASS = 5;
const LEAVES = 6;
const FERN = 7;

const FORMAT = defineVoxelFormat({
  sectionSize: 8,
  blocks: defineBlockTable([
    { class: 'none' },
    { class: 'opaque' },
    { class: 'liquid' },
    { class: 'cross', quads: 2, liquid: WATER, farPatch: true },
    { class: 'opaque', axial: true },
    { class: 'cross', quads: 1, parts: 3, partsReplace: true },
    { class: 'foliage', lodSolid: true },
    { class: 'cross', quads: 2 },
  ]),
  vertex: defineVertexSchema([
    ...VOXEL_VERTEX_OPTIONAL,
    { name: 'far', bits: 1 },
    { name: 'facing', bits: 3 },
  ]),
  cell: {
    idBits: 12,
    fields: [{ name: 'facing', shift: 12, bits: 3, fromNeighbours: { when: 2, y: 1, x: 5, z: 3 } }],
  },
});

const P = 10;
function volume(cells: [number, number, number, number][]): SectionInput {
  const blocks = new Uint32Array(P ** 3);
  for (const [x, y, z, v] of cells) blocks[x + 1 + (z + 1) * P + (y + 1) * P * P] = v;
  return { sx: 0, sy: 0, sz: 0, blocks, heights: new Int32Array(P * P).fill(HEIGHT_OPEN) };
}

function verts(buf: ArrayBuffer): Record<string, number>[] {
  const w = new Uint32Array(buf);
  const out: Record<string, number>[] = [];
  for (let o = 0; o < w.length; o += 4 * SECTION_VERTEX_WORDS) {
    out.push(unpackSectionVertex(FORMAT.vertex, w[o], w[o + 1], {}));
  }
  return out;
}

describe('section mesher asks (ws/scene-read-fit)', () => {
  it('a cross block in a liquid meshes its cell as the liquid, its quads and far patch as foliage', () => {
    // Water at y 0..2, a kelp strand at (3, 0..1, 3) under it.
    const cells: [number, number, number, number][] = [];
    for (let y = 0; y <= 2; y++)
      for (let z = 2; z <= 4; z++) for (let x = 2; x <= 4; x++) cells.push([x, y, z, WATER]);
    cells.push([3, 0, 3, KELP], [3, 1, 3, KELP]);
    const m = new SectionMesher(FORMAT);
    const near = m.mesh(volume(cells), { greedy: false });
    // The liquid's faces are as if the kelp cells were water.
    const plain = new SectionMesher(FORMAT).mesh(
      volume(cells.map(([x, y, z, v]) => [x, y, z, v === KELP ? WATER : v])),
      { greedy: false },
    );
    expect(near.liquidQuads).toBe(plain.liquidQuads);
    expect(verts(near.liquid).every((v) => v.id === WATER)).toBe(true);
    const fol = verts(near.foliage);
    expect(fol.every((v) => v.id === KELP)).toBe(true);
    // Two quads per cell, a far patch on the top cell only.
    expect(fol.length).toBe(5);
    const far = fol.filter((v) => v.far === 1);
    expect(far.length).toBe(1);
    expect(far[0]!.y).toBe(1);
    expect(far[0]!.quad).toBe(2);
    expect(near.tiered).toBe(true);
    // Far away (leafLod 2), the patch alone.
    const away = verts(m.mesh(volume(cells), { greedy: false, leafLod: 2 }).foliage);
    expect(away.length).toBe(1);
    expect(away[0]!.far).toBe(1);
  });

  it('a liquid for a non-cross block, or a block that is no liquid, is refused', () => {
    expect(() => defineBlockTable([{ class: 'liquid' }, { class: 'opaque', liquid: 0 }])).toThrow(
      /cross/,
    );
    expect(() => defineBlockTable([{ class: 'opaque' }, { class: 'cross', liquid: 0 }])).toThrow(
      /not a liquid/,
    );
  });

  it('derives a field from the axial neighbours when the cell’s own is `when`', () => {
    const side = 2 << 12;
    const facing = (cells: [number, number, number, number][]) =>
      verts(new SectionMesher(FORMAT).mesh(volume(cells), { greedy: false }).opaque)
        .filter((v) => v.x === 4 && v.y === 4 && v.z === 4 && v.face === 2)
        .map((v) => v.facing)[0];
    expect(facing([[4, 4, 4, LOG | side]])).toBe(1);
    expect(
      facing([
        [4, 4, 4, LOG | side],
        [5, 4, 4, LOG],
      ]),
    ).toBe(5);
    expect(
      facing([
        [4, 4, 4, LOG | side],
        [4, 4, 3, LOG],
      ]),
    ).toBe(3);
    expect(
      facing([
        [4, 4, 4, LOG | side],
        [4, 5, 4, LOG],
        [5, 4, 4, LOG],
      ]),
    ).toBe(1);
    // Not `when`, or not an axial block: its own value.
    expect(
      facing([
        [4, 4, 4, LOG | (4 << 12)],
        [5, 4, 4, LOG],
      ]),
    ).toBe(4);
    expect(
      facing([
        [4, 4, 4, STONE | side],
        [5, 4, 4, LOG],
      ]),
    ).toBe(2);
  });

  it('keeps cross blocks at leafLod 2 with crossLod 2', () => {
    const v = volume([[1, 1, 1, FERN]]);
    expect(new SectionMesher(FORMAT).mesh(v, { leafLod: 2 }).foliageQuads).toBe(0);
    expect(new SectionMesher(FORMAT).mesh(v, { leafLod: 2, crossLod: 2 }).foliageQuads).toBe(2);
    expect(new SectionMesher(FORMAT).mesh(v, { leafLod: 1, crossLod: 0 }).foliageQuads).toBe(0);
  });

  it('counts solid foliage in the padding as tiered with tieredPadding', () => {
    const v = volume([
      [-1, 3, 3, LEAVES],
      [0, 3, 3, STONE],
    ]);
    expect(new SectionMesher(FORMAT).mesh(v).tiered).toBe(false);
    expect(new SectionMesher(FORMAT).mesh(v, { tieredPadding: true }).tiered).toBe(true);
  });

  it('caps parts, and orders them after every block’s own quads', () => {
    const v = volume([
      [1, 1, 1, GRASS],
      [2, 1, 1, GRASS],
      [3, 1, 1, GRASS],
    ]);
    const inline = verts(new SectionMesher(FORMAT).mesh(v).foliage);
    expect(inline.map((q) => q.part)).toEqual([0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1]);
    const after = verts(new SectionMesher(FORMAT).mesh(v, { partsOrder: 'after' }).foliage);
    expect(after.map((q) => q.part)).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(after.slice(3).map((q) => q.x)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
    const capped = verts(
      new SectionMesher(FORMAT).mesh(v, { partsOrder: 'after', partsCap: 4 }).foliage,
    );
    expect(capped.map((q) => q.x)).toEqual([1, 2, 3, 1, 1, 1, 2]);
    // The last cell lost its parts, so its own quad is no twin.
    expect(capped.slice(0, 3).map((q) => q.twin)).toEqual([1, 1, 0]);
    const inlineCap = verts(new SectionMesher(FORMAT).mesh(v, { partsCap: 4 }).foliage);
    expect(inlineCap.map((q) => q.part)).toEqual([0, 1, 1, 1, 0, 1, 0]);
  });
});

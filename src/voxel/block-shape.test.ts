// ws/render-fit: the block shape hooks a voxel game's mesher needs, as data. Foliage that meshes
// solid away from the eye (leafLod), cross blocks with extra part quads, per-cell inset
// overrides, the `tiered` report, and a material's own vertex entry.
import { describe, expect, it } from 'vitest';
import { defineBlockTable } from './blocks';
import { defineVoxelFormat, type VoxelFormat } from './format';
import { defineVertexSchema, unpackSectionVertex, VOXEL_VERTEX_OPTIONAL } from './schema';
import { CROSS_FACE, SECTION_VERTEX_WORDS, SectionMesher } from './section-mesher';
import { HEIGHT_OPEN, type SectionInput } from './sources';
import { voxelVertexWgsl } from './world-shaders';

const AIR = 0;
const STONE = 1;
const LEAVES = 2;
const BUSH = 3;
const SAPLING = 4;
const FERN = 5;
const LITTER = 6;

const FORMAT = defineVoxelFormat({
  blocks: defineBlockTable([
    { class: 'none' },
    { class: 'opaque' },
    { class: 'foliage', lodSolid: true },
    { class: 'foliage' },
    { class: 'cutout', inset: 6 },
    { class: 'cross', quads: 2, parts: 12, partsReplace: true, inset: 4 },
    { class: 'cross', quads: 1, parts: 3 },
  ]),
  vertex: defineVertexSchema([
    ...VOXEL_VERTEX_OPTIONAL.map((f) => (f.name === 'quad' ? { name: 'quad', bits: 4 } : f)),
  ]),
});

function volume(format: VoxelFormat = FORMAT) {
  const P = format.size + 2;
  const blocks = new Uint32Array(P ** 3);
  const at = (x: number, y: number, z: number) => x + 1 + (z + 1) * P + (y + 1) * P * P;
  const api = {
    at,
    set(x: number, y: number, z: number, v: number) {
      blocks[at(x, y, z)] = v;
      return api;
    },
    input(): SectionInput {
      return {
        sx: 0,
        sy: 0,
        sz: 0,
        blocks: blocks.slice(),
        heights: new Int32Array(P * P).fill(HEIGHT_OPEN),
      };
    },
  };
  return api;
}

type Vertex = Record<string, number>;
function quads(buf: ArrayBuffer): Vertex[][] {
  const w = new Uint32Array(buf);
  const out: Vertex[][] = [];
  for (let o = 0; o < w.length; o += 4 * SECTION_VERTEX_WORDS) {
    const q: Vertex[] = [];
    for (let k = 0; k < 4; k++) {
      q.push(unpackSectionVertex(FORMAT.vertex, w[o + k * 2], w[o + k * 2 + 1], {}));
    }
    out.push(q);
  }
  return out;
}

describe('block table shape data (ws/render-fit)', () => {
  it('compiles lodSolid, parts and partsReplace, and checks them', () => {
    const t = FORMAT.blocks;
    expect([...t.lodSolid!]).toEqual([0, 0, 1, 0, 0, 0, 0]);
    expect([...t.parts!]).toEqual([0, 0, 0, 0, 0, 12, 3]);
    expect([...t.partsReplace!]).toEqual([0, 0, 0, 0, 0, 1, 0]);
    expect(() => defineBlockTable([{ class: 'opaque', lodSolid: true }])).toThrow(/foliage/);
    expect(() => defineBlockTable([{ class: 'cutout', parts: 2 }])).toThrow(/cross/);
    expect(() => defineBlockTable([{ class: 'cross', parts: 64 }])).toThrow(/0\.\.63/);
    // Plain data: it crosses to a Worker.
    expect(structuredClone(FORMAT).blocks.parts).toEqual(t.parts);
  });
});

describe('leaf level of detail (ws/render-fit)', () => {
  // A stone ground under a 3×1×1 leaf row with a one-cell gap, then one more leaf.
  const scene = () => {
    const v = volume();
    for (let x = 0; x < 6; x++) v.set(x, 0, 0, STONE);
    v.set(0, 1, 0, LEAVES).set(1, 1, 0, LEAVES).set(3, 1, 0, LEAVES).set(5, 1, 0, BUSH);
    return v;
  };

  it('0 (default): leaves are foliage; the stone under them keeps its tops', () => {
    const m = new SectionMesher(FORMAT).mesh(scene().input(), { greedy: false });
    expect(m.tiered).toBe(true);
    const fol = quads(m.foliage);
    expect(fol.filter((q) => q[0].id === LEAVES)).toHaveLength(13);
    const stoneTops = quads(m.opaque).filter((q) => q[0].id === STONE && q[0].face === 3);
    expect(stoneTops).toHaveLength(6);
    expect(quads(m.opaque).some((q) => q[0].solid === 1)).toBe(false);
  });

  it('1: lodSolid leaves move to the opaque stream marked solid and hide the stone they cover', () => {
    const m = new SectionMesher(FORMAT).mesh(scene().input(), { greedy: false, leafLod: 1 });
    const fol = quads(m.foliage);
    expect(fol.filter((q) => q[0].id === LEAVES)).toHaveLength(0);
    // The bush is not lodSolid: still foliage.
    expect(fol.filter((q) => q[0].id === BUSH)).toHaveLength(5);
    const leaves = quads(m.opaque).filter((q) => q[0].id === LEAVES);
    expect(leaves).toHaveLength(13);
    expect(leaves.every((q) => q.every((v) => v.solid === 1))).toBe(true);
    const stoneTops = quads(m.opaque).filter((q) => q[0].id === STONE && q[0].face === 3);
    expect(stoneTops).toHaveLength(3);
  });

  it('2: no faces across a one-cell gap inside a canopy', () => {
    const m = new SectionMesher(FORMAT).mesh(scene().input(), { greedy: false, leafLod: 2 });
    const leaves = quads(m.opaque).filter((q) => q[0].id === LEAVES);
    // The +x face of (1,1,0) and both x faces of (3,1,0) cross a gap to leaves or the bush.
    expect(leaves).toHaveLength(10);
  });

  it('a section without lodSolid foliage or cross blocks is not tiered and meshes the same', () => {
    const v = volume();
    v.set(2, 2, 2, STONE).set(3, 2, 2, BUSH).set(4, 2, 2, SAPLING);
    const a = new SectionMesher(FORMAT).mesh(v.input());
    const b = new SectionMesher(FORMAT).mesh(v.input(), { leafLod: 2 });
    expect(a.tiered).toBe(false);
    expect(new Uint32Array(b.opaque)).toEqual(new Uint32Array(a.opaque));
    expect(new Uint32Array(b.foliage)).toEqual(new Uint32Array(a.foliage));
  });
});

describe('cross block parts (ws/render-fit)', () => {
  const scene = () => volume().set(2, 0, 2, FERN).set(4, 0, 4, LITTER);

  it('at full detail parts follow the quads; replaced quads carry twin', () => {
    const m = new SectionMesher(FORMAT).mesh(scene().input());
    const fol = quads(m.foliage);
    const fern = fol.filter((q) => q[0].id === FERN);
    expect(fern).toHaveLength(14);
    expect(fern.every((q) => q[0].face === CROSS_FACE)).toBe(true);
    expect(fern.map((q) => q[0].quad)).toEqual([...Array(14).keys()]);
    expect(fern.map((q) => q[0].part)).toEqual([0, 0, ...Array(12).fill(1)]);
    expect(fern.map((q) => q[0].twin)).toEqual([1, 1, ...Array(12).fill(0)]);
    const litter = fol.filter((q) => q[0].id === LITTER);
    expect(litter.map((q) => q[0].part)).toEqual([0, 1, 1, 1]);
    expect(litter.every((q) => q[0].twin === 0)).toBe(true);
    expect(m.foliageQuads).toBe(18);
  });

  it('1 drops the parts and the twin mark; 2 drops cross blocks', () => {
    const one = new SectionMesher(FORMAT).mesh(scene().input(), { leafLod: 1 });
    const fol = quads(one.foliage);
    expect(fol).toHaveLength(3);
    expect(fol.every((q) => q[0].part === 0 && q[0].twin === 0)).toBe(true);
    const two = new SectionMesher(FORMAT).mesh(scene().input(), { leafLod: 2 });
    expect(two.foliageQuads).toBe(0);
    expect(two.tiered).toBe(true);
  });

  it('a section full of the most quads fits the foliage stream', () => {
    const v = volume();
    const S = FORMAT.size;
    for (let y = 0; y < S; y++)
      for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) v.set(x, y, z, FERN);
    const m = new SectionMesher(FORMAT).mesh(v.input());
    expect(m.foliageQuads).toBe(S * S * S * 14);
  });
});

describe('per-cell inset overrides (ws/render-fit)', () => {
  it('a cutout or cross cell takes the override; the rest keep the block inset', () => {
    const v = volume().set(1, 0, 1, SAPLING).set(3, 0, 1, SAPLING).set(5, 0, 1, FERN);
    const insets = new Int32Array([v.at(1, 0, 1), 20 | (1 << 5), v.at(5, 0, 1), 9]);
    const m = new SectionMesher(FORMAT).mesh(v.input(), { insets, greedy: false });
    const op = quads(m.opaque);
    const insetAt = (x: number) =>
      new Set(op.filter((q) => Math.min(...q.map((p) => p.x)) === x).map((q) => q[0].inset));
    expect(insetAt(1)).toEqual(new Set([20]));
    expect(insetAt(3)).toEqual(new Set([6]));
    const fern = quads(m.foliage).filter((q) => q[0].id === FERN);
    expect(fern.every((q) => q.every((p) => p.inset === 9))).toBe(true);
    // The next section meshes without them.
    const again = new SectionMesher(FORMAT);
    again.mesh(v.input(), { insets });
    const plain = quads(again.mesh(v.input()).opaque);
    expect(new Set(plain.map((q) => q[0].inset))).toEqual(new Set([6]));
  });
});

describe('material vertex hook (ws/render-fit)', () => {
  it("the world's stage is a function a material's own entry can call", () => {
    const code = voxelVertexWgsl(FORMAT);
    expect(code).toContain('fn voxel_vertex(in: VertexIn, vi: u32) -> VoxelVarying');
    expect(code).toContain('return voxel_vertex(in, vi);');
  });
});

void AIR;

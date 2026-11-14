// Forge Wilds' mesher tests (apps/web/test/mesher.test.ts), ported onto the generalized
// section mesher with a Forge-like block table and cell layout, plus a table that is not
// Forge's at all.
import { describe, expect, it } from 'vitest';
import { defineBlockTable } from './blocks';
import { ALL_FACE_PAIRS, ConnectivityFlood, facePairBit } from './connectivity';
import { defineVoxelFormat, type VoxelFormat } from './format';
import { defineVertexSchema, unpackSectionVertex, VOXEL_VERTEX_OPTIONAL } from './schema';
import { CROSS_FACE, SECTION_VERTEX_WORDS, SectionMesher } from './section-mesher';
import { HEIGHT_OPEN, type SectionInput } from './sources';

// A Forge-like world: id in the low 12 bits, a facing above it, a "worked" flag on top that
// a dug-out air cell passes to the faces it exposes.
const AIR = 0;
const STONE = 1;
const GRASS = 2;
const LOG = 3;
const WATER = 4;
const SAPLING = 5;
const LEAVES = 6;
const FERN = 7;
const WORKED = 1 << 15;
const facing = (f: number): number => f << 12;

const forgeBlocks = defineBlockTable([
  { class: 'none' },
  { class: 'opaque' },
  { class: 'opaque' },
  { class: 'opaque' },
  { class: 'liquid' },
  { class: 'cutout', inset: 6 },
  { class: 'foliage' },
  { class: 'cross', quads: 2, inset: 4 },
]);

const forgeSchema = defineVertexSchema([
  ...VOXEL_VERTEX_OPTIONAL,
  { name: 'worked', bits: 1 },
  { name: 'facing', bits: 3 },
]);

const FORGE = defineVoxelFormat({
  blocks: forgeBlocks,
  vertex: forgeSchema,
  cell: {
    idBits: 12,
    fields: [
      { name: 'facing', shift: 12, bits: 3 },
      { name: 'worked', shift: 15, bits: 1, fromFacing: true },
    ],
  },
});

const FACE_NEG_X = 0;
const FACE_POS_Y = 3;

/** A hand-made mesher input: section (0, 0, 0) with an empty one-cell border. */
class Volume {
  readonly P: number;
  readonly blocks: Uint32Array;
  constructor(readonly format: VoxelFormat = FORGE) {
    this.P = format.size + 2;
    this.blocks = new Uint32Array(this.P ** 3);
  }
  /** Section-local; −1 and size address the border. */
  set(x: number, y: number, z: number, v: number): this {
    const P = this.P;
    this.blocks[x + 1 + (z + 1) * P + (y + 1) * P * P] = v;
    return this;
  }
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, v: number): this {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, v);
    }
    return this;
  }
  /** Heights from the volume (world y = local y for section 0). */
  input(): SectionInput {
    const P = this.P;
    const { idShift, idMask, blocks } = this.format;
    const heights = new Int32Array(P * P);
    for (let pz = 0; pz < P; pz++) {
      for (let px = 0; px < P; px++) {
        let h = HEIGHT_OPEN;
        for (let py = P - 1; py >= 0; py--) {
          const id = (this.blocks[px + pz * P + py * P * P] >>> idShift) & idMask;
          if (blocks.faceClass[id] !== 0) {
            h = py - 1;
            break;
          }
        }
        heights[px + pz * P] = h;
      }
    }
    return { sx: 0, sy: 0, sz: 0, blocks: this.blocks.slice(), heights };
  }
}

type Vertex = Record<string, number>;
interface Quad {
  face: number;
  id: number;
  v: Vertex[];
  min: [number, number, number];
  max: [number, number, number];
}

function quads(buf: ArrayBuffer, format: VoxelFormat = FORGE): Quad[] {
  const words = new Uint32Array(buf);
  const out: Quad[] = [];
  const per = 4 * SECTION_VERTEX_WORDS;
  for (let o = 0; o < words.length; o += per) {
    const v: Vertex[] = [];
    for (let k = 0; k < 4; k++) {
      v.push(unpackSectionVertex(format.vertex, words[o + k * 2], words[o + k * 2 + 1], {}));
    }
    const xs = v.map((p) => p.x);
    const ys = v.map((p) => p.y);
    const zs = v.map((p) => p.z);
    out.push({
      face: v[0].face,
      id: v[0].id,
      v,
      min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)],
      max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)],
    });
  }
  return out;
}

const vertexAt = (q: Quad, x: number, y: number, z: number): Vertex | undefined =>
  q.v.find((p) => p.x === x && p.y === y && p.z === z);

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

interface UnitFace {
  id: number;
  worked: number;
  facing: number;
  ao: number[];
  sky: number[];
  block: number[];
}

/** Expand quads into unit faces with their bilinear corner values, as the GPU draws them. */
function unitFaces(qs: Quad[]): Map<string, UnitFace> {
  const out = new Map<string, UnitFace>();
  for (const q of qs) {
    const axis = q.face >> 1;
    const positive = (q.face & 1) === 1;
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const corner = (cu: number, cv: number): Vertex => {
      const p = [0, 0, 0];
      p[axis] = q.min[axis];
      p[u] = cu === 0 ? q.min[u] : q.max[u];
      p[v] = cv === 0 ? q.min[v] : q.max[v];
      const found = vertexAt(q, p[0], p[1], p[2]);
      if (!found) throw new Error('quad corner missing');
      return found;
    };
    const c = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
    const w = q.max[u] - q.min[u];
    const h = q.max[v] - q.min[v];
    for (let a = q.min[u]; a < q.max[u]; a++) {
      for (let b = q.min[v]; b < q.max[v]; b++) {
        const cell = [0, 0, 0];
        cell[axis] = positive ? q.min[axis] - 1 : q.min[axis];
        cell[u] = a;
        cell[v] = b;
        const key = `${q.face}:${cell.join(',')}`;
        if (out.has(key)) throw new Error(`overlapping quads at ${key}`);
        const at = (fu: number, fv: number, pick: (x: Vertex) => number): number =>
          (1 - fv) * ((1 - fu) * pick(c[0]) + fu * pick(c[1])) +
          fv * ((1 - fu) * pick(c[3]) + fu * pick(c[2]));
        const fu0 = (a - q.min[u]) / w;
        const fu1 = (a + 1 - q.min[u]) / w;
        const fv0 = (b - q.min[v]) / h;
        const fv1 = (b + 1 - q.min[v]) / h;
        const corners: [number, number][] = [
          [fu0, fv0],
          [fu1, fv0],
          [fu1, fv1],
          [fu0, fv1],
        ];
        const pick = (f: (x: Vertex) => number) => corners.map(([fu, fv]) => round6(at(fu, fv, f)));
        out.set(key, {
          id: q.id,
          worked: q.v[0].worked ?? 0,
          facing: q.v[0].facing ?? 0,
          ao: pick((x) => x.ao),
          sky: pick((x) => x.sky),
          block: pick((x) => x.block),
        });
      }
    }
  }
  return out;
}

function rand3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

const padIndex = (P: number, px: number, py: number, pz: number): number =>
  px + pz * P + py * P * P;

describe('SectionMesher (Forge mesher tests, ported)', () => {
  it('a lone block has six faces', () => {
    const out = new SectionMesher(FORGE).mesh(new Volume().set(4, 4, 4, STONE).input(), {
      greedy: false,
    });
    expect(out.opaqueQuads).toBe(6);
    expect(out.liquidQuads).toBe(0);
    expect(out.opaque.byteLength).toBe(6 * 4 * 2 * 4);
    expect(
      quads(out.opaque)
        .map((q) => q.face)
        .sort(),
    ).toEqual([0, 1, 2, 3, 4, 5]);
    expect(out.bounds).toEqual([4, 4, 4, 5, 5, 5]);
  });

  it('touching blocks hide the shared faces', () => {
    const vol = new Volume().set(4, 4, 4, STONE).set(5, 4, 4, STONE);
    const out = new SectionMesher(FORGE).mesh(vol.input(), { greedy: false });
    expect(out.opaqueQuads).toBe(10);
    expect(out.faces).toBe(10);
  });

  it('neighbour section borders cull faces at the section edge', () => {
    const vol = new Volume().set(0, 4, 4, STONE).set(-1, 4, 4, STONE);
    const qs = quads(new SectionMesher(FORGE).mesh(vol.input(), { greedy: false }).opaque);
    expect(qs.length).toBe(5);
    expect(qs.some((q) => q.face === FACE_NEG_X)).toBe(false);
  });

  it('a filled section with filled neighbours has no faces', () => {
    const vol = new Volume().fill(-1, -1, -1, 16, 16, 16, STONE);
    const out = new SectionMesher(FORGE).mesh(vol.input(), { greedy: true });
    expect(out.opaqueQuads + out.liquidQuads).toBe(0);
    expect(out.connectivity).toBe(0);
    expect(out.bounds).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('liquid goes to its own stream and culls only against liquid and opaque blocks', () => {
    const vol = new Volume().fill(2, 2, 2, 3, 2, 2, WATER).set(4, 2, 2, STONE);
    const out = new SectionMesher(FORGE).mesh(vol.input(), { greedy: false });
    expect(out.liquidQuads).toBe(9);
    expect(out.opaqueQuads).toBe(6);
    expect(quads(out.liquid).every((q) => q.id === WATER)).toBe(true);
  });

  it('ambient occlusion darkens floor corners next to a block', () => {
    const vol = new Volume().fill(0, 0, 0, 15, 0, 15, STONE).set(5, 1, 5, STONE);
    const qs = quads(new SectionMesher(FORGE).mesh(vol.input(), { greedy: false }).opaque);
    const top = (x: number, z: number): Quad => {
      const q = qs.find(
        (q) => q.face === FACE_POS_Y && q.min[0] === x && q.min[2] === z && q.min[1] === 1,
      );
      if (!q) throw new Error('no top');
      return q;
    };
    const east = top(6, 5);
    expect(vertexAt(east, 6, 1, 5)?.ao).toBe(2);
    expect(vertexAt(east, 6, 1, 6)?.ao).toBe(2);
    expect(vertexAt(east, 7, 1, 5)?.ao).toBe(3);
    expect(vertexAt(east, 7, 1, 6)?.ao).toBe(3);
    const diag = top(6, 6);
    expect(vertexAt(diag, 6, 1, 6)?.ao).toBe(2);
    expect(vertexAt(diag, 7, 1, 7)?.ao).toBe(3);
    expect(top(12, 12).v.every((v) => v.ao === 3)).toBe(true);
  });

  it('two side occluders make the darkest corner regardless of the diagonal', () => {
    const vol = new Volume()
      .fill(0, 0, 0, 15, 0, 15, STONE)
      .set(4, 1, 5, STONE)
      .set(5, 1, 4, STONE);
    const qs = quads(new SectionMesher(FORGE).mesh(vol.input(), { greedy: false }).opaque);
    const q = qs.find(
      (x) => x.face === FACE_POS_Y && x.min[0] === 5 && x.min[2] === 5 && x.min[1] === 1,
    );
    expect(q && vertexAt(q, 5, 1, 5)?.ao).toBe(0);
  });

  it('sky light is full in the open and dims under an overhang', () => {
    const vol = new Volume().fill(0, 0, 0, 15, 0, 15, STONE).fill(0, 5, 0, 7, 5, 15, STONE);
    const mesher = new SectionMesher(FORGE);
    const qs = quads(mesher.mesh(vol.input(), { greedy: false }).opaque);
    const floorTop = (x: number): Quad => {
      const q = qs.find(
        (q) => q.face === FACE_POS_Y && q.min[0] === x && q.min[2] === 8 && q.min[1] === 1,
      );
      if (!q) throw new Error('no floor');
      return q;
    };
    const avg = (q: Quad): number => q.v.reduce((s, v) => s + v.sky, 0) / 4;
    const open = floorTop(13);
    const under = floorTop(2);
    expect(open.v.every((v) => v.sky === 60)).toBe(true);
    expect(avg(under)).toBeLessThan(avg(open));
    expect(avg(floorTop(7))).toBeGreaterThan(avg(under));
    expect(mesher.skyLevels[padIndex(18, 14, 3, 9)]).toBe(15);
  });

  it('a cell field reaches the faces, and a flagged air cell marks the faces it exposes', () => {
    const vol = new Volume()
      .fill(0, 0, 0, 15, 3, 15, STONE)
      .set(3, 3, 3, AIR | WORKED)
      .set(10, 4, 10, LOG | WORKED);
    const qs = quads(new SectionMesher(FORGE).mesh(vol.input(), { greedy: false }).opaque);
    const placed = qs.filter((q) => q.id === LOG);
    expect(placed.length).toBe(5);
    expect(placed.every((q) => q.v.every((v) => v.worked === 1))).toBe(true);
    const pitFloor = qs.find(
      (q) => q.face === FACE_POS_Y && q.min[0] === 3 && q.min[2] === 3 && q.min[1] === 3,
    );
    expect(pitFloor?.v[0].worked).toBe(1);
    const ground = qs.find(
      (q) => q.face === FACE_POS_Y && q.min[0] === 8 && q.min[2] === 8 && q.min[1] === 4,
    );
    expect(ground?.v[0].worked).toBe(0);
  });

  it('greedy merging turns a flat lit floor into one quad', () => {
    const vol = new Volume().fill(-1, 0, -1, 16, 0, 16, GRASS);
    const out = new SectionMesher(FORGE).mesh(vol.input(), { greedy: true });
    const tops = quads(out.opaque).filter((q) => q.face === FACE_POS_Y);
    expect(tops.length).toBe(1);
    expect(tops[0].min).toEqual([0, 1, 0]);
    expect(tops[0].max).toEqual([16, 1, 16]);
  });

  it('cells whose field values differ never merge', () => {
    const vol = new Volume()
      .set(4, 3, 4, WATER | facing(5))
      .set(5, 3, 4, WATER | facing(5))
      .set(6, 3, 4, WATER | facing(2));
    const tops = quads(new SectionMesher(FORGE).mesh(vol.input(), { greedy: true }).liquid).filter(
      (q) => q.face === FACE_POS_Y,
    );
    expect(tops.length).toBe(2);
    expect(tops.map((q) => q.v[0].facing).sort()).toEqual([2, 5]);
    expect(tops.every((q) => q.v.every((v) => v.facing === q.v[0].facing))).toBe(true);
  });

  it('cutout blocks are inset cubes that hide nothing', () => {
    const vol = new Volume().set(4, 3, 4, STONE).set(4, 4, 4, SAPLING);
    const qs = quads(new SectionMesher(FORGE).mesh(vol.input(), { greedy: true }).opaque);
    const sapling = qs.filter((q) => q.id === SAPLING);
    expect(sapling.length).toBe(6);
    expect(sapling.every((q) => q.v.every((v) => v.inset === 6))).toBe(true);
    expect(qs.filter((q) => q.id === STONE).length).toBe(6);
  });

  it('foliage culls against foliage and goes to its own stream; cross blocks emit quads', () => {
    const vol = new Volume().fill(2, 2, 2, 3, 2, 2, LEAVES).set(8, 1, 8, STONE).set(8, 2, 8, FERN);
    const out = new SectionMesher(FORGE).mesh(vol.input(), { greedy: false });
    const fol = quads(out.foliage);
    expect(fol.filter((q) => q.id === LEAVES).length).toBe(10);
    const fern = fol.filter((q) => q.id === FERN);
    expect(fern.length).toBe(2);
    expect(fern.every((q) => q.face === CROSS_FACE)).toBe(true);
    expect(fern.map((q) => q.v[0].quad).sort()).toEqual([0, 1]);
    expect(fern.every((q) => q.v.every((v) => v.inset === 4))).toBe(true);
    // The stone under the fern keeps its top face.
    expect(quads(out.opaque).length).toBe(6);
  });

  it('corners carry which side of their cell they are on', () => {
    const out = new SectionMesher(FORGE).mesh(new Volume().set(4, 4, 4, STONE).input(), {
      greedy: false,
    });
    for (const q of quads(out.opaque)) {
      for (const v of q.v) {
        const side = ((v.x - 4) & 1) | (((v.y - 4) & 1) << 1) | (((v.z - 4) & 1) << 2);
        expect(v.side).toBe(side);
      }
    }
  });
});

/** Greedy output must draw exactly what the per-face output draws. */
function assertGreedyEquivalent(
  format: VoxelFormat,
  input: SectionInput,
  label: string,
): { plain: number; greedy: number } {
  const plain = new SectionMesher(format).mesh(
    { ...input, blocks: input.blocks.slice(), heights: input.heights.slice() },
    { greedy: false },
  );
  const greedy = new SectionMesher(format).mesh(input, { greedy: true });
  expect(greedy.faces, `${label}: same faces`).toBe(plain.faces);
  for (const pass of ['opaque', 'liquid', 'foliage'] as const) {
    const a = unitFaces(quads(plain[pass], format));
    const b = unitFaces(quads(greedy[pass], format));
    expect(b.size, `${label} ${pass}: every face once`).toBe(a.size);
    for (const [key, fa] of a) expect(b.get(key), `${label} ${pass} ${key}`).toEqual(fa);
  }
  const n = (m: typeof plain) => m.opaqueQuads + m.liquidQuads + m.foliageQuads;
  expect(n(greedy)).toBeLessThanOrEqual(n(plain));
  return { plain: n(plain), greedy: n(greedy) };
}

describe('greedy merging', () => {
  it('only merges faces whose block, fields, AO and light match', () => {
    let plain = 0;
    let greedy = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const vol = new Volume();
      for (let y = -1; y <= 16; y++) {
        for (let z = -1; z <= 16; z++) {
          for (let x = -1; x <= 16; x++) {
            const r = rand3(x, y, z, seed);
            const ground = y < 6 + ((x + z) >> 3);
            let v = ground ? (r < 0.9 ? STONE : AIR) : r < 0.04 ? LOG : r < 0.07 ? LEAVES : AIR;
            if (!ground && y < 9 && v === AIR) v = WATER;
            if (rand3(x, y, z, seed + 9) < 0.05) v |= WORKED;
            if (v !== AIR && rand3(x, y, z, seed + 5) < 0.05) v |= facing(3);
            vol.set(x, y, z, v);
          }
        }
      }
      const r = assertGreedyEquivalent(FORGE, vol.input(), `rubble ${seed}`);
      plain += r.plain;
      greedy += r.greedy;
    }
    expect(greedy).toBeLessThan(plain);
  });
});

describe('a block table that is not Forge’s', () => {
  // 8-cell sections, the id in the cell's high byte, two materials, a glowing crystal, and a
  // per-block "material" vertex field the game's shader reads.
  const blocks = defineBlockTable([
    { class: 'none' },
    { class: 'opaque', fields: { material: 1 } },
    { class: 'opaque', fields: { material: 2 } },
    { class: 'opaque', emission: 12, hue: 3, fields: { material: 3 } },
  ]);
  const format = defineVoxelFormat({
    sectionSize: 8,
    blocks,
    vertex: defineVertexSchema([{ name: 'material', bits: 2 }, ...VOXEL_VERTEX_OPTIONAL]),
    cell: { idShift: 24, idBits: 8 },
  });
  const cell = (id: number): number => (id << 24) >>> 0;

  it('meshes, with its own section size, id placement and per-block fields', () => {
    const vol = new Volume(format)
      .fill(0, 0, 0, 7, 0, 7, cell(1))
      .fill(0, 1, 0, 3, 1, 7, cell(2))
      .set(6, 1, 6, cell(3));
    const out = new SectionMesher(format).mesh(vol.input(), { greedy: true });
    const qs = quads(out.opaque, format);
    expect(new Set(qs.map((q) => q.id))).toEqual(new Set([1, 2, 3]));
    for (const q of qs) expect(q.v.every((v) => v.material === q.id)).toBe(true);
    const tops = qs.filter((q) => q.face === FACE_POS_Y && q.id === 2);
    expect(tops.length).toBe(1);
    expect(tops[0].max[0] - tops[0].min[0]).toBe(4);
    expect(out.bounds).toEqual([0, 0, 0, 8, 2, 8]);
    assertGreedyEquivalent(format, vol.input(), 'two materials');
  });

  it('a piece meshes alone (a held block)', () => {
    const mesher = new SectionMesher(format);
    const out = mesher.meshPiece(Uint32Array.of(cell(1), cell(2)), 2, 1, 1);
    const qs = quads(out.opaque, format);
    expect(qs.length).toBe(10);
    expect(qs.every((q) => q.v.every((v) => v.sky === 60 && v.ao === 3))).toBe(true);
    expect(() => mesher.meshPiece(new Uint32Array(81), 9, 3, 3)).toThrow(RangeError);
  });
});

describe('connectivity', () => {
  /** A reference: flood from each open face cell, one face at a time. */
  function reference(opaque: Uint8Array, S: number): number {
    const P = S + 2;
    const idx = (x: number, y: number, z: number) => x + 1 + (z + 1) * P + (y + 1) * P * P;
    let bits = 0;
    const onFace = (f: number, x: number, y: number, z: number): boolean =>
      [x === 0, x === S - 1, y === 0, y === S - 1, z === 0, z === S - 1][f];
    for (let a = 0; a < 6; a++) {
      const seen = new Uint8Array(P * P * P);
      const stack: [number, number, number][] = [];
      for (let y = 0; y < S; y++) {
        for (let z = 0; z < S; z++) {
          for (let x = 0; x < S; x++) {
            if (onFace(a, x, y, z) && !opaque[idx(x, y, z)]) {
              seen[idx(x, y, z)] = 1;
              stack.push([x, y, z]);
            }
          }
        }
      }
      const reached = new Set<number>();
      while (stack.length) {
        const [x, y, z] = stack.pop() as [number, number, number];
        for (let f = 0; f < 6; f++) if (onFace(f, x, y, z)) reached.add(f);
        for (const [dx, dy, dz] of [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
          [0, -1, 0],
          [0, 0, 1],
          [0, 0, -1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (nx < 0 || ny < 0 || nz < 0 || nx >= S || ny >= S || nz >= S) continue;
          const j = idx(nx, ny, nz);
          if (seen[j] || opaque[j]) continue;
          seen[j] = 1;
          stack.push([nx, ny, nz]);
        }
      }
      for (const b of reached) if (b !== a) bits |= facePairBit(a, b);
    }
    return bits;
  }

  it('matches a reference flood on random caves', () => {
    const S = 8;
    const P = S + 2;
    const flood = new ConnectivityFlood(S);
    for (let seed = 1; seed <= 40; seed++) {
      const opaque = new Uint8Array(P ** 3);
      const light = new Uint8Array(P ** 3);
      const fill = 0.3 + (seed % 5) * 0.1;
      for (let i = 0; i < opaque.length; i++) opaque[i] = rand3(i, seed, 0, 7) < fill ? 1 : 0;
      flood.compute(opaque, light);
      expect(flood.bits, `seed ${seed}`).toBe(reference(opaque, S));
    }
  });

  it('reports a sealed tunnel, an open section, and darkness', () => {
    const S = 8;
    const P = S + 2;
    const opaque = new Uint8Array(P ** 3).fill(1);
    const light = new Uint8Array(P ** 3);
    // A tunnel along x at y = z = 3.
    for (let x = 0; x < S; x++) opaque[x + 1 + 4 * P + 4 * P * P] = 0;
    const flood = new ConnectivityFlood(S).compute(opaque, light);
    expect(flood.bits).toBe(facePairBit(0, 1));
    expect(flood.open).toBe(S);
    expect(flood.dark).toBe(true);
    expect(new ConnectivityFlood(S).compute(new Uint8Array(P ** 3), light).bits).toBe(
      ALL_FACE_PAIRS,
    );
  });

  it('the mesher reports it', () => {
    const vol = new Volume().fill(-1, 8, -1, 16, 8, 16, STONE);
    const out = new SectionMesher(FORGE).mesh(vol.input());
    // A floor splits −y from +y; everything else connects.
    expect(out.connectivity & facePairBit(2, 3)).toBe(0);
    expect(out.connectivity & facePairBit(0, 1)).not.toBe(0);
    expect(out.openCells).toBe(16 ** 3 - 256);
  });
});

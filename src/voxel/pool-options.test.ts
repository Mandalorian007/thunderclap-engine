/**
 * ws/forge-asks-fit: every `SectionMeshOptions` field reaches a pool's Workers. Messages cross a
 * port by structured clone (as to a Worker), so the format with every block field and the pool's
 * mesh options must survive the copy; each job's mesh is compared with the same section meshed
 * directly with the same options.
 */
import { describe, expect, it } from 'vitest';
import { defineBlockTable } from './blocks';
import { defineVoxelFormat, encodeRawSection, RAW_SECTION_CODEC, sectionKey } from './format';
import { type MesherPort, SectionMeshPool } from './pool';
import { defineVertexSchema, VOXEL_VERTEX_OPTIONAL } from './schema';
import { SectionMesher, type SectionMeshOptions } from './section-mesher';
import {
  installSectionMesherWorker,
  type PoolMeshOptions,
  type SectionMesherReply,
  type SectionMesherRequest,
} from './section-protocol';
import { SectionInputBuilder, type SectionJob } from './sources';
import { createSectionStore } from './store';

const AIR = 0;
const STONE = 1;
const WATER = 2;
const REED = 3; // a cross block in water with a far patch and an inset
const LOG = 4; // axial
const GRASS = 5; // parts that replace its quads
const LEAVES = 6; // lodSolid
const BUSH = 7; // a cross block with an inset and a constant field

const FORMAT = defineVoxelFormat({
  sectionSize: 8,
  blocks: defineBlockTable([
    { class: 'none' },
    { class: 'opaque' },
    { class: 'liquid' },
    { class: 'cross', quads: 2, liquid: WATER, farPatch: true, inset: 5 },
    { class: 'opaque', axial: true },
    { class: 'cross', quads: 1, parts: 3, partsReplace: true },
    { class: 'foliage', lodSolid: true },
    { class: 'cross', quads: 2, inset: 4, fields: { tint: 1 } },
  ]),
  vertex: defineVertexSchema([
    // Every optional field but the light hue (no block here gives off light).
    ...VOXEL_VERTEX_OPTIONAL.filter((f) => f.name !== 'hue'),
    { name: 'far', bits: 1 },
    { name: 'facing', bits: 3 },
    { name: 'ripe', bits: 2 },
    { name: 'tint', bits: 1 },
  ]),
  cell: {
    idBits: 12,
    fields: [
      { name: 'facing', shift: 12, bits: 3, fromNeighbours: { when: 2, y: 1, x: 5, z: 3 } },
      { name: 'ripe', shift: 15, bits: 2 },
    ],
  },
});
const S = FORMAT.size;
const P = S + 2;
const pad = (x: number, y: number, z: number) => x + 1 + (z + 1) * P + (y + 1) * P * P;

/** A cell of every kind in section (0, 0, 0); stone below, air above; neighbours plain. */
function cellAt(x: number, y: number, z: number): number {
  if (y === 0) return STONE;
  if (x >= 1 && x <= 3 && z >= 1 && z <= 3 && y <= 3) return x === 2 && z === 2 ? REED : WATER;
  if (y === 1 && z === 5) return x === 5 ? LOG | (2 << 12) : x === 6 ? LOG : GRASS;
  if (y === 1 && z === 6) return BUSH | (2 << 15);
  if (y === 4 && x >= 4 && z <= 2) return LEAVES;
  if (y === 5 && x === 7 && z === 7) return LEAVES;
  return AIR;
}

function store() {
  const st = createSectionStore({
    format: FORMAT,
    codec: RAW_SECTION_CODEC,
    minSectionY: 0,
    maxSectionY: 0,
    outside: STONE,
  });
  for (let sz = -1; sz <= 1; sz++) {
    for (let sx = -1; sx <= 1; sx++) {
      const cells = new Uint32Array(S ** 3);
      for (let y = 0, i = 0; y < S; y++) {
        for (let z = 0; z < S; z++) {
          for (let x = 0; x < S; x++) cells[i++] = sx === 0 && sz === 0 ? cellAt(x, y, z) : AIR;
        }
      }
      st.putSection(sx, 0, sz, encodeRawSection(cells));
    }
  }
  return st;
}

const K0 = sectionKey(0, 0, 0);
/** Growing bushes: inset 2 ripe 3, and inset 6 ripe 1, packed above the inset. */
const INSETS = [pad(2, 1, 6), 2 | (3 << 5), pad(4, 1, 6), 6 | (1 << 5)];

/** A Worker stand-in: every message both ways is a structured clone, answered on a microtask. */
class ClonePort implements MesherPort {
  readonly got: SectionMesherRequest['type'][] = [];
  private listener: ((r: SectionMesherReply) => void) | null = null;
  private readonly handle = installSectionMesherWorker(
    { codec: RAW_SECTION_CODEC },
    { postMessage: () => {}, addEventListener: () => {} },
  );
  post(m: SectionMesherRequest, transfer: ArrayBuffer[]): void {
    const copy = structuredClone(m, { transfer });
    this.got.push(copy.type);
    const reply = this.handle(copy);
    if (reply) {
      const back = structuredClone(reply);
      queueMicrotask(() => this.listener?.(back));
    }
  }
  onResult(cb: (r: SectionMesherReply) => void): void {
    this.listener = cb;
  }
  terminate(): void {}
}

function direct(opts: SectionMeshOptions): number[][] {
  const st = store();
  const job = st.jobFor(K0);
  const m = new SectionMesher(FORMAT).mesh(
    new SectionInputBuilder(FORMAT, RAW_SECTION_CODEC).build(job),
    { ...opts, insets: Int32Array.from(INSETS) },
  );
  return [m.opaque, m.liquid, m.foliage].map((b) => [...new Uint32Array(b)]);
}

async function pooled(
  meshOptions: PoolMeshOptions | undefined,
  leafLod: number,
  change?: PoolMeshOptions,
): Promise<{ meshes: number[][][]; port: ClonePort }> {
  const st = store();
  const port = new ClonePort();
  const meshes: number[][][] = [];
  const pool = new SectionMeshPool({
    format: FORMAT,
    ports: [port],
    build: (key): SectionJob => ({ ...st.jobFor(key), insets: Int32Array.from(INSETS) }),
    onMesh: (_key, r) =>
      meshes.push(
        [r.mesh.opaque, r.mesh.liquid, r.mesh.foliage].map((b) => [...new Uint32Array(b)]),
      ),
    greedy: false,
    leafLod: () => leafLod,
    meshOptions,
  });
  const settle = async () => {
    for (let i = 0; i < 20 && !pool.idle; i++) await Promise.resolve();
  };
  pool.enqueue(K0, 0);
  pool.pump();
  await settle();
  if (change) {
    pool.setMeshOptions(change);
    pool.enqueue(K0, 0);
    pool.pump();
    await settle();
  }
  return { meshes, port };
}

const ALL: PoolMeshOptions = {
  crossLod: 2,
  tieredPadding: true,
  partsCap: 2,
  partsOrder: 'after',
  insetFields: { ripe: { shift: 5, bits: 2 }, facing: 4 },
};

describe('SectionMeshPool mesh options (ws/forge-asks-fit)', () => {
  it('the format with every block field survives the clone to a Worker', () => {
    const copy = structuredClone(FORMAT);
    const st = store();
    const job = st.jobFor(K0);
    const a = new SectionMesher(FORMAT).mesh(
      new SectionInputBuilder(FORMAT, RAW_SECTION_CODEC).build(job),
    );
    const b = new SectionMesher(copy).mesh(
      new SectionInputBuilder(copy, RAW_SECTION_CODEC).build(job),
    );
    expect([...new Uint32Array(b.foliage)]).toEqual([...new Uint32Array(a.foliage)]);
    expect([...new Uint32Array(b.opaque)]).toEqual([...new Uint32Array(a.opaque)]);
    expect(a.foliageQuads).toBeGreaterThan(0);
  });

  it('meshes every job with the pool’s options, as the mesher does directly', async () => {
    for (const leafLod of [0, 1, 2]) {
      const { meshes } = await pooled(ALL, leafLod);
      expect(meshes.length).toBe(1);
      expect(meshes[0]).toEqual(direct({ ...ALL, greedy: false, leafLod }));
    }
    // The options change the mesh (else the comparison proves nothing).
    expect(direct({ ...ALL, greedy: false })).not.toEqual(direct({ greedy: false }));
    expect(direct({ ...ALL, greedy: false, leafLod: 2 })).not.toEqual(
      direct({ greedy: false, leafLod: 2 }),
    );
  });

  it('without options, the mesher’s defaults', async () => {
    const { meshes, port } = await pooled(undefined, 0);
    expect(meshes[0]).toEqual(direct({ greedy: false }));
    expect(port.got).toEqual(['init', 'mesh']);
  });

  it('setMeshOptions applies to the jobs sent after it', async () => {
    const { meshes, port } = await pooled(undefined, 0, ALL);
    expect(meshes.length).toBe(2);
    expect(meshes[0]).toEqual(direct({ greedy: false }));
    expect(meshes[1]).toEqual(direct({ ...ALL, greedy: false }));
    expect(port.got).toEqual(['init', 'mesh', 'mesh']);
  });

  it('a respawned Worker meshes the lost job with the options', async () => {
    const first = new ClonePort();
    const second = new ClonePort();
    const st = store();
    let errorCb: ((m: string) => void) | null = null;
    const dying: MesherPort = {
      post: (m, t) => first.post(m, t),
      onResult: () => {},
      onError: (cb) => {
        errorCb = cb;
      },
      terminate: () => {},
    };
    const meshes: number[][][] = [];
    const pool = new SectionMeshPool({
      format: FORMAT,
      ports: [dying],
      build: (key): SectionJob => ({ ...st.jobFor(key), insets: Int32Array.from(INSETS) }),
      onMesh: (_k, r) =>
        meshes.push(
          [r.mesh.opaque, r.mesh.liquid, r.mesh.foliage].map((b) => [...new Uint32Array(b)]),
        ),
      greedy: false,
      meshOptions: { tieredPadding: true },
      respawn: () => second,
    });
    pool.setMeshOptions(ALL);
    pool.enqueue(K0, 0);
    pool.pump();
    (errorCb as unknown as (m: string) => void)('gone');
    for (let i = 0; i < 20 && !pool.idle; i++) await Promise.resolve();
    expect(second.got).toEqual(['init', 'mesh']);
    expect(meshes).toEqual([direct({ ...ALL, greedy: false })]);
  });
});

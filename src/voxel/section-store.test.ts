// The streamed half: the section store, jobs and their inputs, block light across sections
// (Forge Wilds' light tests, ported), the mesher pool, and picking through the store.
import { describe, expect, it } from 'vitest';
import { defineBlockTable } from './blocks';
import {
  defineVoxelFormat,
  encodeRawSection,
  RAW_SECTION_CODEC,
  sectionKey,
  sectionKeyX,
  sectionKeyY,
  sectionKeyZ,
  type VoxelFormat,
} from './format';
import { inThreadMesherPort, type MesherPort, SectionMeshPool } from './pool';
import type { VoxelHit } from './ray';
import { defineVertexSchema, VOXEL_VERTEX_OPTIONAL } from './schema';
import { SectionMesher } from './section-mesher';
import { installSectionMesherWorker, type SectionMesherReply } from './section-protocol';
import { RAY_HIT, RAY_PASS, RAY_UNKNOWN, raycastCells, sectionRayProbe } from './section-ray';
import { SectionInputBuilder } from './sources';
import { createSectionStore, type SectionStore } from './store';

const AIR = 0;
const STONE = 1;
const WATER = 2;
const GLOW = 3; // a glowcap: emission 13, hue 1
const LAMP = 4; // emission 13, hue 2
const blocks = defineBlockTable(
  [
    { class: 'none' },
    { class: 'opaque' },
    { class: 'liquid' },
    { class: 'opaque', emission: 13, hue: 1 },
    { class: 'opaque', emission: 13, hue: 2 },
  ],
  { hueMix: [[1, 2, 5]] },
);
const FORMAT = defineVoxelFormat({
  blocks,
  vertex: defineVertexSchema(VOXEL_VERTEX_OPTIONAL),
});
const S = 16;
const P = S + 2;
const pad = (x: number, y: number, z: number): number => x + 1 + (z + 1) * P + (y + 1) * P * P;

/** A one-row world (section y 0) over sections −r..r, cells from `cell(x, y, z)` (world). */
function world(
  cell: (x: number, y: number, z: number) => number,
  r = 1,
  format: VoxelFormat = FORMAT,
): SectionStore {
  const store = createSectionStore({
    format,
    codec: RAW_SECTION_CODEC,
    minSectionY: 0,
    maxSectionY: 0,
    outside: STONE,
  });
  const n = format.size;
  for (let sz = -r; sz <= r; sz++) {
    for (let sx = -r; sx <= r; sx++) {
      const cells = new Uint32Array(n ** 3);
      for (let y = 0, i = 0; y < n; y++) {
        for (let z = 0; z < n; z++) {
          for (let x = 0; x < n; x++) cells[i++] = cell(sx * n + x, y, sz * n + z);
        }
      }
      store.putSection(sx, 0, sz, encodeRawSection(cells));
    }
  }
  return store;
}

const K0 = sectionKey(0, 0, 0);

/** Mesh section (0, 0, 0) of a store; returns the mesher to read its light from. */
function meshOrigin(store: SectionStore): SectionMesher {
  const mesher = new SectionMesher(store.format);
  const builder = new SectionInputBuilder(store.format, RAW_SECTION_CODEC);
  mesher.mesh(builder.build(store.jobFor(K0)));
  return mesher;
}

describe('SectionStore', () => {
  it('keys round-trip, negative coordinates included', () => {
    for (const [x, y, z] of [
      [0, 0, 0],
      [-1, -2, -3],
      [1000, -40, -99999],
      [-1048576, 1023, 1048575],
    ]) {
      const k = sectionKey(x, y, z);
      expect([sectionKeyX(k), sectionKeyY(k), sectionKeyZ(k)]).toEqual([x, y, z]);
    }
  });

  it('a section is ready once every neighbour is known', () => {
    const store = createSectionStore({
      format: FORMAT,
      codec: RAW_SECTION_CODEC,
      minSectionY: 0,
      maxSectionY: 0,
    });
    const air = encodeRawSection(Uint32Array.of(AIR));
    store.putSection(0, 0, 0, air);
    expect(store.ready(K0)).toBe(false);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) if (dx || dz) store.putSection(dx, 0, dz, air);
    }
    expect(store.ready(K0)).toBe(true);
    expect(store.ready(sectionKey(1, 0, 0))).toBe(false);
    store.dropSection(sectionKey(1, 0, 1));
    expect(store.ready(K0)).toBe(false);
    expect(store.stats().sections).toBe(8);
  });

  it('hands out ready sections nearest the interest point first', () => {
    const store = world(() => AIR, 3);
    store.setInterest(2 * S + 3, 5, -S + 3);
    const out: number[] = [];
    expect(store.takeReady(out, 100)).toBe(25);
    expect(out[0]).toBe(sectionKey(2, 0, -1));
    const d = (k: number) =>
      Math.abs(sectionKeyX(k) * S + 8 - (2 * S + 3)) + Math.abs(sectionKeyZ(k) * S + 8 + S - 3);
    for (let i = 1; i < out.length; i++) {
      expect(d(out[i])).toBeGreaterThanOrEqual(d(out[i - 1]) - 2 * S);
    }
    expect(store.takeReady(out, 100)).toBe(0);
  });

  it('a job round-trips through the builder into the padded volume', () => {
    const cellOf = (x: number, y: number, z: number) =>
      (x * 7 + y * 3 + z * 5) % 5 === 0 ? STONE : AIR;
    const store = world(cellOf);
    const input = new SectionInputBuilder(FORMAT, RAW_SECTION_CODEC).build(store.jobFor(K0));
    for (let y = -1; y <= S; y++) {
      for (let z = -1; z <= S; z++) {
        for (let x = -1; x <= S; x++) {
          const want = y < 0 ? STONE : y >= S ? AIR : cellOf(x, y, z);
          expect(input.blocks[pad(x, y, z)], `${x},${y},${z}`).toBe(want);
        }
      }
    }
    expect(store.cellAt(-1, 3, -1)).toBe(cellOf(-1, 3, -1));
    expect(store.cellAt(0, 0, 5 * S)).toBeUndefined();
  });

  it('an edit returns the sections whose mesh it changes', () => {
    const store = world((_x, y) => (y < 4 ? STONE : AIR));
    const out: number[] = [];
    store.takeReady(out, 100);
    const sort = (a: number[]) => [...a].sort((p, q) => p - q);
    // Inside, under other stone: itself only.
    expect(store.edit(K0, [5 + 5 * S + 1 * S * S, AIR])).toEqual([K0]);
    // On the −x face: and the −x neighbour.
    expect(sort(store.edit(K0, [0 + 5 * S + 1 * S * S, AIR]))).toEqual(
      sort([K0, sectionKey(-1, 0, 0)]),
    );
    // On a vertical edge: the three around it.
    expect(sort(store.edit(K0, [15 + 15 * S + 1 * S * S, AIR]))).toEqual(
      sort([K0, sectionKey(1, 0, 0), sectionKey(0, 0, 1), sectionKey(1, 0, 1)]),
    );
    expect(store.cellAt(15, 1, 15)).toBe(AIR);
    expect(store.stats().decoded).toBe(1);
    // Only the middle section has all its neighbours here.
    expect(store.takeReady(out, 100)).toBe(1);
  });

  it('an edit near a glowing block remeshes every section around it', () => {
    const store = world((x, y, z) => (x === 20 && y === 8 && z === 3 ? GLOW : AIR));
    const keys = store.edit(K0, [5 + 5 * S + 5 * S * S, STONE]);
    expect(keys.length).toBe(9);
  });
});

describe('block light (Forge light tests, ported)', () => {
  it('a glowcap lights its cave by distance, stopped by walls, dimmer through water', () => {
    // Air cave; the glowcap at (8, 8, 8); a stone wall at x = 4; water at x = 11..12.
    const store = world((x, y, z) => {
      if (x === 8 && y === 8 && z === 8) return GLOW;
      if (x === 4) return STONE;
      if ((x === 11 || x === 12) && y === 8 && z === 8) return WATER;
      return AIR;
    });
    const mesher = meshOrigin(store);
    const level = mesher.blockLevels;
    expect(level[pad(7, 8, 8)]).toBe(12);
    expect(level[pad(5, 8, 8)]).toBe(10);
    expect(level[pad(8, 8, 2)]).toBe(7);
    expect(level[pad(4, 8, 8)]).toBe(0); // the wall
    expect(level[pad(3, 8, 8)]).toBe(0); // the wall runs through the world: nothing passes
    // Into water costs 2 per cell, so it beats going around through the air (13 − 6).
    expect(level[pad(10, 8, 8)]).toBe(11);
    expect(level[pad(11, 8, 8)]).toBe(9);
    expect(level[pad(12, 8, 8)]).toBe(7);
    expect(mesher.blockHues[pad(7, 8, 8)]).toBe(1);
    expect(mesher.blockLightVisited).toBeGreaterThan(0);
  });

  it('light from glowing blocks beyond a section’s border reaches it', () => {
    const store = world((x, y, z) => (x === S + 2 && y === 8 && z === 8 ? GLOW : AIR));
    const level = meshOrigin(store).blockLevels;
    expect(level[pad(S - 1, 8, 8)]).toBe(13 - 3);
    expect(level[pad(S, 8, 8)]).toBe(13 - 2); // the border cell
    expect(level[pad(0, 8, 8)]).toBe(0);
  });

  it('where two lights meet, each cell takes the brighter’s hue, the lower hue on a tie', () => {
    const store = world((x, y, z) => {
      if (y !== 8 || z !== 8) return AIR;
      return x === 3 ? LAMP : x === 9 ? GLOW : AIR;
    });
    const mesher = meshOrigin(store);
    expect(mesher.blockHues[pad(4, 8, 8)]).toBe(2);
    expect(mesher.blockHues[pad(6, 8, 8)]).toBe(1); // a tie: hue 1 beats hue 2
    expect(mesher.blockLevels[pad(6, 8, 8)]).toBe(10);
    expect(mesher.blockHues[pad(8, 8, 8)]).toBe(1);
  });

  it('two sections agree on the light of the cells they share', () => {
    const store = world((x, y, z) => (x === S - 3 && y === 6 && z === 4 ? GLOW : AIR), 2);
    const builder = new SectionInputBuilder(FORMAT, RAW_SECTION_CODEC);
    const a = new SectionMesher(FORMAT);
    a.mesh(builder.build(store.jobFor(K0)));
    const la = a.blockLevels.slice();
    const b = new SectionMesher(FORMAT);
    b.mesh(builder.build(store.jobFor(sectionKey(1, 0, 0))));
    for (let y = 0; y < S; y++) {
      for (let z = 0; z < S; z++) {
        // a's x = S (border) is b's x = 0; b's x = −1 is a's x = S − 1.
        expect(b.blockLevels[pad(0, y, z)]).toBe(la[pad(S, y, z)]);
        expect(b.blockLevels[pad(-1, y, z)]).toBe(la[pad(S - 1, y, z)]);
      }
    }
  });

  it('block light reaches the vertices, in half levels, with its hue', () => {
    const store = world((x, y, z) => (y === 0 || (x === 8 && y === 1 && z === 8) ? STONE : AIR));
    store.edit(K0, [8 + 8 * S + 1 * S * S, GLOW]);
    const builder = new SectionInputBuilder(FORMAT, RAW_SECTION_CODEC);
    const mesh = new SectionMesher(FORMAT).mesh(builder.build(store.jobFor(K0)), {
      greedy: false,
    });
    const words = new Uint32Array(mesh.opaque);
    const blockF = FORMAT.vertex.fields.find((f) => f.name === 'block');
    const hueF = FORMAT.vertex.fields.find((f) => f.name === 'hue');
    if (!blockF || !hueF) throw new Error('fields');
    let lit = 0;
    for (let i = 0; i < words.length; i += 2) {
      const bl = (words[i + blockF.word] >>> blockF.shift) & blockF.mask;
      if (bl > 0) {
        lit++;
        expect(bl).toBeLessThanOrEqual(26);
        expect((words[i + hueF.word] >>> hueF.shift) & hueF.mask).toBe(1);
      }
    }
    expect(lit).toBeGreaterThan(0);
  });

  it('with no glowing block near, jobs carry only the border and no light flood runs', () => {
    const store = world((_x, y) => (y < 3 ? STONE : AIR));
    const job = store.jobFor(K0);
    expect(job.glow).toBeUndefined();
    const mesher = meshOrigin(store);
    expect(mesher.blockLightVisited).toBe(0);
    expect(mesher.blockLevels.every((v) => v === 0)).toBe(true);
  });
});

/** A port that answers when told, or fails or dies on demand. */
class FakePort implements MesherPort {
  sent: { job: number; key: number }[] = [];
  private result: ((r: SectionMesherReply) => void) | null = null;
  private error: ((m: string) => void) | null = null;
  terminated = false;
  private readonly handle = installSectionMesherWorker(
    { codec: RAW_SECTION_CODEC },
    { postMessage: () => {}, addEventListener: () => {} },
  );
  post(m: Parameters<MesherPort['post']>[0]): void {
    if (m.type === 'init') {
      this.handle(m);
      return;
    }
    this.sent.push({ job: m.job, key: sectionKey(m.input.sx, m.input.sy, m.input.sz) });
    this.pending.push(m);
  }
  pending: Parameters<MesherPort['post']>[0][] = [];
  onResult(cb: (r: SectionMesherReply) => void): void {
    this.result = cb;
  }
  onError(cb: (m: string) => void): void {
    this.error = cb;
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Answer the oldest job (or fail it). */
  answer(fail = false): void {
    const m = this.pending.shift();
    if (!m || m.type !== 'mesh') throw new Error('nothing pending');
    const reply = fail
      ? ({ type: 'error', job: m.job, sx: 0, sy: 0, sz: 0, message: 'boom' } as const)
      : this.handle(m);
    if (reply) this.result?.(reply);
  }
  die(): void {
    this.error?.('gone');
  }
}

describe('SectionMeshPool (Forge pool tests, ported)', () => {
  const store = world((_x, y) => (y < 4 ? STONE : AIR), 2);

  function pool(ports: MesherPort[], respawn?: (i: number) => MesherPort) {
    const meshed: number[] = [];
    const p = new SectionMeshPool({
      format: FORMAT,
      ports,
      build: (key) => store.jobFor(key),
      onMesh: (key) => meshed.push(key),
      perWorker: 1,
      respawn,
    });
    return { p, meshed };
  }

  it('meshes nearest (lowest priority) first, one at a time per worker', async () => {
    const meshed: number[] = [];
    const p = new SectionMeshPool({
      format: FORMAT,
      ports: [inThreadMesherPort(RAW_SECTION_CODEC)],
      build: (key) => store.jobFor(key),
      onMesh: (key, r) => {
        expect(r.mesh.opaqueQuads).toBeGreaterThan(0);
        meshed.push(key);
      },
      perWorker: 1,
    });
    p.enqueue(sectionKey(1, 0, 0), 5);
    p.enqueue(K0, 1);
    p.enqueue(sectionKey(-1, 0, 0), 3);
    p.pump();
    expect(p.stats.inFlight).toBe(1);
    for (let i = 0; i < 10 && !p.idle; i++) await Promise.resolve();
    expect(meshed).toEqual([K0, sectionKey(-1, 0, 0), sectionKey(1, 0, 0)]);
  });

  it('a job the mesher throws on frees its slot and is counted; the pool carries on', () => {
    const port = new FakePort();
    const { p, meshed } = pool([port]);
    p.enqueue(K0, 0);
    p.enqueue(sectionKey(1, 0, 0), 1);
    p.pump();
    port.answer(true);
    expect(p.errors.count).toBe(1);
    expect(p.errors.last).toContain('boom');
    port.answer();
    expect(meshed).toEqual([sectionKey(1, 0, 0)]);
    expect(p.idle).toBe(true);
  });

  it('a section asked for again while its job fails is meshed again', () => {
    const port = new FakePort();
    const { p, meshed } = pool([port]);
    p.enqueue(K0, 0);
    p.pump();
    p.enqueue(K0, 0);
    port.answer(true);
    port.answer();
    expect(meshed).toEqual([K0]);
  });

  it('a worker that dies is replaced and its jobs run on the new one', () => {
    const first = new FakePort();
    const second = new FakePort();
    const { p, meshed } = pool([first], () => second);
    p.enqueue(K0, 0);
    p.pump();
    first.die();
    expect(first.terminated).toBe(true);
    expect(p.errors.restarts).toBe(1);
    expect(second.sent.map((s) => s.key)).toEqual([K0]);
    second.answer();
    expect(meshed).toEqual([K0]);
  });

  it('a section whose job kills its worker twice in a row is skipped', () => {
    const ports = [new FakePort(), new FakePort(), new FakePort()];
    let next = 1;
    const { p, meshed } = pool([ports[0]], () => ports[next++]);
    p.enqueue(K0, 0);
    p.pump();
    ports[0].die();
    ports[1].die();
    expect(ports[2].sent).toEqual([]);
    expect(p.errors.count).toBe(1);
    expect(p.idle).toBe(true);
    expect(meshed).toEqual([]);
  });

  it('the worker answers a job it throws on with a failure naming the section', () => {
    const handle = installSectionMesherWorker(
      { codec: RAW_SECTION_CODEC },
      { postMessage: () => {}, addEventListener: () => {} },
    );
    const job = store.jobFor(sectionKey(1, 0, -1));
    expect(handle({ type: 'mesh', job: 4, input: job, greedy: true })).toMatchObject({
      type: 'error',
      job: 4,
      sx: 1,
      sz: -1,
    });
    handle({ type: 'init', format: FORMAT });
    job.data.fill(0xff);
    const bad = handle({ type: 'mesh', job: 5, input: job, greedy: true });
    expect(bad?.type === 'error' || bad?.type === 'mesh').toBe(true);
  });
});

describe('picking through the store', () => {
  const store = world((x, y, z) =>
    y < 3 || (x === 5 && y === 3 && z === 5) ? STONE : y === 3 && x === 9 ? WATER : AIR,
  );
  const probe = sectionRayProbe(store);
  const hit: VoxelHit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, distance: 0 };

  it('hits the first solid cell with its face and the cell in front', () => {
    expect(raycastCells(probe, 5.5, 10, 5.5, 0, -1, 0, 20, hit)).toBe(RAY_HIT);
    expect([hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz]).toEqual([5, 3, 5, 0, 1, 0]);
    expect([hit.px, hit.py, hit.pz]).toEqual([5, 4, 5]);
    expect(hit.distance).toBeCloseTo(6);
  });

  it('passes through liquid, runs out of distance, and stops at unknown sections', () => {
    expect(raycastCells(probe, 9.5, 10, 2.5, 0, -1, 0, 20, hit)).toBe(RAY_HIT);
    expect(hit.y).toBe(2);
    expect(raycastCells(probe, 1.5, 10, 1.5, 0, -1, 0, 3, hit)).toBe(RAY_PASS);
    expect(raycastCells(probe, 8.5, 8.5, 8.5, 1, 0, 0, 100, hit)).toBe(RAY_UNKNOWN);
    expect(hit.distance).toBeCloseTo(2 * S - 8.5);
  });

  it('takes a game’s own idea of solid', () => {
    const water = sectionRayProbe(store, (cell) => cell === WATER);
    expect(raycastCells(water, 9.5, 10, 2.5, 0, -1, 0, 20, hit)).toBe(RAY_HIT);
    expect(hit.y).toBe(3);
  });
});

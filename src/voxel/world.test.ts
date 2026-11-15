/**
 * ws/voxel-draw: a streamed voxel world on the retained core, on the fake GPU. Sections mesh in
 * the pool, upload into three static GPU-culled sets within the per-frame budget, cave culling
 * hides what the eye cannot reach, and a held frame costs the same GPU calls at radius 4 and 8
 * and allocates nothing.
 */
import v8 from 'node:v8';
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { createRenderCore, type RenderCore } from '../render/core/core';
import { pipelineGroupErrors, recordPipelines } from '../render/core/pipeline-groups.test-util';
import { createRenderView, type RenderView, setViewFromCamera } from '../render/core/view';
import { createFakeDevice, type FakeDevice } from '../render/fake-gpu';
import { expectProportional } from '../testing/budget';
import { defineBlockTable } from './blocks';
import { defineVoxelFormat, encodeRawSection, sectionIndex, sectionKey } from './format';
import { createVoxelHit } from './ray';
import { RAY_HIT } from './section-ray';
import { SectionVisibility } from './visibility';
import { createVoxelWorld, type VoxelWorld } from './world';

const AIR = 0;
const STONE = 1;
const GRASS = 2;
const WATER = 3;
const FERN = 4;
const LEAF = 5;
const format = defineVoxelFormat({
  sectionSize: 8,
  blocks: defineBlockTable([
    { class: 'none' },
    { class: 'opaque' },
    { class: 'opaque' },
    { class: 'liquid' },
    { class: 'cross' },
    { class: 'foliage' },
  ]),
});
const S = format.size;

/** Rolling ground around y 10 with a pond, ferns and a leaf block: rows −2..2 of 8-cell sections. */
function cellsOf(sx: number, sy: number, sz: number): Uint32Array {
  const cells = new Uint32Array(S * S * S);
  for (let y = 0; y < S; y++) {
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const wx = sx * S + x;
        const wy = sy * S + y;
        const wz = sz * S + z;
        const h = 9 + Math.round(2 * Math.sin(wx * 0.3) + 2 * Math.cos(wz * 0.23));
        let id = AIR;
        if (wy < h) id = wy === h - 1 ? GRASS : STONE;
        // Sealed caves deep down: hollow 4-cell pockets in every other section of row −2.
        if (
          sy === -2 &&
          ((sx + sz) & 1) === 0 &&
          x >= 2 &&
          x < 6 &&
          z >= 2 &&
          z < 6 &&
          y >= 2 &&
          y < 6
        )
          id = AIR;
        else if (wy < 9 && (wx & 15) < 5 && (wz & 15) < 5) id = WATER;
        else if (wy === h && ((wx * 7 + wz * 3) & 15) === 0) id = FERN;
        else if (wy === h && ((wx * 5 + wz * 11) & 31) === 1) id = LEAF;
        cells[sectionIndex(S, x, y, z)] = id;
      }
    }
  }
  return cells;
}

/** The world's clock: a test moves it on so throttled searches come due. */
const clock = { now: 0 };

interface Rig {
  fake: FakeDevice;
  core: RenderCore;
  world: VoxelWorld;
  view: RenderView;
  camera: Camera;
}

function rig(radius: number, opts: { uploadsPerFrame?: number } = {}): Rig {
  const fake = createFakeDevice();
  const core = createRenderCore(fake.device as unknown as GPUDevice);
  const world = createVoxelWorld(core, {
    format,
    radius,
    minSectionY: -2,
    maxSectionY: 2,
    outside: STONE,
    uploadsPerFrame: opts.uploadsPerFrame,
    clock: () => clock.now,
  });
  // One ring past the radius, so every section in it has its 26 neighbours and meshes.
  const ring = radius + 1;
  for (let sz = -ring; sz <= ring; sz++)
    for (let sx = -ring; sx <= ring; sx++)
      for (let sy = -2; sy <= 2; sy++)
        world.putSection(sx, sy, sz, encodeRawSection(cellsOf(sx, sy, sz)));
  world.setInterest(0, 12, 0);
  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 1000);
  camera.lookAt([0, 30, -20], [0, 8, 10]);
  const view = setViewFromCamera(createRenderView(), camera);
  return { fake, core, world, view, camera };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function settle(r: Rig, eye: readonly number[] = [0, 30, -20]): Promise<number> {
  let frames = 0;
  while (!r.world.settled) {
    r.world.update(eye[0]!, eye[1]!, eye[2]!);
    frame(r);
    clock.now += 16;
    await tick();
    if (++frames > 5000) throw new Error('the world never settled');
  }
  clock.now += 2000; // past every search throttle
  r.world.update(eye[0]!, eye[1]!, eye[2]!);
  return frames;
}

const target = (fake: FakeDevice) => {
  const tex = fake.device.createTexture({
    size: [640, 360],
    format: 'bgra8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return {
    view: tex.createView(),
    format: 'bgra8unorm' as GPUTextureFormat,
    width: 640,
    height: 360,
    clear: { r: 0, g: 0, b: 0, a: 1 },
  };
};

function frame(r: Rig, t = target(r.fake)): number {
  const before = r.fake.calls;
  const enc = r.fake.device.createCommandEncoder();
  r.core.prepare(enc, [r.view]);
  r.core.draw(enc, 0, t);
  r.fake.device.queue.submit([enc.finish()]);
  return r.fake.calls - before;
}

/** The heap spaces optimized code lands in: a reading that grew them caught the JIT compiling. */
const CODE_SPACES = new Set([
  'code_space',
  'code_large_object_space',
  'trusted_space',
  'trusted_large_object_space',
]);

function codeBytes(): number {
  let n = 0;
  for (const s of v8.getHeapSpaceStatistics())
    if (CODE_SPACES.has(s.space_name)) n += s.space_used_size;
  return n;
}

/**
 * Bytes allocated while `run` runs, retried until no collection ran and no code was compiled
 * during it: under load the optimizing compiler can still be installing code (and allocating
 * its own bookkeeping) long after warm-up, which is not the frame allocating.
 */
function allocated(run: () => void): number {
  for (let attempt = 0; attempt < 40; attempt++) {
    const p = new v8.GCProfiler();
    p.start();
    v8.getHeapStatistics();
    const c = codeBytes();
    const a = v8.getHeapStatistics().used_heap_size;
    run();
    const b = v8.getHeapStatistics().used_heap_size;
    const compiled = codeBytes() !== c;
    if (p.stop().statistics.length === 0 && !compiled) return b - a;
  }
  throw new Error('a collection or a compile ran during every attempt');
}

/**
 * Bytes 9,000 calls of `run` allocate beyond 1,000 calls (each the least of three readings): the
 * reading's own fixed cost cancels, so anything allocated per call shows as 8,000 × its size.
 */
function leastGrowth(run: (frames: number) => void): number {
  const least = (frames: number) => {
    let bytes = Infinity;
    for (let k = 0; k < 3; k++)
      bytes = Math.min(
        bytes,
        allocated(() => run(frames)),
      );
    return bytes;
  };
  const short = least(1000);
  return least(9000) - short;
}

describe('createVoxelWorld (ws/voxel-draw)', () => {
  it('meshes, uploads into three GPU-culled sets within the per-frame budget', async () => {
    const r = rig(2, { uploadsPerFrame: 4 });
    let most = 0;
    while (!r.world.settled) {
      r.world.update(0, 30, -20);
      most = Math.max(most, r.world.stats.uploads);
      frame(r);
      await tick();
    }
    expect(most).toBeLessThanOrEqual(4);
    const st = r.world.stats;
    expect(st.sections).toBe(7 * 7 * 5);
    expect(st.uploadsTotal).toBeGreaterThanOrEqual(5 * 5 * 3);
    expect(st.opaqueQuads).toBeGreaterThan(0);
    expect(st.liquidQuads).toBeGreaterThan(0);
    expect(st.foliageQuads).toBeGreaterThan(0);
    expect(r.world.sets.opaque.count).toBeGreaterThan(0);
    expect(r.world.sets.liquid.count).toBeGreaterThan(0);
    expect(r.world.sets.foliage.count).toBeGreaterThan(0);
    expect(r.fake.errors).toEqual([]);
    // Cave culling: the deep rock rows are out of sight from above the ground.
    expect(r.world.visibility.active).toBe(true);
    expect(st.hidden).toBeGreaterThan(0);
    // Each set draws its slots from one recorded bundle after one cull dispatch.
    frame(r);
    expect(r.core.stats.dispatches).toBe(3);
    expect(r.core.stats.bundles).toBe(3);
  });

  it('nearest sections upload first', async () => {
    const r = rig(4, { uploadsPerFrame: 2 });
    const dist: number[] = [];
    const set = r.world.visibility.set.bind(r.world.visibility);
    r.world.visibility.set = (x, y, z, bits, open, dark) => {
      dist.push(Math.hypot(x, y - 1, z));
      set(x, y, z, bits, open, dark);
    };
    await settle(r, [0, 12, 0]);
    expect(dist.length).toBeGreaterThanOrEqual(9 * 9 * 5);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(dist.slice(0, 20))).toBeLessThan(2.5);
    expect(mean(dist.slice(0, 20))).toBeLessThan(mean(dist.slice(-20)));
  });

  it('a held frame costs the same GPU calls at radius 4 and 8 and allocates nothing', async () => {
    const rigs = new Map<number, Rig>();
    for (const radius of [4, 8]) {
      const r = rig(radius);
      await settle(r);
      frame(r);
      rigs.set(radius, r);
    }
    expectProportional(
      (radius) => {
        const r = rigs.get(radius)!;
        r.world.update(0, 30, -20);
        return frame(r);
      },
      [4, 8],
      { shape: 'flat', label: 'GPU calls per held frame' },
    );
    const r = rigs.get(8)!;
    const t = target(r.fake);
    const noop = () => {};
    const pass = {
      setPipeline: noop,
      setBindGroup: noop,
      setVertexBuffer: noop,
      setIndexBuffer: noop,
      drawIndexed: noop,
      drawIndexedIndirect: noop,
      dispatchWorkgroups: noop,
      executeBundles: noop,
      end: noop,
    };
    const enc = {
      beginComputePass: () => pass,
      beginRenderPass: () => pass,
    } as unknown as GPUCommandEncoder;
    (r.fake.device.queue as unknown as { writeBuffer: unknown }).writeBuffer = noop;
    const views = [r.view];
    const run = (n: number) => {
      for (let i = 0; i < n; i++) {
        r.world.update(0, 30, -20);
        r.core.prepare(enc, views);
        r.core.draw(enc, 0, t);
      }
    };
    run(10_000);
    // A reading has a fixed cost of its own (the heap-statistics objects, a stray compile: 0 to
    // a few kB under load), so compare a short run with a long one as core.test does: the fixed
    // cost cancels and whatever a frame allocates (16 bytes at least) is multiplied by the
    // 8,000 extra frames.
    expect(leastGrowth(run)).toBeLessThan(8000);
  });

  it('edits mesh again and drops free the geometry', async () => {
    const r = rig(2);
    await settle(r);
    const key = sectionKey(0, 1, 0);
    const quads = r.world.stats.opaqueQuads;
    const bytes = r.world.stats.vertexBytes;
    // Dig a 4×4×4 hole at the top of section (0, 1, 0).
    const changes: number[] = [];
    for (let y = 0; y < 4; y++)
      for (let z = 2; z < 6; z++)
        for (let x = 2; x < 6; x++) changes.push(sectionIndex(S, x, y, z), AIR);
    expect(r.world.edit(key, changes)).toContain(key);
    await settle(r);
    expect(r.world.stats.opaqueQuads).not.toBe(quads);
    const drawn = r.world.stats.drawn;
    r.world.dropSection(0, 1, 0);
    expect(r.world.stats.drawn).toBeLessThanOrEqual(drawn);
    r.world.update(0, 30, -20);
    expect(r.world.stats.sections).toBe(7 * 7 * 5 - 1);
    expect(r.world.stats.vertexBytes).toBeLessThan(bytes + 1e6);
    const hit = createVoxelHit();
    expect(r.world.raycast(12.5, 23, 12.5, 0, -1, 0, 40, hit)).toBe(RAY_HIT);
    expect(hit.y).toBeLessThan(13);
    r.world.dispose();
  });

  it('drops a box of sections and their geometry', async () => {
    const r = rig(2);
    await settle(r);
    const bytes = r.world.stats.vertexBytes;
    // The x ≥ 2 side: 2 columns of 7 × 5.
    expect(r.world.dropBox(2, -2, -3, 3, 2, 3)).toBe(2 * 7 * 5);
    expect(r.world.store.has(sectionKey(2, 0, 0))).toBe(false);
    r.world.update(0, 30, -20);
    expect(r.world.stats.sections).toBe(7 * 7 * 5 - 2 * 7 * 5);
    expect(r.world.stats.vertexBytes).toBeLessThan(bytes);
    expect(r.world.dropBox(2, -2, -3, 3, 2, 3)).toBe(0);
    r.world.dispose();
  });
});

describe('SectionVisibility (ws/voxel-draw)', () => {
  /** A column of sections: solid rock everywhere except where `open` says. */
  function cave(eyeOpen: boolean) {
    const vis = new SectionVisibility({ sectionSize: 16, solidAt: () => false, clock: () => 0 });
    vis.setArea({ minX: -4, maxX: 4, minY: -4, maxY: 4, minZ: -4, maxZ: 4 });
    for (let y = -6; y <= 6; y++)
      for (let z = -6; z <= 6; z++)
        for (let x = -6; x <= 6; x++) {
          if (y >= 1)
            vis.set(x, y, z, 0x7fff, 4096, false); // open sky
          else vis.set(x, y, z, 0, 0, true); // solid rock
        }
    // A sealed cave pocket deep below, open inside but connecting no faces it could be seen by.
    vis.set(0, -3, 0, 0, 200, true);
    if (eyeOpen) vis.set(0, 0, 0, 0x7fff, 4096, false);
    return vis;
  }

  it('hides sections under solid ground from an eye in the open', () => {
    const vis = cave(false);
    vis.update(8, 40, 8, 0);
    expect(vis.active).toBe(true);
    expect(vis.reached(0, 2, 0)).toBe(true);
    expect(vis.reached(0, 1, 0)).toBe(true);
    // The first rock row is seen (its top faces border the open air) but nothing past it.
    expect(vis.reached(0, -1, 0)).toBe(false);
    expect(vis.reached(0, -3, 0)).toBe(false);
  });

  it('stands aside while inactive and when disabled', () => {
    const vis = cave(false);
    expect(vis.reached(0, -3, 0)).toBe(true);
    vis.update(8, 40, 8, 0);
    vis.enabled = false;
    vis.update(8, 40, 8, 0);
    expect(vis.reached(0, -3, 0)).toBe(true);
  });

  it('a held eye searches once and allocates nothing', () => {
    const vis = cave(true);
    vis.update(8, 40, 8, 0);
    const n = vis.stats.searches;
    for (let i = 0; i < 20000; i++) vis.update(8, 40, 8, i);
    const growth = leastGrowth((frames) => {
      for (let i = 0; i < frames; i++) vis.update(8, 40, 8, i);
    });
    expect(vis.stats.searches).toBe(n);
    expect(growth).toBeLessThan(8000);
  });
});

describe('createVoxelWorld mesh options (ws/forge-asks-fit)', () => {
  it('sends its meshOptions with every job, and pool.setMeshOptions changes them', () => {
    const sent: { type: string; options?: unknown }[] = [];
    const port = {
      post: (m: { type: string; options?: unknown }) => sent.push(m),
      onResult: () => {},
      terminate: () => {},
    };
    const fake = createFakeDevice();
    const core = createRenderCore(fake.device as unknown as GPUDevice);
    const world = createVoxelWorld(core, {
      format,
      workers: [port],
      minSectionY: 0,
      maxSectionY: 0,
      radius: 1,
      meshOptions: { crossLod: 2, partsCap: 64, partsOrder: 'after' },
      clock: () => clock.now,
    });
    for (let sz = -2; sz <= 2; sz++)
      for (let sx = -2; sx <= 2; sx++)
        world.putSection(sx, 0, sz, encodeRawSection(cellsOf(sx, 0, sz)));
    world.setInterest(0, 4, 0);
    clock.now += 2000;
    world.update(0, 4, 0);
    const jobs = sent.filter((m) => m.type === 'mesh');
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0]!.options).toEqual({ crossLod: 2, partsCap: 64, partsOrder: 'after' });
    world.pool.setMeshOptions({ tieredPadding: true });
    world.pool.enqueue(sectionKey(5, 0, 5), 0);
    // A section that is not loaded builds no job; one that is gets the new options.
    world.pool.enqueue(sectionKey(0, 0, 0), 0);
    sent.length = 0;
    world.pool.pump();
    expect(
      sent.every(
        (m) => m.type !== 'mesh' || (m.options as { tieredPadding?: boolean }).tieredPadding,
      ),
    ).toBe(true);
    world.dispose();
  });
});

describe('voxel world casters (ws/forge-asks-fit)', () => {
  it('every stream’s caster, warmed before any shadow is drawn, reaches only its groups', () => {
    for (const materials of [
      undefined,
      {
        foliage: { shadowFragmentEntry: 'fs' },
        liquid: { castShadow: true },
      },
    ]) {
      const fake = createFakeDevice();
      const made = recordPipelines(fake);
      const core = createRenderCore(fake.device as unknown as GPUDevice);
      const world = createVoxelWorld(core, { format, workers: [], materials, radius: 1 });
      const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 1000);
      const view = setViewFromCamera(createRenderView(), camera);
      const r = { fake, core, world, view, camera } as unknown as Rig;
      frame(r);
      const casters = made.filter((p) => p.shadow).length;
      expect(casters).toBe(materials ? 3 : 1);
      expect(pipelineGroupErrors(made)).toEqual([]);
      expect(fake.errors).toEqual([]);
      world.dispose();
    }
  });
});

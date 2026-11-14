/**
 * ws/core-retained: the retained render core on the fake GPU. Arenas allocate and coalesce,
 * layouts express packed vertices, the pass list keeps its order, and a frame of a held scene
 * costs the same GPU calls at 1,500 and 6,000 meshes and allocates nothing.
 */
import v8 from 'node:v8';
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera';
import {
  createFakeDevice,
  type FakeBuffer,
  type FakeBundle,
  type FakeDevice,
  type FakePass,
} from '../fake-gpu';
import { Arena } from './arena';
import { createRenderCore, MULTI_DRAW_FEATURE, type RenderCore } from './core';
import { ARGS_WORDS, cullSlotsCpu } from './cull';
import type { DrawSet, DrawSetDesc } from './draw-set';
import { createInstanceLayout, createVertexLayout } from './layout';
import { PassList } from './pass-list';
import { createRenderView, type RenderView, setViewFromCamera } from './view';

const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});
const PLACE = createInstanceLayout({
  stride: 16,
  attributes: [{ name: 'place', format: 'float32x4', offset: 0 }],
});
const SHADER = {
  code: '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(in.place); }\n@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }',
};

/** The 24 packed vertices of a unit box (6 quads), corner bits in the low word. */
function boxVertices(): Uint32Array {
  const out = new Uint32Array(48);
  for (let i = 0; i < 24; i++) out[i * 2] = i;
  return out;
}

interface Scene {
  fake: FakeDevice;
  core: RenderCore;
  set: DrawSet;
  view: RenderView;
  camera: Camera;
}

/** A grid of `n` boxes in one static set (one slot each, shared quad index), seen from above. */
function scene(
  n: number,
  opts: { features?: string[]; cull?: DrawSetDesc['cull']; kind?: DrawSetDesc['kind'] } = {},
): Scene {
  const fake = createFakeDevice({}, opts.features ?? []);
  const device = fake.device as unknown as GPUDevice;
  const core = createRenderCore(device);
  const vertices = new Arena(device, { kind: 'vertex', blockBytes: 1 << 20 });
  const instances = new Arena(device, { kind: 'instance', blockBytes: 1 << 20 });
  const set = core.createDrawSet({
    label: 'boxes',
    shader: SHADER,
    vertexLayout: PACKED,
    instanceLayout: PLACE,
    vertices,
    instances,
    capacity: 8192,
    kind: opts.kind ?? 'static',
    cull: opts.cull ?? 'gpu',
  });
  const box = vertices.alloc(24 * 8, 8);
  vertices.write(box, boxVertices());
  const side = Math.ceil(Math.sqrt(n));
  const place = new Float32Array(4);
  for (let i = 0; i < n; i++) {
    const x = (i % side) * 4;
    const z = Math.floor(i / side) * 4;
    const inst = instances.alloc(16, 16);
    place.set([x, 0, z, 1]);
    instances.write(inst, place);
    set.add({ vertices: box, indexCount: 36, instances: inst, bounds: [x, 0, z, 1.8] });
  }
  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 1000);
  camera.lookAt([side * 2, 60, side * 2 - 30], [side * 2, 0, side * 2]);
  const view = setViewFromCamera(createRenderView(), camera);
  return { fake, core, set, view, camera };
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

/** One frame on the fake device; returns the GPU calls it made. */
function frame(s: Scene, t = target(s.fake)): number {
  const before = s.fake.calls;
  const enc = s.fake.device.createCommandEncoder();
  s.core.prepare(enc, [s.view]);
  s.core.draw(enc, 0, t);
  s.fake.device.queue.submit([enc.finish()]);
  return s.fake.calls - before;
}

/** Run the fake GPU's compute passes through the cull's CPU twin. */
function cullOnSubmit(s: Scene): void {
  s.fake.runPass = (pass: FakePass) => {
    if (pass.kind !== 'compute') return;
    let group: { entries: GPUBindGroupEntry[] } | null = null;
    for (const c of pass.commands) {
      if (c.op === 'setBindGroup') group = c.group as { entries: GPUBindGroupEntry[] };
      if (c.op !== 'dispatch' || !group) continue;
      const buf = (i: number) =>
        (group!.entries[i]!.resource as unknown as { buffer: FakeBuffer }).buffer;
      const params = new Uint32Array(buf(1).data.buffer, 0, 4);
      const slots = buf(2).data.buffer;
      // The cull binds the groups' half of the view buffer, at an offset.
      const at = (group.entries[0]!.resource as unknown as { offset?: number }).offset ?? 0;
      const views = new Float32Array(buf(0).data.buffer, at);
      cullSlotsCpu(
        new Float32Array(slots),
        new Uint32Array(slots),
        params[0]!,
        params[1]!,
        views,
        params[2]!,
        params[3] !== 0,
        new Uint32Array(buf(3).data.buffer),
      );
    }
  };
}

/** Bytes allocated while `run` runs (retried until no collection ran during it). */
function allocated(run: () => void): number {
  for (let attempt = 0; attempt < 8; attempt++) {
    const p = new v8.GCProfiler();
    p.start();
    v8.getHeapStatistics();
    const a = v8.getHeapStatistics().used_heap_size;
    run();
    const b = v8.getHeapStatistics().used_heap_size;
    if (p.stop().statistics.length === 0) return b - a;
  }
  throw new Error('a collection ran during every attempt');
}

describe('arena (ws/core-retained)', () => {
  const make = (blockBytes = 1024) => {
    const fake = createFakeDevice();
    return {
      fake,
      arena: new Arena(fake.device as unknown as GPUDevice, { kind: 'vertex', blockBytes }),
    };
  };

  it('allocates aligned ranges first fit, frees and coalesces', () => {
    const { arena } = make();
    const a = arena.alloc(10);
    expect(a).toEqual({ block: 0, offset: 0, size: 12 });
    const b = arena.alloc(16, 8);
    expect(b.offset).toBe(16);
    expect(arena.freeRanges(0)).toEqual([
      [12, 4],
      [32, 992],
    ]);
    const c = arena.alloc(4);
    expect(c.offset).toBe(12);
    arena.free(b);
    arena.free(a);
    arena.free(c);
    expect(arena.freeRanges(0)).toEqual([[0, 1024]]);
    expect(arena.usedBytes).toBe(0);
  });

  it('opens a block when none has room, a block of its own when too large, and trims', () => {
    const { arena, fake } = make();
    const a = arena.alloc(800);
    const b = arena.alloc(800);
    expect(b.block).toBe(1);
    const big = arena.alloc(4096);
    expect(big.block).toBe(2);
    expect(arena.buffers).toHaveLength(3);
    expect(fake.buffers.filter((x) => x.label?.includes('vertex arena'))).toHaveLength(3);
    const v = arena.version;
    arena.free(big);
    arena.free(b);
    // The empty middle block stays while `a` fills more than three quarters of the first.
    expect(arena.trim()).toBe(1);
    expect(arena.version).toBe(v + 1);
    expect(arena.buffers).toHaveLength(2);
    arena.free(a);
    expect(arena.trim()).toBe(1);
    expect(arena.buffers).toHaveLength(1);
    expect(arena.trim()).toBe(0);
  });

  it('a stride-aligned allocation is a base vertex', () => {
    const { arena } = make();
    arena.alloc(4);
    const v = arena.alloc(24 * 8, 8);
    expect(v.offset % 8).toBe(0);
  });
});

describe('layouts and the pass list (ws/core-retained)', () => {
  it('an 8-byte packed vertex and a float instance give locations and WGSL fields', () => {
    expect(PACKED.buffer(0)).toEqual({
      arrayStride: 8,
      stepMode: 'vertex',
      attributes: [{ format: 'uint32x2', offset: 0, shaderLocation: 0 }],
    });
    expect(PLACE.buffer(1).stepMode).toBe('instance');
    expect(PLACE.wgslFields(1)).toBe('@location(1) place: vec4f,');
    expect(() =>
      createVertexLayout({ stride: 8, attributes: [{ name: 'p', format: 'uint32x2', offset: 4 }] }),
    ).toThrow(/past stride/);
    expect(() =>
      createVertexLayout({ stride: 6, attributes: [{ name: 'p', format: 'uint16', offset: 0 }] }),
    ).toThrow();
  });

  it('passes keep the declared order; passes after the same one keep definition order', () => {
    const list = new PassList();
    list.define({ id: 'a', after: 'opaque' });
    list.define({ id: 'b', after: 'opaque' });
    list.define({ id: 'end' });
    expect(list.order).toEqual([
      'depthPre',
      'opaque',
      'a',
      'b',
      'cutout',
      'transparent',
      'overlay',
      'end',
    ]);
    expect(() => list.define({ id: 'a' })).toThrow(/already/);
    expect(() => list.define({ id: 'x', after: 'nope' })).toThrow(/no pass/);
  });
});

describe('render core (ws/core-retained)', () => {
  it('a held static GPU-culled scene costs the same calls at 1,500 and 6,000 meshes', () => {
    const counts = [1500, 6000].map((n) => {
      const s = scene(n);
      frame(s); // first frame: the bundle is recorded
      const calls = frame(s);
      expect(s.fake.errors).toEqual([]);
      expect(s.core.stats.bundles).toBe(1);
      expect(s.core.stats.dispatches).toBe(1);
      expect(s.core.stats.slotBytes).toBe(0);
      return { calls, coreCalls: s.core.stats.calls, built: s.core.stats.bundleBuilds };
    });
    // writeBuffer (views), compute pass (begin, pipeline, group, dispatch, end), render pass
    // (begin, executeBundles, end), submit.
    expect(counts[0]!.calls).toBe(10);
    expect(counts[1]!.calls).toBe(counts[0]!.calls);
    expect(counts[1]!.coreCalls).toBe(counts[0]!.coreCalls);
    expect(counts.map((c) => c.built)).toEqual([1, 1]);
  });

  it('the bundle draws each slot indirectly with its instances bound at their offset', () => {
    const s = scene(4);
    frame(s);
    const bundle = s.fake.bundles[0] as FakeBundle;
    const ops = bundle.commands.map((c) => (c.op === 'other' ? c.name : c.op));
    expect(ops.filter((o) => o === 'drawIndexedIndirect')).toHaveLength(4);
    expect(ops.slice(0, 4)).toEqual([
      'setPipeline',
      'setBindGroup',
      'setVertexBuffer',
      'setIndexBuffer',
    ]);
    const inst = bundle.commands.filter((c) => c.op === 'other' && c.slot === 1);
    expect(inst.map((c) => (c.op === 'other' ? [c.offset, c.size] : null))).toEqual([
      [0, 16],
      [16, 16],
      [32, 16],
      [48, 16],
    ]);
    expect(bundle.desc.depthStencilFormat).toBe('depth24plus');
    expect(s.core.depth).not.toBeNull();
  });

  it('the GPU cull writes zero instances for slots outside the view', () => {
    const s = scene(64);
    cullOnSubmit(s);
    // Half the grid behind a camera looking away.
    s.camera.lookAt([16, 2, 16], [16, 2, 100]);
    setViewFromCamera(s.view, s.camera);
    frame(s);
    const args = s.fake.buffers.find((b) => b.label === 'boxes args')!;
    const u = new Uint32Array(args.data.buffer);
    let visible = 0;
    for (let i = 0; i < 64; i++) {
      expect(u[i * ARGS_WORDS]).toBe(36);
      if (u[i * ARGS_WORDS + 1]) visible++;
    }
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThan(64);
  });

  it('only changed slots upload; moving bounds does not rebuild the bundle', () => {
    const s = scene(100);
    frame(s);
    frame(s);
    s.set.setBounds(10, 0, 0, 0, 2);
    s.set.setBounds(12, 0, 0, 0, 2);
    frame(s);
    expect(s.core.stats.slotBytes).toBe(3 * 48);
    expect(s.core.stats.bundleBuilds).toBe(1);
    s.set.remove(50);
    frame(s);
    expect(s.core.stats.bundleBuilds).toBe(2);
    expect(s.set.count).toBe(99);
  });

  it('with multi-draw and first-instance the set draws in one multiDrawIndexedIndirect', () => {
    const s = scene(500, { features: [MULTI_DRAW_FEATURE, 'indirect-first-instance'] });
    expect(s.core.caps).toEqual({ multiDraw: true, firstInstance: true });
    frame(s);
    const pass = s.fake.passes.at(-1)!;
    const multi = pass.commands.filter((c) => c.op === 'multiDrawIndexedIndirect');
    expect(multi).toHaveLength(1);
    expect(multi[0]!.op === 'multiDrawIndexedIndirect' && multi[0]!.maxDrawCount).toBe(500);
    expect(s.fake.bundles).toHaveLength(0);
    expect(s.fake.errors).toEqual([]);
  });

  it('a CPU-culled set draws only the visible slots, directly', () => {
    const s = scene(64, { cull: 'cpu' });
    s.camera.lookAt([16, 2, 16], [16, 2, 100]);
    setViewFromCamera(s.view, s.camera);
    frame(s);
    const draws = s.fake.passes.at(-1)!.commands.filter((c) => c.op === 'drawIndexed');
    expect(draws.length).toBeGreaterThan(0);
    expect(draws.length).toBeLessThan(64);
    expect(s.core.stats.dispatches).toBe(0);
    expect(s.fake.passes.some((p) => p.kind === 'compute')).toBe(false);
  });

  it('passes and depth come from use: an empty core clears and makes no depth', () => {
    const fake = createFakeDevice();
    const core = createRenderCore(fake.device as unknown as GPUDevice);
    const enc = fake.device.createCommandEncoder();
    core.prepare(enc, [createRenderView()]);
    core.draw(enc, 0, target(fake));
    expect(fake.passes).toHaveLength(1);
    expect(core.depth).toBeNull();
    expect(fake.textures.some((t) => t.label === 'core depth')).toBe(false);
  });

  it('a frame of a held scene allocates nothing', () => {
    const s = scene(1500);
    const t = target(s.fake);
    frame(s, t);
    frame(s, t);
    // A pass and encoder that keep nothing (the fake GPU records, which allocates).
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
    const queue = s.fake.device.queue as unknown as { writeBuffer: unknown };
    queue.writeBuffer = noop;
    const views = [s.view];
    const run = (n: number) => {
      for (let i = 0; i < n; i++) {
        s.core.prepare(enc, views);
        s.core.draw(enc, 0, t);
      }
    };
    run(20_000); // warm: optimized code, no first-call allocations
    // The least of a few measurements of 2,000 frames: a heap-statistics reading itself costs a
    // few hundred bytes, and a stray compile now and then more.
    let bytes = Infinity;
    for (let r = 0; r < 5; r++)
      bytes = Math.min(
        bytes,
        allocated(() => run(2000)),
      );
    expect(bytes).toBeLessThan(1024);
  });
});

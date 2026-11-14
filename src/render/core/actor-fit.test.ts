/**
 * ws/actor-fit: what a game's actor drawing asks of the core's draw sets, on the fake GPU. An
 * external set leaves hidden slots out of its bundle (no empty indirect draw), slots take the
 * caller's ids and argument offsets, and unindexed sets draw `draw` / `drawIndirect`, with or
 * without a vertex buffer.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera';
import { createFakeDevice, type FakeDevice, type PassCommand } from '../fake-gpu';
import { Arena } from './arena';
import { type CoreTarget, createRenderCore, type RenderCore } from './core';
import { ARGS_BYTES, DRAW_ARGS_BYTES } from './cull';
import type { DrawSet, DrawSetDesc } from './draw-set';
import { createVertexLayout } from './layout';
import { createRenderView, type RenderView, setViewFromCamera } from './view';

const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});
const NONE = createVertexLayout({ stride: 4, attributes: [] });
const CODE =
  '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(0.0); }\n' +
  '@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }';

interface World {
  fake: FakeDevice;
  core: RenderCore;
  vertices: Arena;
  view: RenderView;
  args: GPUBuffer;
  target: CoreTarget;
  modules: string[];
}

function world(): World {
  const fake = createFakeDevice();
  const device = fake.device as unknown as GPUDevice;
  const modules: string[] = [];
  const make = fake.device.createShaderModule.bind(fake.device);
  (fake.device as unknown as { createShaderModule: unknown }).createShaderModule = (
    d: GPUShaderModuleDescriptor,
  ) => {
    modules.push(d.code);
    return make(d);
  };
  const core = createRenderCore(device);
  const vertices = new Arena(device, { kind: 'vertex', blockBytes: 1 << 16 });
  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 1000);
  camera.lookAt([0, 10, -20], [0, 0, 0]);
  const view = setViewFromCamera(createRenderView(), camera);
  const args = device.createBuffer({
    size: 4096,
    usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE,
  });
  const tex = fake.device.createTexture({
    size: [64, 64],
    format: 'bgra8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const target: CoreTarget = {
    view: tex.createView(),
    format: 'bgra8unorm',
    width: 64,
    height: 64,
    clear: { r: 0, g: 0, b: 0, a: 1 },
  };
  return { fake, core, vertices, view, args, target, modules };
}

function frame(w: World): void {
  const enc = w.fake.device.createCommandEncoder() as unknown as GPUCommandEncoder;
  w.core.prepare(enc, [w.view]);
  w.core.draw(enc, 0, w.target);
  w.fake.device.queue.submit([(enc as unknown as { finish(): never }).finish()]);
}

/** The draw commands of the last bundle recorded, else of the frame's render passes. */
function draws(w: World, from: 'bundle' | 'pass' = 'bundle'): PassCommand[] {
  const list =
    from === 'bundle'
      ? (w.fake.bundles.at(-1)?.commands ?? [])
      : w.fake.passes.filter((p) => p.kind === 'render').flatMap((p) => p.commands);
  return list.filter((c) => c.op.startsWith('draw'));
}

function external(w: World, desc: Partial<DrawSetDesc> = {}): DrawSet {
  return w.core.createDrawSet({
    label: 'ext',
    shader: { code: CODE },
    vertexLayout: PACKED,
    vertices: w.vertices,
    capacity: 8,
    cull: 'external',
    args: w.args,
    ...desc,
  });
}

describe('external sets leave hidden slots out (ws/actor-fit)', () => {
  it('a hidden slot issues no indirect draw, and showing it re-records the bundle', () => {
    const w = world();
    const set = external(w);
    const v = w.vertices.alloc(64, 8);
    for (let i = 0; i < 3; i++) set.add({ vertices: v, indexCount: 6, bounds: [0, 0, 0, 1] });
    frame(w);
    expect(draws(w).map((c) => (c as { offset: number }).offset)).toEqual([0, 20, 40]);
    const builds = w.core.stats.bundleBuilds;
    set.setHidden(1, true);
    frame(w);
    expect(w.core.stats.bundleBuilds).toBe(builds + 1);
    expect(draws(w).map((c) => (c as { offset: number }).offset)).toEqual([0, 40]);
    set.setHidden(1, false);
    frame(w);
    expect(draws(w)).toHaveLength(3);
  });

  it("a GPU-culled set still records its hidden slots (the cull zeroes them), and 'none' skips direct draws of nothing", () => {
    const w = world();
    const gpu = w.core.createDrawSet({
      label: 'gpu',
      shader: { code: CODE },
      vertexLayout: PACKED,
      vertices: w.vertices,
      capacity: 8,
      cull: 'gpu',
    });
    const v = w.vertices.alloc(64, 8);
    gpu.add({ vertices: v, indexCount: 6, bounds: [0, 0, 0, 1] });
    gpu.add({ vertices: v, indexCount: 6, bounds: [0, 0, 0, 1] });
    gpu.setHidden(0, true);
    frame(w);
    expect(draws(w)).toHaveLength(2);

    const w2 = world();
    const none = w2.core.createDrawSet({
      label: 'none',
      shader: { code: CODE },
      vertexLayout: PACKED,
      vertices: w2.vertices,
      capacity: 8,
      cull: 'none',
    });
    const v2 = w2.vertices.alloc(64, 8);
    none.add({ vertices: v2, indexCount: 6, bounds: [0, 0, 0, 1] });
    none.add({ vertices: v2, indexCount: 0, bounds: [0, 0, 0, 1] });
    none.add({ vertices: v2, indexCount: 6, instanceCount: 0, bounds: [0, 0, 0, 1] });
    frame(w2);
    expect(draws(w2)).toHaveLength(1);
  });
});

describe("the caller's slot layout (ws/actor-fit)", () => {
  it('addAt takes the given id; the ids skipped go to add, lowest first', () => {
    const w = world();
    const set = external(w);
    const v = w.vertices.alloc(64, 8);
    const slot = { vertices: v, indexCount: 6, bounds: [0, 0, 0, 1] };
    expect(set.addAt(3, slot)).toBe(3);
    expect(set.highWater).toBe(4);
    expect(() => set.addAt(3, slot)).toThrow(/taken/);
    expect(() => set.addAt(8, slot)).toThrow(/capacity/);
    expect(set.add(slot)).toBe(0);
    expect(set.addAt(2, slot)).toBe(2);
    expect(set.add(slot)).toBe(1);
    expect(set.add(slot)).toBe(4);
    expect(set.count).toBe(5);
    set.remove(2);
    expect(set.addAt(2, slot)).toBe(2);
  });

  it('argsOffset and argsStride place each slot’s record in the caller’s buffer', () => {
    const w = world();
    const set = external(w, { argsStride: 1024 });
    const v = w.vertices.alloc(64, 8);
    set.add({ vertices: v, indexCount: 6, bounds: [0, 0, 0, 1], argsOffset: 16 });
    set.add({ vertices: v, indexCount: 6, bounds: [0, 0, 0, 1] });
    frame(w);
    expect(draws(w).map((c) => (c as { offset: number }).offset)).toEqual([16, ARGS_BYTES]);
    // Cull group 1 (a second view) reads `argsStride` further on.
    const enc = w.fake.device.createCommandEncoder() as unknown as GPUCommandEncoder;
    const view2 = createRenderView();
    view2.position.set([0, 50, 0]);
    w.core.prepare(enc, [w.view, view2]);
    w.core.draw(enc, 1, w.target);
    const offsets = w.fake.bundles
      .flatMap((b) => b.commands)
      .filter((c) => c.op === 'drawIndexedIndirect')
      .map((c) => (c as { offset: number }).offset);
    expect(offsets).toContain(1024 + 16);
    expect(() =>
      set.add({ vertices: v, indexCount: 6, bounds: [0, 0, 0, 1], argsOffset: 6 }),
    ).toThrow(/argsOffset/);
    expect(() => external(w, { cull: 'cpu', args: undefined, argsStride: 64 })).toThrow(
      /argsStride/,
    );
  });
});

describe('unindexed sets (ws/actor-fit)', () => {
  it('draw from the vertex arena with no index buffer, directly or indirect', () => {
    const w = world();
    const set = w.core.createDrawSet({
      label: 'icons',
      shader: { code: CODE },
      vertexLayout: PACKED,
      vertices: w.vertices,
      capacity: 300,
      indexed: false,
    });
    expect(set.cull).toBe('cpu');
    w.vertices.alloc(64, 8);
    const v = w.vertices.alloc(48, 8);
    set.add({ vertices: v, indexCount: 6, instanceCount: 3, bounds: [0, 0, 0, 1e9] });
    frame(w);
    const cmds = w.fake.passes.filter((p) => p.kind === 'render').flatMap((p) => p.commands);
    expect(cmds.some((c) => c.op === 'other' && c.name === 'setIndexBuffer')).toBe(false);
    expect(draws(w, 'pass')).toEqual([
      { op: 'draw', vertices: 6, instances: 3, firstInstance: 0, firstVertex: 8 },
    ]);

    const ext = external(w, { label: 'shadows', indexed: false, vertexLayout: NONE });
    ext.add({ indexCount: 6, bounds: [0, 0, 0, 1], argsOffset: 0 });
    ext.add({ indexCount: 6, bounds: [0, 0, 0, 1] });
    frame(w);
    const bundle = w.fake.bundles.at(-1)!.commands;
    expect(bundle.filter((c) => c.op === 'drawIndirect').map((c) => (c as { offset: number }).offset)).toEqual([
      0,
      DRAW_ARGS_BYTES,
    ]);
    expect(bundle.some((c) => c.op === 'other' && c.name === 'setVertexBuffer')).toBe(false);
    // With no fields, VertexIn holds the vertex index.
    expect(w.modules.some((m) => m.includes('@builtin(vertex_index) core_vertex: u32'))).toBe(true);
    const pipe = bundle.find((c) => c.op === 'setPipeline') as {
      pipeline: { desc: GPURenderPipelineDescriptor };
    };
    expect(pipe.pipeline.desc.vertex.buffers).toEqual([]);
    expect(w.fake.errors).toEqual([]);
  });

  it('refuse a GPU cull, an index arena and slots without vertices when the layout has fields', () => {
    const w = world();
    const base = {
      shader: { code: CODE },
      vertexLayout: PACKED,
      vertices: w.vertices,
      capacity: 8,
      indexed: false,
    };
    expect(() => w.core.createDrawSet({ ...base, cull: 'gpu' })).toThrow(/unindexed/);
    const indices = new Arena(w.fake.device as unknown as GPUDevice, {
      kind: 'index',
      blockBytes: 1024,
    });
    expect(() => w.core.createDrawSet({ ...base, indices })).toThrow(/unindexed/);
    const set = w.core.createDrawSet(base);
    expect(() => set.add({ indexCount: 6, bounds: [0, 0, 0, 1] })).toThrow(/needs vertices/);
  });
});

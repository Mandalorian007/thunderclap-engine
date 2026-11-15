/**
 * ws/warm-voxel-fit: pipeline warming (an empty first draw in a scratch pass of the right
 * formats, so WebKit compiles a pipeline at load and not at its first real draw) and a set's
 * cull-group mask, on the fake GPU.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera';
import { createFakeDevice, type FakeDevice, type FakePass } from '../fake-gpu';
import { FullscreenPass } from '../fullscreen';
import { Arena } from './arena';
import { type CoreTarget, createRenderCore, type RenderCore, type RenderCoreOptions } from './core';
import type { DrawSet, DrawSetDesc } from './draw-set';
import type { CoreDrawable, CoreDrawContext } from './drawable';
import { createVertexLayout } from './layout';
import { createRenderView, type RenderView, setViewFromCamera } from './view';
import { pipelineWarmer, warmPipeline } from './warm';

const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});
const CODE =
  '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(f32(in.packed.x)); }\n' +
  '@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }';

interface World {
  fake: FakeDevice;
  device: GPUDevice;
  core: RenderCore;
  vertices: Arena;
  box: ReturnType<Arena['alloc']>;
  view: RenderView;
  made: () => number;
}

function world(opts: RenderCoreOptions = {}): World {
  const fake = createFakeDevice();
  const device = fake.device as unknown as GPUDevice;
  let made = 0;
  const make = fake.device.createRenderPipeline.bind(fake.device);
  (fake.device as unknown as { createRenderPipeline: unknown }).createRenderPipeline = (
    d: GPURenderPipelineDescriptor,
  ) => {
    made++;
    return make(d);
  };
  const core = createRenderCore(device, opts);
  const vertices = new Arena(device, { kind: 'vertex', blockBytes: 1 << 16 });
  const box = vertices.alloc(24 * 8, 8);
  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 1000);
  camera.lookAt([0, 10, -20], [0, 0, 0]);
  const view = setViewFromCamera(createRenderView(), camera);
  return { fake, device, core, vertices, box, view, made: () => made };
}

function addSet(w: World, desc: Partial<DrawSetDesc> = {}, slots = 4): DrawSet {
  const set = w.core.createDrawSet({
    label: 'boxes',
    shader: { code: CODE },
    vertexLayout: PACKED,
    vertices: w.vertices,
    capacity: 16,
    cull: 'cpu',
    castShadow: false,
    ...desc,
  });
  for (let i = 0; i < slots; i++) {
    set.add({ vertices: w.box, indexCount: 36, bounds: [i * 2, 0, 0, 1] });
  }
  return set;
}

function target(w: World): CoreTarget {
  const tex = w.fake.device.createTexture({
    size: [64, 64],
    format: 'bgra8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return {
    view: tex.createView(),
    format: 'bgra8unorm',
    width: 64,
    height: 64,
    clear: { r: 0, g: 0, b: 0, a: 1 },
  };
}

function frame(w: World, t: CoreTarget, views: RenderView[] = [w.view], index = 0): void {
  const enc = w.fake.device.createCommandEncoder();
  w.core.prepare(enc, views);
  w.core.draw(enc, index, t);
  w.fake.device.queue.submit([enc.finish()]);
}

const formatsOf = (p: FakePass) => {
  const d = p.desc as GPURenderPassDescriptor;
  return {
    color: [...d.colorAttachments].map((a) =>
      a ? (a.view as unknown as { texture: { format: string } }).texture.format : null,
    ),
    depth: (
      d.depthStencilAttachment?.view as unknown as { texture: { format: string } } | undefined
    )?.texture.format,
  };
};
const ops = (p: FakePass) => p.commands.map((c) => c.op);
const drawsOf = (passes: FakePass[]) =>
  passes.flatMap((p) => p.commands).filter((c) => c.op !== 'other' && c.op.startsWith('draw'));

describe('pipeline warming (ws/warm-voxel-fit)', () => {
  it('a disabled set gets an empty draw in a scratch pass; enabled, it draws with no new pipeline', () => {
    const w = world();
    const set = addSet(w, { enabled: false });
    const t = target(w);
    frame(w, t);
    expect(drawsOf(w.fake.passes)).toEqual([]);
    const warm = w.fake.warmPasses;
    expect(warm.length).toBe(1);
    expect(formatsOf(warm[0]!)).toEqual({ color: ['bgra8unorm'], depth: 'depth24plus' });
    const d = warm[0]!.desc as GPURenderPassDescriptor;
    expect([...d.colorAttachments][0]!.storeOp).toBe('discard');
    expect(d.depthStencilAttachment!.depthStoreOp).toBe('discard');
    expect(ops(warm[0]!)).toEqual([
      'setPipeline',
      'setBindGroup',
      'other', // setVertexBuffer (the scratch)
      'draw',
      'other', // end
    ]);
    expect(warm[0]!.commands.find((c) => c.op === 'draw')).toMatchObject({ vertices: 0 });
    expect(w.core.stats.warmed).toBe(1);
    const made = w.made();
    set.enabled = true;
    frame(w, t);
    expect(drawsOf(w.fake.passes).length).toBeGreaterThan(0);
    expect(w.made()).toBe(made);
    expect(warm.length).toBe(1);
    expect(w.fake.errors).toEqual([]);
  });

  it('nothing is warmed twice: a steady frame encodes no scratch pass', () => {
    const w = world();
    addSet(w, {}, 0);
    addSet(w, { enabled: false });
    const t = target(w);
    frame(w, t);
    const n = w.fake.warmPasses.length;
    const warmed = w.core.warmer.warmed;
    expect(warmed).toBe(2);
    for (let i = 0; i < 3; i++) frame(w, t);
    expect(w.fake.warmPasses.length).toBe(n);
    expect(w.core.warmer.warmed).toBe(warmed);
    expect(w.core.stats.warmed).toBe(0);
  });

  it('a drawing set is not warmed: its first draw compiles it', () => {
    const w = world();
    addSet(w);
    frame(w, target(w));
    expect(w.fake.warmPasses).toEqual([]);
  });

  it("a caster that draws no shadow is warmed depth-only in the shadow map's format", () => {
    const w = world({ shadowFormat: 'depth32float' });
    addSet(w, { castShadow: true });
    frame(w, target(w));
    const warm = w.fake.warmPasses;
    expect(warm.map(formatsOf)).toEqual([{ color: [], depth: 'depth32float' }]);
    expect(w.fake.errors).toEqual([]);
  });

  it('warm: false warms nothing', () => {
    const w = world({ warm: false });
    addSet(w, { enabled: false, castShadow: true });
    frame(w, target(w));
    expect(w.fake.warmPasses).toEqual([]);
  });

  it('RenderCore.warm queues a game pipeline, encoded by the next prepare', () => {
    const w = world();
    const module = w.device.createShaderModule({ code: CODE });
    const pipeline = w.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs', buffers: [PACKED.buffer(0)] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });
    w.core.warm(pipeline, { color: 'rgba8unorm', depth: 'depth32float', vertexBuffers: 1 });
    expect(w.core.warmer.pending).toBe(1);
    const enc = w.fake.device.createCommandEncoder();
    w.core.prepare(enc, [w.view]);
    expect(w.core.warmer.pending).toBe(0);
    const p = w.fake.warmPasses[0]!;
    expect(formatsOf(p)).toEqual({ color: ['rgba8unorm'], depth: 'depth32float' });
    expect(p.commands[0]).toMatchObject({ op: 'setPipeline', pipeline });
    w.core.warmer.enabled = false;
    warmPipeline(w.device, pipeline);
    expect(w.core.warmer.pending).toBe(0);
  });

  it('warms of the same formats share one scratch pass; other formats get their own', () => {
    const fake = createFakeDevice();
    const device = fake.device as unknown as GPUDevice;
    const warmer = pipelineWarmer(device);
    expect(pipelineWarmer(device)).toBe(warmer);
    const p = {} as GPURenderPipeline;
    warmer.warm(p, { color: 'rgba8unorm' });
    warmer.warm(p, { color: 'rgba16float' });
    warmer.warm(p, { color: 'rgba8unorm' });
    const enc = fake.device.createCommandEncoder();
    expect(warmer.encode(enc)).toBe(2 * 2 + 3 * 3);
    expect(fake.warmPasses.length).toBe(2);
    expect(fake.warmPasses[0]!.commands.filter((c) => c.op === 'draw').length).toBe(2);
    expect(warmer.encode(enc)).toBe(0);
    // The scratch targets are made once per format.
    warmer.warm(p, { color: 'rgba8unorm' });
    const textures = fake.textures.length;
    warmer.encode(enc);
    expect(fake.textures.length).toBe(textures);
  });

  it('an inactive drawable with a warm hook is warmed once per target, with its own context', () => {
    const w = world();
    const seen: CoreDrawContext[] = [];
    const d: { -readonly [K in keyof CoreDrawable]: CoreDrawable[K] } = {
      label: 'fx',
      pass: 'transparent',
      version: 0,
      active: false,
      record: () => 0,
      warm: (enc, ctx) => {
        seen.push(ctx);
        enc.draw(0);
        return 1;
      },
    };
    w.core.addDrawable(d);
    const t = target(w);
    frame(w, t);
    frame(w, t);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ color: 'bgra8unorm', group: 0 });
    d.active = true;
    frame(w, t);
    expect(seen.length).toBe(1);
  });

  it('a fullscreen pass warms itself and encodes the warm before its first pass', () => {
    const fake = createFakeDevice();
    const device = fake.device as unknown as GPUDevice;
    const sampler = device.createSampler();
    const view = device
      .createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING })
      .createView();
    const pass = new FullscreenPass(
      device,
      { label: 'blur', wgsl: '', targets: ['rgba16float'], textures: 1 },
      sampler,
      view,
    );
    expect(pipelineWarmer(device).pending).toBe(1);
    const enc = fake.device.createCommandEncoder();
    const out = device
      .createTexture({
        size: [4, 4],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
      .createView();
    pass.encode(enc, out);
    expect(fake.warmPasses.length).toBe(1);
    expect(formatsOf(fake.warmPasses[0]!).color).toEqual(['rgba16float']);
    expect(fake.passes.length).toBe(1);
    pass.encode(enc, out);
    expect(fake.warmPasses.length).toBe(1);
    expect(fake.errors).toEqual([]);
  });

  it('two colour attachments of one format get distinct scratch views', () => {
    const fake = createFakeDevice();
    const device = fake.device as unknown as GPUDevice;
    const w = pipelineWarmer(device);
    w.warm(device.createRenderPipeline({} as GPURenderPipelineDescriptor), {
      color: ['rgba16float', 'rgba16float'],
      depth: 'depth24plus',
    });
    w.encode(fake.device.createCommandEncoder() as unknown as GPUCommandEncoder);
    const d = fake.warmPasses[0]!.desc as GPURenderPassDescriptor;
    const [a, b] = [...d.colorAttachments].map((x) => x!.view);
    expect(formatsOf(fake.warmPasses[0]!).color).toEqual(['rgba16float', 'rgba16float']);
    expect(a).not.toBe(b);
  });

  it("a fullscreen pass's warm binds scratch views of each slot's dimension, never its unset ones", () => {
    const fake = createFakeDevice();
    const device = fake.device as unknown as GPUDevice;
    const view = device
      .createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING })
      .createView();
    const pass = new FullscreenPass(
      device,
      {
        label: 'grade',
        wgsl: '',
        targets: ['rgba8unorm'],
        textures: 2,
        viewDimension: ['2d', '3d'],
      },
      device.createSampler(),
      view,
    );
    const out = device
      .createTexture({
        size: [4, 4],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
      .createView();
    pass.encode(fake.device.createCommandEncoder(), out);
    const bind = fake.warmPasses[0]!.commands.find((c) => c.op === 'setBindGroup') as {
      group: { entries: GPUBindGroupEntry[] };
    };
    const labels = bind.group.entries
      .filter((e) => e.binding >= 2)
      .map((e) => (e.resource as unknown as { texture: { label: string } }).texture.label);
    expect(labels).toEqual(['warm sampled scratch color|2d', 'warm sampled scratch color|3d']);
    // The pass's own (cached) group is not made by the warm.
    expect(pass.bindings!.bindGroup).not.toBe(bind.group);
  });
});

describe('cull-group mask (ws/warm-voxel-fit)', () => {
  const second = () => {
    const v = createRenderView();
    v.position[0] = 5;
    return v;
  };

  it('a set draws only for the groups in its mask, and casts only there', () => {
    const w = world();
    addSet(w, { cullGroups: 0b10 });
    const t = target(w);
    const views = [w.view, second()];
    const before = w.fake.passes.length;
    frame(w, t, views, 0);
    expect(drawsOf(w.fake.passes.slice(before))).toEqual([]);
    const mid = w.fake.passes.length;
    const enc = w.fake.device.createCommandEncoder();
    w.core.draw(enc, 1, t);
    expect(drawsOf(w.fake.passes.slice(mid)).length).toBeGreaterThan(0);
  });

  it('the GPU cull covers the mask: params words 5 and 6, a dispatch per masked group', () => {
    const w = world();
    const set = addSet(w, { cull: 'gpu', cullGroups: 0b110 });
    const views = [w.view, second(), second(), second()];
    const enc = w.fake.device.createCommandEncoder();
    w.core.prepare(enc, views);
    const dispatch = w.fake.passes
      .filter((p) => p.kind === 'compute')
      .flatMap((p) => p.commands)
      .find((c) => c.op === 'dispatch') as { y: number } | undefined;
    expect(dispatch?.y).toBe(2);
    const params = (set as unknown as { params: Uint32Array }).params;
    expect(params[5]).toBe(0b110);
    expect(params[6]).toBe(1);
    set.cullGroups = 0;
    const enc2 = w.fake.device.createCommandEncoder();
    const n = w.fake.passes.length;
    w.core.prepare(enc2, views);
    const again = w.fake.passes
      .slice(n)
      .flatMap((p) => p.commands)
      .filter((c) => c.op === 'dispatch');
    expect(again).toEqual([]);
  });
  it('warmSets makes every set pipeline at load: the first world frame makes none (E27)', () => {
    for (const warm of [true, false]) {
      const w = world();
      // The warmer off: the pipelines are still made, nothing is queued.
      w.core.warmer.enabled = warm;
      let computes = 0;
      const makeCompute = w.fake.device.createComputePipeline.bind(w.fake.device);
      (w.fake.device as unknown as { createComputePipeline: unknown }).createComputePipeline = (
        d: GPUComputePipelineDescriptor,
      ) => {
        computes++;
        return makeCompute(d);
      };
      w.core.definePass({ id: 'parked', when: () => false });
      // Empty at load, as a world's sets are before its first chunk arrives.
      const sets = [
        addSet(w, { castShadow: true, cull: 'gpu' }, 0),
        addSet(w, { label: 'glass', pass: 'transparent' }, 0),
      ];
      const parked = addSet(w, { label: 'parked', pass: 'parked', castShadow: false }, 0);
      const queued = w.core.warmSets({ format: 'bgra8unorm', shadowFormat: 'depth32float' });
      const made = w.made();
      // A colour pipeline per set (the parked pass never runs) and the caster's depth-only one.
      expect(made).toBe(3);
      expect(computes).toBe(1);
      expect(queued).toBe(warm ? 3 : 0);
      expect(w.core.warmSets({ format: 'bgra8unorm' })).toBe(0);
      expect(w.made()).toBe(made);
      for (const s of [...sets, parked]) {
        for (let i = 0; i < 4; i++)
          s.add({ vertices: w.box, indexCount: 36, bounds: [i, 0, 0, 1] });
      }
      const t = target(w);
      const shadow = w.fake.device.createTexture({
        size: [64, 64],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const enc = w.fake.device.createCommandEncoder();
      w.core.prepare(enc, [w.view]);
      w.core.drawShadow(enc, 0, { view: shadow.createView(), format: 'depth32float', clear: true });
      w.core.draw(enc, 0, t);
      w.fake.device.queue.submit([enc.finish()]);
      expect(drawsOf(w.fake.passes).length).toBeGreaterThan(0);
      expect(w.made()).toBe(made);
      expect(computes).toBe(1);
      expect(w.fake.warmPasses.length).toBe(warm ? 2 : 0);
      expect(w.fake.errors).toEqual([]);
    }
  });

  it('warmSets warms the passes after a resolve in the output format, and flushes into encoder', () => {
    const w = world();
    w.core.definePass({ id: 'post', after: 'transparent', resolve: () => {} });
    w.core.definePass({ id: 'hud', after: 'post', depth: 'none' });
    addSet(w, { label: 'hud', pass: 'hud', depth: false }, 0);
    const enc = w.fake.device.createCommandEncoder();
    expect(w.core.warmSets({ format: 'rgba16float', outputFormat: 'bgra8unorm' }, enc)).toBe(1);
    expect(w.fake.warmPasses.map(formatsOf)).toEqual([{ color: ['bgra8unorm'], depth: undefined }]);
    expect(w.core.warmer.pending).toBe(0);
  });
});

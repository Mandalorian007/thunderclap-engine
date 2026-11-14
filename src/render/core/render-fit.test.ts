/**
 * ws/render-fit: what a voxel game's renderer asks of the core, on the fake GPU. Passes clear
 * depth to their own value (reversed-Z), sets have pipeline variants per view and per pass (a
 * forward eye, a depth prepass), a max draw distance and an enabled switch, share shader modules
 * and keep their pipelines across `setBindGroups`, and passes are timed by id, `prepare` too.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera';
import { createFakeDevice, type FakeBuffer, type FakeDevice, type FakePass } from '../fake-gpu';
import { Arena } from './arena';
import { type CoreTarget, createRenderCore, type RenderCore, type RenderCoreOptions } from './core';
import { ARGS_WORDS, cullSlotsCpu, sphereBeyond } from './cull';
import type { DrawSet, DrawSetDesc } from './draw-set';
import type { CoreDrawContext } from './drawable';
import { createVertexLayout } from './layout';
import { coreDepthCompare, coreDepthFar } from './pass-list';
import { createRenderView, type RenderView, setViewFromCamera, VIEW_SLOT_FLOATS } from './view';

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
  camera: Camera;
  modules: string[];
  /** Per render pass begun: its label and depth attachment as they were then. */
  begun: { label?: string; load?: GPULoadOp; clear?: number; ts?: unknown }[];
}

function world(opts: RenderCoreOptions = {}): World {
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
  const core = createRenderCore(device, opts);
  const vertices = new Arena(device, { kind: 'vertex', blockBytes: 1 << 16 });
  const box = vertices.alloc(24 * 8, 8);
  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 1000);
  camera.lookAt([0, 10, -20], [0, 0, 0]);
  const view = setViewFromCamera(createRenderView(), camera);
  return { fake, device, core, vertices, box, view, camera, modules, begun: [] };
}

function addSet(w: World, desc: Partial<DrawSetDesc> = {}, slots = 4): DrawSet {
  const set = w.core.createDrawSet({
    label: 'boxes',
    shader: { code: CODE },
    vertexLayout: PACKED,
    vertices: w.vertices,
    capacity: 16,
    cull: 'gpu',
    ...desc,
  });
  for (let i = 0; i < slots; i++) {
    set.add({ vertices: w.box, indexCount: 36, bounds: [i * 10, 0, 0, 1] });
  }
  return set;
}

function target(w: World, extra: Partial<CoreTarget> = {}): CoreTarget {
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
    ...extra,
  };
}

/** One frame; records each render pass's label and depth load as it began. */
function frame(w: World, t: CoreTarget, prepareTs?: Parameters<RenderCore['prepare']>[2]): void {
  const enc = w.fake.device.createCommandEncoder();
  const begin = enc.beginRenderPass.bind(enc);
  (enc as unknown as { beginRenderPass: unknown }).beginRenderPass = (
    d: GPURenderPassDescriptor,
  ) => {
    const ds = d.depthStencilAttachment;
    // The warmer's scratch passes (ws/warm-voxel-fit) are not the frame's.
    if (d.label !== 'warm')
      w.begun.push({
        label: d.label,
        load: ds?.depthLoadOp,
        clear: ds?.depthClearValue,
        ts: d.timestampWrites,
      });
    return begin(d);
  };
  w.core.prepare(enc as unknown as GPUCommandEncoder, [w.view], prepareTs);
  w.core.draw(enc as unknown as GPUCommandEncoder, 0, t);
  w.fake.device.queue.submit([enc.finish()]);
}

/** The pipelines a frame's passes and bundles set, in order. */
function pipelinesUsed(w: World): GPURenderPipelineDescriptor[] {
  const out: GPURenderPipelineDescriptor[] = [];
  const take = (cmds: { op: string; pipeline?: unknown }[]) => {
    for (const c of cmds) {
      if (c.op === 'setPipeline') {
        out.push((c.pipeline as { desc: GPURenderPipelineDescriptor }).desc);
      }
    }
  };
  for (const p of w.fake.passes) if (p.kind === 'render') take(p.commands as never);
  for (const b of w.fake.bundles) take(b.commands as never);
  return out;
}

/** Run the fake GPU's compute passes through the cull's CPU twin, with the max distance. */
function cullOnSubmit(w: World): void {
  w.fake.runPass = (pass: FakePass) => {
    if (pass.kind !== 'compute') return;
    let group: { entries: GPUBindGroupEntry[] } | null = null;
    for (const c of pass.commands) {
      if (c.op === 'setBindGroup') group = c.group as { entries: GPUBindGroupEntry[] };
      if (c.op !== 'dispatch' || !group) continue;
      const buf = (i: number) =>
        (group!.entries[i]!.resource as unknown as { buffer: FakeBuffer }).buffer;
      const params = new Uint32Array(buf(1).data.buffer, 0, 8);
      const dist = new Float32Array(buf(1).data.buffer, 0, 8)[4]!;
      const slots = buf(2).data.buffer;
      const at = (group.entries[0]!.resource as unknown as { offset?: number }).offset ?? 0;
      cullSlotsCpu(
        new Float32Array(slots),
        new Uint32Array(slots),
        params[0]!,
        params[1]!,
        new Float32Array(buf(0).data.buffer, at),
        params[2]!,
        params[3] !== 0,
        new Uint32Array(buf(3).data.buffer),
        dist,
      );
    }
  };
}

describe('depth clear per pass (ws/render-fit)', () => {
  it('defaults: depth clears to 1 and sets test less', () => {
    const w = world();
    addSet(w);
    frame(w, target(w));
    expect(w.begun[0]).toMatchObject({ load: 'clear', clear: 1 });
    expect(pipelinesUsed(w)[0]!.depthStencil!.depthCompare).toBe('less');
  });

  it('a reversed-Z core clears to 0 and tests greater; a set may still say otherwise', () => {
    const w = world({ reversedZ: true });
    addSet(w);
    addSet(w, { label: 'equal', shader: { code: CODE, depthCompare: 'greater-equal' } });
    frame(w, target(w));
    expect(w.begun[0]).toMatchObject({ load: 'clear', clear: 0 });
    const compares = pipelinesUsed(w).map((p) => p.depthStencil!.depthCompare);
    expect(compares).toEqual(['greater', 'greater-equal']);
    expect(w.core.passes.get('opaque')!.reversedZ).toBe(true);
  });

  it("a pass's own depthClear and reversedZ win over the core's", () => {
    const w = world({ reversedZ: true });
    w.core.passes.define({ id: 'terrain', after: 'depthPre', reversedZ: false, depthClear: 0.5 });
    addSet(w, { pass: 'terrain' });
    frame(w, target(w));
    expect(w.begun[0]).toMatchObject({ load: 'clear', clear: 0.5 });
    expect(pipelinesUsed(w)[0]!.depthStencil!.depthCompare).toBe('less');
  });

  it("clearDepth clears the caller's depth on the first depth pass instead of loading it", () => {
    const w = world({ reversedZ: true });
    addSet(w);
    addSet(w, { label: 'cut', pass: 'cutout' });
    const depth = w.fake.device
      .createTexture({
        size: [64, 64],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
      .createView();
    frame(w, target(w, { depth }));
    expect(w.begun.map((b) => b.load)).toEqual(['load', 'load']);
    w.begun.length = 0;
    frame(w, target(w, { depth, clearDepth: true }));
    expect(w.begun.map((b) => [b.load, b.clear])).toEqual([
      ['clear', 0],
      ['load', 0],
    ]);
  });
});

describe('pipeline variants (ws/render-fit)', () => {
  it("a view's variant draws the sets that have it; the others draw as usual", () => {
    const w = world();
    addSet(w, {
      label: 'terrain',
      variants: { forward: { fragmentEntry: 'fs_forward', writes: [] } },
    });
    addSet(w, { label: 'plain' });
    frame(w, target(w));
    frame(w, target(w, { variant: 'forward' }));
    const used = pipelinesUsed(w).map((p) => `${p.label}:${p.fragment!.entryPoint}`);
    // The plain set's bundle is the same in both views: recorded once.
    expect(used).toEqual(['terrain:fs', 'plain:fs', 'terrain:fs_forward']);
    // Both kept: the next frames draw from the caches.
    const builds = w.core.stats.bundleBuilds;
    frame(w, target(w));
    frame(w, target(w, { variant: 'forward' }));
    expect(w.core.stats.bundleBuilds).toBe(builds);
  });

  it('a depth-only variant joins the depth prepass: no colour written, same slots, one cull', () => {
    const w = world();
    const set = addSet(w, {
      variants: { depth: { depthOnly: true } },
      passes: [{ pass: 'depthPre', variant: 'depth' }],
    });
    expect(set.variantNames).toEqual(['depth']);
    frame(w, target(w));
    const used = pipelinesUsed(w);
    expect(used).toHaveLength(2);
    const pre = used[0]!;
    expect(pre.fragment!.entryPoint).toBe('core_depth_only');
    expect((pre.fragment!.targets as GPUColorTargetState[])[0]!.writeMask).toBe(0);
    expect((pre.fragment!.module as unknown as { code: string }).code).toContain(
      '@fragment fn core_depth_only() {}',
    );
    expect(pre.depthStencil!.depthWriteEnabled).toBe(true);
    expect(used[1]!.fragment!.entryPoint).toBe('fs');
    // Two render passes, one cull dispatch.
    expect(w.core.stats.passes).toBe(2);
    expect(w.core.stats.dispatches).toBe(1);
    expect(w.fake.errors).toEqual([]);
  });

  it('a join into a read pass does not write depth; a variant can bring its own code', () => {
    const w = world();
    addSet(w, {
      variants: { glass: { code: `${CODE}\n// glass`, blend: { color: {}, alpha: {} } } },
      passes: [{ pass: 'transparent', variant: 'glass', order: 5 }],
    });
    frame(w, target(w));
    const [main, glass] = pipelinesUsed(w);
    expect(main!.depthStencil!.depthWriteEnabled).toBe(true);
    expect(glass!.depthStencil!.depthWriteEnabled).toBe(false);
    expect((glass!.fragment!.targets as GPUColorTargetState[])[0]!.blend).toBeDefined();
    expect((glass!.vertex.module as unknown as { code: string }).code).toContain('// glass');
  });

  it('an unknown join variant throws', () => {
    const w = world();
    expect(() => addSet(w, { passes: [{ pass: 'depthPre', variant: 'nope' }] })).toThrow(
      /no variant nope/,
    );
  });
});

describe('max draw distance and enabled (ws/render-fit)', () => {
  it('the GPU cull drops slots farther than the max distance from the eye', () => {
    const w = world();
    cullOnSubmit(w);
    w.camera.lookAt([0, 0, -5], [0, 0, 100]);
    setViewFromCamera(w.view, w.camera);
    // Slots along the view axis, 10 apart.
    const set = w.core.createDrawSet({
      label: 'far',
      shader: { code: CODE },
      vertexLayout: PACKED,
      vertices: w.vertices,
      capacity: 16,
      cull: 'gpu',
      maxDistance: 26,
    });
    for (let i = 0; i < 6; i++)
      set.add({ vertices: w.box, indexCount: 36, bounds: [0, 0, i * 10, 1] });
    frame(w, target(w));
    const args = new Uint32Array(w.fake.buffers.find((b) => b.label === 'far args')!.data.buffer);
    const seen = (n: number) => [...Array(n).keys()].map((i) => args[i * ARGS_WORDS + 1]);
    // Eye at z -5: slots at 0, 10, 20 (edges 4, 14, 24 away) in; 30 (34) out.
    expect(seen(6)).toEqual([1, 1, 1, 0, 0, 0]);
    set.maxDistance = 0;
    frame(w, target(w));
    expect(seen(6)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('the CPU cull keeps the same limit', () => {
    const w = world();
    w.camera.lookAt([0, 0, -5], [0, 0, 100]);
    setViewFromCamera(w.view, w.camera);
    const set = w.core.createDrawSet({
      label: 'cpu',
      shader: { code: CODE },
      vertexLayout: PACKED,
      vertices: w.vertices,
      capacity: 16,
      cull: 'cpu',
      maxDistance: 26,
    });
    for (let i = 0; i < 6; i++)
      set.add({ vertices: w.box, indexCount: 36, bounds: [0, 0, i * 10, 1] });
    frame(w, target(w));
    const draws = () => w.fake.passes.at(-1)!.commands.filter((c) => c.op === 'drawIndexed');
    expect(draws()).toHaveLength(3);
    set.maxDistance = 100;
    frame(w, target(w));
    expect(draws()).toHaveLength(6);
  });

  it('the twin and the shader agree on the test', () => {
    const data = new Float32Array(VIEW_SLOT_FLOATS);
    data.set([0, 0, -5], 16);
    expect(sphereBeyond(data, 16, 0, 0, 30, 1, 26)).toBe(true);
    expect(sphereBeyond(data, 16, 0, 0, 20, 1, 26)).toBe(false);
  });

  it('a disabled set draws nothing, is not culled and casts no shadow; enabled again it draws', () => {
    const w = world();
    const set = addSet(w, { castShadow: true });
    set.enabled = false;
    expect(w.core.hasWork).toBe(false);
    expect(w.core.castsShadow).toBe(false);
    frame(w, target(w));
    expect(w.core.stats.dispatches).toBe(0);
    expect(pipelinesUsed(w)).toHaveLength(0);
    set.enabled = true;
    expect(w.core.hasWork).toBe(true);
    frame(w, target(w));
    expect(w.core.stats.dispatches).toBe(1);
    expect(pipelinesUsed(w)).toHaveLength(1);
  });

  it('enabled: false in the desc', () => {
    const w = world();
    const set = addSet(w, { enabled: false });
    expect(set.enabled).toBe(false);
    expect(w.core.hasWork).toBe(false);
  });
});

describe('shared shaders (ws/render-fit)', () => {
  it('sets with the same code share one module', () => {
    const w = world();
    const before = w.modules.length;
    addSet(w, { label: 'a' });
    addSet(w, { label: 'b', pass: 'cutout' });
    addSet(w, { label: 'c', shader: { code: `${CODE}\n// other` } });
    expect(w.modules.length - before).toBe(2);
  });

  it('setBindGroups with the same layouts keeps the pipelines; new layouts rebuild them', () => {
    const w = world();
    const layout = w.device.createBindGroupLayout({ entries: [] });
    const g1 = w.device.createBindGroup({ layout, entries: [] });
    const set = addSet(w, { bindGroups: [{ layout, group: g1 }] });
    let made = 0;
    const make = w.fake.device.createRenderPipeline.bind(w.fake.device);
    (w.fake.device as unknown as { createRenderPipeline: unknown }).createRenderPipeline = (
      d: GPURenderPipelineDescriptor,
    ) => {
      made++;
      return make(d);
    };
    // Pipelines the draws make, not the warmer's (it makes the caster's depth-only one ahead).
    w.core.warmer.enabled = false;
    frame(w, target(w));
    expect(made).toBe(1);
    const g2 = w.device.createBindGroup({ layout, entries: [] });
    set.setBindGroups([{ layout, group: g2 }]);
    const builds = w.core.stats.bundleBuilds;
    frame(w, target(w));
    expect(made).toBe(1);
    expect(w.core.stats.bundleBuilds).toBe(builds + 1);
    const other = w.device.createBindGroupLayout({ entries: [] });
    set.setBindGroups([
      { layout: other, group: w.device.createBindGroup({ layout: other, entries: [] }) },
    ]);
    frame(w, target(w));
    expect(made).toBe(2);
  });
});

describe('pass labels and timestamps (ws/render-fit)', () => {
  it('timestamps get each pass id, and prepare times its cull pass', () => {
    const w = world();
    addSet(w);
    addSet(w, { label: 'cut', pass: 'cutout' });
    const calls: string[] = [];
    const writes = { querySet: {} as GPUQuerySet };
    const ts = (label: string, pass?: string) => {
      calls.push(`${label}/${pass}`);
      return writes;
    };
    frame(w, target(w, { timestamps: ts }), ts);
    expect(calls).toEqual(['prepare/prepare', 'core/opaque', 'core/cutout']);
    const compute = w.fake.passes.find((p) => p.kind === 'compute')!;
    expect((compute.desc as GPUComputePassDescriptor).timestampWrites).toBe(writes);
    // Labels stay 'core pass' by default.
    expect(w.begun.map((b) => b.label)).toEqual(['core pass', 'core pass']);
  });

  it('passLabels names each render pass after its pass', () => {
    const w = world({ passLabels: true });
    addSet(w);
    addSet(w, { label: 'cut', pass: 'cutout' });
    frame(w, target(w));
    expect(w.begun.map((b) => b.label)).toEqual(['core opaque', 'core cutout']);
    expect(w.core.passes.get('opaque')!.label).toBe('core opaque');
  });
});

describe('the depth convention, for drawables and effects (ws/render-fit)', () => {
  it('drawables and pass encoders read reversedZ from their pass; the helpers turn it into tests', () => {
    const w = world({ reversedZ: true });
    w.core.passes.define({ id: 'plain', after: 'transparent', reversedZ: false });
    const seen: string[] = [];
    const drawable = (pass: string) => ({
      label: pass,
      pass,
      version: 0,
      active: true,
      record(_enc: unknown, ctx: CoreDrawContext) {
        seen.push(`${pass}:${ctx.reversedZ}:${coreDepthCompare(ctx.reversedZ)}`);
        return 0;
      },
    });
    w.core.addDrawable(drawable('transparent'));
    w.core.addDrawable(drawable('plain'));
    expect(w.core.reversedZ).toBe(true);
    frame(w, target(w));
    expect(seen).toEqual(['transparent:true:greater', 'plain:false:less']);
    expect(coreDepthCompare(true, true)).toBe('greater-equal');
    expect(coreDepthCompare(false, true)).toBe('less-equal');
    expect([coreDepthFar(true), coreDepthFar(false)]).toEqual([0, 1]);
  });
});

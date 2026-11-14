/**
 * ws/core-effects (B5): core drawables on the fake GPU. A drawable joins a pass with the sets,
 * prepares once a frame, records one bundle a cull group (both eyes of a pair execute it), is
 * left out when inactive or out of view, and reads the core's depth and a colour copy.
 */
import { describe, expect, it } from 'vitest';
import { mat4 } from '../../core/math';
import { Camera } from '../camera';
import { createFakeDevice, type FakeDevice, type FakePass } from '../fake-gpu';
import { type CoreTarget, createRenderCore, type RenderCore } from './core';
import {
  CORE_DRAWABLE_WGSL,
  type CoreDrawable,
  type CoreDrawableEncoder,
  type CoreDrawContext,
  CoreViewExtras,
  DrawablePipelines,
  VIEW_EXTRA_FLOATS,
} from './drawable';
import { createRenderView, type RenderView, setViewFromCamera } from './view';

const WGSL = `${CORE_DRAWABLE_WGSL}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return view.viewProj * vec4f(f32(i), 0.0, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }`;

class Probe implements CoreDrawable {
  version = 0;
  active = true;
  prepared = 0;
  records = 0;
  pass?: string;
  readsDepth?: boolean;
  readsColor?: boolean;
  encoding?: 'bundle' | 'direct';
  bounds: Float32Array | null = null;
  lastCtx: Partial<CoreDrawContext> = {};
  private readonly pipes: DrawablePipelines;

  constructor(
    device: GPUDevice,
    opts: Partial<Pick<Probe, 'pass' | 'readsDepth' | 'readsColor' | 'encoding'>> = {},
  ) {
    Object.assign(this, opts);
    const module = device.createShaderModule({ code: WGSL });
    this.pipes = new DrawablePipelines((color, depth, readOnly) =>
      device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: color }] },
        depthStencil: depth
          ? { format: depth, depthWriteEnabled: !readOnly, depthCompare: 'less-equal' }
          : undefined,
      }),
    );
  }

  prepare(): void {
    this.prepared++;
  }

  record(enc: CoreDrawableEncoder, ctx: CoreDrawContext): number {
    this.records++;
    this.lastCtx = { ...ctx };
    enc.setPipeline(this.pipes.get(ctx));
    enc.setBindGroup(0, ctx.viewGroup);
    enc.draw(6, 100);
    return 3;
  }
}

interface Rig {
  fake: FakeDevice;
  device: GPUDevice;
  core: RenderCore;
  left: RenderView;
  right: RenderView;
}

function rig(): Rig {
  const fake = createFakeDevice();
  const device = fake.device as unknown as GPUDevice;
  const core = createRenderCore(device);
  const cam = (x: number) => {
    const c = Camera.perspective(Math.PI / 3, 1, 0.1, 100);
    c.lookAt([x, 2, 10], [x, 0, 0]);
    return setViewFromCamera(createRenderView(), c);
  };
  return { fake, device, core, left: cam(-0.032), right: cam(0.032) };
}

function target(device: GPUDevice, usage = GPUTextureUsage.RENDER_ATTACHMENT): CoreTarget {
  const texture = device.createTexture({ size: [200, 100], format: 'rgba8unorm', usage });
  return { view: texture.createView(), texture, format: 'rgba8unorm', width: 200, height: 100 };
}

/** A stereo frame: both eyes one cull group, each into its half of `t`. */
function stereo(r: Rig, t: CoreTarget): void {
  const enc = r.device.createCommandEncoder();
  r.core.prepare(enc, [{ views: [r.left, r.right] }]);
  r.core.draw(enc, 0, { ...t, viewport: { x: 0, y: 0, width: 100, height: 100 } });
  r.core.draw(enc, 1, { ...t, viewport: { x: 100, y: 0, width: 100, height: 100 } });
  r.device.queue.submit([enc.finish()]);
}

const renders = (f: FakeDevice) => f.passes.filter((p) => p.kind === 'render');
const executed = (p: FakePass) => p.commands.find((c) => c.op === 'executeBundles');

describe('core drawables', () => {
  it('prepare once a frame; one bundle a cull group, executed by both eyes', () => {
    const r = rig();
    const d = new Probe(r.device);
    r.core.addDrawable(d);
    stereo(r, target(r.device));
    stereo(r, target(r.device));
    expect(r.fake.errors).toEqual([]);
    expect(d.prepared).toBe(2);
    expect(d.records).toBe(1);
    expect(r.core.stats.bundleBuilds).toBe(1);
    expect(r.core.stats.bundles).toBe(2);
    const [a, b] = renders(r.fake).slice(-2);
    expect(executed(a!)).toBeDefined();
    expect(executed(a!)).toEqual(executed(b!));
    // The transparent pass by default: depth attached; nothing wrote it before (ws/core-passes),
    // so the pass clears it rather than read uncleared depth, and it is not read-only.
    expect(d.lastCtx.depth).toBe('depth24plus');
    expect(d.lastCtx.depthReadOnly).toBe(false);
  });

  it('re-records when its version moves, and not otherwise', () => {
    const r = rig();
    const d = new Probe(r.device);
    r.core.addDrawable(d);
    const t = target(r.device);
    stereo(r, t);
    stereo(r, t);
    expect(d.records).toBe(1);
    d.version++;
    stereo(r, t);
    expect(d.records).toBe(2);
  });

  it('inactive, out of view or removed: no pass; adding twice adds once', () => {
    const r = rig();
    const d = new Probe(r.device);
    r.core.addDrawable(d);
    r.core.addDrawable(d);
    expect(r.core.coreDrawables).toEqual([d]);
    const t = target(r.device);
    stereo(r, t);
    expect(r.core.stats.passes).toBe(2);
    d.active = false;
    stereo(r, t);
    expect(r.core.stats.passes).toBe(0);
    d.active = true;
    d.bounds = new Float32Array([0, 0, 500, 1]); // behind both eyes
    stereo(r, t);
    expect(r.core.stats.passes).toBe(0);
    d.bounds = new Float32Array([0, 0, 0, 1]);
    stereo(r, t);
    expect(r.core.stats.passes).toBe(2);
    r.core.removeDrawable(d);
    stereo(r, t);
    expect(r.core.stats.passes).toBe(0);
    expect(d.prepared).toBe(4);
  });

  it('direct encoding records into the pass every view and counts its calls', () => {
    const r = rig();
    const d = new Probe(r.device, { encoding: 'direct' });
    r.core.addDrawable(d);
    stereo(r, target(r.device));
    expect(d.records).toBe(2);
    expect(r.core.stats.directDraws).toBe(2);
    expect(r.core.stats.bundleBuilds).toBe(0);
  });

  it('readsDepth: the depth attachment is sampleable, refused in a writing pass', () => {
    const r = rig();
    expect(() =>
      r.core.addDrawable(new Probe(r.device, { pass: 'opaque', readsDepth: true })),
    ).toThrow(/readsDepth/);
    const d = new Probe(r.device, { readsDepth: true });
    r.core.addDrawable(d);
    expect(r.core.sceneDepthView).toBeNull();
    stereo(r, target(r.device));
    expect(r.fake.errors).toEqual([]);
    expect(r.core.sceneDepthView).not.toBeNull();
    const depth = r.core.depth!;
    expect(depth.usage & GPUTextureUsage.TEXTURE_BINDING).toBeTruthy();
    const v = r.core.targetsVersion;
    stereo(r, target(r.device));
    expect(r.core.targetsVersion).toBe(v);
    expect(d.records).toBe(1);
    // A new size re-makes depth: the version moves and the bundle is re-recorded.
    const big = r.device.createTexture({
      size: [400, 200],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const enc = r.device.createCommandEncoder();
    r.core.prepare(enc, [{ views: [r.left, r.right] }]);
    r.core.draw(enc, 0, { view: big.createView(), format: 'rgba8unorm', width: 400, height: 200 });
    r.device.queue.submit([enc.finish()]);
    expect(r.core.targetsVersion).toBe(v + 1);
    expect(d.records).toBe(2);
  });

  it('readsColor: each eye copies its viewport of the target before the pass', () => {
    const r = rig();
    const d = new Probe(r.device, { readsColor: true });
    r.core.addDrawable(d);
    const t = target(r.device, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
    const passes = r.fake.passes.length;
    stereo(r, t);
    expect(r.fake.errors).toEqual([]);
    expect(r.core.sceneColorView).not.toBeNull();
    const copies = r.fake.textureCopies.slice(-2);
    expect(copies.map((c) => [c.src.label, c.dst.label, c.afterPasses - passes])).toEqual([
      [undefined, 'core scene colour', 0],
      [undefined, 'core scene colour', 1],
    ]);
    // Without a texture there is nothing to copy from: no copy, still drawn.
    const before = r.fake.textureCopies.length;
    stereo(r, { ...t, texture: undefined });
    expect(r.fake.textureCopies.length).toBe(before);
    expect(r.core.stats.passes).toBe(2);
  });

  it('CoreViewExtras: each view gets its inverse view-projection and axes, once a frame', () => {
    const r = rig();
    const extras = CoreViewExtras.of(r.core);
    expect(CoreViewExtras.of(r.core)).toBe(extras);
    const d = new Probe(r.device);
    d.prepare = () => {
      extras.update();
      extras.update();
    };
    r.core.addDrawable(d);
    const writes = r.fake.writes.length;
    stereo(r, target(r.device));
    const mine = r.fake.writes.slice(writes).filter((w) => w.buffer.label === 'core view extras');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.bytes).toBe(2 * VIEW_EXTRA_FLOATS * 4);
    const i = r.fake.writes.indexOf(mine[0]!);
    const data = r.fake.writeData[i]!.data as Float32Array;
    const product = new Float32Array(16);
    mat4.multiply(
      product,
      r.right.viewProj,
      data.subarray(VIEW_EXTRA_FLOATS, VIEW_EXTRA_FLOATS + 16),
    );
    for (let k = 0; k < 16; k++) expect(product[k]).toBeCloseTo(k % 5 === 0 ? 1 : 0, 3);
    // Looking down -z (slightly down): right is +x, forward mostly -z.
    expect(data[16]).toBeCloseTo(1, 3);
    expect(data[26]!).toBeLessThan(-0.9);
  });
});

/**
 * ws/core-decals (B6): decals on the render core (fake GPU). They join the core's transparent
 * pass, both eyes of a pair execute one bundle that holds while decals come and go, box decals
 * read the core's depth, the call count is flat in decal count, and the bounds cull them.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { type CoreTarget, createRenderCore, type RenderCore } from '../render/core/core';
import { createRenderView, type RenderView, setViewFromCamera } from '../render/core/view';
import { createFakeDevice, type FakeDevice } from '../render/fake-gpu';
import type { TextureLike } from '../render/texture';
import { createWorkMeter, expectProportional } from '../testing/budget';
import { type DecalDesc, Decals } from './decals';
import { DECAL_INSTANCE_FLOATS, DecalsOnCore, decalSphere } from './decals-core';
import { DECAL_CORE_BOX_WGSL, DECAL_CORE_QUAD_WGSL } from './decals-core-wgsl';
import { WGSL_DECAL_BOX } from './decals-wgsl';

interface Rig {
  fake: FakeDevice;
  device: GPUDevice;
  core: RenderCore;
  eyes: RenderView[];
  target: CoreTarget;
  atlas: TextureLike;
}

function rig(device?: GPUDevice): Rig {
  const fake = createFakeDevice();
  const dev = device ?? (fake.device as unknown as GPUDevice);
  const core = createRenderCore(dev);
  const eye = (x: number) => {
    const c = Camera.perspective(Math.PI / 3, 1, 0.1, 100);
    c.lookAt([x, 4, 10], [x, 0, 0]);
    return setViewFromCamera(createRenderView(), c);
  };
  const texture = dev.createTexture({
    size: [200, 100],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const target: CoreTarget = {
    view: texture.createView(),
    format: 'rgba8unorm',
    width: 200,
    height: 100,
  };
  const atlas: TextureLike = {
    view: dev
      .createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING })
      .createView(),
    width: 4,
    height: 4,
  };
  return { fake, device: dev, core, eyes: [eye(-0.032), eye(0.032)], target, atlas };
}

function stereo(r: Rig): void {
  const enc = r.device.createCommandEncoder();
  r.core.prepare(enc, [{ views: r.eyes }]);
  r.core.draw(enc, 0, { ...r.target, viewport: { x: 0, y: 0, width: 100, height: 100 } });
  r.core.draw(enc, 1, { ...r.target, viewport: { x: 100, y: 0, width: 100, height: 100 } });
  r.device.queue.submit([enc.finish()]);
}

const floor = (x: number, z: number, size = 1): DecalDesc => ({
  x,
  y: 0,
  z,
  nx: 0,
  ny: 1,
  nz: 0,
  size,
});

/** The decals' bundles: those whose commands draw from the decals' indirect args. */
function decalBundles(r: Rig) {
  return r.fake.bundles.filter((b) =>
    b.commands.some(
      (c) =>
        c.op === 'drawIndexedIndirect' &&
        (c.buffer as { label?: string }).label === 'decals-core-args',
    ),
  );
}

describe('decals on the render core', () => {
  it('join the transparent pass before the water; box reads depth, quad does not; destroy leaves', () => {
    const r = rig();
    const box = new Decals(r.core, { texture: r.atlas });
    const d = box.coreDrawable!;
    expect(d).toBeInstanceOf(DecalsOnCore);
    expect(d.pass).toBe('transparent');
    expect(d.order).toBe(-2);
    expect(d.readsDepth).toBe(true);
    expect(box.activeMode).toBe('box');
    const quad = new Decals(r.core, { texture: r.atlas, mode: 'quad' });
    expect(quad.coreDrawable!.readsDepth).toBe(false);
    expect(quad.activeMode).toBe('quad');
    expect(r.core.coreDrawables).toEqual([d, quad.coreDrawable]);
    quad.destroy();
    box.destroy();
    expect(r.core.coreDrawables).toEqual([]);
  });

  it('nothing live: no draw; then one bundle for both eyes, held while decals come and go', () => {
    const r = rig();
    const decals = new Decals(r.core, { texture: r.atlas, capacity: 8 });
    stereo(r);
    expect(decalBundles(r)).toHaveLength(0);
    const a = decals.add(floor(0, 0));
    stereo(r);
    expect(r.fake.errors).toEqual([]);
    expect(decalBundles(r)).toHaveLength(1);
    const renders = r.fake.passes.filter((p) => p.kind === 'render').slice(-2);
    const exec = renders.map((p) => p.commands.find((c) => c.op === 'executeBundles'));
    expect(exec[0]).toBeDefined();
    expect(exec[0]).toEqual(exec[1]);
    const builds = r.core.stats.bundleBuilds;
    for (let i = 0; i < 12; i++) {
      decals.add(floor(i % 4, 1 + (i >> 2)));
      if (i === 5) decals.remove(a);
      decals.update(1 / 60);
      stereo(r);
    }
    expect(r.core.stats.bundleBuilds).toBe(builds);
    expect(decalBundles(r)).toHaveLength(1);
    // The instance count lives in the indirect args: the last write is the live count.
    const args = r.fake.writes.filter((w) => w.buffer.label === 'decals-core-args').at(-1)!;
    const data = r.fake.writeData[r.fake.writes.indexOf(args)]!.data as Uint32Array;
    expect(data[0]).toBe(36);
    expect(data[1]).toBe(decals.count);
    expect(decals.count).toBe(8);
    expect(r.core.depth!.usage & GPUTextureUsage.TEXTURE_BINDING).toBeTruthy();
  });

  it('uploads instances only when they change', () => {
    const r = rig();
    const decals = new Decals(r.core, { texture: r.atlas });
    decals.add(floor(0, 0));
    const uploads = () => r.fake.writes.filter((w) => w.buffer.label === 'decals-core-instances');
    stereo(r);
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0]!.bytes).toBe(DECAL_INSTANCE_FLOATS * 4);
    decals.update(1 / 60); // an infinite lifetime: nothing to write
    stereo(r);
    expect(uploads()).toHaveLength(1);
    decals.add({ ...floor(1, 1), lifetime: 2 });
    stereo(r);
    decals.update(1 / 60); // a finite lifetime: its age fraction moves
    stereo(r);
    expect(uploads()).toHaveLength(3);
    expect(uploads()[2]!.bytes).toBe(2 * DECAL_INSTANCE_FLOATS * 4);
  });

  it('one sphere around every live decal culls them once per pair', () => {
    const r = rig();
    const decals = new Decals(r.core, { texture: r.atlas });
    decals.add(floor(-2, 0, 1));
    decals.add(floor(3, 1, 2));
    stereo(r);
    const b = decals.coreDrawable!.bounds;
    const s = new Float64Array(4);
    const data = decals.instanceData;
    for (let i = 0; i < 2; i++) {
      decalSphere(data, i * DECAL_INSTANCE_FLOATS, s);
      const reach = Math.hypot(s[0]! - b[0]!, s[1]! - b[1]!, s[2]! - b[2]!) + s[3]!;
      expect(reach).toBeLessThanOrEqual(b[3]! + 1e-5);
    }
    decalSphere(data, DECAL_INSTANCE_FLOATS, s);
    expect([s[0], s[1], s[2]]).toEqual([3, 0, 1]);
    expect(s[3]).toBeCloseTo(Math.sqrt(3), 5);
    // Behind both eyes: culled for the pair, no bundle executed.
    decals.clear();
    decals.add(floor(0, 60, 1));
    const before = r.fake.bundles.length;
    const passes = r.fake.passes.length;
    stereo(r);
    for (const p of r.fake.passes.slice(passes)) {
      const ex = p.commands.find((c) => c.op === 'executeBundles');
      const bundles = ex && ex.op === 'executeBundles' ? ex.bundles : [];
      expect(bundles.some((x) => x.label?.startsWith('decals'))).toBe(false);
    }
    expect(r.fake.bundles.length).toBe(before);
  });

  it('a new atlas re-binds without a new pipeline; restore re-makes and re-uploads', () => {
    const r = rig();
    const decals = new Decals(r.core, { texture: r.atlas });
    decals.add(floor(0, 0));
    stereo(r);
    const groups = r.fake.bindGroups.filter((g) => g.label === 'decals-core').length;
    decals.texture = { ...r.atlas };
    stereo(r);
    expect(r.fake.bindGroups.filter((g) => g.label === 'decals-core').length).toBe(groups + 1);
    const builds = r.core.stats.bundleBuilds;
    const uploads = r.fake.writes.filter((w) => w.buffer.label === 'decals-core-instances').length;
    decals.coreDrawable!.restore();
    stereo(r);
    expect(r.core.stats.bundleBuilds).toBe(builds + 1);
    expect(r.fake.writes.filter((w) => w.buffer.label === 'decals-core-instances').length).toBe(
      uploads + 1,
    );
    expect(r.fake.errors).toEqual([]);
  });

  it('the shaders read the core per view; the Renderer path keeps its own', () => {
    expect(DECAL_CORE_BOX_WGSL).toContain('extras[view.index].invViewProj');
    expect(DECAL_CORE_BOX_WGSL).toContain('rel + view.origin.xyz');
    expect(DECAL_CORE_BOX_WGSL).toContain('var scene_depth: texture_depth_2d');
    expect(DECAL_CORE_QUAD_WGSL).toContain('world - view.origin.xyz');
    expect(WGSL_DECAL_BOX).not.toContain('CoreView');
  });

  it('budget: GPU calls and commands per frame are flat in decal count, nothing allocated', () => {
    const calls = (n: number) => {
      const fake = createFakeDevice();
      const meter = createWorkMeter(fake.device as unknown as GPUDevice);
      const r = rig(meter.device);
      const decals = new Decals(r.core, { texture: r.atlas, capacity: 4096, lifetime: 30 });
      for (let i = 0; i < n; i++) decals.add(floor((i % 64) * 0.1 - 3.2, -(i >> 6) * 0.1, 0.2));
      const report = meter.run(
        () => {
          decals.update(1 / 60);
          stereo(r);
        },
        { frames: 4, warmup: 2 },
      );
      expect(report.allocs.typedArrays + report.allocs.arrayBuffers).toBe(0);
      expect(report.gpu.executeBundles).toBe(2);
      return report.gpu.draw + report.gpu.executeBundles + report.gpu.commands;
    };
    expectProportional(calls, [1, 100, 4000], { shape: 'flat', label: 'decal calls' });
  });
});

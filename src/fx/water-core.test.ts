/**
 * ws/core-effects (B5): water on the render core (fake GPU). The surface joins the core's
 * transparent pass, both eyes of a pair execute one bundle, it reads the core's depth, and with
 * refraction or reflection on it reads each eye's colour copy.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { type CoreTarget, createRenderCore, type RenderCore } from '../render/core/core';
import { createRenderView, type RenderView, setViewFromCamera } from '../render/core/view';
import { createFakeDevice, type FakeDevice } from '../render/fake-gpu';
import { createWorkMeter } from '../testing/budget';
import { Water } from './water';
import { WaterOnCore } from './water-core';
import { WATER_CORE_WGSL, WATER_WGSL } from './water-wgsl';

interface Rig {
  fake: FakeDevice;
  device: GPUDevice;
  core: RenderCore;
  eyes: RenderView[];
  target: CoreTarget;
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
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const target: CoreTarget = {
    view: texture.createView(),
    texture,
    format: 'rgba8unorm',
    width: 200,
    height: 100,
  };
  return { fake, device: dev, core, eyes: [eye(-0.032), eye(0.032)], target };
}

function stereo(r: Rig): void {
  const enc = r.device.createCommandEncoder();
  r.core.prepare(enc, [{ views: r.eyes }]);
  r.core.draw(enc, 0, { ...r.target, viewport: { x: 0, y: 0, width: 100, height: 100 } });
  r.core.draw(enc, 1, { ...r.target, viewport: { x: 100, y: 0, width: 100, height: 100 } });
  r.device.queue.submit([enc.finish()]);
}

describe('water on the render core', () => {
  it('joins the transparent pass reading depth and colour; destroy leaves', () => {
    const r = rig();
    const water = new Water(r.core, { size: 40 });
    const d = water.coreDrawable!;
    expect(d).toBeInstanceOf(WaterOnCore);
    expect(d.pass).toBe('transparent');
    expect(d.readsDepth).toBe(true);
    expect(d.readsColor).toBe(true);
    expect(r.core.coreDrawables).toEqual([d]);
    const flat = new Water(r.core, { refraction: 0, reflectionSteps: 0 });
    expect(flat.coreDrawable!.readsColor).toBe(false);
    flat.destroy();
    water.destroy();
    expect(r.core.coreDrawables).toEqual([]);
  });

  it('one bundle for both eyes; each eye copies its own colour before the pass', () => {
    const r = rig();
    const water = new Water(r.core, { size: 40 });
    const copies = r.fake.textureCopies.length;
    for (let f = 0; f < 3; f++) {
      water.update(1 / 60);
      stereo(r);
    }
    expect(r.fake.errors).toEqual([]);
    expect(r.core.stats.bundleBuilds).toBe(1);
    const renders = r.fake.passes
      .filter((p) => p.kind === 'render' && p.label !== 'core depth clear')
      .slice(-2);
    const exec = renders.map((p) => p.commands.find((c) => c.op === 'executeBundles'));
    expect(exec[0]).toBeDefined();
    expect(exec[0]).toEqual(exec[1]);
    expect(r.fake.textureCopies.length - copies).toBe(6);
    expect(r.core.depth!.usage & GPUTextureUsage.TEXTURE_BINDING).toBeTruthy();
  });

  it('live knobs pack into the core block without a re-record', () => {
    const r = rig();
    const water = new Water(r.core, { reflectionSteps: 24 });
    stereo(r);
    water.reflectionSteps = 0;
    water.sunColor.fill(0);
    stereo(r);
    expect(r.core.stats.bundleBuilds).toBe(1);
    const w = r.fake.writes.filter((x) => x.buffer.label === 'water-core').at(-1)!;
    const data = r.fake.writeData[r.fake.writes.indexOf(w)]!.data as Float32Array;
    expect(data[3]).toBe(0); // sun off
    expect(data[13]).toBe(0); // no reflection march
  });

  it('the shader reads the core per view and keeps the Renderer path unchanged', () => {
    expect(WATER_CORE_WGSL).toContain('extras[view.index].invViewProj');
    expect(WATER_CORE_WGSL).toContain('world - view.origin.xyz');
    expect(WATER_CORE_WGSL).toContain('var scene_color: texture_2d<f32>');
    expect(WATER_WGSL).not.toContain('scene_color');
  });

  it('a held frame allocates no typed arrays', () => {
    const fake = createFakeDevice();
    const meter = createWorkMeter(fake.device as unknown as GPUDevice);
    const r = rig(meter.device);
    const water = new Water(r.core, { size: 40 });
    const report = meter.run(
      () => {
        water.update(1 / 60);
        stereo(r);
      },
      { frames: 4, warmup: 2 },
    );
    expect(report.allocs.typedArrays + report.allocs.arrayBuffers).toBe(0);
    expect(report.gpu.executeBundles).toBe(2);
  });
});

describe('fx quality knobs', () => {
  it('water reflection sheds the march and brings each surface back', async () => {
    const { waterReflectionKnob } = await import('./water-core');
    const a = { reflectionSteps: 16 };
    const b = { reflectionSteps: 8 };
    const k = waterReflectionKnob([a, b]);
    expect(k.step(true)).toBe(true);
    expect([a.reflectionSteps, b.reflectionSteps]).toEqual([0, 0]);
    expect(k.step(true)).toBe(false);
    expect(k.step(false)).toBe(true);
    expect([a.reflectionSteps, b.reflectionSteps]).toEqual([16, 8]);
  });

  it('particle budget and weather density step between their limits', async () => {
    const { particleBudgetKnob } = await import('./particles-core');
    const { weatherDensityKnob } = await import('./weather');
    const ps = [{ spawnScale: 1 }, { spawnScale: 0.5 }];
    const k = particleBudgetKnob(ps, { min: 0.5 });
    expect(k.step(true)).toBe(true);
    expect(ps.map((p) => p.spawnScale)).toEqual([0.75, 0.375]);
    expect(k.step(true)).toBe(true);
    expect(k.step(true)).toBe(false);
    expect(k.step(false) && k.step(false)).toBe(true);
    expect(ps.map((p) => p.spawnScale)).toEqual([1, 0.5]);
    const w = { density: 1 };
    const d = weatherDensityKnob(w);
    for (let i = 0; i < 5; i++) d.step(true);
    expect(w.density).toBe(0.25);
  });
});

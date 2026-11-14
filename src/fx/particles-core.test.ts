/**
 * ws/core-effects (B5): world particles on the render core (fake GPU). The system joins the
 * core as a drawable: its compute runs in `core.prepare`, both eyes of a pair execute one
 * bundle, and the draw calls stay flat however many particles are alive.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { type CoreTarget, createRenderCore, type RenderCore } from '../render/core/core';
import { createRenderView, type RenderView, setViewFromCamera } from '../render/core/view';
import { createFakeDevice, type FakeDevice } from '../render/fake-gpu';
import { createWorkMeter, expectProportional } from '../testing/budget';
import { ParticleSystem } from './particles';
import { ParticlesOnCore } from './particles-core';
import { PARTICLE_CORE_RENDER_WGSL } from './particles-wgsl';

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
    c.lookAt([x, 2, 10], [x, 0, 0]);
    return setViewFromCamera(createRenderView(), c);
  };
  const texture = dev.createTexture({
    size: [200, 100],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
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

const burst = { x: 0, y: 1, z: 0, speed: [1, 2] as [number, number], colorStart: [1, 0.6, 0.2, 1] };

describe('particles on the render core', () => {
  it('joins the core as a world-space drawable; 2D space is refused', () => {
    const r = rig();
    const ps = new ParticleSystem(r.core, { capacity: 1024 });
    expect(ps.space).toBe('world');
    expect(ps.coreDrawable).toBeInstanceOf(ParticlesOnCore);
    expect(r.core.coreDrawables).toEqual([ps.coreDrawable]);
    expect(() => new ParticleSystem(r.core, { space: '2d' })).toThrow(/2D/);
    ps.destroy();
    expect(r.core.coreDrawables).toEqual([]);
  });

  it('simulates in prepare; both eyes execute one bundle drawing the whole ring', () => {
    const r = rig();
    const ps = new ParticleSystem(r.core, { capacity: 2048, softness: 0.5 });
    for (let f = 0; f < 3; f++) {
      ps.emit(burst, 100);
      ps.update(1 / 60);
      stereo(r);
    }
    expect(r.fake.errors).toEqual([]);
    const computes = r.fake.passes.filter((p) => p.kind === 'compute');
    expect(computes.length).toBeGreaterThanOrEqual(3);
    expect(r.core.stats.bundleBuilds).toBe(1);
    const renders = r.fake.passes
      .filter((p) => p.kind === 'render' && p.label !== 'core depth clear')
      .slice(-2);
    const exec = renders.map((p) => p.commands.find((c) => c.op === 'executeBundles'));
    expect(exec[0]).toBeDefined();
    expect(exec[0]).toEqual(exec[1]);
    // Soft particles read the core's depth: the attachment is sampleable.
    expect(r.core.depth!.usage & GPUTextureUsage.TEXTURE_BINDING).toBeTruthy();
  });

  it('the shader faces each eye from its own view extras and culls by the eye planes', () => {
    expect(PARTICLE_CORE_RENDER_WGSL).toContain('extras[view.index]');
    expect(PARTICLE_CORE_RENDER_WGSL).toContain('view.planes[k]');
    expect(PARTICLE_CORE_RENDER_WGSL).toContain('p.pos.xyz - view.origin.xyz');
  });

  it('budget: draw calls and commands per frame are flat in the particle count', () => {
    const calls = (n: number) => {
      const fake = createFakeDevice();
      const meter = createWorkMeter(fake.device as unknown as GPUDevice);
      const r = rig(meter.device);
      const ps = new ParticleSystem(r.core, { capacity: 65536, maxSpawnsPerFrame: 4 });
      const report = meter.run(
        () => {
          ps.emit(burst, n);
          ps.update(1 / 60);
          stereo(r);
        },
        { frames: 4, warmup: 2 },
      );
      expect(report.allocs.typedArrays + report.allocs.arrayBuffers).toBe(0);
      return report.gpu.draw + report.gpu.executeBundles + report.gpu.commands;
    };
    expectProportional(calls, [10, 1000, 30000], { shape: 'flat', label: 'particle calls' });
  });
});

/**
 * ws/core-effects (B5): weather on the render core (fake GPU). Rain, snow and a dust storm are
 * configs of one drawable; counts follow intensity and density through the indirect args, so
 * the bundle both eyes execute is recorded once.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { type CoreTarget, createRenderCore, type RenderCore } from '../render/core/core';
import { createRenderView, type RenderView, setViewFromCamera } from '../render/core/view';
import { createFakeDevice, type FakeDevice } from '../render/fake-gpu';
import { createWorkMeter } from '../testing/budget';
import { WEATHER_DUST_STORM, WEATHER_RAIN, WEATHER_SNOW, Weather } from './weather';
import { WEATHER_HEAD_FLOATS, WEATHER_LAYER_FLOATS, WEATHER_WGSL } from './weather-wgsl';

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
  const target = {
    view: texture.createView(),
    texture,
    format: 'rgba8unorm' as const,
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

/** The last weather uniform written. */
function uniform(f: FakeDevice): Float32Array {
  for (let i = f.writes.length - 1; i >= 0; i--) {
    if (f.writes[i]!.buffer.label === 'weather') return f.writeData[i]!.data as Float32Array;
  }
  throw new Error('no weather write');
}

/** The last indirect args written. */
function args(f: FakeDevice): Uint32Array {
  for (let i = f.writes.length - 1; i >= 0; i--) {
    if (f.writes[i]!.buffer.label === 'weather args') return f.writeData[i]!.data as Uint32Array;
  }
  throw new Error('no args write');
}

describe('weather on the render core', () => {
  it('rain: one indirect draw, one bundle executed by both eyes', () => {
    const r = rig();
    const w = new Weather(r.core, WEATHER_RAIN);
    stereo(r);
    w.update(0.5);
    stereo(r);
    expect(r.fake.errors).toEqual([]);
    expect(w.active).toBe(true);
    expect(w.instances).toBe(6000);
    expect(Array.from(args(r.fake))).toEqual([6, 6000, 0, 0]);
    expect(r.core.stats.bundleBuilds).toBe(1);
    expect(r.core.stats.bundles).toBe(2);
    const u = uniform(r.fake);
    // Anchored on view 0's eye; time moved.
    expect(u[0]).toBeCloseTo(-0.032, 5);
    expect(u[2]).toBeCloseTo(10, 5);
    expect(u[3]).toBeCloseTo(0.5, 5);
  });

  it('two configs: a dust storm and snow swap layers, wind and counts; the bundle stays', () => {
    const r = rig();
    const w = new Weather(r.core, WEATHER_DUST_STORM);
    stereo(r);
    let u = uniform(r.fake);
    expect(u[7]).toBe(2);
    expect([u[4], u[5]]).toEqual([9, 3]);
    const L1 = WEATHER_HEAD_FLOATS + WEATHER_LAYER_FLOATS;
    expect(u[L1]).toBe(7000); // the grit layer starts after the dust
    expect(u[L1 + 12]).toBe(0); // a streak
    expect(w.instances).toBe(9500);
    w.configure(WEATHER_SNOW);
    stereo(r);
    u = uniform(r.fake);
    expect(u[7]).toBe(1);
    expect(u[WEATHER_HEAD_FLOATS + 12]).toBe(1); // a flake
    expect(w.instances).toBe(5000);
    // Counted since the core was made: the first frame's one.
    expect(r.core.stats.bundleBuilds).toBe(1);
  });

  it('intensity and density scale counts; zero draws nothing; occlusion height and anchor', () => {
    const r = rig();
    const w = new Weather(r.core, { ...WEATHER_RAIN, occlusionHeight: 3 });
    w.intensity = 0.5;
    w.density = 0.5;
    w.anchor = [5, 6, 7];
    stereo(r);
    expect(w.instances).toBe(1500);
    const u = uniform(r.fake);
    expect([u[0], u[1], u[2], u[8]]).toEqual([5, 6, 7, 3]);
    w.intensity = 0;
    stereo(r);
    expect(w.active).toBe(false);
    expect(r.core.stats.passes).toBe(0);
    expect(() => w.configure({ layers: Array(5).fill(WEATHER_RAIN.layers[0]) })).toThrow(/4/);
  });

  it('an occlusion map re-records the bundle with the map bound', () => {
    const r = rig();
    const w = new Weather(r.core, WEATHER_RAIN);
    stereo(r);
    const texture = r.device.createTexture({
      size: [8, 8],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    w.setOcclusionMap({ texture, origin: [-10, -10], size: [20, 20] });
    stereo(r);
    expect(r.core.stats.bundleBuilds).toBe(2);
    const u = uniform(r.fake);
    expect([u[9], u[10], u[11], u[12]]).toEqual([1, -10, -10, 20]);
  });

  it('the shader: per-eye facing, height occlusion, one draw for every layer', () => {
    expect(WEATHER_WGSL).toContain('extras[view.index]');
    expect(WEATHER_WGSL).toContain('occlusion(p.xz)');
    expect(WEATHER_WGSL).toContain('view.position.xyz');
  });

  it('a held frame allocates nothing and its calls do not grow with the count', () => {
    const work = (count: number) => {
      const fake = createFakeDevice();
      const meter = createWorkMeter(fake.device as unknown as GPUDevice);
      const r = rig(meter.device);
      const w = new Weather(r.core, WEATHER_RAIN);
      const report = meter.run(
        (i) => {
          w.density = (count / 6000) * (i % 2 === 0 ? 1 : 0.9);
          w.update(1 / 60);
          stereo(r);
        },
        { frames: 4, warmup: 2 },
      );
      expect(report.allocs.typedArrays + report.allocs.arrayBuffers).toBe(0);
      return report.gpu.commands;
    };
    expect(work(600)).toBe(work(6000));
  });
});

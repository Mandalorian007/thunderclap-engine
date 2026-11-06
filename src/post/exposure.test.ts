/**
 * Auto-exposure (ws/post-3): the CPU references of the histogram and average kernels on a
 * tiny image, the bin maths, the adaptation curve, and the compute passes on the fake device.
 */
import { describe, expect, it } from 'vitest';
import { createFakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import { Renderer } from '../render/renderer';
import {
  adaptExposure,
  EXPOSURE_BINS,
  EXPOSURE_LOG_MAX,
  EXPOSURE_LOG_MIN,
  ExposurePasses,
  exposureAverage,
  exposureBin,
  exposureBinLog,
  exposureHistogram,
  exposureTarget,
} from './exposure';

describe('exposure bins', () => {
  it('cover the log range in 64 steps; black and the range ends clamp', () => {
    expect(exposureBin(0)).toBe(0);
    expect(exposureBin(-1)).toBe(0);
    expect(exposureBin(2 ** EXPOSURE_LOG_MIN)).toBe(0);
    expect(exposureBin(2 ** EXPOSURE_LOG_MAX)).toBe(EXPOSURE_BINS - 1);
    expect(exposureBin(1e9)).toBe(EXPOSURE_BINS - 1);
    // log2(1) = 0 lies 10/16 of the way: bin 40.
    expect(exposureBin(1)).toBe(40);
    expect(exposureBinLog(40)).toBeCloseTo(0.125);
    for (let i = 1; i < EXPOSURE_BINS; i++) {
      expect(exposureBinLog(i)).toBeGreaterThan(exposureBinLog(i - 1));
      expect(exposureBin(2 ** exposureBinLog(i))).toBe(i);
    }
  });
});

describe('exposure kernels (CPU reference)', () => {
  // A 4×2 image: four black texels, three mid-grey (luminance 0.18), one bright (16).
  const rgba = new Float32Array(8 * 4);
  for (let i = 4; i < 7; i++) rgba.set([0.18, 0.18, 0.18, 1], i * 4);
  rgba.set([16, 16, 16, 1], 7 * 4);

  it('histogram: counts per bin, grey-weighted luminance', () => {
    const h = exposureHistogram(rgba, 8);
    expect(h[0]).toBe(4);
    expect(h[exposureBin(0.18)]).toBe(3);
    expect(h[exposureBin(16)]).toBe(1);
    expect(Array.from(h).reduce((a, b) => a + b, 0)).toBe(8);
    // Luminance is weighted: a pure blue of 1 lands well below a pure green of 1.
    const g = exposureHistogram([0, 1, 0, 1], 1);
    const b = exposureHistogram([0, 0, 1, 1], 1);
    expect(g.indexOf(1)).toBeGreaterThan(b.indexOf(1));
  });

  it('average: the mean log luminance between the percentiles, partial bins weighted', () => {
    const h = exposureHistogram(rgba, 8);
    // 50%..87.5% is exactly the three grey texels.
    expect(exposureAverage(h, 0.5, 0.875)).toBeCloseTo(exposureBinLog(exposureBin(0.18)));
    // 0..100% is the plain mean over all eight.
    const all =
      (4 * exposureBinLog(0) +
        3 * exposureBinLog(exposureBin(0.18)) +
        exposureBinLog(exposureBin(16))) /
      8;
    expect(exposureAverage(h, 0, 1)).toBeCloseTo(all);
    // The default window (40..95%, texels 3.2..7.6) takes 0.8 of the black run, the whole grey
    // run and 0.6 of the bright texel.
    const grey = exposureBinLog(exposureBin(0.18));
    const bright = exposureBinLog(exposureBin(16));
    const black = exposureBinLog(0);
    expect(exposureAverage(h, 0.4, 0.95)).toBeCloseTo(
      (0.8 * black + 3 * grey + 0.6 * bright) / 4.4,
    );
    expect(exposureAverage(new Uint32Array(EXPOSURE_BINS), 0.4, 0.95)).toBe(EXPOSURE_LOG_MIN);
  });

  it('target: log2(key / average) clamped to the EV range', () => {
    expect(exposureTarget(0, 0.18, -4, 4)).toBeCloseTo(Math.log2(0.18));
    expect(exposureTarget(Math.log2(0.18), 0.18, -4, 4)).toBeCloseTo(0);
    expect(exposureTarget(-20, 0.18, -4, 4)).toBe(4);
    expect(exposureTarget(20, 0.18, -4, 4)).toBe(-4);
  });
});

describe('exposure adaptation', () => {
  it('eases toward the target at the up/down speeds without overshoot', () => {
    let ev = 0;
    const steps: number[] = [];
    for (let i = 0; i < 120; i++) {
      ev = adaptExposure(ev, 2, 1 / 60, 3, 1);
      steps.push(ev);
    }
    // Monotonic, never past the target, close after 2 s at speed 3 (e^-6).
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]!);
    expect(ev).toBeLessThanOrEqual(2);
    expect(ev).toBeCloseTo(2 - 2 * Math.exp(-6), 3);
    // Falling uses the slower speed: after 2 s at speed 1 only e^-2 of the gap remains.
    let down = 2;
    for (let i = 0; i < 120; i++) down = adaptExposure(down, 0, 1 / 60, 3, 1);
    expect(down).toBeCloseTo(2 * Math.exp(-2), 3);
    // A zero dt or speed holds.
    expect(adaptExposure(1, 2, 0, 3, 1)).toBe(1);
    expect(adaptExposure(1, 2, 0.1, 0, 1)).toBe(1);
  });
});

describe('ExposurePasses on the fake device', () => {
  it('records the two compute passes, the clear and one readback copy per frame', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const passes = new ExposurePasses(r);
    const color = fake.device
      .createTexture({
        label: 'scene',
        size: [64, 48],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      .createView();
    const encoder = fake.device.createCommandEncoder();
    const from = fake.passes.length;
    const groups = fake.bindGroups.length;
    passes.encode(encoder, color, 64, 48, 0.4, 0.95);
    const list = fake.passes.slice(from);
    expect(list.map((p) => p.label)).toEqual([
      'pass:post-exposure-histogram',
      'pass:post-exposure-average',
    ]);
    expect(list.every((p) => p.kind === 'compute')).toBe(true);
    const dispatch = list[0]!.commands.find((c) => c.op === 'dispatch') as
      | { x: number; y: number }
      | undefined;
    expect([dispatch?.x, dispatch?.y]).toEqual([4, 3]);
    // Steady state: no new bind group for the same colour view.
    expect(fake.bindGroups.length).toBeGreaterThan(groups);
    const after = fake.bindGroups.length;
    passes.encode(encoder, color, 64, 48, 0.4, 0.95);
    expect(fake.bindGroups.length).toBe(after);
    // The fake buffer cannot be mapped: no readback lands, the average stays at the floor.
    passes.poll();
    expect(passes.readbacks).toBe(0);
    expect(passes.averageLog).toBe(EXPOSURE_LOG_MIN);
    passes.destroy();
    expect(fake.errors).toEqual([]);
  });
});

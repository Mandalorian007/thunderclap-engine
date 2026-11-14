/**
 * ws/actor-post-fit, post: the TAA `quality` knob (`'fast'` packs taa3.w and takes a five-tap
 * cross; `'full'` stays the default and its 3×3 path is unchanged), and `writeLutTexture`
 * building its texels in a caller's buffer with no allocation.
 */
import { describe, expect, it } from 'vitest';
import { createFakeDevice } from '../render/fake-gpu';
import { countAllocs } from '../testing/budget';
import { createLutTexture, lutScratch, lutTexels, lutTexelsHalf, writeLutTexture } from './lut';
import {
  cinematicPostSettings,
  defaultPostQuality,
  neutralPostSettings,
  POST_UNIFORM_FLOATS,
  packPostUniforms,
} from './settings';
import { TAA_WGSL } from './taa';

function pack(out: Float32Array, s: ReturnType<typeof cinematicPostSettings>): void {
  packPostUniforms(out, s, 0, 800, 450, 800, 450, defaultPostQuality(), null, 0, {
    jitterX: 0,
    jitterY: 0,
    reset: 0,
    reproj: new Float32Array(16),
    autoExposure: 1,
    roughMetal: 0,
    objectVelocity: 0,
    taaVelocity: 0,
  });
}

describe('TAA quality (ws/actor-post-fit)', () => {
  it("defaults to 'full' and packs 'fast' as taa3.w = 1", () => {
    expect(neutralPostSettings().taa.quality).toBe('full');
    expect(cinematicPostSettings().taa.quality).toBe('full');
    const out = new Float32Array(POST_UNIFORM_FLOATS);
    const s = cinematicPostSettings();
    s.taa.enabled = true;
    pack(out, s);
    expect(out[191]).toBe(0);
    s.taa.quality = 'fast';
    pack(out, s);
    expect(out[191]).toBe(1);
    // The other taa3 words are unchanged by the knob.
    expect(out[190]).toBe(1);
  });

  it('branches on taa3.w: a five-tap cross, and the 3×3 loop and Catmull-Rom for full', () => {
    expect(TAA_WGSL).toContain('let fast = P.taa3.w > 0.5;');
    expect(TAA_WGSL).toMatch(/const TAA_CROSS = array<vec2f, 5>/);
    expect(TAA_WGSL).toMatch(/for \(var k = 0u; k < 5u; k\+\+\)/);
    expect(TAA_WGSL).toMatch(/let mean = m1 \/ taps;/);
    expect(TAA_WGSL).toContain('P.taa3.z > 0.5 && !fast');
  });
});

describe('writeLutTexture into a buffer (ws/actor-post-fit)', () => {
  const fn = (r: number, g: number, b: number) => [b, g, r] as const;

  it('fills the given array with what a new one would hold', () => {
    const into = lutScratch(16);
    expect(into).toBeInstanceOf(Uint8Array);
    expect(into.length).toBe(16 * 16 * 16 * 4);
    expect(lutTexels(16, fn, into)).toBe(into);
    expect(Array.from(into)).toEqual(Array.from(lutTexels(16, fn)));
    const half = lutScratch(16, 'rgba16float');
    expect(half).toBeInstanceOf(Uint16Array);
    expect(lutTexelsHalf(16, fn, half)).toBe(half);
    expect(Array.from(half)).toEqual(Array.from(lutTexelsHalf(16, fn)));
    expect(() => lutTexels(16, fn, new Uint8Array(10))).toThrow(/LUT texels/);
  });

  it('regrades a half-float LUT with no allocation, and refuses the wrong kind', () => {
    const fake = createFakeDevice();
    const tex = createLutTexture(fake.device, 32, fn, 'rgba16float');
    const out = lutScratch(32, 'rgba16float');
    writeLutTexture(fake.device, tex, fn, out); // warm
    const allocs = countAllocs(() => writeLutTexture(fake.device, tex, fn, out));
    expect(allocs.typedArrays + allocs.arrayBuffers).toBe(0);
    expect(() => writeLutTexture(fake.device, tex, fn, lutScratch(32))).toThrow(/Uint16Array/);
    expect(fake.errors).toEqual([]);
  });
});

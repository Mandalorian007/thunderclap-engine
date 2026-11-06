/** Lens dirt (ws/post-3): the procedural map is deterministic, greyscale and corner-weighted. */
import { describe, expect, it } from 'vitest';
import { createFakeDevice } from '../render/fake-gpu';
import { createLensDirtTexture, lensDirtTexels } from './lens-dirt';

describe('lens dirt', () => {
  it('texels: rgba8, greyscale, alpha 255, deterministic in the seed', () => {
    const a = lensDirtTexels(64, 7);
    expect(a.length).toBe(64 * 64 * 4);
    let dirty = 0;
    for (let i = 0; i < a.length; i += 4) {
      expect(a[i + 1]).toBe(a[i]);
      expect(a[i + 2]).toBe(a[i]);
      expect(a[i + 3]).toBe(255);
      if (a[i]! > 0) dirty++;
    }
    expect(dirty).toBeGreaterThan(0);
    expect(dirty).toBeLessThan(64 * 64);
    expect(lensDirtTexels(64, 7)).toEqual(a);
    expect(lensDirtTexels(64, 8)).not.toEqual(a);
  });

  it('creates a texture on the device and uploads it once', () => {
    const fake = createFakeDevice();
    const tex = createLensDirtTexture(fake.device, 32, 3);
    expect(tex.width).toBe(32);
    expect(tex.format).toBe('rgba8unorm');
    expect(fake.textureWrites.length).toBe(1);
    expect(fake.errors).toEqual([]);
  });
});

/**
 * 3D LUT construction (ws/post-2): `size`³ texels uploaded as one 3D texture, red fastest,
 * and an identity LUT that returns every lattice colour unchanged.
 */
import { describe, expect, it } from 'vitest';
import { createFakeDevice } from '../render/fake-gpu';
import { createLutTexture, identityLut, lutTexels } from './lut';

/** CPU-side lookup of the lattice texel `(r, g, b)` of a `lutTexels` array. */
function texel(data: Uint8Array, size: number, r: number, g: number, b: number): number[] {
  const o = ((b * size + g) * size + r) * 4;
  return Array.from(data.subarray(o, o + 4));
}

describe('lutTexels', () => {
  it('writes size³ RGBA texels, red fastest, alpha 255, values clamped', () => {
    const data = lutTexels(16, (r, g, b) => [r, g, b * 2]);
    expect(data.length).toBe(16 * 16 * 16 * 4);
    expect(texel(data, 16, 0, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(texel(data, 16, 15, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(texel(data, 16, 0, 15, 0)).toEqual([0, 255, 0, 255]);
    expect(texel(data, 16, 0, 0, 15)).toEqual([0, 0, 255, 255]);
    expect(texel(data, 16, 0, 0, 8)).toEqual([0, 0, 255, 255]);
  });

  it('identity round-trips every lattice point', () => {
    const size = 32;
    const data = lutTexels(size, (r, g, b) => [r, g, b]);
    for (let b = 0; b < size; b += 7) {
      for (let g = 0; g < size; g += 5) {
        for (let r = 0; r < size; r += 3) {
          const want = [r, g, b].map((v) => Math.round((v / (size - 1)) * 255));
          expect(texel(data, size, r, g, b)).toEqual([...want, 255]);
        }
      }
    }
  });
});

describe('createLutTexture / identityLut', () => {
  it('makes a size³ rgba8unorm 3D texture and uploads one slice-stacked write', () => {
    const fake = createFakeDevice();
    const tex = createLutTexture(fake.device, 16, (r, g, b) => [b, g, r]);
    const record = fake.textures.find((t) => t.label === 'post-lut')!;
    expect(record).toBeDefined();
    expect(record.format).toBe('rgba8unorm');
    expect(record.width).toBe(16);
    expect(record.height).toBe(16);
    const write = fake.textureWrites.at(-1)!;
    expect(write.texture).toBe(record);
    expect(write.size).toEqual([16, 16, 16]);
    expect(write.bytesPerRow).toBe(16 * 4);
    expect((write.data as Uint8Array).length).toBe(16 ** 3 * 4);
    expect(fake.errors).toEqual([]);
    tex.destroy();
  });

  it('identityLut uploads the identity lattice', () => {
    const fake = createFakeDevice();
    identityLut(fake.device, 32);
    const data = fake.textureWrites.at(-1)!.data as Uint8Array;
    expect(texel(data, 32, 31, 0, 31)).toEqual([255, 0, 255, 255]);
    expect(texel(data, 32, 16, 16, 16)).toEqual([132, 132, 132, 255]);
  });
});

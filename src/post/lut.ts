/**
 * 3D colour lookup tables for `PostSettings.lut` (ws/post-2): a `size`³ `rgba8unorm` texture
 * the composite samples trilinearly with the graded colour as the coordinate (red along x,
 * green along y, blue along z). Build one from a function with `createLutTexture`, or start
 * from `identityLut` and edit its texels.
 */

export type LutSize = 16 | 32;

/** Maps an input colour (each 0..1) to an output colour (each 0..1, clamped on write). */
export type LutFn = (r: number, g: number, b: number) => readonly [number, number, number];

/**
 * The texels `createLutTexture` uploads: `size`³ RGBA8 values, red fastest, then green, then
 * blue (one `size`×`size` slice per blue step). Exported so a LUT can be checked or edited on the
 * CPU before upload.
 */
export function lutTexels(size: LutSize, fn: LutFn): Uint8Array {
  const n = size;
  const out = new Uint8Array(n * n * n * 4);
  const step = 1 / (n - 1);
  let o = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const c = fn(r * step, g * step, b * step);
        out[o] = quantize(c[0]);
        out[o + 1] = quantize(c[1]);
        out[o + 2] = quantize(c[2]);
        out[o + 3] = 255;
        o += 4;
      }
    }
  }
  return out;
}

/** Make and upload a `size`³ LUT from `fn`. Destroy it with `texture.destroy()` when done. */
export function createLutTexture(device: GPUDevice, size: LutSize, fn: LutFn): GPUTexture {
  const texture = device.createTexture({
    label: 'post-lut',
    size: [size, size, size],
    dimension: '3d',
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    lutTexels(size, fn),
    { bytesPerRow: size * 4, rowsPerImage: size },
    [size, size, size],
  );
  return texture;
}

/** A LUT that leaves colours alone: the starting point for a graded one. */
export function identityLut(device: GPUDevice, size: LutSize): GPUTexture {
  return createLutTexture(device, size, identity);
}

const identity: LutFn = (r, g, b) => [r, g, b];

function quantize(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

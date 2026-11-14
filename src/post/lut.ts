/**
 * 3D colour lookup tables for `PostSettings.lut` (ws/post-2): a `size`³ `rgba8unorm` texture
 * the composite samples trilinearly with the graded colour as the coordinate (red along x,
 * green along y, blue along z). Build one from a function with `createLutTexture`, or start
 * from `identityLut` and edit its texels.
 */

export type LutSize = 16 | 32;

/**
 * A LUT's texel format (ws/post-fit): `rgba8unorm` (default, 8 bits a channel, clamped to
 * 0..1) or `rgba16float` (half floats, written as given: finer steps for a smooth grade).
 */
export type LutFormat = 'rgba8unorm' | 'rgba16float';

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

/**
 * `lutTexels` as `rgba16float` (ws/post-fit): `size`³ half floats ×4 (bit patterns), same order,
 * alpha 1. Values are not clamped.
 */
export function lutTexelsHalf(size: LutSize, fn: LutFn): Uint16Array {
  const n = size;
  const out = new Uint16Array(n * n * n * 4);
  const step = 1 / (n - 1);
  const one = toHalf(1);
  let o = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const c = fn(r * step, g * step, b * step);
        out[o] = toHalf(c[0]);
        out[o + 1] = toHalf(c[1]);
        out[o + 2] = toHalf(c[2]);
        out[o + 3] = one;
        o += 4;
      }
    }
  }
  return out;
}

/**
 * Make and upload a `size`³ LUT from `fn` in `format` (default `rgba8unorm`). Destroy it with
 * `texture.destroy()` when done.
 */
export function createLutTexture(
  device: GPUDevice,
  size: LutSize,
  fn: LutFn,
  format: LutFormat = 'rgba8unorm',
): GPUTexture {
  const texture = device.createTexture({
    label: 'post-lut',
    size: [size, size, size],
    dimension: '3d',
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  writeLutTexture(device, texture, fn);
  return texture;
}

/**
 * Rewrite a LUT made by `createLutTexture` from `fn` in place (ws/post-fit): same texture, so
 * a stack that binds it keeps its bind groups (a regrade costs one upload, no rebuild). Its
 * size and format are the texture's.
 */
export function writeLutTexture(device: GPUDevice, texture: GPUTexture, fn: LutFn): void {
  const size = texture.width as LutSize;
  const half = texture.format === 'rgba16float';
  device.queue.writeTexture(
    { texture },
    half ? lutTexelsHalf(size, fn) : lutTexels(size, fn),
    { bytesPerRow: size * (half ? 8 : 4), rowsPerImage: size },
    [size, size, size],
  );
}

/** A LUT that leaves colours alone: the starting point for a graded one. */
export function identityLut(device: GPUDevice, size: LutSize): GPUTexture {
  return createLutTexture(device, size, identity);
}

const identity: LutFn = (r, g, b) => [r, g, b];

function quantize(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** `v` as an IEEE half float's bits (round to nearest even; overflow to ∞, NaN kept). */
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && h & 1)) h++;
    return sign | h;
  }
  let h = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && h & 1)) h++;
  return sign | h;
}

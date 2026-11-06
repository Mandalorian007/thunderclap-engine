/**
 * Lens dirt (ws/post-3): a procedural `rgba8unorm` texture of speckles and smudges the
 * composite multiplies into the bloom term (`bloom × (1 + dirt × intensity)`). Pass it as
 * `settings.bloom.dirt = { texture, intensity }`.
 */

function hash(seed: number, i: number): number {
  // Two rounds of a 32-bit integer mix; returns 0..1.
  let x = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0;
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

/**
 * The texels of a `size × size` dirt map (rgba8, greyscale, alpha 255), deterministic in
 * `seed`: ~`size / 2` soft speckles of a few px and a handful of long faint smudges, strongest
 * toward the corners so the centre of the frame stays clean.
 */
export function lensDirtTexels(size: number, seed: number): Uint8Array {
  const n = Math.max(1, Math.floor(size));
  const img = new Float32Array(n * n);
  let k = 0;
  const speckles = Math.max(4, n >> 1);
  for (let i = 0; i < speckles; i++) {
    const cx = hash(seed, k++) * n;
    const cy = hash(seed, k++) * n;
    const r = 0.5 + hash(seed, k++) * hash(seed, k++) * (n / 40);
    const a = 0.3 + hash(seed, k++) * 0.7;
    stamp(img, n, cx, cy, r, r, 0, a);
  }
  const smudges = 6 + Math.floor(hash(seed, k++) * 6);
  for (let i = 0; i < smudges; i++) {
    const cx = hash(seed, k++) * n;
    const cy = hash(seed, k++) * n;
    const len = n * (0.08 + hash(seed, k++) * 0.2);
    const wid = n * (0.01 + hash(seed, k++) * 0.02);
    const ang = hash(seed, k++) * Math.PI;
    stamp(img, n, cx, cy, len, wid, ang, 0.08 + hash(seed, k++) * 0.12);
  }
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // Vignette the dirt: full at the corners, a third in the centre.
      const dx = (x + 0.5) / n - 0.5;
      const dy = (y + 0.5) / n - 0.5;
      const edge = 0.35 + 0.65 * Math.min(1, Math.hypot(dx, dy) * 1.6);
      const v = Math.round(Math.min(1, img[y * n + x]! * edge) * 255);
      const o = (y * n + x) * 4;
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Add a soft ellipse (`rx` along `angle`, `ry` across) of peak `amount` at `(cx, cy)`. */
function stamp(
  img: Float32Array,
  n: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  angle: number,
  amount: number,
): void {
  const reach = Math.ceil(Math.max(rx, ry)) + 1;
  const x0 = Math.max(0, Math.floor(cx - reach));
  const x1 = Math.min(n - 1, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(n - 1, Math.ceil(cy + reach));
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = (dx * c + dy * s) / rx;
      const v = (-dx * s + dy * c) / ry;
      const d = u * u + v * v;
      if (d >= 1) continue;
      const f = 1 - d;
      img[y * n + x] = Math.min(1, img[y * n + x]! + amount * f * f);
    }
  }
}

/** A `size × size` `rgba8unorm` dirt texture on `device` (uploaded once; destroy it yourself). */
export function createLensDirtTexture(device: GPUDevice, size = 256, seed = 1): GPUTexture {
  const n = Math.max(1, Math.floor(size));
  const texture = device.createTexture({
    label: 'post-lens-dirt',
    size: [n, n],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const texels = lensDirtTexels(n, seed);
  device.queue.writeTexture({ texture }, texels, { bytesPerRow: n * 4, rowsPerImage: n }, [n, n]);
  return texture;
}

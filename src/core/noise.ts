/**
 * Seeded coherent noise (ws/core-2): value, Perlin (gradient) and simplex noise in 2D and 3D,
 * plus fractal Brownian motion over any of them.
 *
 * `createNoise(seed)` shuffles a 256-entry permutation table with `createRandom(seed)` (the same
 * seed hash as `Random`) and fills a 256-entry lattice value table in [-1, 1]. Every function
 * returns a value in [-1, 1] (gradient and simplex noise are scaled to that span and clamped),
 * is continuous in its inputs, and allocates nothing. The functions are plain closures, so
 * `noise.perlin2` can be passed around unbound (`fbm(noise.perlin2, x, y)`).
 */

import { createRandom, type Seed } from './random';

/** A noise function; 2D ones ignore `z`. */
export type NoiseFn = (x: number, y: number, z: number) => number;

export interface FbmOptions {
  /** Layers summed. Default 4. */
  octaves?: number;
  /** Frequency multiplier per octave. Default 2. */
  lacunarity?: number;
  /** Amplitude multiplier per octave. Default 0.5. */
  gain?: number;
}

export interface Noise {
  /** Lattice values smoothly interpolated (quintic fade). */
  value2(x: number, y: number): number;
  value3(x: number, y: number, z: number): number;
  /** Improved Perlin gradient noise; 0 on every integer lattice point. */
  perlin2(x: number, y: number): number;
  perlin3(x: number, y: number, z: number): number;
  /** Simplex noise (Gustavson's formulation). */
  simplex2(x: number, y: number): number;
  simplex3(x: number, y: number, z: number): number;
  /**
   * `octaves` layers of `fn`, each at `lacunarity` times the frequency and `gain` times the
   * amplitude of the last, divided by the summed amplitude so the result stays in [-1, 1]. One
   * octave is exactly `fn(x, y, z)`. Hoist the options object: a literal per call allocates.
   */
  fbm(fn: NoiseFn, x: number, y: number, z?: number, opts?: FbmOptions): number;
}

/** Unit gradients at eight angles for 2D Perlin. */
const G2X = new Float64Array(8);
const G2Y = new Float64Array(8);
for (let i = 0; i < 8; i++) {
  G2X[i] = Math.cos((i * Math.PI) / 4);
  G2Y[i] = Math.sin((i * Math.PI) / 4);
}
/** The twelve cube-edge gradients of improved Perlin and 3D simplex. */
const G3 = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1,
  0, 1, -1, 0, -1, -1,
];
/** Twelve directions for 2D simplex (the 3D set projected, as in Gustavson). */
const S2 = [1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1];

// 2D Perlin with unit gradients peaks at sqrt(2)/2; 3D with the edge set at about 1.
const PERLIN2_SCALE = Math.SQRT2;
const PERLIN3_SCALE = 1;
const SIMPLEX2_SCALE = 70;
const SIMPLEX3_SCALE = 32;
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3C = 1 / 6;

const DEFAULT_FBM: Required<FbmOptions> = { octaves: 4, lacunarity: 2, gain: 0.5 };

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp1(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

/** Seeded noise; see the module comment. Builds two small tables (allocates once). */
export function createNoise(seed: Seed): Noise {
  const random = createRandom(seed);
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  random.shuffle(perm.subarray(0, 256));
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i]!;
  const values = new Float64Array(256);
  for (let i = 0; i < 256; i++) values[i] = random.next() * 2 - 1;

  const h2 = (x: number, y: number) => perm[perm[x & 255]! + (y & 255)]!;
  const h3 = (x: number, y: number, z: number) =>
    perm[perm[perm[x & 255]! + (y & 255)]! + (z & 255)]!;

  const value2 = (x: number, y: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const u = fade(x - x0);
    const v = fade(y - y0);
    const a = values[h2(x0, y0)]!;
    const b = values[h2(x0 + 1, y0)]!;
    const c = values[h2(x0, y0 + 1)]!;
    const d = values[h2(x0 + 1, y0 + 1)]!;
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  };

  const value3 = (x: number, y: number, z: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const z0 = Math.floor(z);
    const u = fade(x - x0);
    const v = fade(y - y0);
    const w = fade(z - z0);
    const c000 = values[h3(x0, y0, z0)]!;
    const c100 = values[h3(x0 + 1, y0, z0)]!;
    const c010 = values[h3(x0, y0 + 1, z0)]!;
    const c110 = values[h3(x0 + 1, y0 + 1, z0)]!;
    const c001 = values[h3(x0, y0, z0 + 1)]!;
    const c101 = values[h3(x0 + 1, y0, z0 + 1)]!;
    const c011 = values[h3(x0, y0 + 1, z0 + 1)]!;
    const c111 = values[h3(x0 + 1, y0 + 1, z0 + 1)]!;
    return lerp(
      lerp(lerp(c000, c100, u), lerp(c010, c110, u), v),
      lerp(lerp(c001, c101, u), lerp(c011, c111, u), v),
      w,
    );
  };

  const grad2 = (h: number, x: number, y: number) => G2X[h & 7]! * x + G2Y[h & 7]! * y;
  const grad3 = (h: number, x: number, y: number, z: number) => {
    const g = (h % 12) * 3;
    return G3[g]! * x + G3[g + 1]! * y + G3[g + 2]! * z;
  };

  const perlin2 = (x: number, y: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const u = fade(fx);
    const v = fade(fy);
    const n00 = grad2(h2(x0, y0), fx, fy);
    const n10 = grad2(h2(x0 + 1, y0), fx - 1, fy);
    const n01 = grad2(h2(x0, y0 + 1), fx, fy - 1);
    const n11 = grad2(h2(x0 + 1, y0 + 1), fx - 1, fy - 1);
    return clamp1(PERLIN2_SCALE * lerp(lerp(n00, n10, u), lerp(n01, n11, u), v));
  };

  const perlin3 = (x: number, y: number, z: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const z0 = Math.floor(z);
    const fx = x - x0;
    const fy = y - y0;
    const fz = z - z0;
    const u = fade(fx);
    const v = fade(fy);
    const w = fade(fz);
    const n000 = grad3(h3(x0, y0, z0), fx, fy, fz);
    const n100 = grad3(h3(x0 + 1, y0, z0), fx - 1, fy, fz);
    const n010 = grad3(h3(x0, y0 + 1, z0), fx, fy - 1, fz);
    const n110 = grad3(h3(x0 + 1, y0 + 1, z0), fx - 1, fy - 1, fz);
    const n001 = grad3(h3(x0, y0, z0 + 1), fx, fy, fz - 1);
    const n101 = grad3(h3(x0 + 1, y0, z0 + 1), fx - 1, fy, fz - 1);
    const n011 = grad3(h3(x0, y0 + 1, z0 + 1), fx, fy - 1, fz - 1);
    const n111 = grad3(h3(x0 + 1, y0 + 1, z0 + 1), fx - 1, fy - 1, fz - 1);
    return clamp1(
      PERLIN3_SCALE *
        lerp(
          lerp(lerp(n000, n100, u), lerp(n010, n110, u), v),
          lerp(lerp(n001, n101, u), lerp(n011, n111, u), v),
          w,
        ),
    );
  };

  const corner2 = (h: number, x: number, y: number): number => {
    let t = 0.5 - x * x - y * y;
    if (t < 0) return 0;
    t *= t;
    const g = (h & 7) * 2;
    return t * t * (S2[g]! * x + S2[g + 1]! * y);
  };

  const simplex2 = (x: number, y: number): number => {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const n =
      corner2(h2(i, j), x0, y0) +
      corner2(h2(i + i1, j + j1), x1, y1) +
      corner2(h2(i + 1, j + 1), x2, y2);
    return clamp1(SIMPLEX2_SCALE * n);
  };

  const corner3 = (h: number, x: number, y: number, z: number): number => {
    let t = 0.6 - x * x - y * y - z * z;
    if (t < 0) return 0;
    t *= t;
    return t * t * grad3(h, x, y, z);
  };

  const simplex3 = (x: number, y: number, z: number): number => {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3C;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);
    let i1: number;
    let j1: number;
    let k1: number;
    let i2: number;
    let j2: number;
    let k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1;
        j1 = 0;
        k1 = 0;
        i2 = 1;
        j2 = 1;
        k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1;
        j1 = 0;
        k1 = 0;
        i2 = 1;
        j2 = 0;
        k2 = 1;
      } else {
        i1 = 0;
        j1 = 0;
        k1 = 1;
        i2 = 1;
        j2 = 0;
        k2 = 1;
      }
    } else if (y0 < z0) {
      i1 = 0;
      j1 = 0;
      k1 = 1;
      i2 = 0;
      j2 = 1;
      k2 = 1;
    } else if (x0 < z0) {
      i1 = 0;
      j1 = 1;
      k1 = 0;
      i2 = 0;
      j2 = 1;
      k2 = 1;
    } else {
      i1 = 0;
      j1 = 1;
      k1 = 0;
      i2 = 1;
      j2 = 1;
      k2 = 0;
    }
    const n =
      corner3(h3(i, j, k), x0, y0, z0) +
      corner3(h3(i + i1, j + j1, k + k1), x0 - i1 + G3C, y0 - j1 + G3C, z0 - k1 + G3C) +
      corner3(h3(i + i2, j + j2, k + k2), x0 - i2 + 2 * G3C, y0 - j2 + 2 * G3C, z0 - k2 + 2 * G3C) +
      corner3(h3(i + 1, j + 1, k + 1), x0 - 1 + 3 * G3C, y0 - 1 + 3 * G3C, z0 - 1 + 3 * G3C);
    return clamp1(SIMPLEX3_SCALE * n);
  };

  const fbm = (
    fn: NoiseFn,
    x: number,
    y: number,
    z = 0,
    opts: FbmOptions = DEFAULT_FBM,
  ): number => {
    const octaves = Math.max(1, Math.floor(opts.octaves ?? DEFAULT_FBM.octaves));
    const lacunarity = opts.lacunarity ?? DEFAULT_FBM.lacunarity;
    const gain = opts.gain ?? DEFAULT_FBM.gain;
    let freq = 1;
    let amp = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * fn(x * freq, y * freq, z * freq);
      norm += amp;
      freq *= lacunarity;
      amp *= gain;
    }
    return norm > 0 ? sum / norm : 0;
  };

  return { value2, value3, perlin2, perlin3, simplex2, simplex3, fbm };
}

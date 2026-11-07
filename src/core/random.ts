/**
 * Seeded random numbers with named streams (ws/core-2).
 *
 * Generator: xoshiro128** (Blackman and Vigna), 128 bits of state in a `Uint32Array(4)`, period
 * 2^128 − 1, 32-bit output. A seed is turned into a 32-bit key (a number seed that is an integer
 * is taken `>>> 0`; any other number, and every string, is hashed with 32-bit FNV-1a over its
 * UTF-8 bytes: offset basis 0x811c9dc5, prime 0x01000193), and the key is expanded into the four
 * state words with splitmix32. The same seed gives the same sequence on every engine.
 *
 * `fork(name)` derives a child key from the stream's own key and the name (FNV-1a of the name
 * started from the parent key), never from the parent's current state, so how often one stream is
 * used never changes another. Every draw, and `seedKey` itself, allocates nothing; `fork` and the
 * `state` getter do.
 */

export type Seed = number | string;

/** Anything indexable by number that a vector helper can write into (`Float32Array`, `number[]`). */
export interface NumberSink {
  [index: number]: number;
}

export interface Random {
  /** The 32-bit key this stream was seeded from (a fork's key is derived from its parent's). */
  readonly key: number;
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both ends included; unbiased (rejection sampling). */
  int(min: number, max: number): number;
  /** A float in [min, max). */
  float(min: number, max: number): number;
  /** True with probability `p` (default 0.5). */
  bool(p?: number): boolean;
  /** A uniformly chosen element. Throws a `RangeError` on an empty array. */
  pick<T>(array: ArrayLike<T>): T;
  /** An index chosen with probability `weights[i] / sum`; -1 when the sum is not positive. */
  weighted(weights: ArrayLike<number>): number;
  /** Fisher–Yates in place; returns `array`. */
  shuffle<T, A extends { [index: number]: T; length: number }>(array: A): A;
  /** A normal sample (Box–Muller; two uniforms per call, nothing cached, so `state` is complete). */
  gaussian(mean?: number, sd?: number): number;
  /** A uniformly distributed unit vector into `out[0..1]`; returns `out`. */
  unitVec2<T extends NumberSink>(out: T): T;
  /** A uniformly distributed unit vector on the sphere into `out[0..2]`; returns `out`. */
  unitVec3<T extends NumberSink>(out: T): T;
  /** A child stream keyed by this stream's key and `name`; independent of draws on this one. */
  fork(name: string): Random;
  /** The four state words. Reading copies; writing copies in (an all-zero state is rejected). */
  state: Uint32Array;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const INV_2_32 = 1 / 4294967296;

/** 32-bit FNV-1a over the UTF-8 bytes of `s`, starting from `basis`. No allocation. */
function fnv1a(s: string, basis: number = FNV_OFFSET): number {
  let h = basis >>> 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) h = Math.imul(h ^ c, FNV_PRIME);
    else if (c < 0x800) {
      h = Math.imul(h ^ (0xc0 | (c >> 6)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME);
    } else if (c < 0x10000) {
      h = Math.imul(h ^ (0xe0 | (c >> 12)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 63)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME);
    } else {
      h = Math.imul(h ^ (0xf0 | (c >> 18)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | ((c >> 12) & 63)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 63)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME);
    }
  }
  return h >>> 0;
}

/**
 * The 32-bit key of a seed: the key `createRandom(seed)` is seeded from (`random.key`) and the
 * one `hash2`/`hash3` mix their coordinates into. An integer number seed is taken `>>> 0`; any
 * other number, and every string, is hashed with 32-bit FNV-1a over its UTF-8 bytes. A game uses
 * it to derive its own stable hashes from the same seed the engine does, for example
 * `seedKey('level-3') ^ chunkId`. Pure and allocation-free; the value never changes between
 * engine versions (the FNV-1a reference values are tested).
 */
export function seedKey(seed: Seed): number {
  if (typeof seed === 'number' && Number.isInteger(seed)) return seed >>> 0;
  return fnv1a(String(seed));
}

/** Expand a 32-bit key into four xoshiro words with splitmix32 (never all zero). */
function expand(key: number, out: Uint32Array): void {
  let s = key | 0;
  for (let i = 0; i < 4; i++) {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    out[i] = (z ^ (z >>> 16)) >>> 0;
  }
  if ((out[0]! | out[1]! | out[2]! | out[3]!) === 0) out[0] = 1;
}

class XoshiroRandom implements Random {
  private readonly s = new Uint32Array(4);

  constructor(readonly key: number) {
    expand(key, this.s);
  }

  /** The next 32-bit output (xoshiro128**). */
  private u32(): number {
    const s = this.s;
    const s0 = s[0]!;
    const s1 = s[1]!;
    const s2 = s[2]!;
    const s3 = s[3]!;
    const m = Math.imul(s1, 5);
    const result = Math.imul((m << 7) | (m >>> 25), 9) >>> 0;
    const t = s1 << 9;
    const n2 = s2 ^ s0;
    const n3 = s3 ^ s1;
    s[1] = s1 ^ n2;
    s[0] = s0 ^ n3;
    s[2] = n2 ^ t;
    s[3] = (n3 << 11) | (n3 >>> 21);
    return result;
  }

  next(): number {
    return this.u32() * INV_2_32;
  }

  int(min: number, max: number): number {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    const n = hi - lo + 1;
    if (n <= 1) return lo;
    if (n > 4294967296) return lo + Math.floor(this.next() * n);
    // Reject the top sliver of 2^32 that does not divide evenly by n.
    const limit = 4294967296 - (4294967296 % n);
    let u = this.u32();
    while (u >= limit) u = this.u32();
    return lo + (u % n);
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(array: ArrayLike<T>): T {
    if (array.length === 0) throw new RangeError('Random.pick: empty array');
    return array[this.int(0, array.length - 1)]!;
  }

  weighted(weights: ArrayLike<number>): number {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i]!;
      if (w > 0) sum += w;
    }
    if (!(sum > 0)) return -1;
    let r = this.next() * sum;
    let last = -1;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i]!;
      if (!(w > 0)) continue;
      last = i;
      if (r < w) return i;
      r -= w;
    }
    return last;
  }

  shuffle<T, A extends { [index: number]: T; length: number }>(array: A): A {
    for (let i = array.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = array[i]!;
      array[i] = array[j]!;
      array[j] = tmp;
    }
    return array;
  }

  gaussian(mean = 0, sd = 1): number {
    const u1 = 1 - this.next(); // (0, 1]: log stays finite
    const u2 = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  unitVec2<T extends NumberSink>(out: T): T {
    const a = this.next() * 2 * Math.PI;
    out[0] = Math.cos(a);
    out[1] = Math.sin(a);
    return out;
  }

  unitVec3<T extends NumberSink>(out: T): T {
    const z = this.next() * 2 - 1;
    const a = this.next() * 2 * Math.PI;
    const r = Math.sqrt(1 - z * z);
    out[0] = r * Math.cos(a);
    out[1] = r * Math.sin(a);
    out[2] = z;
    return out;
  }

  fork(name: string): Random {
    return new XoshiroRandom(fnv1a(name, this.key ^ 0x9e3779b9));
  }

  get state(): Uint32Array {
    return this.s.slice();
  }

  set state(words: Uint32Array) {
    if (words.length !== 4) throw new RangeError('Random.state: expected 4 words');
    if ((words[0]! | words[1]! | words[2]! | words[3]!) === 0) {
      throw new RangeError('Random.state: an all-zero state is invalid for xoshiro128**');
    }
    this.s.set(words);
  }
}

/** A seeded stream; see the module comment for the generator, the seed hash and `fork`. */
export function createRandom(seed: Seed): Random {
  return new XoshiroRandom(seedKey(seed));
}

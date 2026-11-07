/**
 * Positional hashing (ws/core-3): a stable random value per lattice cell, for rolls that need a
 * number per point rather than a field between points (a tree in this column, a speckle on this
 * texel, a lantern on this floor). Noise is `createNoise`; a sequence is `createRandom`.
 *
 * The seed goes through `seedKey`, the same hash `createRandom` uses (an integer number seed is
 * taken `>>> 0`, anything else is FNV-1a over UTF-8). Each coordinate is truncated toward zero
 * and wrapped to 32 bits (`x | 0`), so `hash2(s, 2.9, -0.5)` is `hash2(s, 2, 0)`: floor first
 * when a cell is `Math.floor(x)`. The key, tagged per dimension, and then each coordinate in turn
 * are folded in with Wellons' lowbias32 finaliser (xor-shift-multiply, a bijection on 32 bits),
 * so neighbouring cells share no bits and `hash3(s, x, 0, z)` is unrelated to `hash2(s, x, z)`.
 *
 * Pure integer arithmetic (`Math.imul`, shifts): the same uint32 on every engine. Nothing
 * allocates; a string seed is rehashed per call, so a hot loop passes a number seed.
 */

import { type Seed, seedKey } from './random';

const INV_2_32 = 1 / 4294967296;
/** Per-dimension tags folded into the key first, so 2D and 3D hashes of one seed differ. */
const TAG2 = 0x6a09e667;
const TAG3 = 0xbb67ae85;

/** lowbias32 (Chris Wellons, hash-prospector): a well-mixed bijection on uint32. */
function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A uint32 for cell `(x, z)` under `seed`. */
export function hash2(seed: Seed, x: number, z: number): number {
  let h = mix(seedKey(seed) ^ TAG2);
  h = mix(h ^ (x | 0));
  return mix(h ^ (z | 0));
}

/** A uint32 for cell `(x, y, z)` under `seed`. */
export function hash3(seed: Seed, x: number, y: number, z: number): number {
  let h = mix(seedKey(seed) ^ TAG3);
  h = mix(h ^ (x | 0));
  h = mix(h ^ (y | 0));
  return mix(h ^ (z | 0));
}

/** `hash2` as a float in [0, 1). */
export function hash2f(seed: Seed, x: number, z: number): number {
  return hash2(seed, x, z) * INV_2_32;
}

/** `hash3` as a float in [0, 1). */
export function hash3f(seed: Seed, x: number, y: number, z: number): number {
  return hash3(seed, x, y, z) * INV_2_32;
}

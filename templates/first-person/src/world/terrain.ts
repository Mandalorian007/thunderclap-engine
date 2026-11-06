/**
 * The terrain: a seeded height field of whole-unit columns. Pure TypeScript, no engine, no DOM,
 * no `Math.random`: the same seed gives the same world on the page, in the Worker and in a test.
 *
 * World coordinates: x and z in `0..size` (one column per unit), y up, column `(cx, cz)` covers
 * `cx..cx+1` × `cz..cz+1` and its top face is at `y = height`. Outside the field the height is 0.
 */

/** Columns per side of the world. */
export const WORLD_SIZE = 64;
/** The lowest and highest column a world can have. */
export const MIN_HEIGHT = 1;
export const MAX_HEIGHT = 14;

export interface Terrain {
  readonly seed: number;
  readonly size: number;
  /** `size × size` column heights, row-major by z then x. */
  readonly heights: Uint8Array;
}

/** Texture-array layers of the block material, in the order `layers/` paints them. */
export const LAYER_GRASS = 0;
export const LAYER_SAND = 1;
export const LAYER_ROCK = 2;
export const LAYER_SNOW = 3;
export const LAYER_COUNT = 4;

/** A named point of interest the scene labels and the player can inspect. */
export interface Landmark {
  readonly name: string;
  readonly note: string;
  /** Column indices. */
  readonly x: number;
  readonly z: number;
  /** The column's top, so a label sits above the ground. */
  readonly height: number;
}

/** A 32-bit integer hash of two coordinates and a seed, mixed to a float in 0..1. */
export function hash2(x: number, z: number, seed: number): number {
  let h = (x | 0) * 374761393 + (z | 0) * 668265263 + (seed | 0) * 2147483647;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise: lattice points hashed, bilinear with a smoothstep. 0..1. */
export function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smooth(x - x0);
  const tz = smooth(z - z0);
  const a = hash2(x0, z0, seed);
  const b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed);
  const d = hash2(x0 + 1, z0 + 1, seed);
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

/** Height of the column at (x, z) in the world `seed` describes, before the field exists. */
export function sampleHeight(x: number, z: number, seed: number, size: number): number {
  // Two octaves of rolling hills plus a sharp ridge, raised toward the middle so the edge of the
  // world is low ground.
  const base = valueNoise(x / 14, z / 14, seed);
  const detail = valueNoise(x / 5, z / 5, seed + 1);
  const ridge = 1 - Math.abs(2 * valueNoise(x / 22, z / 22, seed + 2) - 1);
  const dx = (x + 0.5) / size - 0.5;
  const dz = (z + 0.5) / size - 0.5;
  const centre = 1 - Math.min(1, 2 * Math.hypot(dx, dz));
  const v = 0.45 * base + 0.2 * detail + 0.35 * ridge * ridge;
  const h = MIN_HEIGHT + Math.round((v * 0.75 + 0.25 * centre) * (MAX_HEIGHT - MIN_HEIGHT));
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h));
}

export function createTerrain(seed: number, size = WORLD_SIZE): Terrain {
  const heights = new Uint8Array(size * size);
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) heights[z * size + x] = sampleHeight(x, z, seed, size);
  }
  return { seed, size, heights };
}

/** Column height at integer (x, z); 0 outside the field. */
export function heightAt(t: Terrain, x: number, z: number): number {
  if (x < 0 || z < 0 || x >= t.size || z >= t.size) return 0;
  return t.heights[z * t.size + x]!;
}

/** The ground under a world position: the top of the column it stands in. */
export function surfaceY(t: Terrain, wx: number, wz: number): number {
  return heightAt(t, Math.floor(wx), Math.floor(wz));
}

/** Which texture layer a column top of `height` shows. */
export function layerForTop(height: number): number {
  if (height <= MIN_HEIGHT + 1) return LAYER_SAND;
  if (height >= MAX_HEIGHT - 2) return LAYER_SNOW;
  return LAYER_GRASS;
}

/** Which texture layer a column's side shows: rock, or sand down near the shore. */
export function layerForSide(height: number): number {
  return height <= MIN_HEIGHT + 1 ? LAYER_SAND : LAYER_ROCK;
}

/**
 * Three points of interest: the summit (highest column, first in scan order), the hollow (lowest
 * column) and the cairn, the highest column at least half the world away from the summit.
 */
export function findLandmarks(t: Terrain): readonly [Landmark, Landmark, Landmark] {
  let hi = 0;
  let lo = 0;
  for (let i = 1; i < t.heights.length; i++) {
    if (t.heights[i]! > t.heights[hi]!) hi = i;
    if (t.heights[i]! < t.heights[lo]!) lo = i;
  }
  const sx = hi % t.size;
  const sz = Math.floor(hi / t.size);
  let far = -1;
  for (let i = 0; i < t.heights.length; i++) {
    const x = i % t.size;
    const z = Math.floor(i / t.size);
    if (Math.hypot(x - sx, z - sz) < t.size / 2) continue;
    if (far < 0 || t.heights[i]! > t.heights[far]!) far = i;
  }
  if (far < 0) far = lo;
  const at = (i: number, name: string, note: string): Landmark => ({
    name,
    note,
    x: i % t.size,
    z: Math.floor(i / t.size),
    height: t.heights[i]!,
  });
  return [
    at(hi, 'Summit', 'The highest ground. The fog thins up here.'),
    at(lo, 'Hollow', 'The lowest point of the field. Sand underfoot.'),
    at(far, 'Cairn', 'A marker on the far ridge, half a world from the summit.'),
  ];
}

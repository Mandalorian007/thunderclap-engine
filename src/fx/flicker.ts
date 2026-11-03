/**
 * Pure, allocation-free light helpers. Feed the result into a tint/emissive/intensity value.
 */

function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Smooth 1D value noise in [0, 1]. */
export function valueNoise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i + seed * 57.13);
  const b = hash1(i + 1 + seed * 57.13);
  return a + (b - a) * u;
}

export interface FlickerOptions {
  /** Distinguishes multiple lights. */
  seed?: number;
  /** Noise frequency in Hz-ish. Default 7. */
  speed?: number;
  /** 0..1 depth of the flicker. Default 0.3. */
  amount?: number;
  /** Value at rest. Default 1. */
  base?: number;
}

/**
 * Flame/torch flicker: two octaves of value noise plus a rare dip.
 * Returns `base * (1 - amount * n)` with n in [0, 1].
 */
export function flicker(t: number, opts: FlickerOptions = {}): number {
  const seed = opts.seed ?? 0;
  const speed = opts.speed ?? 7;
  const amount = opts.amount ?? 0.3;
  const base = opts.base ?? 1;
  const n1 = valueNoise1(t * speed, seed);
  const n2 = valueNoise1(t * speed * 2.7 + 13.3, seed + 1);
  const dip = valueNoise1(t * speed * 0.21 + 5.1, seed + 2);
  let n = n1 * 0.65 + n2 * 0.35;
  if (dip > 0.85) n = Math.min(1, n + (dip - 0.85) * 3);
  return base * (1 - amount * n);
}

export interface PulseOptions {
  /** Seconds per cycle. Default 2. */
  period?: number;
  min?: number;
  max?: number;
  /** 0..1 phase offset. */
  phase?: number;
}

/** Smooth breathing pulse between `min` and `max` (cosine ease). */
export function pulse(t: number, opts: PulseOptions = {}): number {
  const period = opts.period ?? 2;
  const min = opts.min ?? 0.6;
  const max = opts.max ?? 1;
  const ph = opts.phase ?? 0;
  const k = 0.5 - 0.5 * Math.cos(((t / period + ph) % 1) * Math.PI * 2);
  return min + (max - min) * k;
}

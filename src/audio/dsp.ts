/**
 * Pure sample-level helpers: seeded noise, crackle impulses, loop folding, normalisation,
 * unit conversions. No WebAudio here, so all of it runs (and is tested) in Node.
 */

/** Deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type NoiseColor = 'white' | 'pink' | 'brown';

/** Fill `out` with noise in roughly [-1, 1]. Same seed, same samples. */
export function fillNoise(out: Float32Array, color: NoiseColor, seed = 1): Float32Array {
  const rand = rng(seed);
  if (color === 'white') {
    for (let i = 0; i < out.length; i++) out[i] = rand() * 2 - 1;
    return out;
  }
  if (color === 'pink') {
    // Paul Kellet's economy pink filter.
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < out.length; i++) {
      const w = rand() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
    return out;
  }
  // Brown: leaky integrated white noise.
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rand() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    out[i] = last * 3.5;
  }
  return out;
}

/**
 * Sparse random clicks, like embers or static. `density` = average clicks per second; each
 * click is a short decaying noise burst of `clickDecay` seconds with random amplitude.
 */
export function fillCrackle(
  out: Float32Array,
  sampleRate: number,
  density: number,
  seed = 1,
  clickDecay = 0.004,
): Float32Array {
  out.fill(0);
  const rand = rng(seed);
  const p = density / sampleRate;
  const decayN = Math.max(1, Math.round(clickDecay * sampleRate));
  const k = Math.exp(-5 / decayN);
  for (let i = 0; i < out.length; i++) {
    if (rand() >= p) continue;
    let amp = (0.3 + 0.7 * rand()) * (rand() < 0.5 ? -1 : 1);
    const len = Math.min(decayN * 2, out.length - i);
    for (let j = 0; j < len; j++) {
      out[i + j]! += amp * (rand() * 2 - 1);
      amp *= k;
    }
  }
  return out;
}

/**
 * Make a seamless loop: `data` holds `loopLen + fade` samples. The last `fade` samples are
 * crossfaded (equal power) into the first `fade`, and the result is the first `loopLen` samples.
 * Returns a new array of length `loopLen`.
 */
export function foldLoop(
  data: Float32Array,
  loopLen: number,
  fade: number,
): Float32Array<ArrayBuffer> {
  if (fade < 0 || loopLen + fade > data.length)
    throw new RangeError('foldLoop: not enough samples');
  const out = new Float32Array(loopLen);
  out.set(data.subarray(0, loopLen));
  for (let i = 0; i < fade; i++) {
    const x = (i + 0.5) / fade;
    const fadeIn = Math.sin((x * Math.PI) / 2);
    const fadeOut = Math.cos((x * Math.PI) / 2);
    out[i] = data[i]! * fadeIn + data[loopLen + i]! * fadeOut;
  }
  return out;
}

/** Largest absolute sample across channels. */
export function peakOf(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]!);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/** Scale all channels so the peak equals `target`. No-op on silence. Returns the gain applied. */
export function normalize(channels: readonly Float32Array[], target = 0.9): number {
  const peak = peakOf(channels);
  if (peak < 1e-9) return 1;
  const g = target / peak;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i]! *= g;
  return g;
}

/** Round `freq` so a whole number of cycles fits in `duration` (clean loops for tonal layers). */
export function loopSafeFreq(freq: number, duration: number): number {
  if (duration <= 0) return freq;
  return Math.max(1, Math.round(freq * duration)) / duration;
}

export const midiToHz = (note: number): number => 440 * 2 ** ((note - 69) / 12);
export const semitones = (freq: number, st: number): number => freq * 2 ** (st / 12);
export const dbToGain = (db: number): number => 10 ** (db / 20);
export const gainToDb = (g: number): number => (g <= 0 ? -Infinity : 20 * Math.log10(g));

/**
 * How a volume slider (0..1) maps to gain. `squared` (the default): 0.5 on the slider ≈ -12 dB,
 * which feels much closer to "half as loud". `linear`: the slider is the gain, for a game whose
 * own sliders already shape the curve.
 */
export type VolumeCurve = 'squared' | 'linear';

/**
 * Slider position (0..1) to linear gain on `curve` (default `squared`: 0.5 on the slider ≈
 * -12 dB, which feels much closer to "half as loud" than linear gain does).
 */
export function volumeToGain(volume: number, curve: VolumeCurve = 'squared'): number {
  const v = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0));
  return curve === 'linear' ? v : v * v;
}

/** Early reflections: a few sparse, seeded taps ahead of the tail (`ImpulseShape.early`). */
export interface EarlyReflections {
  /** Taps per channel. Default 6. */
  count?: number;
  /** Seconds the taps spread over from the start. Default 0.08. */
  time?: number;
  /** Level of the first tap; later ones fall off linearly. Default 0.5. */
  gain?: number;
}

/** The optional shaping of a procedural impulse past its length and decay. */
export interface ImpulseShape {
  /**
   * High-frequency damping 0..1: a one-pole lowpass on the noise that closes over the tail, so
   * the onset stays bright and the end goes dark, as in a furnished room. Default 0 (none).
   */
  damping?: number;
  /** Early reflections ahead of the tail. Default none. */
  early?: EarlyReflections;
}

/**
 * Procedural reverb impulse response: decaying seeded noise, independent per channel (stereo
 * width), with a short fade-in so the onset doesn't click. `decay` shapes the tail
 * (`(1 - t)^decay`; higher = shorter, darker room). `shape` adds damping and early reflections;
 * without it (or with damping 0 and no `early`) the samples are exactly the plain ones. Same
 * arguments, same samples.
 */
export function reverbImpulse(
  sampleRate: number,
  seconds = 2,
  decay = 3,
  seed = 1,
  channels = 2,
  shape?: ImpulseShape,
): Float32Array<ArrayBuffer>[] {
  const n = Math.max(1, Math.round(sampleRate * Math.max(0.01, seconds)));
  const fadeIn = Math.min(n, Math.max(1, Math.round(sampleRate * 0.002)));
  const damping = Math.min(1, Math.max(0, shape?.damping ?? 0));
  const early = shape?.early;
  const out: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < channels; c++) {
    const r = rng(seed * 7919 + c * 104729);
    const ch = new Float32Array(n);
    if (damping > 0) {
      // One-pole lowpass whose coefficient closes from 1 (open) to 1 - 0.95 × damping.
      let y = 0;
      for (let i = 0; i < n; i++) {
        const env = (1 - i / n) ** decay * Math.min(1, (i + 1) / fadeIn);
        const a = 1 - 0.95 * damping * (i / n);
        y += a * (r() * 2 - 1 - y);
        ch[i] = y * env;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const env = (1 - i / n) ** decay * Math.min(1, (i + 1) / fadeIn);
        ch[i] = (r() * 2 - 1) * env;
      }
    }
    if (early) addEarlyReflections(ch, sampleRate, early, seed * 15485863 + c * 32452843);
    out.push(ch);
  }
  return out;
}

/** Sparse seeded taps over `early.time`, falling off linearly from `early.gain`, random sign. */
function addEarlyReflections(
  ch: Float32Array,
  sampleRate: number,
  early: EarlyReflections,
  seed: number,
): void {
  const count = Math.max(0, Math.floor(early.count ?? 6));
  const span = Math.max(0, early.time ?? 0.08);
  const gain = early.gain ?? 0.5;
  const r = rng(seed);
  for (let k = 0; k < count; k++) {
    // Tap k sits in the k-th slice of the span, jittered inside it.
    const t = (span * (k + 0.25 + 0.5 * r())) / count;
    const i = Math.min(ch.length - 1, Math.max(0, Math.round(t * sampleRate)));
    const sign = r() < 0.5 ? -1 : 1;
    ch[i] = ch[i]! + sign * gain * (1 - k / count);
  }
}

/** The part of a `BaseAudioContext` that `impulseResponse` needs (a fake will do in tests). */
export interface BufferFactory {
  readonly sampleRate: number;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
}

export interface ImpulseResponseOptions {
  /** Impulse length in seconds. Default 2. */
  seconds?: number;
  /** Tail shape: `(1 - t)^decay`. Higher = shorter, drier. Default 3. */
  decay?: number;
  /** Noise seed. Default 1. */
  seed?: number;
  /** Default 2 (stereo width from independent channels). */
  channels?: number;
  /** High-frequency damping 0..1 over the tail (`ImpulseShape.damping`). Default 0. */
  damping?: number;
  /** Early reflections ahead of the tail (`ImpulseShape.early`). Default none. */
  early?: EarlyReflections;
}

/**
 * A procedural reverb impulse as an `AudioBuffer` on `ctx` (a `ConvolverNode.buffer`), built from
 * `reverbImpulse`: no asset to load. Same options, same samples.
 */
export function impulseResponse(
  ctx: BufferFactory,
  opts: ImpulseResponseOptions = {},
): AudioBuffer {
  const ir = reverbImpulse(
    ctx.sampleRate,
    opts.seconds ?? 2,
    opts.decay ?? 3,
    opts.seed ?? 1,
    opts.channels ?? 2,
    opts,
  );
  const buffer = ctx.createBuffer(ir.length, ir[0]!.length, ctx.sampleRate);
  ir.forEach((ch, i) => {
    buffer.copyToChannel(ch, i);
  });
  return buffer;
}

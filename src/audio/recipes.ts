/**
 * Generic named sound recipes. Each returns a `SoundSpec`; pass options to vary pitch,
 * length, brightness or seed. Game-specific sound design builds on these or writes specs
 * directly.
 */
import { loopSafeFreq, rng, semitones } from './dsp';
import { pluck } from './envelope';
import type { Layer, SoundSpec } from './synth';

export interface RecipeOptions {
  /** Base pitch in Hz (meaning varies per recipe). */
  pitch?: number;
  /** Overall length scale, 1 = default. */
  length?: number;
  /** 0..1, how much high end. Default 0.5. */
  brightness?: number;
  /** Seed for the random parts. */
  seed?: number;
  /** Peak level after normalisation. Default 0.8. */
  level?: number;
}

const bright = (o: RecipeOptions) => Math.min(1, Math.max(0, o.brightness ?? 0.5));

/** Electric zap: a fast falling buzz with a hissing tail. */
export function zap(o: RecipeOptions = {}): SoundSpec {
  const L = o.length ?? 1;
  const p = o.pitch ?? 1400;
  const b = bright(o);
  return {
    duration: 0.4 * L,
    normalize: o.level ?? 0.8,
    layers: [
      {
        source: { type: 'osc', wave: 'sawtooth', freq: p, freqEnd: p * 0.08, glide: 0.25 * L },
        env: { attack: 0.002, decay: 0.3 * L, sustain: 0, release: 0.02, curve: 'exp' },
        filter: { type: 'lowpass', freq: 3000 + 6000 * b, freqEnd: 600, q: 4 },
        gain: 0.6,
      },
      {
        source: { type: 'osc', wave: 'square', freq: p * 1.51, freqEnd: p * 0.11, glide: 0.2 * L },
        env: pluck(0.18 * L),
        gain: 0.25,
      },
      {
        source: { type: 'noise', color: 'white', seed: o.seed ?? 7 },
        env: { attack: 0.001, decay: 0.25 * L, sustain: 0, release: 0.02, curve: 'exp' },
        filter: { type: 'bandpass', freq: 5000 + 3000 * b, freqEnd: 900, q: 1.2 },
        gain: 0.5,
      },
    ],
  };
}

/** Bell-like chime with inharmonic partials and an FM shimmer. `pitch` is the fundamental. */
export function chime(o: RecipeOptions = {}): SoundSpec {
  const L = o.length ?? 1;
  const f = o.pitch ?? 880;
  const b = bright(o);
  const ring = 1.6 * L;
  const partials: [ratio: number, gain: number, decay: number][] = [
    [1, 1, ring],
    [2.76, 0.4 * (0.5 + b), ring * 0.6],
    [5.4, 0.2 * b, ring * 0.35],
    [8.93, 0.08 * b, ring * 0.2],
  ];
  const layers: Layer[] = partials
    .filter(([ratio]) => f * ratio < 18000)
    .map(([ratio, gain, decay]) => ({
      source: { type: 'osc', wave: 'sine', freq: f * ratio },
      env: pluck(decay, 0.003),
      gain,
    }));
  layers.push({
    source: { type: 'osc', wave: 'sine', freq: f, fm: { ratio: 3.5, index: 1.5 * b, indexEnd: 0 } },
    env: pluck(ring * 0.5, 0.003),
    gain: 0.3,
  });
  return { duration: ring + 0.05, normalize: o.level ?? 0.8, layers };
}

/** Low, soft impact: a falling sine body plus a muffled noise knock. */
export function thud(o: RecipeOptions = {}): SoundSpec {
  const L = o.length ?? 1;
  const p = o.pitch ?? 110;
  const b = bright(o);
  return {
    duration: 0.5 * L,
    normalize: o.level ?? 0.85,
    layers: [
      {
        source: { type: 'osc', wave: 'sine', freq: p, freqEnd: p * 0.4, glide: 0.25 * L },
        env: pluck(0.4 * L, 0.003),
        gain: 1,
      },
      {
        source: { type: 'noise', color: 'brown', seed: o.seed ?? 3 },
        env: pluck(0.08 * L, 0.001),
        filter: { type: 'lowpass', freq: 300 + 1500 * b, q: 0.7 },
        gain: 0.7,
      },
    ],
  };
}

/** Short UI tick. `pitch` sets the tone (higher = lighter). */
export function click(o: RecipeOptions = {}): SoundSpec {
  const p = o.pitch ?? 1800;
  const b = bright(o);
  return {
    duration: 0.06 * (o.length ?? 1),
    normalize: o.level ?? 0.6,
    layers: [
      {
        source: { type: 'osc', wave: 'triangle', freq: p, freqEnd: p * 0.7 },
        env: pluck(0.03, 0.001),
        gain: 0.8,
      },
      {
        source: { type: 'noise', color: 'white', seed: o.seed ?? 11 },
        env: pluck(0.01, 0.0005),
        filter: { type: 'highpass', freq: 2000 + 4000 * b },
        gain: 0.4 * (0.5 + b),
      },
    ],
  };
}

/** Rising (or falling) airy sweep, for transitions and panels. */
export function whoosh(o: RecipeOptions & { direction?: 'up' | 'down' } = {}): SoundSpec {
  const L = o.length ?? 1;
  const b = bright(o);
  const lo = 250;
  const hi = 1800 + 3000 * b;
  const up = (o.direction ?? 'up') === 'up';
  return {
    duration: 0.7 * L,
    normalize: o.level ?? 0.7,
    layers: [
      {
        source: { type: 'noise', color: 'pink', seed: o.seed ?? 5 },
        env: { attack: 0.3 * L, decay: 0.3 * L, sustain: 0, release: 0.05, curve: 'linear' },
        filter: { type: 'bandpass', freq: up ? lo : hi, freqEnd: up ? hi : lo, q: 1.5 },
        gain: 1,
      },
    ],
  };
}

/** A scatter of tiny high plinks across the stereo field, like glints or magic. */
export function sparkle(o: RecipeOptions & { count?: number } = {}): SoundSpec {
  const L = o.length ?? 1;
  const rand = rng(o.seed ?? 21);
  const base = o.pitch ?? 1760;
  const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19];
  const count = o.count ?? 9;
  const span = 0.5 * L;
  const layers: Layer[] = [];
  for (let i = 0; i < count; i++) {
    const st = scale[Math.floor(rand() * scale.length)]!;
    layers.push({
      source: { type: 'osc', wave: 'sine', freq: semitones(base, st) },
      env: pluck(0.12 + 0.15 * rand(), 0.002),
      start: (i / count) * span * (0.7 + 0.3 * rand()),
      gain: 0.35 + 0.4 * rand(),
      pan: rand() * 1.6 - 0.8,
    });
  }
  return { duration: span + 0.35, normalize: o.level ?? 0.7, channels: 2, layers };
}

/**
 * Seamless loop of crackling: sparse clicks over a faint low rumble. Fire, static, sparks.
 * `pitch` moves the click band's centre.
 */
export function crackleLoop(o: RecipeOptions & { density?: number } = {}): SoundSpec {
  const dur = 4 * (o.length ?? 1);
  const b = bright(o);
  const hold = { attack: 0.005, decay: 0, sustain: 1, release: 0.01, curve: 'linear' as const };
  return {
    duration: dur,
    loop: { crossfade: 0.25 },
    normalize: o.level ?? 0.6,
    layers: [
      {
        source: { type: 'crackle', density: o.density ?? 25, seed: o.seed ?? 13 },
        env: hold,
        filter: { type: 'bandpass', freq: o.pitch ?? 1500 + 2500 * b, q: 0.6 },
        gain: 1,
      },
      {
        source: { type: 'noise', color: 'brown', seed: (o.seed ?? 13) + 1 },
        env: hold,
        filter: { type: 'lowpass', freq: 220 },
        gain: 0.25,
      },
    ],
  };
}

/**
 * Seamless loop of a soft sustained chord (root, fifth, octave) with slow movement. Ambience
 * and tension beds. Frequencies are snapped so every layer completes whole cycles per loop.
 */
export function dronePad(o: RecipeOptions & { chord?: readonly number[] } = {}): SoundSpec {
  const dur = 8 * (o.length ?? 1);
  const root = o.pitch ?? 110;
  const b = bright(o);
  const chord = o.chord ?? [0, 7, 12];
  const hold = { attack: 0.005, decay: 0, sustain: 1, release: 0.01, curve: 'linear' as const };
  const layers: Layer[] = [];
  chord.forEach((st, i) => {
    const f = semitones(root, st);
    for (const [k, detune] of [
      [0, 1],
      [1, 1.004],
    ] as const) {
      layers.push({
        source: {
          type: 'osc',
          wave: k === 0 ? 'sawtooth' : 'triangle',
          freq: loopSafeFreq(f * detune, dur),
        },
        env: hold,
        filter: { type: 'lowpass', freq: 500 + 1500 * b, q: 0.5 },
        gain: (k === 0 ? 0.35 : 0.5) / (1 + i * 0.4),
        tremolo: { rate: loopSafeFreq(0.125 * (i + 1), dur), depth: 0.3 },
        pan: chord.length > 1 ? ((i / (chord.length - 1)) * 2 - 1) * 0.5 * (k === 0 ? 1 : -1) : 0,
      });
    }
  });
  return {
    duration: dur,
    loop: { crossfade: 0.5 },
    normalize: o.level ?? 0.5,
    channels: 2,
    layers,
  };
}

/** All recipes by name, for sound boards and data-driven sound tables. */
export const recipes = {
  zap,
  chime,
  thud,
  click,
  whoosh,
  sparkle,
  crackleLoop,
  dronePad,
} as const;

export type RecipeName = keyof typeof recipes;

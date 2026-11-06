/**
 * Ducking: while anything plays on a trigger bus (dialogue on `ui`), the target bus (music)
 * drops by `amount`, with an attack and a release. The level is a linear envelope advanced by
 * `update(dt)`; the target bus's gain is rewritten from the mixer's settings so it keeps
 * following `setVolume` and `setMuted`.
 */
import { type AudioEngine, busGain, type OutputBus, type Voice } from './audio';

export interface DuckerOptions {
  /** Bus whose activity ducks the target. */
  trigger: OutputBus;
  /** Bus that is lowered. */
  target: OutputBus;
  /** Fraction of the target's gain removed when fully ducked, 0..1. Default 0.6. */
  amount?: number;
  /** Seconds from idle to fully ducked. Default 0.1. */
  attack?: number;
  /** Seconds from fully ducked back to idle. Default 0.6. */
  release?: number;
  /**
   * Sidechain threshold in dB. When set (and the context has `createAnalyser`), an analyser on
   * the trigger bus counts as active while its RMS is above this level, so voices nobody passed
   * to `watch` still duck. Off by default: activity comes from `watch`.
   */
  threshold?: number;
}

export interface Ducker {
  /** Count `voice` as activity on the trigger bus while it plays. Returns the voice. */
  watch<V extends Voice>(voice: V): V;
  /** Advance the envelope and write the target bus gain. Call once per frame. */
  update(dt: number): void;
  /** True while the trigger bus is active (a watched voice plays, or the sidechain is above threshold). */
  readonly active: boolean;
  /** Duck envelope 0 (idle) .. 1 (fully ducked). */
  readonly level: number;
  /** Multiplier applied to the target bus right now, `1 - amount × level`. */
  readonly gain: number;
  /** Restore the target bus and stop. */
  dispose(): void;
}

const ANALYSER_SIZE = 256;

export function createDucker(mixer: AudioEngine, opts: DuckerOptions): Ducker {
  const amount = Math.min(1, Math.max(0, opts.amount ?? 0.6));
  const attack = Math.max(0.001, opts.attack ?? 0.1);
  const release = Math.max(0.001, opts.release ?? 0.6);
  const threshold = opts.threshold;
  const watched: Voice[] = [];
  let level = 0;
  let active = false;
  let analyser: AnalyserNode | null = null;
  let analyserOn: AudioContext | null = null;
  const samples = new Float32Array(ANALYSER_SIZE);
  let disposed = false;
  let lastWritten = -1;

  const unsubSettings = mixer.onSettingsChange(() => {
    // The mixer just wrote the plain bus gain; put the duck back on top.
    lastWritten = -1;
    write();
  });

  function ensureAnalyser(): void {
    const ctx = mixer.context;
    if (threshold === undefined || !ctx || analyserOn === ctx) return;
    const bus = mixer.busNode(opts.trigger);
    if (!bus || typeof ctx.createAnalyser !== 'function') return;
    const a = ctx.createAnalyser();
    a.fftSize = ANALYSER_SIZE;
    bus.connect(a);
    analyser = a;
    analyserOn = ctx;
  }

  function sidechainActive(): boolean {
    if (!analyser || threshold === undefined) return false;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
    const rms = Math.sqrt(sum / samples.length);
    return rms > 10 ** (threshold / 20);
  }

  function anyWatched(): boolean {
    // Drop finished voices in place (no allocation).
    let w = 0;
    for (let i = 0; i < watched.length; i++) {
      const v = watched[i]!;
      if (v.playing) watched[w++] = v;
    }
    watched.length = w;
    return w > 0;
  }

  function write(): void {
    const ctx = mixer.context;
    const node = mixer.busNode(opts.target);
    if (!ctx || !node) return;
    const g = busGain(mixer.settings[opts.target]) * (1 - amount * level);
    if (g === lastWritten) return;
    lastWritten = g;
    node.gain.setTargetAtTime(g, ctx.currentTime, 0.005);
  }

  return {
    watch(voice) {
      if (!disposed) watched.push(voice);
      return voice;
    },
    update(dt) {
      if (disposed) return;
      ensureAnalyser();
      active = anyWatched() || sidechainActive();
      const step = Math.max(0, dt);
      let next = active ? level + step / attack : level - step / release;
      // Snap at the ends so float residue never leaves a bus a hair below its volume.
      if (next > 1 - 1e-6) next = 1;
      else if (next < 1e-6) next = 0;
      if (next === level && lastWritten >= 0) return;
      level = next;
      write();
    },
    get active() {
      return active;
    },
    get level() {
      return level;
    },
    get gain() {
      return 1 - amount * level;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubSettings();
      level = 0;
      active = false;
      lastWritten = -1;
      write();
      analyser?.disconnect();
      analyser = null;
      watched.length = 0;
    },
  };
}

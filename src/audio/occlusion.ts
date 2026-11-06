/**
 * Occlusion (ws/audio-4): a game answers one probe per spatial voice with how much of the world
 * sits between the listener and the emitter (0 clear .. 1 occluded); the engine never casts a
 * ray. Each probed voice owns a pooled lowpass whose cutoff and gain ramp with the answer. The
 * probing is round-robin and budgeted, so a scene with many emitters costs a fixed number of
 * probes per `audio.update`. This file holds the scheduler and the curves; the nodes live in
 * `audio.ts` (`VoiceImpl.applyOcclusion`).
 */

/** The probe's answer, written in place (no allocation per probe). */
export interface OcclusionResult {
  /** 0 clear .. 1 fully occluded. Clamped. */
  amount: number;
}

/** `audio.occlusion`: the game's probe and the filter's range. */
export interface OcclusionOptions {
  /**
   * Answer how occluded the sound at `emitter` is for the ears at `listener`, into `out.amount`.
   * Called from `audio.update`, at most `budget` times per call, each voice at most once per
   * `interval` seconds. Both positions are live views; copy them if kept.
   */
  probe: (listener: ArrayLike<number>, emitter: ArrayLike<number>, out: OcclusionResult) => void;
  /** Seconds between two probes of one voice, and the ramp time of its filter. Default 0.1. */
  interval?: number;
  /** Lowpass cutoff (Hz) when clear. Default 20000. */
  openCutoff?: number;
  /** Lowpass cutoff (Hz) when fully occluded. Default 600. */
  closedCutoff?: number;
  /** Linear gain when fully occluded (1 when clear). Default 0.4. */
  closedGain?: number;
  /** Most probes per `audio.update`. Default 8. */
  budget?: number;
}

export const DEFAULT_OCCLUSION: Readonly<Required<Omit<OcclusionOptions, 'probe'>>> = {
  interval: 0.1,
  openCutoff: 20000,
  closedCutoff: 600,
  closedGain: 0.4,
  budget: 8,
};

/** What the scheduler needs from a voice (a `VoiceImpl` in `audio.ts`). */
export interface OccludableVoice {
  readonly position: ArrayLike<number>;
  /** Context time of the last probe (-Infinity before the first). */
  occlusionProbedAt: number;
  /** Ramp the voice's filter to `amount` over `ramp` seconds. */
  applyOcclusion(amount: number, cutoff: number, gain: number, ramp: number): void;
}

/** Lowpass cutoff for `amount`: log-interpolated between open and closed, so the sweep sounds even. */
export function occlusionCutoff(amount: number, open: number, closed: number): number {
  return open * (closed / open) ** amount;
}

/** Linear gain for `amount`: 1 down to `closedGain`. */
export function occlusionGain(amount: number, closedGain: number): number {
  return 1 - amount * (1 - closedGain);
}

/**
 * Round-robin probe scheduler over the engine's occludable voices. `run` walks `voices` from
 * where the last call stopped, probing those due (`interval` since their last probe) until the
 * budget is spent; the rest wait for the next `update`. Allocates nothing per call.
 */
export class OcclusionScheduler {
  private cursor = 0;
  private readonly out: OcclusionResult = { amount: 0 };

  run(
    opts: OcclusionOptions,
    listener: ArrayLike<number>,
    voices: readonly OccludableVoice[],
    now: number,
  ): number {
    const n = voices.length;
    if (n === 0) return 0;
    const interval = opts.interval ?? DEFAULT_OCCLUSION.interval;
    const budget = Math.max(1, opts.budget ?? DEFAULT_OCCLUSION.budget);
    const open = opts.openCutoff ?? DEFAULT_OCCLUSION.openCutoff;
    const closed = opts.closedCutoff ?? DEFAULT_OCCLUSION.closedCutoff;
    const closedGain = opts.closedGain ?? DEFAULT_OCCLUSION.closedGain;
    let cursor = this.cursor < n ? this.cursor : 0;
    let probed = 0;
    let visited = 0;
    while (visited < n && probed < budget) {
      const v = voices[cursor]!;
      cursor = (cursor + 1) % n;
      visited++;
      if (now - v.occlusionProbedAt < interval - 1e-9) continue;
      this.out.amount = 0;
      opts.probe(listener, v.position, this.out);
      const a = Math.min(1, Math.max(0, Number.isFinite(this.out.amount) ? this.out.amount : 0));
      v.occlusionProbedAt = now;
      v.applyOcclusion(a, occlusionCutoff(a, open, closed), occlusionGain(a, closedGain), interval);
      probed++;
      // The next call resumes after the last voice probed (skipped ones stay in line).
      this.cursor = cursor;
    }
    return probed;
  }
}

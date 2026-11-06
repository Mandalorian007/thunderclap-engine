/**
 * Round-robin-ish one-shots: footsteps, impacts, hits. Picks one of several buffers at random,
 * never the one just played, with a little pitch and gain jitter so repeats do not sound stamped.
 */
import type { AudioEngine, OutputBus, PlayOptions, Voice } from './audio';
import { dbToGain } from './dsp';

export interface VariationsOptions {
  /** Default `sfx`. */
  bus?: OutputBus;
  /** Random pitch offset in ± semitones (through `playbackRate`). Default 0. */
  pitchJitter?: number;
  /** Random level offset in ± dB. Default 0. */
  gainJitter?: number;
  /** Never play the same buffer twice in a row (with two or more buffers). Default true. */
  noRepeat?: boolean;
  /** Source of randomness in [0, 1). Default `Math.random`; tests pass their own. */
  random?: () => number;
}

export interface Variations {
  /** Play one variation. `opts.rate` and `opts.gain` are multiplied by the jitter. */
  play(opts?: PlayOptions): Voice;
  /** Index of the buffer played last, -1 before the first play. */
  readonly last: number;
  readonly count: number;
}

/** What `play` returns with no buffers: an inert voice, like the mixer's while locked. */
const SILENT: Voice = {
  stop() {},
  setGain() {},
  setRate() {},
  setPosition() {},
  setDirection() {},
  follow() {},
  sendTo() {},
  position: new Float64Array(3),
  playing: false,
};

export function createVariations(
  mixer: AudioEngine,
  buffers: readonly AudioBuffer[],
  opts: VariationsOptions = {},
): Variations {
  const bus = opts.bus ?? 'sfx';
  const pitch = Math.abs(opts.pitchJitter ?? 0);
  const gainDb = Math.abs(opts.gainJitter ?? 0);
  const noRepeat = opts.noRepeat ?? true;
  const random = opts.random ?? Math.random;
  let last = -1;

  function pick(): number {
    const n = buffers.length;
    if (n <= 1) return 0;
    if (!noRepeat || last < 0) return Math.min(n - 1, Math.floor(random() * n));
    // Uniform over the other n - 1 indices.
    const r = Math.min(n - 2, Math.floor(random() * (n - 1)));
    return r >= last ? r + 1 : r;
  }

  return {
    play(o = {}) {
      if (buffers.length === 0) return SILENT;
      const i = pick();
      last = i;
      const st = pitch > 0 ? (random() * 2 - 1) * pitch : 0;
      const db = gainDb > 0 ? (random() * 2 - 1) * gainDb : 0;
      return mixer.play(buffers[i]!, {
        ...o,
        bus: o.bus ?? bus,
        rate: (o.rate ?? 1) * 2 ** (st / 12),
        gain: (o.gain ?? 1) * dbToGain(db),
      });
    },
    get last() {
      return last;
    },
    count: buffers.length,
  };
}

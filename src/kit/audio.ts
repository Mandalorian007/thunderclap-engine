/**
 * The audio service (ws/kit): an `AudioEngine` that unlocks on the first gesture and pauses
 * while the page is hidden, its mixer persisted through the host when `mixerKey` is set.
 */

import { AudioEngine, persistMixer } from '../audio';
import type { Host } from '../host';
import type { KitPart, KitService } from './types';

/** `createKitAudio`'s dependencies. */
export interface KitAudioDeps {
  /** False: nothing unlocks it (no DOM listeners); it stays locked and silent. */
  dom: boolean;
  /** Where the mixer persists (with `mixerKey`). */
  host: Host;
  /** The key the mixer persists under: `thunderclap:<mixerKey>:audio`. Omit for in memory. */
  mixerKey?: string;
}

/** The audio engine, attached to the page (with a DOM) and persisted (with `mixerKey`). */
export function createKitAudio(deps: KitAudioDeps): AudioEngine {
  const audio = new AudioEngine();
  if (deps.dom) audio.attach();
  if (deps.mixerKey) persistMixer(audio, { game: deps.mixerKey, host: deps.host });
  return audio;
}

/** `ctx.audio`. */
export interface KitAudioFields {
  readonly audio: AudioEngine;
}

/**
 * The audio service: the loop updates it each step, the host's `background` state suspends it,
 * device loss halts it.
 */
export function withAudio(opts: { mixerKey?: string } = {}): KitService<KitAudioFields> {
  return {
    setup(core): KitPart<KitAudioFields> {
      return {
        fields: {
          audio: createKitAudio({ dom: core.dom, host: core.host, mixerKey: opts.mixerKey }),
        },
      };
    },
  };
}

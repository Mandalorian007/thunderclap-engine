import { createSaveStore, type SaveStore, type StorageLike, s } from '../save';
import {
  type AudioEngine,
  BUS_NAMES,
  DEFAULT_MIXER,
  type MixerSettings,
  sanitizeMixer,
} from './audio';

const Bus = s.object({ volume: s.number({ min: 0, max: 1 }), muted: s.boolean() });
const Mixer = s.object(
  Object.fromEntries(BUS_NAMES.map((b) => [b, Bus])) as Record<
    (typeof BUS_NAMES)[number],
    typeof Bus
  >,
);

export interface PersistMixerOptions {
  game: string;
  /** Default `audio` (key `thunderclap:<game>:audio`), separate from progress saves. */
  slot?: string;
  storage?: StorageLike | null;
  debounceMs?: number;
  autoFlush?: boolean;
}

/**
 * Load mixer settings from `engine/save`, apply them to `audio`, and save every change.
 * Returns the store (check `store.persistent` to warn about non-persistent storage) and
 * an `unbind` function.
 */
export function persistMixer(
  audio: AudioEngine,
  opts: PersistMixerOptions,
): { store: SaveStore<MixerSettings>; unbind: () => void } {
  const store = createSaveStore<MixerSettings>({
    game: opts.game,
    slot: opts.slot ?? 'audio',
    version: 1,
    defaults: () => sanitizeMixer(DEFAULT_MIXER),
    schema: (v: unknown): v is MixerSettings => Mixer.is(v),
    storage: opts.storage,
    debounceMs: opts.debounceMs ?? 300,
    autoFlush: opts.autoFlush,
  });
  audio.applySettings(store.get());
  const unbind = audio.onSettingsChange((next) => {
    store.set(sanitizeMixer(next));
  });
  return { store, unbind };
}

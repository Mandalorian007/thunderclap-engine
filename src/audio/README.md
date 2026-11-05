# engine/audio

WebAudio buses, one-shots and loops, plus a **procedural synth toolkit**: we ship no audio files, so every sound is a small declarative spec rendered once into an `AudioBuffer` with an `OfflineAudioContext`. No dependencies.

## Quick start

```ts
import { AudioEngine, persistMixer, recipes } from '@thunderclap/engine/audio';

const audio = new AudioEngine();
audio.attach();                                  // unlock on first gesture; pause while tab hidden
persistMixer(audio, { game: 'my-game' });        // volumes/mutes saved at thunderclap:my-game:audio

audio.define('zap', recipes.zap({ pitch: 1600 }));
audio.define('select', recipes.click({ pitch: 2400 }), { maxVoices: 4 });
audio.define('bed', recipes.dronePad({ pitch: 98, brightness: 0.3 }));
await audio.prepare();                           // render everything up front (no gesture needed)

audio.play('zap', { rate: 1 + Math.random() * 0.1, pan: -0.3 });   // sfx bus by default
audio.play('select', { bus: 'ui' });
const bed = audio.loop('bed', { gain: 0.6 });    // music bus by default; waits for unlock if needed
bed.stop(2);                                     // 2 s fade-out

audio.setVolume('music', 0.5);  audio.toggleMuted('master');
audio.settings;                                  // { master|music|sfx|ui: { volume 0..1, muted } }
```

## Unlock and the iframe
- The `AudioContext` is created **inside the first user gesture** (`pointerdown`, `keydown`, `touchend`, …) on `window`, then resumed. Until then `state === 'locked'`.
- While locked/suspended, `play()` drops one-shots (returns an inert `Voice`): a click sound arriving late is wrong. `loop()` voices are queued and start on unlock.
- iOS: a 1-sample silent buffer is played inside the gesture to fully open output.
- `attach({ pauseWhenHidden: true })` suspends the context while the tab is hidden. `suspend()` / `resume()` for game pause.
- No WebAudio → `state === 'unavailable'`; every call is a silent no-op. Show a muted icon via `onStateChange`.

## Buses
`master` ← `music`, `sfx`, `ui`. Slider `volume` 0..1 maps to gain as `v²` (0.5 ≈ -12 dB). Changes ramp over ~15 ms (no zipper noise). `onSettingsChange` fires on every change; `persistMixer` uses it to write through `engine/save`.

**Master limiter** (on by default): `master` → `DynamicsCompressorNode` → output. The defaults (`DEFAULT_LIMITER`) are threshold -1 dB, knee 0, ratio 20, attack 3 ms and release 250 ms, so it only touches peaks that would clip, such as stacked one-shots. Change it with `new AudioEngine({ limiter: { threshold: -3 } })` or turn it off with `limiter: false`. `audio.limiter` exposes the node. Where the node type is missing, master connects straight to the output.

**Reverb** (off by default): one shared `ConvolverNode` whose impulse is procedural seeded noise (`reverbImpulse`, so no files). Each output bus feeds it through a send gain taken after the bus volume, and the wet return goes into `master`.

```ts
const audio = new AudioEngine({ reverb: { seconds: 2.5, decay: 3, seed: 4, wet: 0.8 } });
audio.setReverbSend('sfx', 0.4);              // linear; defaults music 0.2, sfx 0.25, ui 0
audio.setReverb({ seconds: 1.2, decay: 5 });  // new room (renders a new impulse; do it on scene change)
audio.setReverb(null);                        // off; send levels are remembered
```

Both are safe to call before unlock, and the graph is built with the buses. Where `createConvolver` is missing, reverb is a no-op.

## Voices
`play`/`loop` return a `Voice`: `stop(fade?)`, `setGain(g, ramp?)`, `setRate(r, ramp?)`, `playing`. Each named sound has `maxVoices` (default 8); the oldest is stolen past that. `stopAll(fade?, bus?)`. Options: `bus, gain, rate, detune (cents), pan, delay, fadeIn`.

One-shots of a sound not yet rendered are rendered on demand and dropped if that takes > 150 ms; call `prepare()` at boot to avoid that.

## Synth toolkit

A `SoundSpec` is data:

```ts
const blip: SoundSpec = {
  duration: 0.3,
  normalize: 0.8,                         // peak-normalise (optional)
  layers: [
    { source: { type: 'osc', wave: 'square', freq: 880, freqEnd: 440, glide: 0.1 },
      env: pluck(0.25),                   // or { attack, hold?, decay, sustain, release, curve }
      filter: { type: 'lowpass', freq: 4000, freqEnd: 800, q: 2 } },
    { source: { type: 'noise', color: 'pink', seed: 3 }, env: pluck(0.05), gain: 0.3, pan: 0.4 },
  ],
};
audio.define('blip', blip);
```

- **Sources**: `osc` (`sine|square|sawtooth|triangle`, glide `freq → freqEnd` exp/linear, `detune`, `vibrato {rate, depth cents}`, `fm {ratio, index, indexEnd}` for bells/metal), `noise` (`white|pink|brown`, seeded), `crackle` (sparse seeded clicks, `density` per second).
- **Per layer**: `env`, `gain`, `start`, `gate` (note-off time; default lets the release finish inside `duration`), `pan`, `filter` (one or a chain of biquads, each with optional exp sweep), `tremolo {rate, depth}`.
- **Loops**: `loop: { crossfade }` renders extra tail and folds it into the head (equal-power) so the buffer loops seamlessly. For tonal layers use `loopSafeFreq(f, duration)` so each oscillator completes whole cycles.
- `validateSpec(spec)` lists problems (layers running past `duration`, out-of-range frequencies, …). `renderSound` warns with it in dev.
- Deterministic: same spec + seeds → same samples.

### Recipes (generic)
`zap, chime, thud, click, whoosh({direction}), sparkle({count}), crackleLoop({density}), dronePad({chord})`. All take `{ pitch, length, brightness 0..1, seed, level }`. They return specs, so you can tweak one before defining it: `{ ...recipes.chime({ pitch: 660 }), normalize: 0.5 }`.

Measured in Chromium: all eight render in ~80 ms total (drone pad, the heaviest, ~50 ms).

### Pure helpers (tested in Node)
`envelopeSegments / envelopeValueAt / scheduleEnvelope` (one source of truth for envelope maths and the AudioParam automation), `reverbImpulse`, `rng`, `fillNoise`, `fillCrackle`, `foldLoop`, `normalize`, `peakOf`, `loopSafeFreq`, `midiToHz`, `semitones`, `dbToGain`, `gainToDb`, `volumeToGain`.

## Testing
`AudioEngine` takes `createContext` / `createOffline` factories (the `OfflineContextFactory` type is exported), so the unlock/bus/voice logic is tested with a fake context (`audio.test.ts`). Offline rendering needs a browser; it was checked in headless Chromium (no NaNs, one-shots start and end silent, loops continuous at the wrap).

## Types and constants

- **Engine**: `new AudioEngine(opts?: AudioEngineOptions)` (`createContext`, `createOffline`, `settings`, `limiter: boolean | LimiterOptions`, `reverb: ReverbOptions | null`); `attach(opts?: AttachAudioOptions)` takes `{ target?, pauseWhenHidden? }` and returns detach. `AudioState` is `'locked' | 'running' | 'suspended' | 'unavailable'`. `PlayOptions` are the `play`/`loop` options above; `Voice` is what they return.
- **Mixer**: `BUS_NAMES` (`master`, `music`, `sfx`, `ui`) and `BusName`; `OutputBus` is every bus but `master`. `MixerSettings` maps each bus to `BusSettings` (`{ volume, muted }`); `DEFAULT_MIXER` is 0.8 / 0.7 / 0.9 / 0.8, unmuted. `sanitizeMixer(input)` clamps and fills any object into valid settings; `busGain(settings)` is the effective linear gain. `DEFAULT_LIMITER` and `DEFAULT_REVERB_SENDS` are the defaults quoted above.
- **Persistence**: `persistMixer(audio, opts: PersistMixerOptions)` (`{ game, slot?, host?, storage?, debounceMs?, autoFlush? }`) returns `{ store, unbind }`.
- **Synth specs**: `SoundSpec` holds `Layer`s; a layer's `source` is a `Source` (`OscSource` with a `Wave`, `NoiseSource` with a `NoiseColor`, or `CrackleSource`), its `filter` one or more `FilterSpec`s and its `env` an `Envelope`. `Segment` is one envelope breakpoint (`{ t, v, ramp }`); `envelopeLength(env, gate)` is an envelope's total length. `OfflineContextFactory` is the offline renderer factory `renderSound` and the engine take.
- **Recipes**: `recipes` maps each `RecipeName` to its function; every recipe takes `RecipeOptions` (`{ pitch, length, brightness, seed, level }`, plus the per-recipe extras listed above).

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
`play`/`loop` return a `Voice`: `stop(fade?)`, `setGain(g, ramp?)`, `setRate(r, ramp?)`, `setPosition(x, y, z)`, `setDirection(x, y, z)`, `playing`. Each named sound has `maxVoices` (default 8); the oldest is stolen past that. `stopAll(fade?, bus?)`. Options: `bus, gain, rate, detune (cents), pan, at, spatial, delay, fadeIn` (`pan`, `at` and `spatial` under *Spatial audio*).

One-shots of a sound not yet rendered are rendered on demand and dropped if that takes > 150 ms; call `prepare()` at boot to avoid that.

## Spatial audio

A sound can play *somewhere*: the listener follows the camera, an emitter sits at a world point, and WebAudio does distance and direction.

```ts
// 3D: once per frame, before playing or moving voices.
audio.listener.fromCamera(ctx.camera);          // or listener.set([x, y, z], forward, up?)

const torch = audio.loop('crackle', {
  at: [12, 1, -4],                                // world units, same space as the camera
  spatial: { refDistance: 2, maxDistance: 40, rolloff: 'linear' },
});
torch.setPosition(x, y, z);                       // moves it; no allocation, call every frame

// 2D shorthand: stereo only, -1 left .. 1 right.
audio.play('zap', { pan: (cellX / cols) * 2 - 1 });
```

- **Listener.** `audio.listener` is a `SpatialListener`. `set(position, forward, up = [0, 1, 0])` and `fromCamera(camera)` write the context's `AudioListener` (its `positionX`… AudioParams, or the deprecated `setPosition` / `setOrientation` on older Safari). `fromCamera` takes any `CameraLike` (`{ view, position }`, a column-major world→view matrix and the eye): position from `camera.position`, forward = minus the view's third row, up = its second, so the renderer's `Camera` works as is. A pose set before unlock is applied when the context is built. `listener.position`, `forward` and `up` read the current pose. Nothing allocates.
- **Emitters.** `PlayOptions.at` routes the voice gain → `PannerNode` → bus. `PlayOptions.spatial` (`SpatialOptions`) sets `refDistance` (default 1), `maxDistance` (10000), `rolloff: Rolloff` (`'linear' | 'inverse' | 'exponential'`, default `'inverse'`), `rolloffFactor` (1), `panningModel` (`'equalpower'` by default; `'HRTF'` for binaural on headphones and headsets), `cone: ConeOptions` (`{ inner, outer, outerGain }`, degrees) and `direction` (`[1, 0, 0]` by default). `Voice.setPosition(x, y, z)` and `Voice.setDirection(x, y, z)` write the voice's panner in place; on a voice still waiting for unlock they are kept and applied at start; on a non-spatial voice they do nothing. No occlusion: what is between emitter and listener does not matter.
- **Pool.** Each playing spatial voice holds one panner; when it ends the panner is disconnected and returned, and the next spatial voice reuses it with its own options (`audio.pooledPanners` counts the idle ones). `dispose()` drops the pool.
- **2D.** `PlayOptions.pan` goes through a `StereoPannerNode`, for a flat game that wants a sound from one side of the board. `at` and `pan` are exclusive; when both are given, `at` wins.
- Where `createPanner` is missing, a spatial voice plays dry into its bus.

## Music

A beat grid over the mixer's `music` bus: looping stems that start sample-accurately on the next beat or bar from the context clock, grouped in layers and crossfaded by `fadeBeats` or by an intensity level. Stems are `AudioBuffer`s (synth-rendered, so still no files) whose length is a whole number of bars.

```ts
import { createMusic } from '@thunderclap/engine/audio';

const music = createMusic(audio, { bpm: 120, beatsPerBar: 4 });        // a 2 s bar
music.add({ name: 'pad', buffer: audio.buffer('pad')!, layer: 'pad' });
music.add({ name: 'drums-low', buffer: lowBuf, layer: 'drums', intensity: [0, 0.5] });
music.add({ name: 'drums-high', buffer: highBuf, layer: 'drums', intensity: [0.5, 1] });
music.play('pad', { at: 'now' });            // joins the grid in phase
music.play('drums-low');                     // on the next bar (the default)
music.play('drums-high', { at: 'beat' });
music.setIntensity(0.7);                     // drums-low → drums-high, linear, over 1 beat
music.play({ name: 'tense', buffer: b, layer: 'pad' }, { fadeBeats: 4 });  // replaces 'pad' with a 4-beat crossfade
music.onBeat((beat, bar) => flash(beat === 0));
music.update(dt);                            // once per frame: advances beat/bar, fires onBeat
music.stop('drums', 2);  music.stop();       // a layer, or everything, fading in beats
```

- **Grid.** The origin is the context time of the first `play` (or `update`) after unlock. `beat` (in the bar, 0-based), `bar`, `totalBeats`, `beatDuration`, `nextBeatTime()` and `nextBarTime()` are computed from `ctx.currentTime` and the origin, never accumulated from `dt`, so they do not drift; `update` fires `onBeat` once for every beat crossed since the last call (a long frame skips none). A suspended context pauses the grid with it.
- **Scheduling.** `MusicPlayOptions.at` is `'now' | 'beat' | 'bar'` (`MusicStart`; default `bar`). A stem starts with `AudioBufferSourceNode.start(when, offset)` where `offset` is the grid time elapsed modulo the loop length, so every stem stays in phase whenever it joins. `fadeBeats` is a linear gain ramp in beats; `gain` scales the stem.
- **Layers and intensity.** A `Stem` is `{ name, buffer, layer?, intensity? }` (layer defaults to the name). Within a layer, stems with an `intensity: [lo, hi]` range are mixed by `setIntensity(level)`: full gain inside the range, a linear crossfade between one stem's `hi` and the next's `lo` (sorted by `lo`; a gap or an overlap is the crossfade region, touching ranges switch hard), so the layer's gains always sum to 1 (`intensityGains(ranges, level, out)` is that pure function). A stem without a range replaces the layer's other rangeless stem when played, with a `fadeBeats` crossfade (default 1 beat). `intensity` reads the level, `gain(name)` a stem's current target gain, `playing` the names on now. `MusicOptions.intensityFadeBeats` (default 1) is the crossfade length of `setIntensity`.
- **Before unlock** `play` queues; the stems start together when the context runs. Music owns its source nodes (not voices), so `audio.stopAll` and `voiceCount` do not see them: use `music.stop()` / `music.dispose()`.

## Variations

Footsteps, impacts, hits: one of several buffers at random, never the one just played, with a little jitter so repeats do not sound stamped.

```ts
import { createVariations } from '@thunderclap/engine/audio';

const steps = createVariations(audio, [bufA, bufB, bufC], { pitchJitter: 2, gainJitter: 3 });
steps.play({ at: [x, y, z] });   // any PlayOptions; rate and gain are multiplied by the jitter
steps.last;                       // index just played, -1 before the first
```

`VariationsOptions`: `bus` (default `sfx`), `pitchJitter` in ± semitones (through `playbackRate`), `gainJitter` in ± dB, `noRepeat` (default true: uniform over the other buffers), `random` (a `() => number` in [0, 1) for tests). `Variations.play(opts?)` returns the mixer's `Voice` (inert while locked, like `audio.play`); `count` is the buffer count.

## Sends

An effect send is a parallel path from one bus through an effect and back into `master`, next to the dry path: a reverb (`ConvolverNode` on a procedural impulse) or a lowpass (`BiquadFilterNode`). A zone drives its `amount` and `cutoff` as the listener moves; the engine's own shared reverb (`setReverb`) is one room for every bus, a send is an extra one you place.

```ts
import { createSend, impulseResponse } from '@thunderclap/engine/audio';

const cave = createSend(audio, { kind: 'reverb', bus: 'sfx', seconds: 3, decay: 2 });
cave.amount = 0.6;                                    // 0..1, ramped
const muffle = createSend(audio, { kind: 'lowpass', bus: 'sfx', amount: 1, cutoff: 800 });
muffle.cutoff = 300;                                  // Hz, ramped
someNode.connect(muffle.input!);                      // anything with `connect` can feed a send directly
const ir = impulseResponse(ctx, { seconds: 2, decay: 3, seed: 1 });   // the convolver's buffer, no asset
```

`SendOptions`: `kind: SendKind` (`'reverb' | 'lowpass'`), `bus` (default `sfx`), `amount` (default 0), reverb `seconds` / `decay` / `seed`, lowpass `cutoff` (default 800) / `q` (0.7). `Send`: `amount`, `cutoff` (undefined on a reverb), `node` (the effect node, null before unlock or where the context lacks it), `input` (the send gain; the source bus is connected for you), `dispose()`. Safe before unlock: built when the context runs, remembering the values set meanwhile. `impulseResponse(ctx: BufferFactory, opts?: ImpulseResponseOptions)` (`{ seconds, decay, seed, channels }`) wraps `reverbImpulse` into an `AudioBuffer`; `BufferFactory` is the `sampleRate` + `createBuffer` slice of a context, so it runs on the test fake. The lowpass is a parallel darkened copy, not an insert: a true occlusion insert needs a per-voice send on `Voice`, which is on the wish list.

## Ducking

Dialogue lowers music: while anything plays on a trigger bus, the target bus drops by `amount`, with an attack and a release.

```ts
import { createDucker } from '@thunderclap/engine/audio';

const duck = createDucker(audio, { trigger: 'ui', target: 'music', amount: 0.7, attack: 0.05, release: 0.4 });
duck.watch(audio.play('line', { bus: 'ui' }));   // counts as activity while it plays
duck.update(dt);                                  // once per frame
duck.active; duck.level; duck.gain;               // bool, 0..1 envelope, 1 - amount × level
```

`DuckerOptions`: `trigger`, `target`, `amount` (fraction of the target's gain removed, default 0.6), `attack` (seconds to fully ducked, 0.1), `release` (0.6), `threshold` (dB; when set, an `AnalyserNode` on the trigger bus counts RMS above it as active, so unwatched voices duck too; off by default). `Ducker`: `watch(voice)` (returns the voice), `update(dt)`, `active`, `level`, `gain`, `dispose()` (restores the bus). The envelope is linear in `dt`; the target bus gain is rewritten as `busGain(settings) × gain` with a 5 ms time constant, and again after every `onSettingsChange`, so `setVolume` and `setMuted` keep working while ducked. Nothing allocates per frame.

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
`AudioEngine` takes `createContext` / `createOffline` factories (the `OfflineContextFactory` type is exported), so the unlock/bus/voice logic is tested with a fake context (`audio.test.ts`); `fake-context.test-util.ts` is the same fake with recording params, used by the music, variations, send and ducker tests. Offline rendering needs a browser; it was checked in headless Chromium (no NaNs, one-shots start and end silent, loops continuous at the wrap).

## Types and constants

- **Engine**: `new AudioEngine(opts?: AudioEngineOptions)` (`createContext`, `createOffline`, `settings`, `limiter: boolean | LimiterOptions`, `reverb: ReverbOptions | null`); `attach(opts?: AttachAudioOptions)` takes `{ target?, pauseWhenHidden? }` and returns detach. `AudioState` is `'locked' | 'running' | 'suspended' | 'unavailable'`. `PlayOptions` are the `play`/`loop` options above; `Voice` is what they return.
- **Spatial**: `SpatialListener` (`audio.listener`), `CameraLike`, `SpatialOptions`, `Rolloff` and `ConeOptions`, all described under *Spatial audio*.
- **Mixer**: `BUS_NAMES` (`master`, `music`, `sfx`, `ui`) and `BusName`; `OutputBus` is every bus but `master`. `MixerSettings` maps each bus to `BusSettings` (`{ volume, muted }`); `DEFAULT_MIXER` is 0.8 / 0.7 / 0.9 / 0.8, unmuted. `sanitizeMixer(input)` clamps and fills any object into valid settings; `busGain(settings)` is the effective linear gain. `DEFAULT_LIMITER` and `DEFAULT_REVERB_SENDS` are the defaults quoted above.
- **Persistence**: `persistMixer(audio, opts: PersistMixerOptions)` (`{ game, slot?, host?, storage?, debounceMs?, autoFlush? }`) returns `{ store, unbind }`.
- **Synth specs**: `SoundSpec` holds `Layer`s; a layer's `source` is a `Source` (`OscSource` with a `Wave`, `NoiseSource` with a `NoiseColor`, or `CrackleSource`), its `filter` one or more `FilterSpec`s and its `env` an `Envelope`. `Segment` is one envelope breakpoint (`{ t, v, ramp }`); `envelopeLength(env, gate)` is an envelope's total length. `OfflineContextFactory` is the offline renderer factory `renderSound` and the engine take.
- **Music, variations, sends, ducking**: `createMusic(mixer, opts: MusicOptions)` → `Music`, `Stem`, `MusicPlayOptions`, `MusicStart`, `intensityGains`; `createVariations(mixer, buffers, opts?: VariationsOptions)` → `Variations`; `createSend(mixer, opts: SendOptions)` → `Send`, `SendKind`, `impulseResponse`, `ImpulseResponseOptions`, `BufferFactory`; `createDucker(mixer, opts: DuckerOptions)` → `Ducker`. All described above.
- **Recipes**: `recipes` maps each `RecipeName` to its function; every recipe takes `RecipeOptions` (`{ pitch, length, brightness, seed, level }`, plus the per-recipe extras listed above).

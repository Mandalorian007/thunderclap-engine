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
`play`/`loop` return a `Voice`: `stop(fade?)`, `setGain(g, ramp?)`, `setRate(r, ramp?)`, `setPosition(x, y, z)`, `setDirection(x, y, z)`, `follow(target | null)`, `position`, `playing`. Each named sound has `maxVoices` (default 8); the oldest is stolen past that. `stopAll(fade?, bus?)`. Options: `bus, gain, rate, detune (cents), pan, at, spatial, delay, fadeIn` (`pan`, `at` and `spatial` under *Spatial audio*).

One-shots of a sound not yet rendered are rendered on demand and dropped if that takes > 150 ms; call `prepare()` at boot to avoid that.

`voice.follow(target)` makes a spatial voice (one played with `at`) read its position from `target.world`, a 3×4 row-major world matrix with the translation at floats 3, 7 and 11 (a `Transform` from `render/`, or any `FollowTarget`), on every `audio.update(dt)`, so the game stops copying positions each frame; `follow(null)` stops. `voice.position` is the emitter's world position as last set or followed (zeros on a non-spatial voice). Both are no-ops on a non-spatial voice.

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

## Zones

A 3D space sounds like a place: walking into a cave raises the reverb and brings in a drip loop, leaving it fades both out. `audio.zones` (an `AudioZones`) holds regions of the world; `audio.update(dt)` weighs the listener against each one and drives the rest. Pure bookkeeping over the existing graph: no new nodes, nothing allocated per update.

```ts
const cave = audio.zones.add({
  shape: { sphere: { center: [40, 2, -8], radius: 6 } },   // or { box: { center, halfExtents } }
  feather: 2,                                               // weight 1 → 0 over 2 units outside the shape
  ambient: { sound: 'drip', bus: 'sfx', gain: 0.6 },        // one loop per zone, started lazily
  reverbSend: { sfx: 0.9, music: 0.5 },                     // while inside
  fade: 0.5,                                                // ramp seconds; also the silence before the loop stops
});
// Each frame, after the camera moved (createGame does the update call for you):
audio.listener.fromCamera(camera);
audio.update(dt);
audio.zones.weights();   // [1] inside, smoothstep to [0] across the feather; the same array every call
cave.weight; cave.ambientGain; cave.voice;
audio.zones.remove(cave); // fades its loop out over `fade`
```

- **Weight.** `zoneWeight(desc, position)` (pure, exported): 1 inside the shape, smoothstep to 0 at `feather` world units outside it (default 1; 0 is a hard edge). A box measures the distance to its nearest face, edge or corner. `update(dt, listenerPosition?)` defaults to `audio.listener.position`.
- **Ambient.** The first update with a weight above 0 starts `audio.loop(sound, { bus, gain: 0, fadeIn: 0 })` (bus default `sfx`); its gain moves linearly towards `weight × gain` at `gain / fade` per second and is written through `setGain` only when it changed by more than 1e-3. Once the weight has been 0 for `fade` seconds the voice is stopped and a later visit starts a new one. Before unlock the loop is queued like any other, so the ramp is already at its value when sound starts.
- **Reverb.** Per bus the largest `weight × send` over the zones is the zones' contribution, and `max(base, zones)` reaches the send node, where `base` is what `setReverbSend` or the reverb options set (so the game's own sends keep working and a zone can only add room, never dry one out). The node is written only when the value moves by more than 1e-3. `audio.reverbSendLevels` stays the base; `audio.effectiveReverbSendLevels` is what the graph has.
- **Safe anywhere.** Before unlock and when audio is unavailable the weights, gains and sends still compute; nothing plays. `AudioZoneHost` is the slice of the engine `AudioZones` is built on (`listener`, `loop`, `setZoneReverbSend`), for tests.
- `createGame`'s loop calls `audio.update(dt)` after input and pad navigation, before the hooks and scenes, in both the fixed-step and `sim: false` paths. Harness: `zones.html`.

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
- **Spatial**: `SpatialListener` (`audio.listener`), `CameraLike`, `SpatialOptions`, `Rolloff` and `ConeOptions`, all described under *Spatial audio*; `FollowTarget` (`{ world }`) is what `Voice.follow` takes.
- **Zones**: `AudioZones` (`audio.zones`) with `add(desc: AudioZoneDesc): AudioZone`, `remove(zone)`, `update(dt, listenerPosition?)`, `weights()`, `size`; `ZoneShape` is the sphere-or-box shape; `zoneWeight(desc, position)` is the pure weight; `AudioZoneHost` is the engine slice the class takes. All under *Zones*.
- **Mixer**: `BUS_NAMES` (`master`, `music`, `sfx`, `ui`) and `BusName`; `OutputBus` is every bus but `master`. `MixerSettings` maps each bus to `BusSettings` (`{ volume, muted }`); `DEFAULT_MIXER` is 0.8 / 0.7 / 0.9 / 0.8, unmuted. `sanitizeMixer(input)` clamps and fills any object into valid settings; `busGain(settings)` is the effective linear gain. `DEFAULT_LIMITER` and `DEFAULT_REVERB_SENDS` are the defaults quoted above.
- **Persistence**: `persistMixer(audio, opts: PersistMixerOptions)` (`{ game, slot?, host?, storage?, debounceMs?, autoFlush? }`) returns `{ store, unbind }`.
- **Synth specs**: `SoundSpec` holds `Layer`s; a layer's `source` is a `Source` (`OscSource` with a `Wave`, `NoiseSource` with a `NoiseColor`, or `CrackleSource`), its `filter` one or more `FilterSpec`s and its `env` an `Envelope`. `Segment` is one envelope breakpoint (`{ t, v, ramp }`); `envelopeLength(env, gate)` is an envelope's total length. `OfflineContextFactory` is the offline renderer factory `renderSound` and the engine take.
- **Recipes**: `recipes` maps each `RecipeName` to its function; every recipe takes `RecipeOptions` (`{ pitch, length, brightness, seed, level }`, plus the per-recipe extras listed above).

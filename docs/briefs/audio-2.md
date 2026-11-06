# Brief: ws/audio-2

Read `docs/briefs/common.md` first, then DECISIONS E-015 (quality bar), E-021; `src/audio/README.md` whole, `src/audio/audio.ts` (the mixer: buses, `play`, `Voice`, how it is driven per frame and how it fakes `AudioContext` in tests), `src/audio/synth.ts`, `src/audio/recipes.ts`, `src/audio/envelope.ts`, `src/audio/dsp.ts`, `src/audio/audio.test.ts` (the fake context pattern). Do not read `persist.ts` beyond its exports.

## Goal

The second half of a game audio toolkit: a music layer that crossfades stems on a beat grid, a one-liner for footsteps and impacts that picks a variation and never repeats the last one, a reverb/occlusion send a zone can drive, and a ducking rule so dialogue lowers music. All on top of the existing mixer and buses; nothing about zones (ws/audio-zones owns `src/audio/zones.ts` and is landing).

STATUS row, *done when*: `createMusic(mixer, { bpm, beatsPerBar?, bus? })` → `Music { play(stem, { layer?, fadeBeats?, at: 'now' | 'beat' | 'bar' }), stop(layer?, fadeBeats?), setIntensity(level: 0..1) (crossfades layered stems by their declared `intensity` range), beat, bar, onBeat(cb), update(dt) }` with sample-accurate scheduling from the context clock; `createVariations(mixer, buffers[], { bus?, pitchJitter?, gainJitter?, noRepeat? })` → `Variations { play(opts?) → Voice, last }`; `createSend(mixer, { kind: 'reverb' | 'lowpass', bus? })` → `Send { amount: 0..1, cutoff?, node }` wired as a parallel bus with the existing `ConvolverNode`/`BiquadFilterNode` (an impulse response built procedurally by `impulseResponse(ctx, { seconds, decay })` in `dsp.ts`: no asset); `createDucker(mixer, { trigger: Bus, target: Bus, amount, attack, release })` → `Ducker { update(dt), active }`; unit tests against the fake context (schedules land on beats, intensity crossfade gains sum to 1, variations never repeat, ducker gain curve); harness `music.html` on the matrix; documented.

## Scope

- `src/audio/music.ts`: stems are `AudioBuffer`s registered with `{ name, buffer, layer, intensity: [lo, hi] }`; loops aligned to the bar via `AudioBufferSourceNode.start(when, offset)`; `fadeBeats` uses linear ramps on gain nodes; `update(dt)` advances `beat`/`bar` from `ctx.currentTime` and fires `onBeat` once per beat (no drift: compute from the start time, do not accumulate `dt`).
- `src/audio/variations.ts`: picks uniformly among the buffers except `last`; `pitchJitter` in semitones via `playbackRate`; `gainJitter` in dB.
- `src/audio/send.ts` + `dsp.ts` `impulseResponse`: a send is a bus the game routes voices to with `mixer` (read how buses connect; add a `sendTo(bus, amount)` on `Voice` only if a one-line hook exists, otherwise expose the send's `node` and document the connection).
- `src/audio/duck.ts`: reads the trigger bus's analyser or voice count (choose what the mixer already exposes; prefer "any voice playing on the trigger bus"), ramps the target bus gain.
- Tests with the fake context in `audio.test.ts`'s style: `music.test.ts`, `variations.test.ts`, `send.test.ts`, `duck.test.ts`.
- Harness `harness/music.html` + `music.ts` + `music-state.ts`: synth-generated stems (use `synth.ts`), an intensity slider, a footstep button; state exposes `beat`, `bar`, `intensity`, `layerGains`, `lastVariation`, `ducked`; api `setIntensity`, `step`, `speak`. `e2e/music.spec.ts`: beat advances under a fake clock or real time with tolerance; intensity 0 → 1 moves gains; `speak` ducks.
- Docs: audio README *Music*, *Variations*, *Sends*, *Ducking*; CHANGELOG one line; ARCHITECTURE *Audio* one sentence; root README harness list item.

## Files owned

`src/audio/music.ts`, `variations.ts`, `send.ts`, `duck.ts`, their tests, `src/audio/dsp.ts` (one exported function appended), `src/audio/index.ts` (append), `src/audio/README.md`, `harness/music.*`, `e2e/music.spec.ts`, root `README.md` (harness list item), `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`.

Branch from `main` (5e6177a or later). Running alongside: ws/audio-zones (landing; `src/audio/zones.ts`, `audio.ts`: do not edit `audio.ts`; if you need a hook there, document the wish instead), ws/ui-widgets (`src/ui`). `src/audio/index.ts`: append only.

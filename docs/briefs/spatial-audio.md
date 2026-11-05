# Brief: ws/spatial-audio

Read `docs/briefs/common.md` first, then `docs/VISION.md` (the engine owns audio; Forgewilds is a 3D world, The Last Rune pans by board position), DECISIONS E-013; `ARCHITECTURE.md` *Audio*; `src/audio/README.md`; `src/audio/audio.ts` (`AudioEngine`, `PlayOptions`, `Voice`, buses), `src/audio/index.ts`.

## Goal

A sound plays *somewhere*: a listener follows the camera, an emitter sits at a world point, and distance, direction and optional occlusion-free rolloff come out of the engine with no game code beyond a position.

STATUS row, *done when*: `audio.listener` (position, orientation) and `PlayOptions.at` / `Voice.setPosition` through a `PannerNode` per spatial voice, with a 2D stereo-pan shorthand; unit tests on a fake `AudioContext`; documented.

## Scope

1. **Listener.** `audio.listener.set(position: [x,y,z], forward: [x,y,z], up?: [x,y,z])` writes the `AudioListener` (use the `positionX.value` style with a fallback to `setPosition` where unavailable). `audio.listener.fromCamera(camera)` reads `camera.position` and the view matrix's forward/up rows (the `Camera` type comes from `render/`; audio may import `render` types only if `check:boundaries` allows it today; if not, take the three vectors and leave `fromCamera` as a documented three-line snippet).
2. **Emitters.** `PlayOptions.at?: [x,y,z]` plus `spatial?: { refDistance?, maxDistance?, rolloff?: 'linear' | 'inverse' | 'exponential', cone? }` routes the voice through a `PannerNode` (HRTF off by default: `panningModel: 'equalpower'`, option to `'HRTF'`) before its bus. `Voice.setPosition(x, y, z)` updates it while playing without allocation (reuse the node). Pooled panners: one per playing spatial voice, returned on end.
3. **2D shorthand.** `PlayOptions.pan?: number` (-1..1) through a `StereoPannerNode`, for a 2D game that wants a sound to come from the left side of the board. Mutually exclusive with `at`.
4. **Tests.** A fake `AudioContext` in `src/audio/` tests (extend what `audio.test.ts` already fakes) asserting node graphs and parameter values. No harness page is required (autoplay policy makes it untestable on the matrix); a `harness/audio-probe` is optional.

## Files owned

`src/audio/**`, `ARCHITECTURE.md` *Audio* paragraph (one sentence), `CHANGELOG.md`.

Running alongside: nothing else is in `src/audio/`. If you need a camera vector helper from `render/`, write it down rather than editing `camera.ts` (ws/cull and ws/xr own it).

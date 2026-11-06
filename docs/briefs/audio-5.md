# Brief: ws/audio-5

Read `docs/briefs/common.md` first. In `docs/STATUS.md`, read the ws/audio-3 and ws/audio-4 rows, the ws/e2e-harden engine findings line (finding 1) and the ws/audio-4 wish line. Then read `src/audio/README.md` (*Ducking*, *Pause*, *Voices*), `src/audio/{duck,audio,music}.ts` with their tests, `src/audio/fake-context.test-util.ts`, and `harness/music*` with `e2e/music.spec.ts`.

## Goal

Ducking never fights a pause. Paused audio stays silent until it is resumed. A resume restores the ducked gain, not the raw one.

STATUS row, *done when*:
- **Ducker respects pause.**
  - `createDucker`'s `write()` doesn't raise a bus while the engine is paused, whether by user `pause()` or by the background flag.
  - On resume, the bus ramps to the current ducked target.
  - The first write after the context exists can't land after a pause and override it.
  - Fix the engine side so ordering doesn't matter. Don't hide the race in the ducker alone if the real gap is `AudioEngine` exposing no paused state. Add `audio.paused` (read only) if it is missing.
  - Tests (fake context):
    - Paused music stays at 0 while a line is spoken.
    - A boot write after a pause keeps 0.
    - Resume lands on the ducked gain.
- **`Voice.doppler`.** Promote the getter from `VoiceImpl` to the `Voice` interface (ws/audio-4 wish).
- **Spec.** `e2e/music.spec.ts:125` (`?pause`) has a new case: speak a line while paused, then poll that `busGains.music` stays 0. You own that spec for this case only. Run `audio`, `audio4` and `music` specs alone; all must be green.
- **Docs.** In the audio README, cover the pause and duck interaction and the types list. Add a CHANGELOG line.

## Files owned

- `src/audio/**` and its tests
- `e2e/music.spec.ts` (the new case only)
- `CHANGELOG.md`

Do not edit `harness/audio4*` or `e2e/audio4.spec.ts`, which are in train 2 through ws/e2e-harden. Also leave `demos/**` and `templates/**` alone.

Branch from `main` (the head of this brief or later). Use `E2E_PORT_OFFSET=840`. Gate per E-031.

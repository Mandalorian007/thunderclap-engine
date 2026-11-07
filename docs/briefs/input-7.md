# Brief: ws/input-7

Read `docs/briefs/common.md` first, then the ws/input-5 and ws/input-6 rows and notes in `docs/STATUS.md`. Then read:
- `src/input/README.md`, *Recording* and *Gestures*
- `src/input/{record,pointer-dispatch,gestures}.ts` and their tests

## Goal

A recording replays the gesture it captured. Today a replayed long-press or double-tap can classify differently because pointer timing is lost.

STATUS row, *done when*:

- **Capture the time.** Recorded pointer events carry the input-6 `time`, which is the `eventTime`-shifted stamp, relative to the start of the recording.
- **Replay keeps the timing.** Replay feeds the events back on the gestures' `now` clock with those relative times, so a tap, long-press, double-tap and drag each classify the same as live.
  - Add a test for each: record live, replay into a fresh instance, and get identical gesture events.
  - Old recordings without `time` still replay, falling back to tick spacing, and a test covers it.
- **Format.** If the recording has a version field, bump it. Document the format change in the README and the CHANGELOG.

## Files owned

You own:
- `src/input/**`
- `CHANGELOG.md`

Do not edit `harness/**` or `demos/**`, unless a recording fixture there must be updated, and then fixtures only.

Branch from `main` (6fedfbf or later). Use `E2E_PORT_OFFSET=930`. Gate per E-031 with the gestures, input, input5 and look specs each run alone.

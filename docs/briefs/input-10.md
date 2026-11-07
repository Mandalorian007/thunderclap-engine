# Brief: ws/input-10

Read `docs/briefs/common.md` first. Then read the ws/input-9 and ws/core-4 rows and notes in `docs/STATUS.md`, including the two core-4 wishes this closes: *playback should anchor the first event's age at its start reading* and *input README Clock pointer to `ctx.clock`*. Then read `src/input/README.md` (*Clock*, *Recording*) and `src/input/{record,clock}*.ts` and their tests.

## Goal

A replay started at any wall time fires timed gestures on the same recorded tick as the original.

STATUS row, *done when*:

- **Anchored first event.** Playback anchors event ages to the clock reading at its first `step()`, not at creation. A long-press recorded on tick N fires on tick N, even if playback starts late or the first step is slow.
  - Unit test: start playback after a 500 ms idle on the clock; the long-press tick index still matches the recording at speed 1 and 4.
- **Clock pointer.** The input README *Clock* section says that under `createGame` the tick clock is `ctx.clock` and that the loop skips its own advance while a playback drives it. This is one paragraph, and it names core-4.
- **Unchanged.** Live input, v1/v2/v3 recordings and every existing record and replay test pass untouched.
- **Docs.** One CHANGELOG line.

## Files owned

You own:
- `src/input/**`
- `e2e/{replay,gestures}.spec.ts` and their harness pages, additive only
- `CHANGELOG.md`

Do not edit:
- `src/core/**`
- `demos/**`
- `templates/**`

Branch from `main` (56e0840 or later). ws/core-4 is in E-031 train 9. If `git merge-base --is-ancestor fc7faed origin/main` succeeds before your final gate, merge origin/main first. Use `E2E_PORT_OFFSET=1110`. Gate per E-031, with input, input5, look, replay and gestures each run alone.

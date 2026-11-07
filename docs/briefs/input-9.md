# Brief: ws/input-9

Read `docs/briefs/common.md` first. Then read the ws/input-7 and ws/input-8 rows and notes in `docs/STATUS.md`, and the two input-8 wishes this closes: *`Look` pad reads bypass recorded pads* and *`InputPlayback.speed > 1` doesn't advance a tick clock*. Then read `src/input/README.md` (*Clock*, *Look*, *Recording*) and `src/input/{look,record,clock}*.ts` and their tests.

## Goal

A recording replays exactly, at any speed, including gamepad look.

STATUS row, *done when*:

- **Look reads recorded pads.** During playback, `Look`'s gamepad stick input comes from the recorded pad state, not the live `navigator.getGamepads()`.
  - Unit test: a recording with a stick sweep replays the same yaw and pitch per tick while the live fake pad is centred.
- **Speed advances the clock.** `createInputPlayback(input, rec, { speed, clock })`: when given a tick clock, each fed tick advances it by the recorded tick spacing. `speed: 4` advances it 4 × spacing per `step()`.
  - Unit test: a long-press replayed at speed 1, 2 and 4 fires on the same recorded tick index.
- **Live input unchanged.** The default clock is still wall time. Existing record and replay tests pass untouched. A v1/v2/v3 recording still replays.
- **Docs.** Input README *Recording* and *Look* updates, one CHANGELOG line, and the wishes it closes named in the README.

## Files owned

You own:
- `src/input/**`
- `e2e/{replay,look,gestures}.spec.ts` and their harness pages, additive only
- `CHANGELOG.md`

Do not edit:
- `src/core/**` (ws/core-4 runs alongside and consumes your exports)
- `demos/**`
- `templates/**`

Branch from `main` (bd73c67 or later). If input-8 (train 7) is not yet on main, branch from `ws/input-8` at 36fae44 and merge main once `git merge-base --is-ancestor 36fae44 origin/main` succeeds. Use `E2E_PORT_OFFSET=1050`. Gate per E-031 with input, input5, look, replay and gestures each run alone.

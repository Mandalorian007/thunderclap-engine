# Brief: ws/input-8

Read these first:
- `docs/briefs/common.md`
- the ws/input-5, ws/input-6 and ws/input-7 rows and notes in `docs/STATUS.md`, including the wishes:
  - a tick-driven gesture clock
  - `Look` and `Gestures` sharing a clock
- `src/input/README.md`, *Gestures*, *Look* and *Recording*
- `src/input/{gestures,look,record}*.ts` and their tests

## Goal

Gestures and look can run on game time, so a recording replays the same gestures at any tick spacing, including a long-press fired on a held pointer.

STATUS row, *done when*:

- **Shared clock.** Add an `InputClock` type, `{ now(): number }`, plus `createTickClock()` with `advance(ms)`, which the game calls from its fixed step.
  - `createGestures({ clock })` and `createLook({ clock })` accept it.
  - The default stays `performance.now()`, unchanged.
  - Recorder and playback default to the gestures' clock, as input-7 does today.
- **Replay at any spacing.** With a tick clock, a recording replayed at half, the same, or double the live tick spacing produces the same gesture sequence on the same tick indices. That includes a long-press fired by `update()` while the pointer is held.
  - Unit test over all four gestures at the three spacings.
- **Look on the same clock.** Look's smoothing and acceleration read the shared clock. Test: with a shared tick clock, look output is identical across replay spacings.
- **Docs.**
  - Input README: a *Clock* section.
  - Types list.
  - One CHANGELOG line.
  - Note in the README which wish this closes.

## Files owned

You own:
- `src/input/**`
- `e2e/{gestures,replay,look}.spec.ts` and their harness pages, additive only
- `CHANGELOG.md`

Do not edit:
- `demos/**`
- `templates/**`

Branch from `main` (43d0a1d or later). Use `E2E_PORT_OFFSET=1000`. Gate per E-031 with gestures, input, input5, look and replay each run alone.

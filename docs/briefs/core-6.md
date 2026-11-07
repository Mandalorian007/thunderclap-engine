# Brief: ws/core-6

Read `docs/briefs/common.md` first. Then read the ws/core-4, ws/input-10 and ws/core-5 rows and notes in `docs/STATUS.md`. This brief closes two core-5 wishes:
- *`EngineCtx.clock` is typed `InputClock`, so `{ clock: ctx.clock }` doesn't typecheck*
- *real input still reaches the canvas during a mid-session replay*

Then read `src/core/game.ts`, its tests, the core README, and `createInputPlayback` in `src/input/record.ts` (read only).

## Goal

Starting a replay in a running game is one typed call, and the real player can't disturb it.

STATUS row, *done when*:

- **Typed clock.** `EngineCtx.clock` is typed as the tick clock that `createInputPlayback` accepts. `{ clock: ctx.clock }` typechecks with no cast. Remove the casts from the core README and from the core-5 test.
- **`ctx.replay(rec, opts?)`.** This installs a playback on `ctx.input`, driven by `ctx.clock`, and detaches real input the same way `opts.input.replay` does. When the recording ends or `stop()` is called, it reattaches the input to the canvas. It returns the `InputPlayback`.
  - Test: real pointer and key events during the replay don't reach `ctx.input`.
  - Test: after the replay ends, they reach it again.
  - Test: the long-press fires on its recorded tick at speed 1 and speed 4.
- **Docs.**
  - Core README: rewrite the mid-session replay note around `ctx.replay`.
  - Add the types to the types list.
  - Add one CHANGELOG line.
  - Add one ARCHITECTURE phrase to the core *Today* text.

## Files owned

You own:
- `src/core/**`
- `CHANGELOG.md`
- the one ARCHITECTURE phrase

Do not edit:
- `src/input/**` (read only). If a type needs to move into input, report that as a wish.
- `demos/**`
- `templates/**`

**Branch** from `ws/core-5` at fdc822e, which is going to E-031 train 11 or 12. Merge origin/main before your final gate. Use `E2E_PORT_OFFSET=1180`. Gate per E-031: check, snap, and the replay, core2 and lifecycle specs run alone.

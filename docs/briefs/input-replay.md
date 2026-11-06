# Brief: ws/input-replay

Read `docs/briefs/common.md` first, then DECISIONS E-011 (e2e determinism), E-021; `src/input/input.ts` (`Input`: the public feed methods `keyDown`, `keyUp`, `buttonDown`, `buttonUp`, `wheel`, `pointerAt`, `releaseAll`, `InputOptions.getGamepads`, `GamepadLike`, `update()`), `src/input/README.md` *Testing / automation*, `src/core/game.ts` (fixed-step loop: where `input.update()` is called per step, `GameOptions.input`), `e2e/fixtures.ts` (how specs reach harness state today).

## Goal

A game records everything its `Input` was fed, tick by tick, and plays it back later with the same results: for bug reports, for automated playtests, and for e2e specs that want a scripted session instead of synthetic DOM events. The recorder sits beside `Input` and never changes how `Input` evaluates bindings.

STATUS row, *done when*: `createInputRecorder(input, opts?)` → `InputRecorder { tick(), stop(): InputRecording, recording, ticks }` captures every feed call and the gamepad snapshot per `update()`; `createInputPlayback(input, recording, opts?)` → `InputPlayback { step(): boolean, done, tick, seek(tick), speed }` replays them so an identical game sees identical `pressed`/`held`/`value` per tick; `InputRecording` is plain JSON (`{ version: 1, ticks: [...] }`, deltas only, keys as strings, pads as `{ buttons: number[], axes: number[] }`); `serializeRecording`/`parseRecording` validate; `createGame({ input: { replay: InputRecording } })` runs the loop from the recording with `ctx.input` fed by it and real DOM input detached; unit tests prove record → replay equality for keys, pointer, wheel, pads and `releaseAll`; harness `replay.html` records 3 s of scripted input and replays it; documented.

## Scope

- `src/input/record.ts`: the recorder wraps the feed methods (`Input` gets a small private hook list, `onFeed`, or the recorder monkey-patches the instance methods: choose the hook; add it to `input.ts` as the only change there, with `getGamepads` wrapped so pad snapshots are captured on `update()`). Per tick: `{ t: number, k?: [string, 0|1][], b?: [number, 0|1][], p?: [x, y, inside?], w?: [dx, dy], r?: 1, g?: PadSnapshot[] }`; a tick with no events is a count run (`{ t, n }`). Zero allocations per tick when nothing happened.
- Playback feeds the same calls before each `update()`; `getGamepads` returns the recorded snapshot for that tick. `speed` is ticks per `step()` for fast-forward in tests. `done` after the last tick; `seek(0)` calls `releaseAll` first.
- `src/core/game.ts`: `GameOptions.input.replay?: InputRecording` and `GameOptions.input.record?: boolean` → `ctx.input.recorder: InputRecorder | null`; with `replay` the DOM listener is not attached and `playback.step()` runs before each fixed step. Keep the change to the `Input` construction block and the step call; nothing else in `game.ts` (ws/ergo-2d is editing `getGamepads` plumbing in the same file: add your lines next to that option, and expect a one-line conflict the integrator resolves).
- Tests: `src/input/record.test.ts` (a scripted sequence recorded on one `Input` and replayed on a second produces equal `pressed`/`held`/`released`/`value` per tick for every bound action; pads; pointer; JSON round trip; `parseRecording` rejects a bad version). `game.test.ts`: one test that `replay` drives `ctx.input` with no DOM.
- Harness `harness/replay.html` + `replay.ts` + `replay-state.ts`: a sprite moved by WASD/pad; page records a scripted 3 s session on load, then replays it; state exposes `recordedTicks`, `replayTick`, `positionAfterRecord`, `positionAfterReplay`, `equal`. `e2e/replay.spec.ts`: `equal` true on every row; recording JSON round-trips through `serializeRecording`.
- Docs: input README *Recording and replay* (format, sizes, what is not captured: gestures' DOM timing, `Look` pointer lock); core README `input.replay`/`record`; CHANGELOG one line; ARCHITECTURE *Input* one sentence.

## Files owned

`src/input/record.ts`, `src/input/record.test.ts`, `src/input/input.ts` (hook + `getGamepads` wrap only), `src/input/index.ts` (append), `src/input/README.md` (new section), `src/core/game.ts` (input option block and step call), `src/core/game.test.ts` (one test), `src/core/README.md` (one paragraph), `harness/replay.*`, `e2e/replay.spec.ts`, root `README.md` (harness list item), `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`.

Branch from `main` (0aec104 or later). Running alongside: ws/ergo-2d (`game.ts` `getGamepads` option, `src/ui/stack.ts`, render tile layer), ws/perf-overlay (`src/ui/perf.ts`), ws/billboards (`src/fx/`), ws/gesture-longpress (landing; `src/input/gestures.ts`: do not touch), ws/look-zoom (landing; `look.ts`, `follow.ts`: do not touch).

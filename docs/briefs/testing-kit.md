# Brief: ws/testing-kit

Read `docs/briefs/common.md` first. Then read:
- `docs/guide/testing-your-game.md`
- the ws/api-rest note in `docs/STATUS.md` ("`./testing` could gain a fake host and a fixed clock")
- the `package.json` `exports["./testing"]` entry and the file it points at
- `src/host/types.ts` (the `Host` shape), `src/core/README.md` (`createGame`, `ctx.clock`) and `src/input/README.md` (record and replay)

## Goal

A game author can unit-test game logic in Vitest or Node with no browser and no GPU, using only `@thunderclap/engine/testing`.

STATUS row, *done when*:

- **Fake host.** `createFakeHost(opts?)` returns a full `Host`:
  - in-memory storage
  - controllable lifecycle (`setState('background')`)
  - recording haptics
  - a settable safe area
  - fullscreen and wake-lock stubs that record their calls

  Tests: it satisfies the `Host` type; lifecycle transitions fire listeners; storage round-trips.
- **Fixed clock.** `createFixedClock(stepMs?)` returns a clock that `createGame`/`ctx.clock` accept, plus `advance(ms)` and `step(n)`. A game can then be driven tick by tick in a test.
- **Headless game.** `createTestGame(opts)` wires the fake GPU (already in `./testing`), the fake host and the fixed clock into `createGame`. It returns `{ ctx, step(n), input }`, so a test can press an action, step 10 ticks and assert state. If `createGame` cannot run without a canvas, stop and report a wish instead of patching core.
  - Test: a tiny game moves a value on an action press after N steps.
  - Test: an input recording replays to the same state.
- **Docs.**
  - Rewrite the *Unit tests* part of `docs/guide/testing-your-game.md` around these helpers; snippets must pass `check:snippets`.
  - Add a `src/testing/README.md` covering every export, so `check:docs` passes.
  - Add a CHANGELOG *Added* block.
  - Run `pnpm api:update`.

## Files owned

You own:
- new `src/testing/**`
- the `package.json` `exports["./testing"]` entry, which keeps re-exporting the fake GPU
- `docs/guide/testing-your-game.md`
- `api/testing.api.txt`, regenerated
- `CHANGELOG.md`

Do not edit `src/{core,host,input,render}/**`. They are used through their public exports only, and ws/api-core and ws/api-render are editing them. A gap there is a wish.

Branch from `origin/main`. Use `E2E_PORT_OFFSET=1310`. Gate: `pnpm check` and `snap:check`.

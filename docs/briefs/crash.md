# Brief: ws/crash

Read `docs/briefs/common.md`, E-040 in `docs/DECISIONS.md`, the ARCHITECTURE sections **Frame loop** and **Platform**, the READMEs of `src/core` and `src/platform`, and GitHub issues #5, #6 and #7 (`gh issue view N`).

## Goal

Three hardening fixes from The Last Rune. STATUS row, *done when*, each item with a unit test that fails before the fix:

1. **#5 `initGpu`.** A throwing `canvas.getContext('webgpu')` (`src/platform/gpu.ts`) is treated like a null return: the player gets the unsupported result and screen, and the thrown message is kept for diagnostics.
2. **#7 loop clock.** In `GameLoop.frame` (`src/core/loop.ts`), a throwing `now()` no longer stops the loop. The next frame is still scheduled, and the error still surfaces the same way a throwing `runFrame` does.
3. **#6 crash screen.** An opt-in engine crash screen. Port Last Rune's implementation (`~/repos/last-rune/games/last-rune/game/crash.ts` + `crash.test.ts`; read only, never touch that repo) without game nouns:
   - It is one styled card ("Something went wrong") with Reload and Keep playing.
   - It shows for a boot throw inside `createGame` (which otherwise leaves a blank page), for uncaught errors and for unhandled rejections after boot.
   - A game hook flushes the save first. The card says "progress saved" only if that flush succeeded.
   - It ignores cross-origin "Script error.", ResizeObserver loop noise, and AbortError / NotAllowedError.
   - It defers to the engine's own unsupported and device-lost screens.
   - Shape: a `createGame({ crash })` option, or an exported `installCrashScreen()`, or both if one wraps the other. Pick what fits the existing `createGame` options and say why.
   - It is additive, and off unless the game opts in.
   - It is styled like the engine's existing unsupported screen, so a game can restyle it with CSS.
   - The template (`templates/puzzle`) opts in.

e2e: one spec (new or extended) proves that the boot throw shows the card and that a getContext throw shows the unsupported screen. Last Rune's `tests/e2e/hardening.spec.ts` is the model.

## Files owned

`src/core/loop.ts`, `src/core/game.ts`, a new `src/core/crash.ts` (or under `ui/` if styling lives there; say so), `src/platform/gpu.ts`, their tests and READMEs, `templates/puzzle` (opt-in only), the e2e spec, `api/` via `pnpm api:update`, ARCHITECTURE lines, CHANGELOG `## Unreleased`.

Running alongside: ws/layout-check (`src/ui/layout.ts`) and ws/prepackage (`packages/host-electron`). Don't edit their files.

## Gate

common.md: `pnpm check`, `pnpm snap:check` at 0 px, and your spec plus `e2e/` specs touching boot/unsupported, each green on its own.

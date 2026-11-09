# Brief: ws/layout-check

Read `docs/briefs/common.md`, E-040 in `docs/DECISIONS.md`, the ARCHITECTURE layout section, `src/ui/README.md`, and GitHub issues #8, #9, #10 (`gh issue view N`).

## Goal

The layout overflow check (`src/ui/layout.ts`, around `overflows` and the `[layout] … overflows` warn) is right for shipped games. STATUS row, *done when*, each with a unit test failing before the fix:

1. **#8 dev only.** The `console.warn` no longer ships to players by default. Gate it behind a dev condition or option. Say which, and how a production bundle drops or silences it. `layout.overflows()` stays callable and accurate in every build, so a game's e2e can assert zero overflows against a production preview. Document that use in the README.
2. **#9 whole layouts.** A run of `add()` calls is judged once, on the finished layout, not on each half-built step. The check moves to a deferred pass (a microtask or the next frame), or to an explicit `layout.batch(fn)`, or both. A widget added before its column's siblings no longer warns. Each real overflow warns once, and a later real overflow is never hidden.
3. **#10 computed padding.** The check measures against each region's computed content box, not the configured padding. A game that restyles a region's padding gets neither false positives nor misses.

All additive. Existing callers keep their behaviour, apart from the fixes themselves.

## Files owned

`src/ui/layout.ts`, `src/ui/layout.test.ts`, `src/ui/README.md` (layout part), layout e2e specs, `api/` via `pnpm api:update`, ARCHITECTURE layout lines, and CHANGELOG `## Unreleased`.

Running alongside: ws/crash (`core/`, `platform/gpu.ts`) and ws/prepackage (`packages/host-electron`). Don't edit their files.

## Gate

common.md: `pnpm check`, `pnpm snap:check` at 0 px, and every layout spec on its own.

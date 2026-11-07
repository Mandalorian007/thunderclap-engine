# Brief: ws/surface-fill

Read `docs/briefs/common.md`, E-010 and E-038 in `docs/DECISIONS.md`, the ARCHITECTURE sections **Surface**, **Camera** and **Layout**, and `src/platform/README.md` and `src/ui/README.md`. GitHub issues #1 and #3 (`gh issue view 1`, `gh issue view 3`) are the asks.

Read the game-side workaround you are replacing, without checking anything out: `git -C /Users/matthewfontana/repos/last-rune show origin/main:games/last-rune/game/screen-fit.ts` (and whatever it imports, the same way). The Last Rune should be able to delete that file and get the same phone framing from the engine.

## Goal

A landscape game fills a phone instead of letterboxing, and a game can restyle selects without fighting the engine's CSS.

STATUS row, *done when*:

- **Cover / fill mode (#1).** `Surface` and `createGame` take an opt-in fit mode alongside today's letterbox (the default, unchanged). In it, the canvas covers its container (or the frame given to `setFrame`, which may then exceed the container) and the logical space is cropped to a band. Match what `screen-fit.ts` does for The Last Rune (fill bands, in whichever form fits the engine's API: a band limit so a 16:9 game never crops past its safe content). The game can read the visible logical rect; `clientToLogical` / `logicalToClient` / `containsLogical` stay correct; `Camera.fitFreeRect` and the overlay frame (`--tc-frame-*`) follow the covered canvas. The pure math goes in `platform/letterbox.ts` with unit tests.
- **Form factor (#1).** The overlay root's existing `data-form-factor` attribute is documented in `src/ui/README.md` (and in the 2D guide if a reader would look there), as the replacement for the removed `ctx.device`.
- **Select specificity (#3).** The zoomed-select rules in `src/ui/styles.ts` stop out-ranking ordinary game rules: wrap the selectors in `:where()` (or a cascade layer) so a game's `.my-panel select { … }` wins. The engine's own selects render exactly as before; `styles.test.ts` is updated.
- **Proof.** A harness page (or a query mode on an existing 2D page) shows cover mode, with an e2e spec on the matrix: on each phone row the canvas covers the viewport with no letterbox bars, the visible rect is within the band, and a tap maps to the right logical point. The 2D goldens stay at 0 px (the default mode is untouched).
- ARCHITECTURE *Surface* and *Layout* text, `src/platform/README.md`, `src/ui/README.md`, CHANGELOG `## Unreleased` *Added* (fit mode) and *Fixed* (select specificity, citing #3) lines, `api/*.api.txt` via `pnpm api:update`. Name the CHANGELOG lines with `(#1)` / `(#3)`.

## Files owned

`src/platform/surface.ts`, `src/platform/letterbox.ts` (and tests), `src/core/game.ts` (**you own it this wave**; ws/xr-fixes may change only the XR frame block's `{ present: false }` literal there), `src/ui/styles.ts` and `styles.test.ts`, `src/ui/layout.ts` (doc comments only), new harness page and spec, `src/platform/README.md`, `src/ui/README.md`, `docs/guide/2d-game.md`, ARCHITECTURE *Surface* / *Layout*, `api/`.

Running alongside: ws/publish-3 (`packages/host-electron`, `scripts/pack-smoke.mjs`, README Status, ARCHITECTURE *Package shape*) and ws/xr-fixes (`core/loop.ts`, `platform/xr-*`, `post/`, `render/renderer.ts`, `ui/world-panel/`). Don't edit their files.

## Rules

Additive only (E-036 naming: `Options` for call arguments, getters for reads). No breaking change to `setFrame`'s existing behaviour in letterbox mode. If the API shape needs a ruling, pick the smallest additive one and say why in the report.

## Gate

`pnpm check`, `pnpm snap:check` at 0 px, and your new spec plus `e2e/layout.spec.ts`, `e2e/ui.spec.ts` and `e2e/game.spec.ts` (if present) each green on their own.

# Brief: ws/kit (A3)

Read `common.md`, `wave-2.0-1.md`, E-041, `docs/design/2.0/architecture.md` P4 and §2.1, §2.19, ARCHITECTURE *Frame loop* and *createGame* sections, `src/core/README.md`, `src/core/game.ts`.

## Goal

`createGame` becomes a composer of independent services, so a game takes only what it uses and a Forge-sized client can adopt the engine piece by piece. STATUS *done when*: "1.x `createGame` calls unchanged; templates and The Last Rune harness pixel-identical; a 2D-only kit import measurably smaller."

1. Split what `createGame` wires today (surface, GPU init, renderer, post, overlay UI, audio, input, gestures/pointers, XR, save, sim loop, analytics hooks, crash screen) into services, each constructible alone with an explicit dependency list (no hidden globals).
2. A lean composer (e.g. `@thunderclap-engine/engine/kit`: `composeGame({ ... })` or `createGame` from `/kit`) brings in only what is passed; the root `createGame` stays the full default kit, signature unchanged.
3. Client mode stays first-class: an external loop owner (a game that drives frames itself, as Forge does) can use the services with `loop: 'external'` or equivalent: the game calls `frame(now)`; the engine never reads a clock itself in that mode.
4. Measure: bundle (gzip) of the puzzle template on the default kit vs a 2D-only lean kit; put the numbers in the README.

## Files owned

`src/core/game.ts`, new `src/kit/`, `src/index.ts`, `package.json` (one `./kit` export), `templates/*` (only if they move to the lean kit; optional), their tests and READMEs.

## Gate

common.md; `snap:check` 0 px and the boot/game/client/templates specs green.

# Brief: ws/template-platformer

Read `docs/briefs/common.md` first, then `docs/VISION.md` (a painted side-scroller is one of the named styles; a template game boots from zero in under a day), DECISIONS E-013, E-014; `templates/puzzle/**` (the 2D shape to copy: package, `CLAUDE.md`, `rules/`, `save/`, scripts, how it keeps game nouns out of the engine), `templates/third-person/CLAUDE.md` (the newest template's house rules), `src/render/README.md` *2D*, *Tile layers*, *Flipbooks*, *Emissive*, *Layers* (ws/ergo-2d landed `createTileLayer`, `createFlipbook`, `atlasFrames`), `src/input/README.md` (bindings, gestures, the virtual stick or touch zones, `Follow` for a 2D camera if it supports ortho), `src/ui/README.md` (`ui.stack`, HUD widgets, `ui.meter`, pad navigation), `src/audio/README.md` (synth voices, buses), `src/save/README.md`, `src/tween/README.md`, `src/fx/README.md` (2D particles, flicker), `demos/dungeon/map.ts` (`moveBox` against solid tiles: the collision shape this template also needs, written in the game).

## Goal

A copyable 2D side-scrolling platformer: a tile map drawn through `createTileLayer` from a procedural atlas, a flipbook-animated player with run, jump, fall and land states, tile collision with coyote time and jump buffering written in the template (ws/collide's `slide2` is not on main; note the wish), one-way platforms, moving platforms, collectibles with a tween pop, hazards that reset to a checkpoint, a parallax background on three layers, a camera that follows with look-ahead and dead zone, a HUD (coins, lives, a `ui.meter` for a dash cooldown), a pause menu walked by pad, keyboard and touch, saves of best time and coins per level through `save` with one migration, synthesised jump/coin/hurt sounds, and a level format (`levels/*.ts` as plain arrays of strings) an agent edits without reading the engine.

STATUS row, *done when*: `templates/platformer`: `createGame` fixed-step; two levels in the string format; a 60-frame-per-second run on the desktop row with under 12 draw calls for the whole frame (tile layers, parallax, sprites, particles batched); unit tests on the level parser, the collision resolve (coyote time, buffering, one-way platforms, moving-platform carry), the save migration and the camera look-ahead; scripts `dev`, `typecheck`, `test`; root `check:template-platformer` chained into `check` after `check:template-third-person`; root `template:platformer` dev script; `scripts/create-game.mjs` `REWRITES` gains `platformer: CLAUDE_MD_RULES` so the scaffold test passes for it; `CLAUDE.md` with a *Levels* section explaining the string format and a *Physics* section naming the three constants an agent tunes.

## Scope

- `templates/platformer/` as a private workspace package `@thunderclap/template-platformer` depending on `@thunderclap/engine` via `workspace:*`.
- `src/levels/`: the string format (one char per tile: solid, one-way, hazard, coin, checkpoint, spawn, moving-platform path markers), the parser, the two levels.
- `src/physics/`: AABB vs tile grid resolve with sub-stepping, coyote time, jump buffering, variable jump height, one-way platforms, moving platforms (the player rides them), all pure and tested.
- `src/world/`: tile layers, parallax, the procedural atlas (canvas-painted, no asset committed), flipbook frames for the player and a coin, particles for dust and coin pop.
- `src/scenes/`, `src/ui/`, `src/save/`: title, level, pause; HUD; the save record and its migration from a v0 shape.
- Input mapping: left/right, jump, dash from keyboard, pad, and two touch zones (left half axis, right half jump) with the engine's gesture or action primitives; no custom pointer handling if the engine covers it.
- Timing: record minutes from empty directory to green and what you would cut.

## Files owned

`templates/platformer/**`, root `package.json` scripts (two lines at the end of the scripts block, plus the `check` chain entry), `scripts/create-game.mjs` (the one `REWRITES` line), root `README.md` (one templates row), `CHANGELOG.md` (one line), `templates/README.md` if it exists (one row). Nothing under `src/`. Engine wishes go in report item 5 (expect several: a 2D collision helper arrives with ws/collide, a parallax helper, a 2D camera follow with dead zone; name exactly what you had to write).

Branch from `main` (4754ef1 or later). Running alongside: ws/host-mobile landing on chain 3 (root `package.json` `check` chain gains `check:host-capacitor`: keep your entry last so the merge is trivial), ws/ui-inventory (`src/ui`), ws/collide (`src/geom/collide`). Use `E2E_PORT_OFFSET=480`; the template has no e2e of its own, but run the full matrix once on your final head to prove nothing regressed, plus `pnpm snap:check` (0 px).

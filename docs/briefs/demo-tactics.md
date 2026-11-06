# Brief: ws/demo-tactics

Read `docs/briefs/common.md`, then `docs/briefs/demos-common.md`, then `docs/VISION.md` ("an isometric tactics map" is a named style the engine must express with the same camera and instance format), `demos/dungeon/**` (the 2D demo shape, `__demo` state, the pad-walk latch, the spec route), `src/render/README.md` (*2D*, *Tile layers* (`createTileLayer`), *Flipbooks*, *Layers*, *Emissive*, *Instances*: an isometric map is an ortho camera over a diamond-projected tile layer, or sorted sprites, say which you chose and why), `src/nav/README.md` (`createNavGrid`, `findPath`, flow fields, `followPath`: the engine already ships grid pathing), `src/input/README.md` (pointer rays into an ortho camera, `screenToWorld`, gestures: pinch zoom and pan, pad cursor), `src/ui/README.md` (`ui.stack`, panels with arrow and pad navigation, `ui.card`-style tooltips are in flight on ws/ui-inventory: do not depend on them; `ui.meter`, toasts, captions), `src/tween/README.md` (unit moves ease along the path), `src/fx/README.md` (2D particles for hits), `src/audio/README.md`.

## Goal

`demos/tactics`: an isometric turn-based tactics skirmish on a 24×24 diamond map with height (two elevation steps drawn as stacked tiles), four player units against six enemy units, each with move range and attack range shown as tile overlays, pathing through `nav` with terrain costs (grass 1, mud 2, water impassable, elevation step +1), a pointer cursor that converts screen to tile (iso inverse in the demo), hover shows the path preview and a unit panel, click moves along the path with a tween per step and a facing flipbook, attack with a hit particle burst and a damage caption anchored over the target, an enemy turn driven by a simple flow-field-toward-nearest-player AI, a turn order bar in the HUD, pinch and wheel zoom with pan on touch and drag, pad cursor stepping tiles with d-pad and `select` to confirm, and a win/lose panel.

STATUS row, *done when*: `pnpm demo tactics` runs; `__demo` exposes `fps`, `turn`, `phase` (`player` | `enemy` | `over`), `units` (alive counts per side), `cursorTile`, `selected` (unit id or null), `pathLength`, `drawCalls`; `e2e/demos/tactics.spec.ts`: boots to a steady state with no console errors; a synthetic pointer move over a known screen point sets `cursorTile` to the expected tile on every row (the iso inverse is right under every DPR and viewport); clicking a player unit then a reachable tile moves it (`pathLength` > 0, unit position changes after the tween settles); clicking an unreachable tile does nothing; ending the turn runs the enemy phase and returns to `player` with `turn` incremented; the d-pad steps `cursorTile` by one; `?still&seed=1` fixes the map and the AI roll for stable probes; `demos/tactics/README.md` with *What to look at* (five bullets) and *Known limits*; `pnpm check` and `pnpm test:e2e` green at `E2E_PORT_OFFSET=500`; `pnpm snap:check` 0 px.

## Rules

- Rules, units, AI, the iso projection and its inverse are the demo's. The engine supplies the renderer, the tile layer or sprite path, nav, tweens, input, UI, audio. Every piece you wished the engine had (an iso projection helper on `Camera`, a tile-layer `depthSort` or per-tile elevation offset, a pad-driven world cursor, a tooltip widget) goes in the report; those feed ws/ergo-2d-2.
- The map must read as isometric from the painted tiles (diamond tiles with left and right faces for elevation): paint them on a canvas at startup, no asset committed.
- Keep the draw count low: the map in at most two tile layers or one sorted instance list, units and overlays as sprites in one atlas.

## Files owned

`demos/tactics/**`, `e2e/demos/tactics.spec.ts`, `demos/README.md` (one row), `CHANGELOG.md` (one line under *Demos*). Nothing under `src/`, `harness/`, `templates/`.

Branch from `main` (4754ef1 or later). Running alongside: ws/demo-voxel (`demos/voxel`), ws/ui-inventory (`src/ui`: do not depend on it), ws/nav-2 landing on chain 2 (`src/nav/mesh`: the grid API you use is already on main). Use `E2E_PORT_OFFSET=500`.

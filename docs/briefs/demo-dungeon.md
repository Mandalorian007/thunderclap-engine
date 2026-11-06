# Brief: ws/demo-dungeon

Read `docs/briefs/common.md`, then `docs/briefs/demos-common.md`, then `examples/hello/main.ts`, `templates/puzzle/` (2D game shape: scene, rules, save), `src/render/README.md` (2D draw path, sprites, texture atlases, emissive, layers), `src/fx/README.md` (2D particles, flicker), `src/ui/README.md` (menus, toasts, pad navigation, anchors), `src/audio/README.md` (synth voices, buses), `src/save/README.md`, `src/input/README.md` (bindings, gestures, virtual stick if any).

## Goal

`demos/dungeon`: a 2D top-down dungeon crawl room. Validates the 2D path at game scale: a 40×30 tile map drawn from a procedural atlas (canvas-generated tiles), 60 animated sprites (bats) with a flipbook, a player square moved by keys/pad/touch drag with wall collision, torches with `flicker` and emissive bloom, a fog-of-war overlay layer, a pause menu with pad navigation, a coin counter saved through `save` across reloads, and synthesised pickup/hit sounds on a bus. Must stay at 60 fps on the desktop row.

STATUS row, *done when*: `pnpm demo dungeon` runs; `__demo` exposes `fps`, `coins`, `bats`, `drawCalls`, `playerTile`; `e2e/demos/dungeon.spec.ts` moves the player with synthetic keys into a wall and asserts it stopped at the tile, picks up a coin, reloads and asserts `coins` persisted, opens the pause menu and walks it with the d-pad keys, no console errors; `demos/dungeon/README.md`; `pnpm check` and `pnpm test:e2e` green at `E2E_PORT_OFFSET=200` except E-017.

## Files owned

`demos/dungeon/**`, `e2e/demos/dungeon.spec.ts`, `demos/README.md` (one row), `CHANGELOG.md` (one line under *Demos*; create the heading if ws/demo-arena has not). Nothing under `src/`.

For the e2e server route, use the same mechanism ws/demo-arena chooses: if its branch exists when you reach the spec, read `git show ws/demo-arena:vite.harness.config.ts` and mirror it in your worktree without committing those shared files; if not, serve your demo with a one-off Playwright `webServer` in your spec's config block only and say so. Running alongside: ws/demo-arena, ws/demo-showroom, ws/demo-range.

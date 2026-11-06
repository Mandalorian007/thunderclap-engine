# Brief: ws/ergo-2d

Read `docs/briefs/common.md` first, then DECISIONS E-021 (demos as quality validation); `src/core/game.ts` (`GameOptions.input`, how `Input` and `PadNav` are constructed, `ctx.padNav`), `src/input/input.ts` (`InputOptions.getGamepads`), `src/ui/padnav.ts`, `src/ui/stack.ts` (`PanelStack.handleKey`, focus rules), `src/ui/README.md` *Panels* and *Pad navigation*, `src/render/frame.ts` (`DrawParams`, `Frame.draw`), `src/render/README.md` *Drawing*, `demos/dungeon/main.ts` (how it draws tiles and animates sprites today; read only, do not edit).

## Goal

Three ergonomics gaps the dungeon demo hit, each small, each engine-generic: a game can inject its gamepad source through `createGame`, a panel stack walks focus with the arrow keys itself, and a 2D game draws a tile layer and a flipbook sprite without per-tile `DrawParams` bookkeeping.

STATUS row, *done when*: `GameOptions.input.getGamepads?: () => readonly (Gamepad | null)[]` reaches `Input` and `PadNav` (specs drive `ctx.padNav` with a fake pad); `PanelStack` moves focus among the top panel's focusable elements on ArrowUp/ArrowDown (and ArrowLeft/Right when the panel opts in via `PanelOptions.arrowNav: 'vertical' | 'both' | 'none'`, default `'vertical'`), wrapping, without stealing arrows from inputs, selects and sliders; `createTileLayer(renderer, { material, tileW, tileH, columns, rows, atlas: { cols, rows } })` → `TileLayer { set(col, row, tileIndex | -1), fill(tiles: Int16Array | number[]), origin, scale, draw(frame, params?), count }` and `createFlipbook({ frames: readonly UvRect[], fps, loop })` → `Flipbook { update(dt), uv: UvRect, frame, done, reset(), play(frames?) }` in `src/render/`; unit tests; harness `tiles.html` on the matrix; documented.

## Scope

- `src/core/game.ts`: pass `opts.input.getGamepads` to `Input` and to `PadNav` (today `PadNav` reads `navigator.getGamepads` itself: give it an option, default unchanged). One test in `game.test.ts` with a fake pad driving a `PanelStack` push through `ctx.padNav`.
- `src/ui/stack.ts`: arrow handling in `handleKey` for the top panel only; the focusable set is the panel's `[tabindex]`, buttons, links, inputs in DOM order (reuse whatever `PadNav` uses to find them; if that lives in `padnav.ts`, move it to a shared private helper in `dom.ts`). Skip when `document.activeElement` is an `input`, `textarea`, `select` or `[role=slider]` for the axis it consumes. Tests in a new `stack.dom.test.ts`.
- `src/render/tile-layer.ts`: one `Mesh` of `columns × rows` quads with per-tile UVs written on `set`/`fill` (dirty range upload, no per-frame allocation), drawn as one `frame.mesh`-style draw in the 2D path with the layer's `origin`/`scale` as its `DrawParams`; tile `-1` collapses the quad to zero area. The 2D harness pages must stay pixel-identical: this is a new draw path, nothing in `frame.draw` changes.
- `src/render/flipbook.ts`: pure timing over a `UvRect[]`; zero allocations in `update`.
- Harness `harness/tiles.html` + `tiles.ts` + `tiles-state.ts`: a 32×18 layer from a generated checker atlas plus one flipbook sprite walking across it; state exposes `tiles`, `frame`, `uv`, `drawCalls`. `e2e/tiles.spec.ts`: one draw for the layer, flipbook frame advances, a `set` changes the pixel at a tile centre.
- Docs: render README *Drawing* gains *Tile layers and flipbooks*; ui README *Panels* arrow sentence; core README `input.getGamepads`; CHANGELOG one line each; ARCHITECTURE *UI* one clause.

## Files owned

`src/core/game.ts`, `src/core/game.test.ts`, `src/core/README.md`, `src/ui/stack.ts`, `src/ui/stack.dom.test.ts`, `src/ui/padnav.ts` (option only), `src/ui/dom.ts`, `src/ui/README.md` (*Panels*), `src/render/tile-layer.ts`, `src/render/tile-layer.test.ts`, `src/render/flipbook.ts`, `src/render/flipbook.test.ts`, `src/render/index.ts` (append), `src/render/README.md` (*Drawing* subsection), `harness/tiles.*`, `e2e/tiles.spec.ts`, root `README.md` (harness list item), `ARCHITECTURE.md` (one clause), `CHANGELOG.md`.

Nothing in `renderer.ts`, `frame.ts`, `src/ui/perf.ts`, `src/ui/hud*.ts`. Branch from `main` (bf87092 or later). Running alongside: ws/perf-overlay (`src/ui/perf.ts`, harness `?perf`), ws/billboards and ws/debug-draw (`src/fx/`), ws/batch-submit and ws/pbr-lights (landing; `renderer.ts`, `frame.ts`, `wgsl.ts`), ws/ui-hud (landing; `src/ui/hud.ts`, `styles.ts`). `src/ui/index.ts` and `src/render/index.ts`: append only.

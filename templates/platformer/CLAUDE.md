# Skyline: a ThunderClap platformer template

This folder is a complete, copyable 2D side-scrolling platformer on `@thunderclap/engine`. To start a new game: copy it, rename the package in `package.json`, replace `levels/`, keep the shape. Everything an agent needs to extend it is in this file; it should not have to read the engine.

## Commands

- `pnpm dev`: Vite dev server at `http://127.0.0.1:5173` (from the repo root: `pnpm template:platformer`).
- `pnpm typecheck`, `pnpm lint`, `pnpm test`: `tsc`, Biome (the repo's `biome.json`), Vitest. `pnpm check` runs all three; the repo root's `pnpm check` runs it too (`check:template-platformer`).
- Tests are product tests only (`src/**/*.test.ts`): the level parser, the collision and player step (coyote time, jump buffering, one-way platforms, mover carry), the camera follow, the touch zones and the save migration. The engine verifies the platform itself.

## Shape

```
index.html           the page: a positioned #app the engine mounts into
src/main.ts          createGame(...) → engine ctx; atlas texture, tweens, sounds; the title scene pushed
src/ctx.ts           Action names, their bindings, Run (lives, level index), GameCtx (= EngineCtx + game nouns)
src/levels/format.ts the level format: TILE, tile kinds, parseLevel(id, name, lines), kindAt, moverAt
src/levels/*.ts      the levels, one file each, as arrays of strings; index.ts lists them in order
src/physics/body.ts  AABB vs tile grid: moveBody (sub-stepped, X then Y), one-way tiles, mover carry
src/physics/player.ts the player step: tunables, states, coyote time, jump buffer, variable jump, dash
src/world/atlas.ts   the procedural canvas atlas (8×8 cells of 64 px) and every cell's index
src/world/world.ts   the tile layer for a level plus the flipbook frames; UVs for props
src/world/parallax.ts three tile layers scrolling at a fraction of the camera, wrapping on a period
src/world/follow.ts  the 2D camera follow: dead zone, look-ahead in the facing direction, clamp to world
src/input/touch.ts   two thumb zones read from the pointer router: left half steers, right half jumps
src/scenes/title.ts  level list with best times, from the save
src/scenes/level.ts  the gameplay scene: intent → stepPlayer, pickups, hazards, checkpoints, camera, draws
src/scenes/pause.ts  a transparent scene over the level holding one modal panel
src/ui/hud.ts        coins, lives, time (DOM in the top region) and the dash cooldown ui.meter
src/save/schema.ts   the save: schema, version, migrations, createProgressStore(host), recordRun
```

## Levels

A level is a `string[]`: one string per row, every row the same length, top row first. Each character is one 64 px tile (`TILE`). `parseLevel(id, name, lines)` turns it into a `Level` and throws on ragged rows, unknown characters, a missing or doubled spawn or exit, or a mover path of one cell.

| Char | Meaning |
| --- | --- |
| ` ` | air |
| `#` | solid: walls, floors, ceilings |
| `-` | one-way platform: passable from below and the sides, stood on from above |
| `^` | hazard: touching it costs a life and resets to the last checkpoint |
| `o` | coin |
| `c` | checkpoint flag |
| `p` | spawn (exactly one) |
| `x` | exit door (exactly one) |
| `m` | mover path: a straight run of two or more `m` is one platform shuttling end to end |

Outside the grid, the sides are solid and above and below are air (falling out of the bottom costs a life). The ground row's tiles draw with a grass top when nothing solid sits on them (`world.ts`). Movers are `MOVER_W` tiles wide, `MOVER_H` px tall and travel at `MOVER_SPEED` px/s; `moverAt(path, t, dt, out)` gives the position and the delta for one tick. Add a level: a new `levels/<name>.ts` with `parseLevel`, add it to `LEVELS` in `levels/index.ts`; the title lists it, the save keys on its `id`, and the format tests check it has coins, a mover and a checkpoint.

## Physics

The feel lives in three constants at the top of `src/physics/player.ts`, in design px and seconds:

- **`GRAVITY`** (px/s²): how fast falls build. Higher is snappier and lowers the jump arc for the same `JUMP_SPEED`.
- **`JUMP_SPEED`** (px/s): the take-off speed. Jump height is `JUMP_SPEED² / (2 · GRAVITY)`; releasing the button early multiplies gravity by `SHORT_HOP_GRAVITY` for a short hop.
- **`RUN_SPEED`** (px/s): the top running speed. `RUN_ACCEL`, `RUN_DECEL` and `AIR_ACCEL` shape how fast it is reached and lost.

Alongside them: `COYOTE_TIME` (a jump still fires this long after leaving an edge), `JUMP_BUFFER` (a press this long before landing fires on touchdown), `MAX_FALL`, and the dash (`DASH_SPEED`, `DASH_TIME`, `DASH_COOLDOWN`; the HUD meter's range). The step is fixed at 60 Hz (`createGame`'s default `sim.step`), and `moveBody` sub-steps so nothing moves more than half a tile per resolve; the physics tests run at 120 Hz to show the result does not depend on the step. Change a constant, run `pnpm test`: the jump-height and coyote tests are written against the constants, not against numbers.

## Rules of the house

1. **Levels and physics are pure.** `levels/` and `physics/` import nothing from the engine or the DOM and never read time. Every rule has a unit test.
2. **Rendering, not mechanics.** The scene turns input into an `Intent`, calls `stepPlayer`, and draws what the player and level say. Game state lives in `ctx.run` and the save, not in the scene's closure.
3. **Zero allocations per frame.** `render` mutates pre-built `DrawParams` and `EmitParams`; nothing is created inside `render` or `update` in steady state. One atlas, so the whole world is a handful of draw calls (three parallax layers, the map, one sprite batch, particles).
4. **Devices never leak past `ctx.ts` and `input/touch.ts`.** Scenes read actions (`input.pressed('jump')`) and the touch reading, never keys, buttons or pointers.
5. **Import only the public map.** `@thunderclap/engine` and `@thunderclap/engine/<module>` (`core`, `render`, `input`, `ui`, `save`, `audio`, `tween`, `fx`). Never a path into the engine's `src/`.

## The engine's nouns

- **`createGame(opts)`** (`@thunderclap/engine`): boots WebGPU on a letterboxed canvas and returns the **`EngineCtx`** (or `null` when WebGPU is missing). Options used here: `root`, `title`, `design` (1920×1080), `save(host)`, `input: { bindings, buttonKeys }`, `particles: { capacity }`. The game widens it with `Object.assign(engine, {...})` (`GameCtx` in `ctx.ts`).
- **`Scene<GameCtx, Frame>`** (`core`): `enter`, `exit`, `pause`, `resume`, `update(dt)` (fixed steps), `render(frame, camera, alpha)`. `ctx.stack.push/pop/replace`; a `transparent` scene draws over the one beneath (the pause menu).
- **`createTileLayer(renderer, { material, tileW, tileH, columns, rows, atlas })`** (`render`): a grid of atlas indices drawn in one call; `set(col, row, index)`, `fill(Int16Array)`, a mutable `origin`, `draw(frame, params)`. The map and the parallax layers are tile layers over the one atlas.
- **`atlasFrames` / `createFlipbook`** (`render`): `atlasFrames({ cols, rows }, indices)` makes UV rects; `createFlipbook({ frames, fps, loop })` steps them with `update(dt)`, `play(frames)` switches the clip, `uv` is the current frame.
- **`Frame`** (`render`): `frame.clear(r, g, b)`; `frame.sprite(material, { x, y, w, h, uv, tint, emissive, order })` (a negative `w` flips the sprite); `frame.drawable(ctx.particles)`. Draws with the same material batch into one call.
- **`Camera`** (`render`): `ctx.camera` is `Camera.ortho2d(1920, 1080)`; `camera.x`, `camera.y` pan it (the world point at the view centre is `design/2 + x`). The level scene sets them from `world/follow.ts` every step.
- **`Input` bindings** (`input`): `{ key }`, `{ padButton }`, `{ padAxis, dir }`; `input.pressed(a)`, `held(a)`, `value(a)`. Input is blocked while a modal panel is open. Touch is read from **`ctx.pointers.pointers`** (device, x, y in design px, `select`), because the gesture recogniser treats two fingers as a pinch.
- **`ctx.ui`** (`ui`): `ui.layout.add(el, { place, order })` for the HUD, `ui.meter({ label, max, region, tone, width })` for the dash cooldown, `ui.stack.push({ title, content, dismissible, onClose })` for the title and pause panels (Tab, arrows and the pad walk them), `ui.toasts.show`. Widgets `button`, `h`.
- **`ctx.audio`** (`audio`): `define(name, recipes.whoosh|chime|thud(opts))` synthesises a sound, `await prepare()` renders them, `play(name, { bus, rate, pan })`. No files.
- **`createTweens`, `ease`** (`tween`): `tweens.to(target, props, seconds, { ease })`; `engine.hooks.update` drives `tweens.update(dt)`. The coin pop.
- **`ctx.particles.emit(params, count)`** (`fx`): dust on landing, sparkle on a coin, a burst on a hit; the engine steps them each fixed step.
- **Save** (`save`): `createSaveStore({ game, slot, version, migrations, defaults, schema, host })`; `save.get()`, `save.update(d => next)`, `save.persistent`. Here version 2 keeps `levels[id] = { bestMs, coins }` and `lives`; `migrations[1]` reads the v1 `best: [{ level, time }]` list. Test with `storage: new MemoryStorage()`.

## Extending it

- A new tile kind: a character in `CHARS` and a kind in `levels/format.ts`, a cell in `world/atlas.ts`, a branch in `moveBody` or the scene's `update`, a test.
- A new move: a field on `Intent`, an action in `ctx.ts` (and a touch zone in `input/touch.ts` if it needs one), a state in `physics/player.ts`, a flipbook clip in `world/world.ts`.
- A new HUD element: build it with `h`, `layout.add` it with a `place` per form factor, refresh it from the scene.
- Art: paint more cells in `buildAtlas` or replace the atlas with a loaded texture (`renderer.textureFromSource` / the `render` loaders) at the same cell layout.

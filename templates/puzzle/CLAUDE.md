# Pairs: a ThunderClap puzzle template

This folder is a complete, copyable 2D puzzle game on `@thunderclap/engine`. To start a new game: copy it, rename the package in `package.json`, replace `rules/`, keep the shape. Everything an agent needs to extend it is in this file; it should not have to read the engine.

## Commands

- `pnpm dev`: Vite dev server at `http://127.0.0.1:5173` (from the repo root: `pnpm template:puzzle`). The repo's `pnpm test:e2e` boots the page once per device row (`e2e/templates.spec.ts`) and reads `window.__template` (`{ scene, frames, ... }`, set in `main.ts`).
- `pnpm typecheck`, `pnpm lint`, `pnpm test`: `tsc`, Biome (the repo's `biome.json`), Vitest. `pnpm check` runs all three; the repo root's `pnpm check` runs it too (`check:template-puzzle`).
- Tests are product tests only (`src/**/*.test.ts`): the rules and the save schema. The engine verifies the platform (WebGPU, input, layout) itself.

## Shape

```
index.html          the page: a positioned #app the engine mounts into
src/main.ts         createGame(...) → engine ctx; widened with the game's nouns; one scene pushed
src/ctx.ts          Action names, their bindings, GameCtx (= EngineCtx + game nouns)
src/analytics.ts    the game's events (level_start, level_complete) and createBeaconSink(url); off until COLLECT_URL is set
src/rules/          pure TypeScript: Board, createBoard, reveal, settle, phase. No DOM; only createRandom from the engine
src/scenes/board.ts the scene: input → rules, rules → sprites; camera fitted to the free rect
src/save/schema.ts  the save: schema, version, migrations, createProgressStore(host)
src/layout/spec.ts  LayoutSpec: HUD regions per form factor
src/ui/hud.ts       DOM widgets registered against layout regions
```

## Rules of the house

1. **Rules are pure.** `rules/` imports nothing from the DOM and nothing from the engine but `createRandom` (`@thunderclap/engine/core`, seeded, the same sequence everywhere), and never reads time or `Math.random`: `createRandom(seed)` deals the board. A move is a function `(Board, input) => Board` that returns a new board; the input board is never mutated. Every rule has a unit test.
2. **Rendering, not mechanics.** The scene draws what the rules say and turns actions into rule calls. Game state lives in `ctx.game`, not in the scene's closure (the scene keeps only animation state).
3. **No network without a decision.** The engine makes no network call. The template's one network path is analytics: `createBeaconSink(url)` in `src/analytics.ts`, built only when `COLLECT_URL` is set (it is `null` here); set it only with an endpoint you own and the consent your product needs. Saves go through the host's storage.
4. **Zero allocations per frame.** `render` mutates pre-built `Transform`s and `DrawParams`; nothing is created inside `render` or `update` in steady state.
5. **Devices never leak past `ctx.ts`.** Scenes read actions (`input.pressed('select')`), never keys, buttons or touches.
6. **Import only the public map.** `@thunderclap/engine` and `@thunderclap/engine/<module>` (`core`, `render`, `input`, `ui`, `save`, `host`, `platform`, `post`, `fx`, `audio`, `analytics`). Never a path into the engine's `src/`.

## The engine's nouns

- **`createGame(opts)`** (`@thunderclap/engine`): boots WebGPU on a letterboxed canvas and returns the **`EngineCtx`** (or `null` when WebGPU is missing; the engine has shown its unsupported screen). Options used here: `root`, `title`, `design` (logical size, 1920×1080), `save(host)`, `input: { bindings, buttonKeys }`, `layout`. Not used but available: `sim: false` (render-rate loop for a server-driven client), `mixerKey` (persist audio volumes), `post` (bloom, fog, grade), `host` (an Electron host), `styles(doc)` (inject stylesheets), `input.magnify` (loupe and snap for small touch targets).
- **`EngineCtx`**: `design`, `surface` (canvas, `rect` in CSS px, `clientToLogical`, `onResize`), `renderer`, `camera` (the one the scenes draw through), `post`, `particles`, `input`, `gestures`, `pointers`, `padNav`, `audio`, `ui` (the overlay), `host`, `save`, `stack` (scenes), `loop`, `hooks` (`update`, `beforeRender`, `afterRender`, `hide`, `show`, `deviceLost`). The game adds its own fields with `Object.assign(engine, {...})` (`GameCtx` in `ctx.ts`); scenes receive that one object.
- **`Scene<GameCtx, Frame>`** (`@thunderclap/engine/core`): `enter(ctx)`, `exit`, `pause`, `resume`, `update(dt)` (fixed 60 Hz steps), `render(frame, camera, alpha)` (the camera is `ctx.camera`; the engine draws the frame through it after the scenes return). `ctx.stack.push/pop/replace`; only the top scene updates; a `transparent` scene draws over the one beneath (a pause menu).
- **`Frame`** (`@thunderclap/engine/render`): the per-frame draw recorder. `frame.clear(r, g, b)`; `frame.sprite(material | null, transform, params)` draws the engine's quad (`null` material = flat sprite); `frame.sprite(null, { x, y, w, h, rotation, tint, emissive })` is the matrix-free form. `frame.mesh(mesh, material, transform)` for geometry. Draws with the same material and mesh batch into one call.
- **`Transform`** (`render`): position xyz, `rotation` (radians about z), scale xyz, optional `parent`; a cached 3×4 world matrix. For the engine's quad, scale is the size in design px. Build once, mutate per frame (`setPosition`, `setScale`, `.rotation =`).
- **`DrawParams` / `InstanceParams`** (`render`): `tint` (linear RGBA, HDR allowed; `hex('#rrggbb', intensity)`), `emissive` (bloom), `uv`, `params` (a free vec4 for custom WGSL), **`layers`** (u32 mask; a draw is skipped when `layers & camera.layers` is 0), **`order`** (sort key; draws render by `order` then submission order, so leave it 0 for plain batching and raise it to draw on top).
- **`Camera`** (`render`): `ctx.camera` is `Camera.ortho2d(1920, 1080)` by default: origin top-left, y down, 1 unit = 1 design px. `camera.fitFreeRect(worldRect, ctx.ui.layout.freeRect, ctx.surface)` frames a world rect inside the space the HUD leaves (the free rect is CSS px; the camera converts it); `camera.fitRect(worldRect, viewport)` is the same with a viewport in design px. `camera.screenToWorld(x, y, 0, out)` turns a tap (design px) into world units; `worldToScreen` the other way. `Camera.perspective(...)` for 3D.
- **`Input` bindings** (`@thunderclap/engine/input`): `createGame` builds `ctx.input` from `bindings: Record<Action, Binding[]>`. Binding kinds: `{ key: 'KeyA' }` (`KeyboardEvent.code`), `{ mouse: 0 }`, `{ wheel: 1 | -1 }`, `{ padButton: 0 }`, `{ padAxis: 0, dir: -1 }`, `{ gesture: 'tap' | 'doubleTap' | 'longPress' | 'pan' | 'drag' | 'pinch' }` (`createGame` builds the `Gestures`, `ctx.gestures`; two fingers pinch and never pan), `{ pointer: 'select' | 'secondary' }` (the pointer router, `ctx.pointers`). Read per tick: `input.pressed(a)`, `held(a)`, `released(a)`, `value(a)`; `input.pointer` (`x`, `y` in design px, `inside`, `down`); `input.lastDevice` for prompts. `ctx.gestures.tap` carries the tap's position. Input is blocked automatically while a modal panel is open.
- **`ctx.ui`** (`@thunderclap/engine/ui`): the DOM overlay over the canvas, in CSS px. `ui.layout` is the **layout**: `layout.add(element, { place: { default: 'top', 'phone-portrait': 'hidden' }, order })` registers a widget against a region (`top`, `left`, `right`, `bottom`, `cardLane`, `captionLane`, `modal`) per **form factor** (`desktop`, `tablet`, `phone-landscape`, `phone-portrait`); `'hidden'` hides it there. `top` and `bottom` lay widgets out in a row, `left`, `right` and `cardLane` in a column. `layout.freeRect` is what the HUD leaves for the world; `layout.onChange(fn)` fires on every re-layout. `ui.toasts.show(text, { tone, duration })`, `ui.stack` (panels; a modal blocks input), `ui.caption`, and widget helpers `button`, `toggle`, `slider`, `h` (hyperscript). Theme tokens: `--tc-font-display`, `--tc-font-size-l`, `--tc-color-text`, `--tc-tap-min`.
- **`LayoutSpec`** (`layout/spec.ts`): per form factor, `columns`/`rows` (CSS px, `'fill'`, or `{ frac, min, max }` of the safe area), `areas` (grid-template-areas; each region one rectangle), `pad`, `tapMin`, `textMin`, `units`. Fields left out keep the engine's defaults; tracks whose regions hold no widget collapse.
- **Save** (`@thunderclap/engine/save`): `createSaveStore({ game, slot, version, migrations, defaults, schema, host })`. Schema with `s.object({...})`, `s.number({ min, int })`, `s.nullable`, `s.array`, `s.optional`, `s.literal`; `Infer<typeof Schema>` gives the type. `save.get()` (read-only), `save.update(d => next)` (validated, debounced write; returns `false` when the schema rejects), `save.flush()` (also on hide and device loss), `save.persistent` (false in blocked storage: tell the player). Changing the shape: bump `SAVE_VERSION`, add `migrations[oldVersion]`, keep the old data readable; the engine backs up anything it cannot migrate. Test with `storage: new MemoryStorage()`.
- **Analytics** (`@thunderclap/engine/analytics`): `createAnalytics<Events>({ sink, onError })`, `analytics.attach(engine)` (emits `game_start`, `session_end` on hide), `analytics.emit('level_start', { level })`. The sink is the game's: `createBeaconSink(url)` in `src/analytics.ts`. `ctx.analytics` is `null` when `COLLECT_URL` is unset, so call it as `ctx.analytics?.emit(...)`.
- **Host** (`@thunderclap/engine/host`): the page the game runs in (`web` top-level or iframe, Electron through `@thunderclap/host-electron`): `openExternal`, `copyText`, `fullscreen`, `storage`. The game never touches `window.open`, the clipboard or `localStorage` directly.

## Installable

The build can ship as an installable, offline-capable web app through `@thunderclap/host-pwa` (the engine stays network-free; the worker and manifest are the package's and yours). Three lines turn it on: add the package (`pnpm add -D @thunderclap/host-pwa`, or `"workspace:*"` inside the engine repo), uncomment the `pwaPlugin({ manifest: { name, theme_color, background_color, svg } })` line and its import in `vite.config.ts` (the `svg` is one icon string the plugin rasterises at 192 and 512 px when it can), and pass `host: createPwaHost()` (from `@thunderclap/host-pwa`) to `createGame`. The built page then registers `sw.js`: hashed assets are cached on first visit, `index.html` is fetched network-first with the cache as fallback, and the game loads offline on the next visit. `ctx.host.pwa` exposes `installable`/`install()`, `updateReady`/`applyUpdate()`, `offline` and `cacheStatus()` for an install button, an update toast and an offline hint; saves are untouched (they live in the host's storage, never in the cache). `pnpm dev` is unaffected: the plugin only runs on `vite build`.

## Extending it

- A new mechanic: a pure function in `rules/` with a test, an action in `ctx.ts` if it needs input, a few lines in the scene's `update`.
- A new HUD element: build it with `h`/`button`, `layout.add` it with a `place` per form factor, refresh it from `ctx.refreshHud()`.
- Art: a `Material` with custom WGSL (`ctx.renderer.createMaterial({ label, wgsl })`; see the engine's render README) passed as the first argument of `frame.sprite`; textures through `render`'s texture loaders.
- 3D: `Camera.perspective`, `frame.mesh` with a `VERTEX_LAYOUT_3D` mesh, the same `Transform`.

# Highland: a ThunderClap first-person template

This folder is a complete, copyable first-person 3D game on `@thunderclap/engine`: a walk over a
chunked height field with a sun, shadows, fog, snow and three labelled landmarks. To start a new
game: copy it, rename the package in `package.json`, replace `world/`, keep the shape. Everything
an agent needs to extend it is in this file; it should not have to read the engine.

## Commands

- `pnpm dev`: Vite dev server at `http://127.0.0.1:5173` (from the repo root: `pnpm template:first-person`). Click the canvas to take the pointer lock; WASD walks, Shift runs, E inspects the landmark in the crosshair, R respawns. On a phone the left half is a walk stick and the right half drags the view; on a pad the sticks move and look, A inspects.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`: `tsc`, Biome (the repo's `biome.json`), Vitest. `pnpm check` runs all three; the repo root's `pnpm check` runs it too (`check:template-first-person`).
- Tests are product tests only (`src/**/*.test.ts`): the terrain generator and the mesher. The engine verifies the platform (WebGPU, input, layout, shadows) itself.

## Shape

```
index.html            the page: a positioned #app the engine mounts into
src/main.ts           createGame({ sim: false }) → engine ctx; a Look linked to the input; one scene pushed
src/ctx.ts            Action names and bindings, World, Player, GameCtx (= EngineCtx + game nouns)
src/world/terrain.ts  pure: seeded height field, heightAt/surfaceY, layers by height, findLandmarks
src/world/mesher.ts   pure: meshChunk(terrain, cx, cz, buffer) → VERTEX_LAYOUT_3D floats + uint16 indices + bounds
src/world/protocol.ts the messages between the scene and the Worker
src/world/worker.ts   the Worker: builds the terrain once, meshes chunks into transferred buffers
src/art/blocks.ts     the block faces as generated pixels, one per texture-array layer
src/scenes/world.ts   the scene: Look → camera, walking, chunk meshes, lights, snow, anchors, picking
src/ui/hud.ts         crosshair (ui.layers.hud), prompt and focus line (ui.layout)
```

## Rules of the house

1. **`world/` is pure.** It imports nothing from the engine or the DOM and never reads time or `Math.random` (everything derives from the seed through `hash2`). The mesher writes a numeric layout, not engine types, so the same code runs in the Worker and in a test. Every generator and mesher rule has a unit test.
2. **Rendering, not mechanics.** The scene draws what `world/` says and turns `Look` and actions into movement and inspections. Collision is the game's (three lines against `surfaceY`), not the engine's.
3. **A client keeps nothing.** `sim: false` and no `save`: the engine never touches storage and the loop runs at render rate (`update(dt)` gets the real frame delta). A server-driven game applies its state in `ctx.hooks.frame`. No network call anywhere in the engine; add your own transport.
4. **Zero allocations per frame.** `update` and `render` mutate pre-built `Transform`s, `Float32Array`s and emitter params; the Worker's buffers are views, never copies. Nothing is created inside them in steady state.
5. **Devices never leak past `ctx.ts` and `Look`.** Scenes read `look.look`, `look.move` and actions (`input.pressed('inspect')`), never keys, buttons, touches or `movementX`.
6. **Import only the public map.** `@thunderclap/engine` and `@thunderclap/engine/<module>` (`core`, `render`, `input`, `ui`, `fx`, `save`, `host`, `platform`, `post`, `audio`, `analytics`). Never a path into the engine's `src/`.

## The engine's nouns

- **`createGame(opts)`** (`@thunderclap/engine`): boots WebGPU on a letterboxed canvas and returns the **`EngineCtx`** (or `null` when WebGPU is missing; the engine has shown its unsupported screen). Used here: `root`, `title`, `design` (1920×1080), `sim: false` (render-rate loop; `hooks.frame(dt)` instead of `hooks.update`), `input: { bindings, buttonKeys }`. Left out: `save` (so `ctx.save` is typed `null`), `layout` (the default regions serve), `post`, `mixerKey`, `host`.
- **`EngineCtx`**: `renderer`, `camera`, `surface`, `design`, `input`, `gestures`, `pointers`, `ui`, `particles` (the engine's screen-space pool; this game builds its own world-space one), `audio`, `host`, `stack`, `loop`, `hooks`, `onDeviceLost`. `main.ts` widens it with `look`, `world`, `player`, `hud`, `respawn()` (`GameCtx`), so every scene sees one object.
- **`Camera`** (`render`): `ctx.camera` is the camera every scene draws through and the pointer router casts rays through; it starts as `Camera.ortho2d`. The scene calls `camera.setPerspective(fovY, aspect, near, far)` on enter and sets `depthTest`, `depthWrite` and `cull` to true (`Camera.perspective(...)` does that for a new camera; re-aiming the shared one does not). `camera.lookAt(eye, target)` each frame; `camera.worldToScreen` / `screenToWorld` convert; `camera.cull` skips draws whose bounding sphere leaves the frustum (`renderer.stats.culled`).
- **`Look`** (`input`): `new Look({ keys: { forward, back, left, right }, touch: { moveZone: 'left' } })`, linked with `ctx.input.setLook(look)`. Each tick `look.look.dx`/`dy` are yaw and pitch deltas in radians (summed over a pointer-locked mouse, a touch drag in the look zone and the pad's right stick) and `look.move.x`/`y` is the walk vector in -1..1 (keys, the touch stick, the left stick). `look.request()` asks for the pointer lock (only inside a gesture: on `pointerdown`), `look.release()`, `look.locked`, `look.onLockChange(fn)`, `look.stick` (to draw the touch stick), `sensitivity`, `invertY`. `createGame` builds no `Look`; a 2D game pays nothing.
- **`Transform`** (`render`): position, rotation and scale (`x`, `y`, `z`, `scaleX/Y/Z`) into a 4×4 world matrix. Build once, mutate per frame. One per chunk (placed at the chunk origin) and per marker here.
- **`Mesh`** (`render`): `renderer.createMesh({ layout: VERTEX_LAYOUT_3D, capacity: { vertices, indices } })` makes an empty mesh with room; **`mesh.update({ vertices, indices, vertexCount, indexCount, bounds })`** uploads views over a buffer in place (a Worker's transferred `ArrayBuffer` costs no copy) and reuses the GPU buffers while the counts fit (`mesh.growths` counts reallocations). **`bounds`** (`{ center, radius }` in mesh space) is what the frustum cull tests; pass it from the mesher so the mesh never scans vertices. `VERTEX_LAYOUT_3D` is 12 floats: xyz, normal, uv, rgba. `frame.mesh(mesh, material, transform, params?)` draws one instance.
- **The layer-in-alpha convention**: the 3D layout has no spare channel, so a face's texture-array layer is a whole number in the vertex colour's alpha; the material reads `u32(round(in.color.a))`. Draw with tint alpha 1 (the default).
- **`loadTextureArray(device, sources, { label, mips?, mipFilter?, format? })`** (`render`): one `PixelSource` (`{ width, height, data }`) or image per layer, same size, GPU-generated mips. A material binds it with `textures: 1, viewDimension: '2d-array'` and a `sampler` (`'linear-mip-repeat'` tiles per block; `'nearest-mip-clamp'` is the pixel-art choice) and `material.setTexture(0, array)`; in WGSL it is `@group(1) @binding(2) var blocks: texture_2d_array<f32>` with the sampler at binding 1.
- **`Material`** (`render`): `renderer.createMaterial({ label, blend, wgsl, textures?, viewDimension?, sampler? })`, your fragment shader after the engine's prelude (`VSOut`: `uv`, `color`, `normal`, `worldPos`, `emissive`, `params`, `flags`; `FragOut`: `color`, `emissive`). `params` on an `InstanceParams` is a free vec4; `emissive` feeds the bloom.
- **`Lights`** (`render`): `frame.lights = lights` each frame. `lights.ambient`, **`lights.sun`** (`dir`, `color`, **`shadow: { extent, size?, near?, far?, bias? }`**: one shadow map, an orthographic box of `±extent` around the camera position, drawn by the renderer before the scene pass; `null` for none) and **`lights.fog`** (`color`, `density`, `near`, `far`: linear when `far > near`, exponential otherwise). In WGSL `engine_lambert(n, worldPos)` is ambient + shadowed sun + point lights, `engine_shadow(worldPos)` the raw factor, and **`engine_fog(color, worldPos)`** mixes a colour towards the fog by distance from the eye; materials call it on their final colour. `InstanceParams.castShadow` defaults true for 3D meshes; `receiveShadow: false` sets flag bit 0.
- **`ParticleSystem`** (`fx`): `new ParticleSystem(renderer, { space: 'world', capacity, blend, lit, fade: { near, far }, softness, floorY?, stretch })` is a GPU particle pool in world units (y up); `frame.drawable(system, order)` draws it. **`ParticleEmitter(system, params, rate)`** spawns `rate` per second from `params` (`x`, `y`, `z`, `shape`, `speed`, `life`, `size`, `colorStart/End`, `gravity`, `wind`, `drag`, `emissive`); mutate `emitter.params.x/y/z` to move it (the snow follows the player). Call `emitter.update(dt)` and `system.update(dt)` each tick.
- **`ctx.ui`** (`ui`): the DOM overlay in CSS px. **`ui.layout.add(el, { place: { default: 'top' | 'bottom' | 'left' | 'right' | ... , 'phone-portrait': 'hidden' }, order })`** places a widget in a region per form factor; `ui.layers.hud` is the layer that sits on the canvas frame for free-positioned HUD (the crosshair). **`ui.anchors(() => ctx.camera)`** returns the overlay's `Anchors`; `anchors.add(el, [x, y, z], { align, offset, scale: 'distance', clamp, margin, hideBehind })` pins a DOM element to a world point and `createGame` updates it after every frame (`handle.set(world)` moves it, `handle.remove()`). `ui.toasts.show(text, { tone, duration })`, `ui.stack` (panels; a modal blocks input), `h` (hyperscript), `button`. Theme tokens: `--tc-font-display`, `--tc-font-size-m/l`, `--tc-color-text`.
- **`Input` bindings** (`input`): `createGame` builds `ctx.input` from `bindings: Record<Action, Binding[]>`: `{ key: 'KeyE' }`, `{ padButton: 0 }`, `{ padAxis, dir }`, `{ mouse: 0 }`, `{ gesture: 'tap' }`, **`{ pointer: 'select' }`** (any pointer's button through the pointer router). Read per tick: `input.pressed(a)`, `held(a)`, `released(a)`, `value(a)`; `input.lastDevice` for prompts. Input is blocked while a modal panel is open.
- **`ctx.pointers`** (`input`): every mouse, pen, touch and pad-cursor pointer becomes a ray through `ctx.camera`, tested against hit testers you register: `ctx.pointers.addTester(aabbTester(boxes))` (returns the remover; `boxes` is a live `Aabb<T>[]` with `min`, `max`, `target`). `ctx.pointers.hit` is the primary pointer's nearest hit (`target`, `point`, `distance`); events `hit`, `hitEnd`, `select`. A `{ pointer: 'select' }` binding selects what is hovered. Under the pointer lock the mouse stops moving, so the crosshair casts its own ray: `screenRay(camera, design.width / 2, design.height / 2, ray)` and the same tester function.
- **`Scene`** (`core`): `{ name, enter(ctx), exit(), update(dt), render(frame, camera, alpha) }`; `ctx.stack.push(scene)`. Only the top scene updates; `render` draws through the ctx camera.
- **Host** (`host`): the page the game runs in (`web` top-level or iframe, Electron through `@thunderclap/host-electron`): `openExternal`, `copyText`, `fullscreen`, `storage`. The game never touches `window.open`, the clipboard or `localStorage` directly.

## Extending it

- A new block kind: a layer constant in `world/terrain.ts`, a colour in `art/blocks.ts`, a rule in `layerForTop`/`layerForSide` with a test.
- A new landmark or interaction: add it to `findLandmarks` (or a new pure finder), and it gets a marker, a label, a hit box and the crosshair for free; put what happens in the scene's `inspect`.
- Caves, overhangs or edits at runtime: replace the height field with a block volume in `world/` and the mesher with a face-culling one; keep `meshChunk(…, buffer) → { vertexCount, indexCount, bounds }` and nothing in the scene changes. Re-mesh a chunk by posting its request again and reusing the buffer that came back.
- A server: build the transport in `main.ts`, apply its state in `ctx.hooks.frame(dt)` or the scene's `update`, and send `player.position`/`yaw` from there.
- Weather: swap the snow emitter's params for the rain in the engine's `harness/weather.ts` shape (`stretch`, `floorY`, additive blend) or add a second system.
- Post-processing: `post: { bloom: {...} }` on `createGame`, or `ctx.post` at runtime; the markers' `emissive` already feeds it.

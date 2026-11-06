# What the engine offers (after wave 4)

*2026-11-05, for the Last Rune and Forgewilds PMs. One line per capability with its entry point. Everything under "Landed" is on `main` at `65800b7` or later, tested on the harness matrix (611 unit tests, e2e 502 passed / 52 skipped). Contracts: `ARCHITECTURE.md`; module details: each `src/<module>/README.md`.*

## Landed

| Capability | Entry point | Workstream |
| --- | --- | --- |
| One boot call: surface, renderer, post, particles, input, overlay, audio, host, loop, lifecycle, device loss | `createGame(opts)` from `@thunderclap/engine`; `ctx: EngineCtx` | create-game |
| Pure client of a server-authoritative game (no save, loop at render rate) | `createGame({ sim: false })` with no `save`; `hooks.frame(dt)` | client-mode |
| Matrix camera, 2D by default, perspective with depth; split views and stereo pairs | `Camera.ortho2d`, `Camera.perspective`, `camera.screen`, `camera.viewIndex`; `renderer.render(frame, camera, target)` | camera, render-call, two-views |
| One instance format for sprites and meshes, a vertex layout per mesh, hierarchical transforms | `Transform`, `frame.sprite`, `frame.mesh`, `VERTEX_LAYOUT_2D` / `VERTEX_LAYOUT_3D` | transforms |
| Lighting block read by the game's WGSL: ambient, sun, 16 point lights | `frame.lights: Lights`; `engine_lambert`, `engine_point_lights` in `materialPrelude` | lights |
| Sun shadow map and distance fog | `lights.sun.shadow: SunShadow`, `lights.fog: Fog`; `engine_shadow(world_pos)`, `engine_fog(color, world_pos)`; `InstanceParams.castShadow` / `receiveShadow` | shadows |
| Meshes streamed from a Worker without a main-thread copy | `createMesh({ capacity })`, `mesh.update({ vertices, indices, vertexCount, indexCount })` | mesh-stream |
| Frustum culling per draw | `mesh.bounds`, `camera.cull` (perspective default), `camera.frustum`, `renderer.stats.culled` | cull |
| Texture arrays with GPU mip generation | `createTextureArray`, `loadTextureArray(device, sources, { mips })`, `generateMipmaps`, `viewDimension: '2d-array'` on `MaterialDesc`, mip sampler kinds | texture-array |
| glTF 2.0 static geometry (engine-free parse, then meshes, transforms, textures, a lit material) | `parseGltf(bytes)`, `loadGltf(renderer, doc, opts?)` → `GltfScene.draw(frame)` from `@thunderclap/engine/assets` | gltf |
| Pointers as rays, hit testing, select; pad cursor | `ctx.pointers` (`createPointerRouter`), `planeTester`, `aabbTester`, bindings `{ pointer }` / `{ xr }` | input-rays |
| First-person look and move: pointer lock, touch zones, sticks, keys | `new Look(opts)`, `input.setLook(look)`; `look.look` / `look.move` per tick | look |
| Gestures (tap, double tap, long-press, pan, drag, pinch) and the touch loupe with snap | `ctx.gestures`; `CreateGameOptions.input.magnify`, `snapToGrid` | gestures, port-altar, plumbing |
| One DOM overlay in CSS px on every form factor, layout regions, free rect for the world | `ctx.ui`, `ctx.ui.layout`, `CreateGameOptions.layout`; `camera.fitFreeRect(worldRect, ui.layout.freeRect, surface)` | one-overlay, layout, plumbing |
| DOM anchored to world points (labels over 3D objects), clamped and distance-scaled | `ctx.ui.anchors(camera).add(el, world, opts)`; updated by `createGame` each frame | anchors |
| GPU particles in 2D or world space (camera-facing, soft, lit), weather-class FX | `new ParticleSystem({ space: 'world', lit, fade, softness })`, `EmitParams` with `z`, `vz`, `wind`, 3D `gravity` | particles-3d |
| Spatial audio: a listener and positioned voices | `audio.listener.fromCamera(camera)`, `PlayOptions.at`, `voice.setPosition` | spatial-audio |
| WebXR: enter and leave an immersive session, an eye per render, controllers and hands as rays | `createGame({ xr })`, `ctx.xr.enter()` / `exit()` / `supported()`; `XrSurface`, `createXrHost`, `XrPointerSource` | xr |
| Hosts: top-level page, cross-origin iframe, Electron | `Host`, `createWebHost`, `createElectronHost` (`@thunderclap/host-electron`) | host, host-electron |
| Typed analytics events to a game-supplied sink | `createAnalytics({ sink }).attach(ctx)`; the template's `createBeaconSink(url)` | analytics |
| Versioned saves with migrations, quota- and blocked-storage-safe | `createSaveStore({ ..., host })`, `s` schemas | save |
| Copyable 2D puzzle template | `templates/puzzle` (`pnpm template:puzzle`) | template-puzzle |

Not XR yet: the post stack per eye (an XR frame skips post; see below).

## In flight (wave 5, `docs/STATUS.md`)

Branches exist; nothing here is on `main`. Names are the briefs' and may change at merge.

| Stream | What it adds | Entry point (planned) |
| --- | --- | --- |
| ws/xr-post | post stack per eye into the projection layer | `ctx.xr.enter()` runs `ctx.post` per eye |
| ws/gltf-anim | glTF skins and animations in `anim` shapes | `GltfDocument.skins` / `animations`, `skeletonFromSkin`, `interleaveSkinned` |
| ws/anim | pure animation module: clips, `Pose`, `Skeleton`, mixer with layers and crossfade | `@thunderclap/engine/anim` |
| ws/skinning | GPU skinning in the scene and shadow passes | `VERTEX_LAYOUT_SKINNED`, `SkinPalette` |
| ws/pbr | standard PBR material over the lights block, shadows and fog | `createStandardMaterial`, `WGSL_PBR` |
| ws/follow | third-person follow camera on `Look` | `Follow` (`mode: 'first' \| 'third'`) |
| ws/trails | ribbon trails in 2D or world space | `Trail` |
| ws/shadow-cull | shadow casters outside the view frustum still cast | `renderer.stats.shadowDraws` |
| ws/template-first-person | copyable 3D walk: `Look`, Worker chunks, texture array, shadow, fog, weather, anchors | `templates/first-person` |

After wave 5 (candidates, unscheduled): spot lights and per-light layer masks, attachment sockets, a third-person showcase template, GPU picking, publishing `engine-v1.0.0`.

## How to ask for more

VISION rule 6: a capability arrives with the game that needs it. Name the game, the scene and the month in a note to the engine PM; it becomes a brief in `docs/briefs/` and a row in `docs/STATUS.md`.

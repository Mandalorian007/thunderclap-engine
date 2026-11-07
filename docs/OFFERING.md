# What the engine offers

*2026-11-06. One line per capability with its entry point, as on `main` today. Everything here is tested on the harness matrix. Contracts: [ARCHITECTURE.md](../ARCHITECTURE.md). Walkthroughs: [docs/guide/](guide/). Full reference: each `src/<module>/README.md`.*

## Start and run

| Capability | Entry point |
| --- | --- |
| One boot call: surface, renderer, post, particles, input, overlay, audio, host, loop, lifecycle, device loss | `createGame(opts)` from `@thunderclap-engine/engine`; `ctx: EngineCtx` |
| Scenes on a stack, fixed 60 Hz update, variable-rate render | `Scene`, `ctx.stack`, `ctx.loop` (`GameLoop`) in `@thunderclap-engine/engine/core` |
| Pure client of a server-authoritative game (no save, loop at render rate) | `createGame({ sim: false })` with no `save`; `hooks.frame(dt)` |
| Page lifecycle: hide, show, freeze, device loss | `GameHooks` (`hide`, `show`, `deviceLost`) |
| Seeded random, noise, timers, pools | `createRandom`, `createNoise`, `createScheduler`, `createPool` in `core` |
| Starting a game from a template | `pnpm create-game <dir> --template puzzle \| platformer \| first-person \| third-person` |
| Hosts: top-level page, cross-origin iframe, XR session | `Host`, `createWebHost`, `createXrHost` in `@thunderclap-engine/engine/host` |
| Desktop, mobile and installable shells | `createElectronHost` (`@thunderclap-engine/host-electron`), `createCapacitorHost` (`@thunderclap-engine/host-capacitor`), `createPwaHost` and `pwaPlugin` (`@thunderclap-engine/host-pwa`) |

## Render

| Capability | Entry point |
| --- | --- |
| Draw recorder for sprites and meshes, one instance format | `Frame`: `frame.sprite`, `frame.mesh`, `frame.meshes`; `Transform` in `@thunderclap-engine/engine/render` |
| Matrix camera: 2D by default, perspective with depth, split views and stereo | `Camera.ortho2d`, `Camera.perspective`, `camera.screen`, `camera.viewIndex`; `renderer.render(frame, camera, target)` |
| Materials in the game's WGSL, with a prelude for lights, shadow and fog | `renderer.createMaterial({ label, wgsl })`, `materialPrelude` |
| Lighting block: ambient, sun, 16 point lights, 8 spot lights, layer masks | `frame.lights: Lights`, `SpotLight`, `layers` on lights |
| Sun shadow map and distance fog | `lights.sun.shadow: SunShadow`, `lights.fog: DistanceFog`; `engine_shadow`, `engine_fog` in WGSL |
| Standard PBR material (glTF metallic-roughness), normal maps, dissolve | `createStandardMaterial`, `WGSL_PBR` |
| GPU skinning in the scene and shadow passes | `VERTEX_LAYOUT_SKINNED`, `SkinPalette` |
| Meshes streamed from a Worker without a main-thread copy | `renderer.createMesh({ capacity })`, `mesh.update(...)` |
| Frustum culling and shadow-caster culling | `mesh.bounds`, `camera.cull`, `renderer.stats.culled`, `stats.shadowDraws` |
| Level of detail by screen size, instance lists with stable keys | `MeshLod`, `selectLod` (`geom`), `InstanceList` |
| Textures, texture arrays with GPU mips, KTX2 compressed textures | `loadTexture`, `loadTextureArray`, `createTextureArray`, `uploadKtx2` |
| 2D kit: tile layers, flipbooks, parallax, a follow camera | `createTileLayer`, `Flipbook`, `createParallax`, `createFollow2D` |
| Dynamic resolution | `DynamicResolution` |

## Post and FX

| Capability | Entry point |
| --- | --- |
| Post stack: bloom, tone map, grade, vignette, god rays, fog | `ctx.post` (`PostStack`) in `@thunderclap-engine/engine/post`; `CreateGameOptions.post` |
| Depth passes: ambient occlusion, depth of field | `PostSettings.ao`, `PostSettings.dof` |
| Temporal and screen-space passes: TAA, SSR, motion blur, auto exposure, white balance, lens dirt | `PostSettings.taa`, `ssr`, `motionBlur`, `autoExposure`; `Taa` |
| Finishing passes: FXAA, LUT, grain, aberration, sharpen, outline | `PostSettings.fxaa`, `lut`, `grain`, `aberration`, `sharpen`, `outline` |
| Quality tiers for weaker devices | `postQualityFor(tier)`, `lowPostQuality()`, `PostQuality` |
| Post per eye in VR | `renderer.resolve(target, out, viewport?)` |
| GPU particles in 2D or world space: soft, lit, sprite sheets, forces, depth collision, sub-emitters | `ParticleSystem`, `EmitParams` in `@thunderclap-engine/engine/fx` |
| Effect descriptors with seeds | `createEffect`, `EffectDesc` |
| Sky, water, ribbon trails, projected decals | `Sky`, `Water`, `Trail`, `Decals` |
| Billboards with a text atlas, debug lines | `createBillboards`, `createDebugDraw` |

## Content

| Capability | Entry point |
| --- | --- |
| glTF 2.0: meshes, materials, skins, animations, morph targets, lights, cameras, variants, quantized and meshopt data | `parseGltf(bytes)`, `loadGltf(renderer, doc, opts?)` in `@thunderclap-engine/engine/assets` |
| Typed asset loading with progress, an asset cache, atlas packing | `defineManifest`, `createBundle`, `createAssetCache`, `packAtlas` |
| Procedural geometry and heightfields | `box`, `sphere`, `capsule`, `torus`, `createHeightfield`, `mergeGeometry` in `@thunderclap-engine/engine/geom` |
| Static colliders, capsule and circle sliding, moving tiles | `createStaticCollider`, `slide`, `slide2`, `slideTiles` |
| Voxel grids, greedy chunk meshing with baked AO in a Worker, culled chunks, block picking | `createVoxelGrid`, `createVoxelMesher`, `createVoxelChunks`, `raycastVoxels` in `@thunderclap-engine/engine/voxel` |
| Grid navigation: A*, flow fields, reachability, steering | `createNavGrid`, `findPath`, `createFlowField`, `reachable` in `@thunderclap-engine/engine/nav` |
| Navmeshes, path queues, crowds, carved obstacles | `bakeNavMesh`, `createPathQueue`, `createCrowd`, `createObstacleSet` |
| Build-time bakes of navmeshes and colliders | `pnpm bake bake.config.json`, `importNavMesh`, `importCollider` |
| Animation: clips, a mixer with layers and crossfade, a state graph, blend spaces | `AnimationMixer`, `createAnimGraph` in `@thunderclap-engine/engine/anim` |
| IK, look-at, retargeting, spring chains, morph weights | `twoBoneIk`, `lookAt`, `retargetPose`, `createSpringChain`, `sampleWeights` |
| Sockets: a transform that follows a joint | `createSocket`, `attachTransform` |
| Tweens: easing, sequences, springs | `createTweens`, `ease` in `@thunderclap-engine/engine/tween` |

## Input

| Capability | Entry point |
| --- | --- |
| One action map over keyboard, mouse, touch, pen and gamepad | `createGame({ input: { bindings } })`; `ctx.input.pressed`, `held`, `value` |
| Action contexts, an input buffer, stick shapes, rumble | `Input` in `@thunderclap-engine/engine/input` |
| Gestures and the touch loupe with snap | `ctx.gestures`; `input.magnify`, `snapToGrid` |
| Pointers as rays and hit tests against planes, boxes and meshes | `ctx.pointers`, `planeTester`, `aabbTester`, `meshTester` |
| First-person look and move: pointer lock, touch zones, sticks, keys | `createLook(opts)`, `Look` |
| Third-person follow camera | `Follow` |
| Touch zones: sticks, buttons, swipes | `createTouchZones` |
| Gyro aim | `createGyroSource` |
| Record a session and replay it tick for tick | `createGame({ input: { record, replay } })`, `ctx.replay(rec)`, `createInputRecorder`, `createInputPlayback` |
| WebXR: immersive session, an eye per render, controllers and hands as rays | `createGame({ xr })`, `ctx.xr.enter()`; `XrSurface`, `XrPointerSource` |

## UI, audio and plumbing

| Capability | Entry point |
| --- | --- |
| One DOM overlay in CSS px with layout regions per form factor and safe areas | `ctx.ui`, `ctx.ui.layout`, `LayoutSpec` in `@thunderclap-engine/engine/ui` |
| Panels, buttons, toggles, sliders, toasts, captions, a modal stack, pad navigation | `ui.stack`, `button`, `toggle`, `slider`, `ui.toasts`, `ctx.padNav` |
| HUD widgets: meters, orbs, rings, compass, minimap, reticle, slots, heading, floating numbers | `ui.meter`, `createOrbMeter`, `ui.ring`, `ui.compass`, `ui.minimap`, `createReticle`, `createSlots`, `ui.floats` |
| Inventory grids, drag and drop, cards, radial and context menus | `createDragContext`, `Grid`, `ContextList` |
| DOM anchored to world points | `ctx.ui.anchors(() => camera).add(el, world, opts)` |
| Panels in the 3D world or head-locked in VR | `createWorldPanel` |
| Loading screen and notifications | `createLoading`, `createNotifier` |
| Audio: buses, synth, recipes, mixer persistence | `ctx.audio` (`AudioEngine`) in `@thunderclap-engine/engine/audio` |
| Spatial audio, zones, occlusion, Doppler | `audio.listener`, `AudioPlayOptions.at`, `AudioZones` |
| Music stems, variations, ducking, sends | `createMusic`, `createVariations`, `createDucker`, `createSend` |
| Versioned saves with migrations, slots, settings, undo journal | `createSaveStore`, `s`, `createSlotManager`, `createSettingsStore`, `createJournal` in `@thunderclap-engine/engine/save` |
| Typed analytics events to a game-supplied sink | `createAnalytics({ sink }).attach(ctx)` in `@thunderclap-engine/engine/analytics` |
| String tables, plurals, a runtime locale swap | `createI18n`, `negotiateLocale` in `@thunderclap-engine/engine/i18n` |
| A fake GPU for unit tests | `@thunderclap-engine/engine/testing` |

## How to ask for more

VISION rule 6: a capability arrives with the game that needs it. Name the game, the scene and the month in a note to the engine PM; it becomes a brief in `docs/briefs/` and a row in `docs/STATUS.md`.

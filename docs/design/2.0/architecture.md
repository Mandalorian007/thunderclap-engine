# D1: ThunderClap target architecture (2026-11-14)

**Status (2026-11-14):** accepted as the 2.0 target (E-041), with one change: decision 2 moved the client side of networking into the engine (a `net` module) and a server foundation after it, where this doc kept netcode in Forge. The program is [ROADMAP.md](../../ROADMAP.md); the switch bar is [bar.md](bar.md), softened by E-041 (timing is a floor, not parity).

Design only. Nothing here is built. Inputs: A-engine.md, A1, A2, A3, B-client.md, C-spike.md (this folder), and the code at TC 5022d33 and Forge d38b72ad.

Paths:
- `TC:` is thunderclap-engine/src.
- `FW:` is forgewilds/apps/web/src.
- `LR:` is last-rune/games/last-rune.

**The one-paragraph answer.** ThunderClap 2.0 keeps one renderer, built in two layers:
- **The bottom layer is a retained, view-plural core.** It holds draw sets in buffer arenas, culls once per frame for all views, encodes through render bundles and indirect draws, and builds only the passes and targets that something uses. It is Forge's render model (FW:render/renderer/, arena.ts, view.ts) with the game nouns taken out.
- **The top layer is TC's immediate API.** `frame.sprite`, `frame.mesh`, `frame.meshes`, `InstanceList` and `Drawable` (TC:render/frame.ts:243-396) become a "transient set" over that core. A 2D sprite game pays one upload and one sorted draw list per frame, as it does today, and never touches the compute cull, the shadow pass or the arenas.

Everything that is a foundation becomes an independent TC module that `createGame` composes as a kit: voxel streaming and meshing, part models, GPU-posed actors, the UI spec with its DOM and world presenters, intents, stereo, the governor and the counted-work rails. Forge keeps its rules, content meaning, net, play and wiring.

---

## 1. Principles

Each principle gives the call, the reason, and the alternative it rejects.

### P1. One renderer, two layers: a retained GPU-driven core under an immediate convenience layer

- **Call.** Every draw lands in a `DrawSet`: a pipeline, an instance layout, a source of instances and a cull mode.
  - Retained sets are kinds of sets: static sets backed by bundles, dynamic sets with dirty-range instances, and large GPU-culled sets.
  - The immediate API fills one per-frame *transient* set per (material, mesh), exactly as `pushInstance`/`pushBatch` do today (TC:render/renderer.ts:1687, 1787).
- **Why.**
  - The spike measured the cost of the immediate path at Forge's scale: route b ran 2.5 vs 1.0 ms CPU and about 1.8× the GPU on the same terrain (C-spike "Numbers").
  - A 50-sprite puzzle must not pay for compute culls or bundles either.
  - Layering lets each game pay for what it records. The sprite path stays O(sprites) with no compute pass. The voxel path stays O(change) with "46 calls flat" (B §2).
- **Rejected: two renderers (a 2D one and a 3D one).** They would mean two post, XR and test stacks. TC VISION pillar 3 ("2D and 3D on one renderer") holds, and a 2.5D game (sprites in a 3D world, a HUD-in-world) would straddle both.
- **Rejected: GPU-driven for everything.** It needs a compute cull, `indirect-first-instance` and bundle invalidation for a game with 40 sprites. It is also harder to debug, and it buys nothing at that scale.

### P2. Views are plural from the bottom: prepare once, draw N

- **Call.** A frame runs `prepare(views[])` once (cull, sort, upload, shadow and pose compute), then `draw(view)` for each view, then one submit. This is Forge's seam generalized (FW:render/renderer/frame.ts:14-29, FW:render/view.ts:47-66).
- **Cull groups.** Views come in *cull groups*:
  - a stereo pair is one group, culled by the union frustum (FW:render/view.ts:134 `unionPlanesInto`);
  - split-screen views or a minimap are separate groups.
- **Why.**
  - VR is first-class only if stereo costs once, not twice. Today TC renders, culls, shadows and posts per eye (TC:core/game.ts:760-773). Forge pays 1 cull, 1 pose and about 1.15× an eye's sections (B §5).
  - The same seam serves a 2D game's minimap or a level-editor split view.
- **Rejected: per-eye `render()` (TC today).** It doubles CPU and the shadow pass.
- **Rejected: waiting for WebGPU multiview.** It is not in the spec, and WebKit has nothing like it.

### P3. Pay only for what is used: passes, targets and attachments come from what is recorded

- **Call.** Each item is created and encoded only when its condition holds:
  - the shadow pass, when a sun shadow is configured *and* some set is a caster;
  - the emissive MRT attachment, when a material in the frame declares `emissive` or bloom reads it;
  - the depth attachment, when a camera asks for depth;
  - the HDR target, when post is on (otherwise draw straight to the swap chain, as Forge's "off" preset does, B App. A §1);
  - the depth copy, when a drawable `readsDepth`.
- **Why.** The spike's leading suspect for the 1.8× GPU cost is the always-on `FragOut` MRT (TC:render/wgsl.ts:459-461) at 2360×1640. 2D games and the iPad pay fill for every attachment.
- **Rejected: a fixed scene target shape (TC today).** It is simple, but it puts a tax on every game.
- **Rejected: a general frame graph.** It is too big for the risk budget. P3 is a small *declared* pass list with conditions, not a graph solver (see §3.6).

### P4. Kit, not framework: `createGame` composes independent services, and nothing is mandatory

- **Call.** Every service has a standalone `create*` function: surface, gpu, renderer, post, audio, input, ui, xr, governor and loop. `createGame(kit)` is a ~150-line composer, and each service is a field the game passes, accepts as a default, or sets to `false`.
- **Why.**
  - `createGame` today builds everything, and `overlay:false` is all or nothing (TC:core/game.ts:185-191, A-engine §1). It also defeats tree-shaking: 171 kB gzip for a small import set (C-spike "Bundle size") against Forge's 30 kB of headroom (B §5).
  - A composer whose fields are *imports the game makes* tree-shakes, because the default kit lives in a separate entry (`@thunderclap-engine/engine/kit/default`).
- **Rejected: opt-out flags only (`createGame({ui:false})`).** The code is still imported, so the bundle cost remains.
- **Rejected: pure à la carte with no composer.** Every game would rewire the loop, lifecycle, device loss and XR frame source, which is the "reimplementing foundations" the user wants gone.

### P5. Data in, no scene graph; the game owns state, the engine owns buffers

- **Call.** Games push typed arrays and handles into retained sets: `set.write(slot, data)`, `voxel.putSection(key, bytes)`, `actors.setRecord(i, rec)`. The engine has no entity system and no scene tree. Transforms are a helper, not a graph.
- **Why.**
  - Forge's renderer already works this way: there is no scene graph, and game code pushes data in (B §3 "Net → renderer").
  - Forge rejected three.js and Babylon.js for exactly this reason (DEPENDENCIES.md:75).
  - A server-authoritative client must not have engine-side simulation state.
  - The Last Rune draws immediately each frame, which is the same model at a different rate.
- **Rejected: an ECS or scene graph in the engine.** It would force a data model on every game and stand between voxel meshing and the GPU buffers.

### P6. Shader-first and asset-optional: WGSL modules, procedural geometry, glTF as an opt-in island

- **Call.**
  - Materials are game WGSL over a small, opt-in prelude. Each prelude piece is a named include: lights, fog, shadow, skin, noise, voxel decode.
  - Geometry comes from `geom` builders, part models, meshers or, optionally, `assets` (glTF/KTX2).
  - The core never imports `assets` (it holds today: only TC:render/compressed.ts:9 does).
  - No WGSL `override` anywhere, ever. The iPad WebKit rule (FW test/shaders.test.ts) becomes a TC rail.
- **Why.**
  - Forge's binding rule is no texture or model pipeline.
  - LR is procedural WGSL.
  - Other games (a glTF character game) need glTF without forcing it on anyone.
  - Forge's scene shader is hand-written WGSL modules (B §7: "any engine material system must accept hand-written WGSL modules").
- **Rejected: a node material system or a mandatory PBR "standard" material.** It is a style cost, and it rewrites every Forge visual.

### P7. UI is described once as data; presenters are per surface; the look is tokens, not parsed CSS

- **Call.**
  - TC's `ui` becomes Forge's spec → layout → model → presenter system (FW:ui/spec/).
  - It has a DOM presenter and a world presenter (Canvas2D → texture) for XR and in-world panels.
  - The look is a token sheet the spec references, emitted as CSS for the DOM and read directly by the world presenter. That replaces FW:xr/ui/spec/look.ts (1,027 lines of CSS resolver).
- **Why.**
  - The user's rule is "one HUD for flat/touch/VR".
  - TC's DOM overlay doesn't show in a headset, and its world panels are a separate smaller kit (A2 §1).
  - Forge's system already proves screen and headset parity with tests (FW test/xr/ui-world-words.test.ts).
- **Rejected: keep TC's DOM overlay plus world panels.** Every game would write its UI twice.
- **Rejected: an all-GPU UI.** It loses DOM accessibility, text input and IME on screens.

### P8. Input as actions → intents, aim always a ray

- **Call.**
  - Devices map to actions; TC's `Input` (TC:input/) stays.
  - Actions plus the pointer router's rays map to *game-declared intents*, pushed to a sink. Forge's `ActionSink` (FW:play/actions.ts:63-101) is one such intent set.
  - Gesture primitives that Forge proved move into TC: still-hold, tap, and stick-side hold.
- **Why.**
  - Every style needs press, aim and release over keyboard, mouse, touch, pad and XR without seeing devices.
  - Forge's intents (`gathers`, `pick`, hotbar) are game nouns, so the intent *vocabulary* is the game's and the *plumbing* is TC's.
- **Rejected: polling actions only (TC today).** Each game rebuilds hold/tap timing.
- **Rejected: moving Forge's ActionSink as is.** It is full of game nouns.

### P9. Counted work is the engine's product; WebKit iPad is the reference device

- **Call.** `@thunderclap-engine/engine/testing` ships these rails, and every module carries its own counted budget:
  - a fake GPU that records a call trace (TC:render/fake-gpu.ts plus Forge's sha256 golden, FW test/client-budget-frame.test.ts);
  - an allocation counter;
  - a clock-read counter;
  - a "work proportional to change" harness.
- **WebKit.** TC CI gains a Playwright WebKit project, and real-iPad bench rungs are the parity gate (G5).
- **Why.**
  - "No change may cost client frame time" is only enforceable with counted rails.
  - TC has never run on WebKit (A3), and it is where Forge plays.
- **Rejected: benches with medians only (TC's BENCH.md).** They do not catch regressions in CI.

### P10. Generalize, never copy: Forge code moves with its nouns turned into declared data

- **Call.** A Forge module moves only once its game concepts are parameters. Examples:
  - The 8 B vertex's ripeness, worked and rune-hue bits become a game-declared bitfield schema with generated WGSL decode.
  - Block kinds become declared face classes.
  - Panel words stay in Forge, and the word *types* go to TC.
- **TC's promotion rule changes** from "LR uses it" to "a shipped consumer uses it and its API has zero game nouns".
- **TC VISION rule 5 needs an amendment.** It reads "a voxel mesher … is a game's content pipeline". It becomes "foundations, not rules": world representation, streaming and meshing are foundations, while rules, content and servers are the game's (open question Q1).
- **Why.** This is the user's direction: TC is "the core engine … rather than reimplementing the foundations for dozens of games".
- **Rejected: TC as a Forge fork with Forge nouns.** It serves one game.
- **Rejected: rewriting Forge's subsystems from scratch in TC.** It throws away measured iPad tuning.

---

## 2. Module map (TC 2.0)

Legend: **Takes** = Forge sources (FW:), **Keeps** = TC today (TC:), **Drops** = removed or replaced, **Others** = other game styles.

Layering (the check-boundaries rank, low → high):

`core · math · geom · tween` → `platform · host · gpu` → `render` (core) → `render/2d · mesh · models · actors · voxel · terrain · fx · post` → `quality` → `input · audio · ui` → `xr` → `kit` (createGame) → `testing` (dev only)

### 2.1 `core` (loop, clock, events, kit composer split out)

- **Job:** the frame loop with frame-source swap (rAF / XR / Electron), the optional fixed step (`sim:false` = client mode), clocks, and the Emitter.
- **API:** `createLoop({ frames, step?: number | null, update?, frame })`, `TickClock`, `Emitter`.
- **Takes:**
  - Forge's "clock read twice a frame and passed down; renderer reads 0" discipline (FW:boot/frame.ts:569-587 `tick`, B §3) as a contract;
  - the frame cap.
- **Keeps:** TC:core/loop.ts, clock, events, and scenes (`SceneStack` as an optional helper).
- **Drops:** `createGame` moves out to `kit` (P4).
- **Others:**
  - fixed-step sims (puzzlers, arenas, local physics);
  - client mode (networked games).

### 2.2 `platform` + `host` + `gpu`

- **Job:**
  - the surface and DPR (`computeBackbuffer`), lifecycle, fullscreen, capability probes;
  - **`gpu`** (new subpath): the device, a caps/quirks table, and **device-loss recovery**.
- **API:**
  - `initGpu()` → `{ device, caps: { indirectFirstInstance, multiDrawIndirect, timestamp, maxBuffer… }, quirks: { webkit… } }`;
  - `gpu.onRebuild(fn)`: a resource registry; every renderer-owned buffer, pipeline and bundle is re-creatable, and modules re-upload from their own CPU sources.
- **Takes:**
  - Forge's XR reload-with-guard (FW:xr/session.ts, A2 §4);
  - the iPad notes (61 files mention WebKit, A2 §4) distilled into `quirks`;
  - the no-SharedArrayBuffer assumption (B §3).
- **Keeps:** TC:platform/* (gpu.ts:79-83 failure reasons, screens), and TC:host/* unchanged.
- **Drops:** the halt-on-loss default (TC:platform/boot.ts:37-62) becomes automatic rebuild, with the reload screen kept as a guarded fallback. This follows "recoverable without effort".
- **Others:** every game. Electron, Capacitor and PWA hosts stay.

### 2.3 `render` (core): see §3 for detail

- **Job:** arenas, layouts, draw sets, views, culling, pass list, targets, materials and prelude, bundles, the GPU timer, dynamic resolution.
- **API (key):**
  - `Renderer`;
  - `renderer.arena(kind)`;
  - `createDrawSet(desc)`;
  - `createVertexLayout({ attributes, wgslDecode? })`;
  - `createInstanceLayout`;
  - `beginFrame / prepare(views) / draw(view) / endFrame`;
  - `View`, `CullGroup`;
  - the immediate `Frame` API, unchanged.
- **Takes:**
  - FW:render/arena.ts (ArenaPool, first fit with skip index);
  - FW:render/view.ts (View, RenderTarget, unionPlanesInto);
  - FW:render/renderer/frame.ts (prepare/draw/submit);
  - FW:render/renderer/sections.ts:169-210 (bundle encoding of indirect draws);
  - FW:render/shaders/cull.ts (cs_cull into DrawIndexedIndirect args);
  - FW:render/pass-timer.ts (24 timestamp pairs, 1 frame in 8);
  - FW:render/forward.ts (forward/tonemap-inline eye variant);
  - the reversed-Z infinite projection (FW:render/renderer/common.ts:65-66).
- **Keeps:**
  - TC:render/material.ts and wgsl.ts (the prelude, split into includes);
  - camera.ts and camera-2d.ts;
  - transform, lod, lights (layer masks), shadow.ts (with snapping + cascades, R5/R6);
  - scene-target, texture, mipmap, dynamic-resolution, gpu-timer, diagnostics, fake-gpu.
- **Drops:**
  - The per-view `buildDraws` CPU cull+sort+copy as the *only* path (TC:render/renderer.ts:1946). It stays, but only as the transient-set path, run once per cull group.
  - The fixed MRT `FragOut`.
  - The fixed 112 B instance as the only layout (it stays as `STANDARD_INSTANCE`).
  - Per-`Mesh` vertex and index buffers for arena users (`Mesh` keeps its own buffers for small users).
- **Others:**
  - 2D: transient sets of sprites;
  - glTF games: dynamic sets plus the skin palette;
  - voxel and terrain: GPU-culled static sets;
  - VR: cull groups.

### 2.4 `render/2d` (sprites, tile layers, 2D camera, text-in-world)

- **Job:** the 2D conveniences, all over transient or static sets.
- **API:**
  - `frame.sprite(material, params)` (unchanged);
  - `createTileLayer(renderer, opts)` (TC:render/tile-layer.ts:125) becomes a *static* set, rebuilt on edit;
  - `ortho2d`, `fitRect`, parallax, flipbook.
- **Takes:** nothing (Forge has no 2D).
- **Keeps:** TC:render/tile-layer.ts, camera-2d.ts, parallax.ts, flipbook.ts, sprite materials (`createSpriteMaterial`, TC:render/renderer.ts:920).
- **Drops:** nothing. The tile layer gains bundle backing for free from the core.
- **Others:**
  - LR (47 `frame.sprite` sites, 24 `createMaterial`);
  - side-scrollers, tactics maps, card games;
  - HUD-in-world quads in 3D games.

### 2.5 `geom` + `mesh` (procedural shapes, mesh descriptors)

- **Job:** procedural geometry and typed mesh descriptors.
- **API:** `box/plane/sphere/capsule…` (kept); `MeshDesc<V extends ArrayBufferView>` (C-spike friction 2); `sharedQuadIndex(renderer, maxQuads)` (friction 3).
- **Takes:** the shared u32 quad index buffer (FW:render/renderer/setup.ts:100, MAX_QUADS).
- **Keeps:** TC:geom/*, TC:render/mesh.ts with optional `wgslUv`/`wgslColor` (the C-spike patch).
- **Drops:** the `Float32Array`-only typing.
- **Others:** every 3D game, and editors.

### 2.6 `models` (new): procedural part models

- **Job:** turn a *part tree* (data) into packed meshes and instanced units.
  - Shapes: box, cylinder, gear, ring, prism, frustum, wedge.
  - Structure: grouped, turned, repeated.
  - Motion: bound to named state channels, evaluated in the shader from time.
- **API:**
  - `compileModel(spec: PartModel, materials: MaterialCodeTable)` → `ModelUnits`;
  - `createModelScene(renderer, { maxInstances })` with `place(unit, slot, xform, state)`;
  - instances are written only on change.
- **Takes:**
  - FW:render/models.ts (496);
  - FW:render/model-scene.ts (738);
  - FW:render/parts-shader.ts and shaders/model-parts.ts.
  - The 15 procedural material codes ("MM") become a game-declared code table.
- **Keeps:** geom builders as the primitives.
- **Drops:** nothing in TC. On Forge's side, content-schema knowledge (the JSON shape of Forge content) stays in Forge as an adapter to `PartModel`.
- **Others:**
  - asset-free 3D games (low-poly, toon, machines);
  - editor tooling;
  - LR-style props in 3D.

### 2.7 `actors` (new): GPU-posed instances, rigid or skinned

- **Job:** many animated characters at a constant draw count.
  - A slot table of records.
  - One compute pass copies, culls, picks near or far LOD and poses bones.
  - Indirect draws per model and LOD.
  - A CPU pose mirror for picking and attachments.
- **API:**
  - `createActorSystem(renderer, { slots, bonesPerSlot, recordLayout, lods })`;
  - `defineRig(parts|gltfSkin)`;
  - `setRecord(slot, typed)`;
  - `poseCpu(slot, out)`;
  - a skinning mode: `'rigid'` (Forge) or `'linear'` (glTF, from TC skin palette).
- **Takes:**
  - FW:actors/actor-draw.ts (482; "14 calls whatever the count", B App. A §3);
  - pose-shader.ts, pose-cpu.ts (407), layout.ts, rig.ts;
  - actor-light.ts (light sampling becomes a hook: the game supplies `sampleLight(pos)`).
- **Keeps:** TC:render/skin.ts (`SkinPalette`, linear skinning for glTF), TC:anim (clips, mixer) as the CPU animation source for skinned rigs.
- **Drops:** game actors stay in Forge: players, creatures, husks, fox, hand, zone-tells.
- **Others:**
  - glTF character games (skinned, via `assets` + `anim`);
  - crowds in strategy games;
  - VR avatars.

### 2.8 `voxel`: streamed sections (replaces today's demo module)

- **Job:**
  - a sparse section store, kept encoded;
  - readiness and priority (nearest first);
  - a worker mesher pool with self-contained jobs (the section plus 26 neighbours);
  - greedy merging, AO, sky and block light floods;
  - face classes (opaque, liquid, cutout, foliage, cross-plant, no-face);
  - connectivity bits;
  - arena upload into GPU-culled static sets;
  - connectivity (cave) culling;
  - DDA raycast.
- **API:**
  - `createVoxelWorld(renderer, { sectionSize: 16, blocks: BlockTable, vertex: VertexSchema, classes: FaceClass[], workers, materials: {terrain, liquid, foliage} })`;
  - `putSection(key, bytes, codec)`;
  - `dropSection(key)`;
  - `edit(key, cells)`, which returns the remesh set (≤6 sections);
  - `setInterest(center, radius)`;
  - `raycast(ray)`;
  - `stats`.
- **`BlockTable`:** per id, a face class, an opacity or light-blocking value, emission (hue index), and game bits to pack.
- **`VertexSchema`:** a declared bitfield over 2×u32. Defaults: xyz 5+5+5, face 3, AO 2, sky 6, block 5, id 12. Game fields fill the rest. TC generates the WGSL `decode_voxel_vertex` include from it (no `override`).
- **Takes:**
  - FW:mesh/mesher.ts, faces.ts, vertex.ts, input.ts, light.ts, connectivity.ts, pool.ts (301), view.ts (WorldView, 387);
  - FW:render/visibility.ts (582) and render/arena.ts;
  - the section and cull parts of FW:render/renderer/sections.ts and draw.ts;
  - FW:interact/raycast.ts;
  - the falling-piece mesher (FW:mesh/falls.ts) as `meshPiece(cells)`, moved to a worker.
- **Keeps:** TC:voxel/ray.ts. The rest of TC:voxel (dense Uint8 grid, 48 B vertex, one worker) becomes a `createVoxelGrid` *source* that feeds the same world. That is a small bounded world for a puzzle or editor, with no second renderer path.
- **Drops:** TC:voxel/chunks.ts' one-`frame.mesh`-per-chunk path (A1 §2).
- **Forge keeps:**
  - the wire codec (ChunkStore and the protocol);
  - the block content table and its meanings;
  - fs_terrain's procedural painting WGSL;
  - ripeness and inset semantics (as declared vertex fields);
  - water timelines.
- **Others:**
  - any block world;
  - destructible arenas;
  - voxel-art games;
  - small bounded voxel puzzles (grid source).

### 2.9 `terrain` (new, later): heightfield and far LOD

- **Job:** heightfield tiles with LOD rings, and a horizon or far-terrain impostor fed by any height source (voxel summary or noise).
- **API:** `createHeightfield(renderer, { tileSize, levels, source: (tile) => Float32Array | Promise })`, shaded by a game material.
- **Takes:** the idea and data from Forge's surface map and section summaries (FW:state/, "summary" worker, B §3). Forge has *no far LOD* today (B §2), so this is new code that Forge's horizon would also use.
- **Keeps / drops:** nothing (new).
- **Others:** open-world 3D, racing, flight, RTS maps. **Not on Forge's critical path.**

### 2.10 `fx`

- **Job:** GPU particles, trails, decals, billboards and text atlas, debug draw, sky dome, weather volume.
- **API:**
  - `ParticleSystem` (kept, as a set participant with per-view info, R1-R3);
  - `createSky(renderer, { keys: SkyKeyframes, layers: {stars, moon, clouds, rainbow} })`;
  - `createPrecipitation(renderer, { caps, map })`.
- **Takes:**
  - FW:render/shaders/sky.ts (keyframed procedural sky: clouds from a weather map, rain shafts, rainbow, stars, moon);
  - FW:render/weather-pass.ts and weather-shader.ts (GPU weather map plus GPU-procedural rain and snow from the instance index; caps of 16k drops and 12k flakes);
  - FW:render/life-motes.ts (motes).
  - Forge's day and night *values* (state/sky.ts SKY_KEYS) and the climate port stay in Forge.
- **Keeps:** TC:fx particles (compute), decals, billboards, trails, debug draw.
- **Drops:**
  - TC's gradient sky dome, which becomes the 1-key case of the keyframed sky;
  - TC's flat `Water` plane, which stays only as a preset.
- **Others:**
  - LR (particles: 13 `fx` imports);
  - any outdoor 3D game;
  - VR ambience.

### 2.11 `post`

- **Job:** bloom, tonemap, grade, AA (FXAA/TAA), AO, DoF, SSR, god rays, LUT; composite variants by enabled set.
- **API:**
  - `PostStack` (kept);
  - `setQuality(PostQuality)`;
  - `neutralPostSettings()` as **the default** (A1 §3);
  - `compositeVariant` keyed by an enabled-terms bitmask (P1 from A1);
  - an XR profile that resolves per eye from the shared prepare, or the forward-eye path (§3.7).
- **Takes:**
  - FW:render/shaders/composite.ts (ACES, the painterly grade terms, heat shimmer, night desaturation) as named composite terms;
  - Forge's half-res bloom targets (FW:render/renderer/targets.ts:60-64).
  - Land mood stays Forge as a game term passed through `custom`.
- **Keeps:** TC:post/* (tiers `postQualityFor`, TC:post/settings.ts:598-607).
- **Drops:** cinematic defaults as the default.
- **Others:**
  - LR (7 `post` imports);
  - stylized 3D;
  - VR (light profile).

### 2.12 `quality` (new): tiers, device, governor

- **Job:**
  - device tier detection with a reason;
  - quality tiers as data;
  - a frame-time governor with asymmetric, sticky hysteresis whose *rungs are registered knobs* from any module (post, fx, voxel radius, render scale).
- **API:**
  - `detectTier()` → `{ tier, reason }`;
  - `createGovernor({ rungs: Knob[], targetMs, …})`;
  - `Knob { name, step(down: boolean), cost? }`;
  - `quality.register(module, knobs)`.
- **Takes:**
  - FW:render/governor.ts (253, `FrameGovernor`, line 101);
  - FW:settings/device.ts (152), settings/adjust.ts (128, step-down only).
  - The tier *values* in FW:settings/registry.ts:187-275 stay Forge.
- **Keeps:** TC:render/dynamic-resolution.ts as one knob, and `postQualityFor` tiers.
- **Others:** every game on weak devices; VR (frame budget halves).

### 2.13 `input`

- **Job:** the action map (kept), touch zones, gestures, pad, pointer lock, rays and router, record and replay, plus **intents**.
- **API:**
  - `Input`, `createTouchZones`, `createPointerRouter` (kept);
  - new: `createIntents<I>(spec: IntentSpec<I>, sink: I)`, where the game declares intents (`press`, `hold`, `aim`, `release`, `tap`, `cycle`, `select(n)`), each bound to actions and to `Aim = Ray | null`;
  - gesture primitives `stillHold({ tolerancePx, ms })` and `stickSideHold`.
- **Takes:**
  - FW:play/gestures.ts (479, pure; the hold vs tap timing);
  - the scheme glue patterns of FW:ui/touch.ts (701) that are not game rules (WebKit pinch and stuck-pointer workarounds, touch.ts:76, 506);
  - the "aim ray re-made as the view turns" rule (FW:play/actions.ts:21-40);
  - the XR controller binding shape (FW:xr/input.ts, xr/scheme.ts).
- **Keeps:** TC:input/* (A2 §2); the loupe is injected instead of imported (G9).
- **Drops:** nothing.
- **Forge keeps:**
  - `ActionSink` as its intent set (`gathers`, `pick`, hotbar);
  - FW:play/walker.ts and controller.ts;
  - the Bedrock-style stick tuning values.
- **Others:**
  - LR (touch, loupe);
  - shooters (aim rays);
  - VR (controller rays as the same intents).

### 2.14 `ui`: spec + presenters

- **Job:**
  - UI described once as words (stack, grid, list, text, slot, meter, icon, button, field, tabs, range) bound to keys;
  - a pure, allocation-free layout;
  - a model that marks changed keys;
  - presenters: **DOM**, and **world** (Canvas2D atlas → texture, ray-hit, head-follow screen, quad layers in XR);
  - a token look;
  - the existing DOM overlay widgets as a legacy surface.
- **API:**
  - `panel(spec: PanelSpec)`, `b("key")`;
  - `presentDom(panel, host)`;
  - `presentWorld(panel, { renderer, place })`;
  - `hud(spec)`;
  - `theme(tokens)`;
  - `createWorldHud({ widthDeg, distance })`.
- **Takes:**
  - FW:ui/spec/* (6.6k; words.ts:24-456, layout.ts, model.ts, present.ts:80-125, present-html.ts, hud-layout.ts, measure.ts);
  - FW:xr/ui/spec/present-world*.ts, panel-atlas.ts, follow.ts;
  - FW:xr/ui/world-hud.ts (the 48° screen at 1.5 m, :65);
  - FW:xr/quad-panels.ts;
  - the generic notices, tags and panel manager (B §1 "ui generic 3.9k").
  - FW:xr/ui/spec/look.ts is **replaced** by tokens (P7).
- **Keeps:**
  - TC:ui layout regions and form factors (`ui.layout`, safe areas);
  - PadNav;
  - focus and ARIA behaviour;
  - inventory drag and drop (re-expressed as a `grid` word with drag behaviour);
  - anchors;
  - the existing `ctx.ui` overlay API, unchanged for LR.
- **Drops:** TC world panels (`createWorldPanel`, TC:ui/world-panel/*), superseded by the world presenter.
- **Others:**
  - LR (30 `ui` imports, unchanged API; opt in to specs per screen);
  - any VR game (one HUD);
  - in-world terminals and shop signs.

### 2.15 `xr`

- **Job:** session lifecycle, the XR frame source, eye views as `View`s in one cull group, the projection layer (texture-array), layer depth, quad layers, comfort (vignette, snap turn, speed ladder, height), the emulator, the ray keyboard, reload-with-guard.
- **API:**
  - `createXr({ renderer, ui?, input? })` with `.supported() / .enter() / .exit()`;
  - `xr.views(frame)` → `View[]`;
  - `xr.comfort`, `xr.quadLayer(panel)`;
  - `emulateXr()` (dev).
- **Takes:**
  - FW:xr/session.ts (1,385), stereo.ts (844), emulate.ts (1,144);
  - layer-depth.ts, quad-panels.ts, comfort.ts, ladder.ts, speed.ts, height.ts, keyboard.ts, pointer.ts, input.ts, scheme.ts;
  - FW:render/eye-pass.ts (fused composite+depth+panels eye pass);
  - FW:render/renderer/eyes.ts.
  - Controller GLB models (FW:xr/controller-models.ts) move to `assets`-free primitives or optional `assets`.
- **Keeps:** TC:platform/xr-surface.ts (head camera, union frustum), TC:input/xr-source.ts, TC:host/xr.ts.
- **Drops:** per-eye full render + post (TC:core/game.ts:760-773).
- **Others:** every game can be entered in VR (LR as a floating board, any 3D game, VR-first games).

### 2.16 `audio`

- **Job:** procedural synth, buses, spatial voices, zones, music stems, iOS unlock, plus an **ambience graph** with a node cap and server-time scheduling.
- **API:**
  - `AudioEngine` (kept);
  - new: `createAmbience({ maxNodes })` (beds and rooms);
  - `playAt(spec, serverTimeMs)` (A2 §5 gap).
- **Takes:**
  - FW:ui/ambience/graph.ts (112-node cap, :27), beds.ts, room.ts, buffers.ts;
  - the voice specs mechanism of FW:ui/sound.ts (488) and the unlock targets (:451-480).
  - Forge's sound *recipes* stay Forge.
- **Keeps:** TC:audio/* (A2 §5).
- **Drops:** nothing.
- **Others:** all games; LR (15 imports).

### 2.17 `testing` (rails)

- **Job:** the fake GPU, a call-trace recorder with a sha256 golden, an allocation and clock-read counter, "proportional to change" harnesses, fake XR, a fake DOM, and budget helpers.
- **API:**
  - `fakeDevice({ trace: true })`;
  - `traceGolden(name, frames)`;
  - `countAllocs(fn)`;
  - `expectProportional(run, sizes)`;
  - `fakeXr()`.
- **Takes:**
  - FW test/client-budget-harness.ts;
  - the frame-trace golden mechanism (test/client-budget-frame.test.ts, fixtures/frame-trace.json);
  - FW test/fake-dom.ts;
  - the shader rails (no `override`, the texture-read cap as a configurable lint);
  - the layer-rank check (scripts/check-layers.ts) as a generic tool.
- **Keeps:** TC:render/fake-gpu.ts, testing/index.ts, fixed clock, xr-fake.ts.
- **Others:** every game's CI.

### 2.18 Unchanged, optional islands

- `assets` (glTF/KTX2; never imported by core).
- `anim`, `tween`, `nav`, `save`, `i18n`, `analytics`, `host-*` packages.
- They keep their APIs.

### 2.19 `kit` (createGame)

- **Job:** compose services, wire lifecycle, device loss and the XR frame-source swap.
- **API:**

  ```ts
  createGame({
    surface,
    renderer: true | opts,
    post?: false | PostStack,
    ui?: false | 'overlay' | 'spec',
    audio?: false | AudioEngine,
    input?: false | 'external' | opts,
    xr?: false | opts,
    quality?: false | opts,
    loop: { sim: false | hz },
    hooks,
  })
  ```

- The default kit (everything on, as today) lives at `@thunderclap-engine/engine/kit/default`, and LR keeps calling it. A lean import such as `createGame` from `/kit` brings in only the passed services.

---

## 3. The render core in detail

### 3.1 Objects

```ts
// Buffers
interface Arena { alloc(bytes, align): Alloc | null; free(a: Alloc); write(a, data, offset?); trim(); }
renderer.arena('vertex' | 'index' | 'instance' | 'storage', { blockBytes = 64 << 20 })   // FW:render/arena.ts ArenaPool

// Layouts
createVertexLayout({ stride, attributes, wgslDecode?: string, wgslUv?, wgslColor? })
createInstanceLayout({ stride, attributes, wgslDecode })                 // STANDARD_INSTANCE = today's 112 B (TC:render/material.ts:30)

// Draw sets
createDrawSet({
  material, vertexLayout, instanceLayout,
  geometry: Mesh | { arena, sharedIndex },                // own buffers or sub-ranges in an arena
  kind: 'transient' | 'dynamic' | 'static',
  cull: 'none' | 'sphere' | { gpu: { slots, hiddenMask?: GPUBuffer } } | Culler,
  passes: { opaque?: true, cutout?: true, transparent?: true, shadow?: true, custom?: PassId[] },
  order?: number, layers?: number,
}) → DrawSet  // .slot(i).set(range, instance)  .remove(i)  .count

// Views
interface View { basis; offset; proj; viewProj; invViewProj; planes; tanHalfFov; aspect; near; target: RenderTarget; viewport }
interface CullGroup { views: View[]; planes: 'union' | 'each' }

// Frame
renderer.beginFrame(time, dt) → Frame        // immediate API lives here, unchanged
renderer.prepare(groups: CullGroup[])        // cull/sort/upload/compute/shadow once per group
renderer.draw(view)                          // the pass list for that view
renderer.endFrame()                          // one submit
renderer.render(frame, camera, target?)      // kept: = prepare([{views:[viewOf(camera,target)]}]) + draw
```

### 3.2 Buffer arenas and custom layouts

- **Arenas.** Arenas are 64 MB first-fit pools with size-class skip indexes, taken from Forge (FW:render/arena.ts:34; fewer than 60 ranges inspected per upload, B App. A §2). Every large user sub-allocates; small `Mesh`es keep their own buffers.
- **Shared index.** One shared quad index buffer per renderer. It removes C-spike's 26 MB (+75%) of index duplication.
- **Vertex layouts.** These are any byte layout; a layout supplies `wgslDecode` (for example the voxel 2×u32 decode). The prelude's `engine_vertex` stops reading `v.uv` and `v.color` unconditionally (C friction 1).
- **Instance layouts.** These are per set:
  - `STANDARD_INSTANCE`: the 28 floats today, so 2D and LR are unchanged;
  - `COMPACT_16`: pos + packed;
  - `SLOT_ORIGIN`: `firstInstance` = slot, reading a per-slot origin from storage (Forge's terrain);
  - game-declared layouts.
  - This is R8 from A1.

### 3.3 Retained draw lists, culling, indirect and multi-draw

The core has three set kinds, sharing one encoding back end.

| Kind | Instances live | Cull | Encoding | Who |
|---|---|---|---|---|
| transient | per-frame CPU array, uploaded once per frame into the instance arena | CPU sphere per cull group (today's `buildDraws`), or none (sprites) | direct draws, merged runs (today's batching, TC:render/renderer.ts:2615-2725) | `frame.sprite/mesh/meshes`, LR, small games |
| dynamic | GPU buffer, dirty-range writes (`InstanceList` today) | CPU per batch or per instance, or GPU | direct, or indirect when GPU-culled | props, piles, drops, model scene, particles' emitters |
| static | arena sub-ranges per slot; args written by GPU cull | GPU compute (`cs_cull`: frustum planes + hidden bitset → DrawIndexedIndirect args per slot per class) | **render bundle** of `drawIndexedIndirect` per slot, rebuilt only when the slot set changes (throttled, 250 ms default) | voxel sections, tile layers, static level geometry, heightfield tiles |

- **Bundles.**
  - A bundle is cached per (set, pass, view-target format).
  - Bundles are pass-agnostic about the view: they read the view uniform through a dynamic bind or a per-view uniform slot copied with `copyBufferToBuffer`, which is how Forge does it (B App. A §5).
  - So one bundle serves both eyes and the shadow pass reuses the geometry with a depth-only pipeline bundle.
- **Multi-draw.**
  - `multiDrawIndexedIndirect` is used when `caps.multiDrawIndirect` is present (Chromium experimental): one call per set per pass.
  - It is never required. WebKit lacks it, so the bundle-of-indirect path is the baseline and the reference for parity.
  - Without `indirect-first-instance`, sets fall back to direct draws with a CPU cull, as Forge does (FW:render/renderer.ts:138-143).
- **Change proportionality.** Retained sets are walked only when dirty, so held-but-unchanged sets cost 0 CPU. This is the "46 calls at 1.5k and 6k sections" invariant made generic, and a `testing` rail.
- **Front-to-back ordering** for static opaque sets is resorted when the camera moves more than N units (Forge: 8 blocks).

### 3.4 First-class passes and drawables (R1-R3 generalized)

- **Passes are named.** The built-in passes are `shadow`, `depthPre` (optional), `opaque`, `cutout`, `transparent` and `overlay`. A module can declare more with `renderer.definePass({ id, after, target: 'scene' | 'shadow' | custom, depth: 'write' | 'read' | 'none', when: () => boolean })`.
- **Sets** declare which passes they join.
- **`Drawable` (custom pipeline objects)** gets these fields:
  - `passes` (default `['transparent']`, today's behaviour; `opaque` is R1);
  - `drawShadow?(pass, shadowView)` (R2);
  - `draw(pass, frame, view: ViewInfo)`, where `ViewInfo` gains `camera`, `viewSlot`, `planes` and `group` (R3). TC already has `ViewInfo` for the depth hook (TC:render/frame.ts:191).
  - `prepare(encoder, frame, groups)` runs once per frame, not per view.
- **Forge's terrain** is no longer a drawable at all; it is a static set with a GPU cull. Its one-off visuals (Spire, rune glow, telegraphs) stay Forge drawables or sets in named passes.

### 3.5 Stereo done once

- `prepare` runs once for each cull group:
  - one union-frustum cull;
  - one sort and upload for transient sets;
  - one GPU cull dispatch for static sets;
  - one actor pose dispatch;
  - one shadow pass (the shadow box covers the union);
  - per-view uniform slots.
- `draw(view)` then encodes the scene passes into that eye's layer slice (texture-array projection layer).
- **Post in XR** takes one of two routes:
  - (a) `forward` material variants with the tonemap inline and no HDR target (FW:render/forward.ts, built only when XR-compatible). This is the default on standalone headsets.
  - (b) a per-eye `PostStack.resolve` with the `xr` quality tier.
- **Variant compilation.** The forward variant is a prelude include switch, so materials compile both variants lazily, and only once XR is entered.
- **Rails** (from FW test/stereo.test.ts): 1 cull, 1 pose and 1 uniform build for 2 eyes, and a union of ≤1.15× an eye's visible set.

### 3.6 The pass list (not a graph)

`frame` order:

1. `prePasses`
2. compute (`prepare`: culls, pose, weather maps, particles)
3. `shadow` (if active)
4. for each view:
   1. `depthPre`?
   2. `opaque`
   3. `cutout`
   4. [depth copy if any set or drawable `readsDepth`]
   5. `transparent`
   6. custom passes in `after` order
5. post (per view, or forward)
6. `overlay` (world UI panels, eye pass)
7. submit

- Each item encodes only if its `when` holds and it has participants.
- `definePass` inserts into this list by `after`. There is no general dependency solver.
- The order is pinned by the call-trace golden, as Forge pins its 24-step order today.

### 3.7 Targets and attachments, built from use

- **The scene target's attachments** are the union over the frame's active materials:
  - `color` (always);
  - `emissive` (when any material declares `emissive: true` *or* the post stack reads it);
  - `roughMetal` and `velocity` (when post asks: SSR, TAA; TC:render/frame.ts aux key).
- **Pipelines** are keyed on the attachment signature, as `auxKey` already does (TC:render/frame.ts "Aux key"). The `FragOut` struct is generated per signature, and an absent `emissive` write is compiled out.
- **Compat default:** `createMaterial` without the flag keeps `emissive: true`, so LR's 24 materials are pixel-identical. New 3D materials default to `false`.
- **Formats.**
  - HDR is `rgba16float` only when post is on; otherwise draw straight to the swap chain.
  - Depth is `depth24plus` (TC today) or `depth32float` reversed-Z infinite (Forge), chosen per camera preset.
  - 2D has no depth.

### 3.8 Camera-relative origin

- **CPU side.** World positions are float64 numbers (JS numbers) in `Transform` and the camera. Each cull group has a **frame origin**: the camera position snapped to a grid, such as 1,024 units.
- **Instances.** Instance matrices are written relative to the frame origin (a subtract at upload; transient sets do it in the copy that already happens, TC:render/renderer.ts:2361).
- **Retained sets.** These store *slot origins* (float64 → origin-relative float32 at upload, rewritten only when the origin moves). This is Forge's section-local vertex + per-slot origin pattern.
- **Views.** `View.offset` and `viewProj` are camera-relative, as in FW:render/view.ts:47-66.
- **2D cost.** Nothing changes for 2D: `ortho2d`'s origin is 0 and the subtract is skipped.
- This removes C friction 6 and makes big worlds safe.

### 3.9 How today's TC APIs map, and The Last Rune

| Today (TC 1.3) | TC 2.0 | Cost change for LR |
|---|---|---|
| `frame.sprite(mat, p)` (TC:render/frame.ts:289) | push into the transient set; no cull; merged runs; `STANDARD_INSTANCE` | none (same path; upload happens once per frame instead of once per `render` call, which LR calls once anyway) |
| `frame.mesh`, `frame.meshes`, `MeshLod` | transient set, CPU-culled per cull group | none for one view; less for N views |
| `InstanceList` | a `dynamic` set (the class keeps its name and API) | none |
| `frame.drawable(d, order, layers)` | a drawable in `transparent` by default; new opt-ins `passes`, `drawShadow` and the `view` arg | none (LR's 9 drawables are particles and post-adjacent) |
| `frame.prePass(fn)` | `prePasses` (unchanged) | none |
| `renderer.createMaterial` and the prelude (TC:render/wgsl.ts:443-531) | the same; the prelude is split into includes; `emissive` defaults to true for compat; `VSOut`/`engine_vertex` keep their names | none |
| `renderer.render(frame, camera, target)` | the wrapper `prepare([oneView]) + draw` | none |
| `renderer.resolve`, `PostStack`, `Lights`, `ShadowMap` | kept; shadow gains snapping and cascades (opt-in) | none |
| `createGame(opts)` | `kit/default` re-exports it with identical options | none |

**The compatibility story.**

1. **Source compatibility.** TC 2.0 is a major version only because of the API snapshot (1,820 frozen names, A3). Every name LR imports keeps its signature, and `check:api` is run against LR's import list as an allow-list.
2. **Pixel compatibility.** LR's 86 e2e baselines must pass unchanged on TC 2.0 before release. This is the gate, not the re-baselining LR did in 1.x (A3 "Last Rune migration").
3. **Trace compatibility.** A new rail runs LR's scenes headless on the fake GPU and diffs the call trace against a 1.3 recording. Allowed diffs are listed (for example, an upload moving earlier). Anything else fails.
4. **Bundle.** LR's bundle must not grow by more than 2 kB gzip; the kit split should shrink it.
5. **Migration.** LR adopts nothing new unless it wants to. Deprecations wait at least one minor version, and none are planned for the 2D path.

---

## 4. What stays Forge game code, and the seam

### What stays in Forge (apps/web after the move), about 50-55k of today's 107k lines

| Area | Stays | Why |
|---|---|---|
| net/, SDK, protocol | all of it: ServerSession, interest, edit prediction and rollback, inflate worker, watches, liveness, recovery, sign-in | server-authoritative netcode is the game's (TC VISION "What is the game's job"); the SDK is Forge's mineflayer-style client |
| state/ | world store over ChunkStore, content table, sky and weather ports of forge-core, rune-sight and rune-match, entities, selection | content meaning and server mirrors |
| play/ | ActionSink (as Forge's intent set), walker, controller, fight, tools, Spire, escort, finds | rules display and play |
| life/, scene/ | deterministic ambient life, the opening, crash film | game content |
| ui/ (panels) | ~40 panel specs and HUD words, chat, make, menu, film, help | game UI written in TC's spec words |
| visuals | fs_terrain painting WGSL, block material codes and palette, the water look, SKY_KEYS values, composite grade values and land mood, Spire, rune glow, telegraphs, piles, drops, dryad land, hand, husks, creatures, players and fox rigs and logic, zone tells | art direction and game visuals, expressed as TC materials, sets and drawables |
| content adapters | Forge content JSON → `PartModel`, → `BlockTable` and `VertexSchema`, → actor rigs | the content schema is Forge's |
| settings values | the ~33 settings, tier values, governor rung choices | tuning |
| boot/, main.ts | wiring: `createGame(kit)`, join flow, the `live` bag shrinks to the game's own state | |
| budgets | Forge's product-level goldens (46/58/48 calls, stream budgets) re-recorded on TC | Forge's frame is Forge's product |

### The seam (what crosses it)

```
Forge                                    ThunderClap
-----                                    -----------
ChunkStore bytes + codec  ──putSection──▶ voxel world (workers, mesh, light, arenas, cull)
BlockTable, VertexSchema  ──config─────▶ voxel (generated WGSL decode)
terrain/water/foliage WGSL ─materials──▶ render core (prelude includes)
SnapshotBuffer → records  ──setRecord──▶ actors (pose compute, 14-call draw)
content parts → PartModel ──compile────▶ models + model scene
sky keys, climate values  ──set────────▶ fx/sky, fx/precipitation
panel specs + model keys  ──present────▶ ui (DOM presenter, world presenter)
ActionSink                ◀──intents──── input (actions, rays, gestures, XR controllers)
rung list, tier values    ──register───▶ quality (governor)
sound recipes             ──play───────▶ audio (+ ambience graph)
frame hook                ◀──loop────── core (client mode, no sim)
```

**Seam rules.**

- (a) TC never imports Forge, the SDK or the protocol.
- (b) Forge never reaches into TC internals. Today's layer-rank violations (81 allow-list entries, B App. A §6) shrink, because render ↔ actors is TC-internal or goes away.
- (c) Every crossing is typed arrays or declared data, with no per-frame allocation.
- (d) The clock is passed in, and TC reads none.

**Switch-over rule (binding).** Forge moves one module at a time behind its current seam (B §7 order: post, then isolated passes, input, UI presenters, audio, render core + voxel, XR). Each move requires parity on the WebKit iPad profile in CPU per frame, GPU, time to full view and memory (D2 owns the bar).

---

## 5. Risks and open questions

### Risks

1. **The generalization tax costs frame time.** Generated vertex decode, prelude includes and pass `when` checks could add instructions to fs_terrain, which is already 6-7 ms of about 8 ms on the iPad (B §2).
   - Mitigation: the generated WGSL for Forge's schema must be token-identical to today's hand-written decode (a golden).
   - Mitigation: P10 rules out runtime polymorphism in shaders; specialization happens at build time only.
2. **Scope and age.** TC is about 9 days old, 95% agent-written, and has never run on WebKit (A3).
   - This design moves about 25-30k Forge lines into it (render core 7.6k, voxel and mesh 6.7k, actors 4.8k, ui spec + world 9k+, xr 11k, quality and audio about 1.5k).
   - Mitigation: WebKit CI first (G5); modules move in seam order; Forge pins exact TC versions.
3. **The Last Rune regresses quietly.** Shared core rewrites (instance upload timing, MRT signature) can shift pixels. Mitigation: the three compat gates in §3.9, run on every TC PR.
4. **Bundle headroom** is about 30 kB in Forge (B §5).
   - Mitigation: the kit split (P4) and "replace equal code" accounting. Every TC module Forge adopts must delete at least its size in apps/web in the same PR.
5. **WebGPU feature variance.**
   - `indirect-first-instance` is optional, and multi-draw-indirect is Chromium-only.
   - Mitigation: the baseline path is bundles of `drawIndexedIndirect` (already proven on Forge's iPad), with direct fallback; MDI is a pure optimization behind caps.
6. **The pass list outgrows "not a graph".** Mitigation: hold the `after`-ordered list until a third consumer needs a dependency the list can't express; then revisit.
7. **Two repos, one cadence.** Forge work would stall on TC releases.
   - Mitigation: a TC `next` channel plus a local link in Forge dev.
   - Release discipline (D3) decides.

### Open questions for the user (≤3)

**Q1. TC's rule 5 says "rendering, not mechanics: a voxel mesher … is a game's content pipeline". Amend it to "foundations, not rules"?**
- Under "foundations, not rules", world representation, streaming, meshing, light and GPU-posed actors join TC, while rules, content, netcode and servers stay games'.
- **Recommendation: yes.** Your direction ("the core engine … rather than reimplementing the foundations for dozens of games") only works if the voxel world, part models and actors live in TC. Without the amendment, Forge keeps about 12k lines of foundations and the next voxel game copies them.

**Q2. Must The Last Rune stay pixel-identical across the TC 2.0 core rewrite, or may its baselines be re-recorded once if a change is reviewed and judged invisible?**
- **Recommendation: pixel-identical.** Hold all 86 baselines unchanged as a hard gate. Only an explicit bug fix you approve re-baselines. This is the cheapest proof that "simple cases don't pay for the big one".

**Q3. VR is shelved in Forge. Should stereo still be a first-class rail in TC's core from day one?**
- That means every render-core change is tested with a two-view cull group on fake XR and the emulator. Real-headset work stays shelved.
- **Recommendation: yes.** Retrofitting "stereo once" later means rewriting prepare/draw. Carrying it costs about one extra test path per core change, and no real device until you lift the shelf.

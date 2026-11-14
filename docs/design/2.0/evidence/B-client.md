# Track B: Forge Wilds browser client (apps/web) inventory

main d38b72ad, 2026-11-14. Read-only. The body below is the synthesis. Appendices A to C hold the three sub-reports in full, with file:line references: render, UI/input/XR, and loop/net/guard rails. Paths are under apps/web/src unless marked otherwise.

## 0. Size at a glance

- **Source:** 107.4k lines of TypeScript and CSS in 369 files. No `.wgsl` files exist: every shader is a `/* wgsl */` template literal inside TS.
  - Embedded WGSL is about 6,755 lines: render 5,560, actors 991, xr 204.
  - The scene shader is one module built from 20 pieces (`render/shaders.ts:54`).
  - WGSL `override` is banned because iPad WebKit refuses it (`test/shaders.test.ts`).
- **Tests:** 44.0k lines in 198 files under `test/`. Also 46 e2e checks (`e2e/`), 6 benches (`bench/`) and 8 build/check scripts (`scripts/`).
- **Runtime dependencies:** only `@forgewilds/protocol` and `@forgewilds/sdk`. Dev dependencies are `vite` and `@webgpu/types`. There is no framework of any kind.
- **The project has already rejected engines once:**
  - `docs/DEPENDENCIES.md:75` rejects three.js and Babylon.js ("Scene graphs don't fit voxel meshing; client performance depends on controlling GPU buffers directly").
  - `docs/VISUALS.md` says "We build these effects ourselves on WebGPU."
  - An engine proposal has to answer that rationale.
- **Churn:** 256 commits touched src/ in the last 30 days, out of 606 in the repo. src/ has 0 TODO/FIXME/HACK markers; the convention is that debt lives in the docs.

## 1. Subsystem table

Kinds:
- **G**: generic engine-ish, any game could use it.
- **V**: voxel or content-model technology. Reusable for a block game, but purpose-built.
- **F**: Forge Wilds game-specific (rules display, the content's meaning, play, wiring).

TS counts exclude WGSL-in-TS only where it is noted. Churn is commits in the last 30 days (`git log --since=30.days -- dir`), with lines added plus deleted in parentheses.

| Dir | TS lines | WGSL (in TS) | What it does | Key files | Kind | Churn 30d |
|---|---|---|---|---|---|---|
| render/ | 15,862 | 5,560 | Renderer facade and passes, arenas, GPU cull, connectivity culling, part-model interpreter, model scene, painter, sky, weather, water, foliage, drops, telegraphs, Spire, rune glow, bloom/composite, governor, camera, views | renderer.ts, renderer/{setup,frame,draw,state,sections,uploads,eyes}.ts, arena.ts, visibility.ts, models.ts, model-scene.ts, painter.ts, view.ts, governor.ts, shaders/*.ts | G 7.6k / V 6.7k / F 1.6k | 74 (24.4k) |
| mesh/ | 3,103 | 0 | Worker mesher (greedy, AO, smooth sky and block light baked into an 8-byte vertex), job format, block-light flood, face-pair connectivity, MeshPool, WorldView readiness, falling trees | mesher.ts, faces.ts, vertex.ts, input.ts, light.ts, connectivity.ts, pool.ts, view.ts, falls.ts | V | 12 (2.1k) |
| actors/ | 7,963 | 991 | GPU-posed rigid-bone actors (768 slots, 16 bones, 14 draws constant), CPU pose mirror, players, creatures, husks, fox, first-person hand, actor light, zone tells | pose-shader.ts, pose-cpu.ts, rig.ts, actor-draw.ts, players.ts, creatures.ts, hand.ts, husks/*.ts | V 4.8k / F 3.2k | 53 (7.6k) |
| state/ | 4,798 | 0 | World store (the SDK ChunkStore kept encoded), content table, section summaries, glows, surface map, model index, sky and weather (ports of forge-core), particles, entities, selection, status, emitter | store.ts, content.ts, weather.ts, sky.ts, rune-sight.ts, rune-match.ts | V 2.8k / G 1.2k / F 0.7k | 14 (5.4k) |
| net/ | 2,993 | 0 | ServerSession (interest, picking, commands, edit prediction), inflate worker, live queries (`watch.ts`), the Actions/Reads panel seam, liveness, recovery, reports, sign-in | session.ts, actions.ts, watch.ts, inflate.ts, liveness.ts | F 2.1k / G 0.9k | 58 (2.3k) |
| play/ | 6,171 | 0 | ActionSink and gestures, walker (20 Hz inputs via the SDK PlayerBody), controller, fight, tools, the Spire run, escort, finds, coming back | actions.ts, gestures.ts, walker.ts, controller.ts, spire.ts, fight.ts, interact.ts, tools.ts | G 1.0k / F 5.2k | 116 (6.6k) |
| input/ | 348 | 0 | DOM input for keys and mouse: pointer lock, free pointer, wheel, keys → camera / ActionSink | look.ts | G | 4 |
| interact/ | 189 | 0 | Voxel DDA raycast, placement facing | raycast.ts | V | 4 |
| life/ | 1,984 | 0 | Deterministic ambient life (birds, fish, butterflies, fireflies): placed identically on every client from world time, motion, sounds | life.ts, motion.ts, place.ts, species.ts | F | 9 (2.9k) |
| scene/ | 1,860 | 0 | The opening (wreck, elder's gift), crash film shots, dryad veins, the listener's surroundings for ambience | opening.ts, crash-film.ts, surroundings.ts | F | 7 (2.1k) |
| ui/ | 34,808 | 0 | The one UI framework `ui/spec/` (6.6k: words → layout → model → HTML presenter), HUD, about 40 panels, touch scheme, procedural WebAudio (sound, ambience graph), film, menu, chat, help | spec/{words,layout,model,present-html,hud-layout}.ts, hud.ts, panels.ts, registry.ts, touch.ts, make.ts, sound.ts, ambience/graph.ts | G 10.5k / F 24.4k | 191 (76.0k) |
| xr/ | 16,896 | 204 | WebXR session (shelved 2026-10-24, live), stereo views, emulator, controller input and GLB models, comfort, speed ladder, quad layers, the world presenter (spec → Canvas2D → texture), HUD on a following screen | session.ts, stereo.ts, emulate.ts, input.ts, render/panel-pass.ts, ui/spec/present-world*.ts, ui/spec/look.ts | G | 26 (20.6k; only 7 commits after 10-24) |
| settings/ | 1,570 | 0 | About 33 settings as data, store, device tier (Auto with a reason), auto adjust (only steps down), binding into every part | registry.ts, settings.ts, device.ts, adjust.ts, bind.ts | G 0.7k / F 0.9k | 28 (0.4k) |
| stats/ | 839 | 0 | Overlay, `__forgeStats`, telemetry | stats.ts, telemetry.ts | G | 16 |
| boot/ | 4,864 | 0 | The page's start, in order: menu, xr-lobby, join, scene, life-scene, play-*, stats, frame loop, workers, `live` (about 70 shared fields) | frame.ts, play-session.ts, join.ts, play-fight.ts, play-world.ts, scene.ts, live.ts, workers.ts | F (wiring) | 76 (6.2k) |
| spike/ | 503 | 0 | Local noise terrain for benchmarks only (`?source=spike`) | terrain.ts | G (bench) | 11 |
| styles/ | 1,828 CSS | 0 | One CSS file per area, inlined into index.html by a Vite plugin. The XR look parses it | hud.css, play-panels.css, chat-make.css | G | 56 (2.1k) |
| main.ts | 601 | 0 | Module level: errors, reports, leave guard, `main()` setup | | F-wiring | 100 |
| params.ts | 214 | 0 | URL parameters | | G | 19 |
| build.ts | 11 | 0 | Build stamp | | G | 0 |

**Split by kind** (file-level rules, scratchpad tc/classify.mjs). Total 107.4k lines:

| Kind | Lines | Share | 30-day churn (lines changed) |
|---|---|---|---|
| G generic engine-ish | 43.1k | 40% | 65.6k (XR is 20.6k of it, and that work ended 10-24) |
| V voxel / content-model tech | 17.6k | 16% | 8.9k |
| F game-specific | 46.7k | 44% | 67.5k |

What the G bucket holds:

| Part | Lines |
|---|---|
| xr/ | 16.9k |
| Renderer core, post, sky, weather, camera, governor, math | 7.6k |
| ui/spec framework | 6.6k |
| ui generic: touch, audio engine, panel manager, tags, notices | 3.9k |
| styles | 1.8k |
| state services | 1.2k |
| play input seam | 1.0k |
| net plumbing | 0.9k |
| stats | 0.8k |
| settings mechanism | 0.7k |
| main and params | 0.8k |
| spike | 0.5k |
| input | 0.3k |

Of the G lines, only about 7.6k (render core) plus the 6.6k UI framework plus 0.3k input are what a rendering engine would normally replace. XR (16.9k) is also replaceable in principle, but it is shelved.

**Churn is dominated by game work:** ui panels, play/spire, controller, session and boot wiring. The engine core (arena, cull, visibility, mesh workers) barely moves: store.ts has 3 commits and mesher.ts 8. renderer.ts has 33 commits and shaders.ts 23, but those are mostly new visuals registering a setter or pass, not engine rework.

## 2. Render pipeline (detail: Appendix A)

- **Targets:**
  - rgba16float HDR scene target;
  - depth32float, reversed-Z, infinite far plane;
  - **no MSAA and no anti-aliasing of any kind**;
  - bloom at half resolution;
  - composite to the swap chain: ACES, grade, vignette.
- **Frame:**
  - Compute passes:
    - weather map, at most twice a second;
    - GPU cull, only when something changed;
    - actor pose pass.
  - Scene pass:
    - opaque and foliage **render bundles** of `drawIndexedIndirect`, one per section per class, written by the GPU cull and rebuilt at most every 250 ms;
    - then models, boxes, actors, drops, hand, sky, Spire.
  - Water pass: water bundle, wind streaks, weather.
  - Four post passes.
- **The clear frame is 46 GPU calls, held as a sha256 golden** (`test/fixtures/frame-trace.json`). The calls break down as:
  - 5 for writes and the encoder;
  - 5 for the cull;
  - 2 for the swap view;
  - 6 for the scene;
  - 6 for water;
  - 20 for post;
  - 2 for submit.
- **No multi-draw.** XR uses direct draws with a CPU cull.
- **Meshing:**
  - Up to 8 workers (hardwareConcurrency−2), nearest first.
  - A job carries its 27 sections as received, about 2 KB and at most 4.5 KB.
  - Greedy merging cuts quads by 32%. AO, smooth sky light and block light (8 light colors) are baked per vertex.
  - **8-byte vertex** (2×u32) and a 1,024-entry palette.
  - **No textures:** every surface is painted procedurally in fs_terrain from world position, block and state.
  - 3 classes (opaque, water, foliage/cutout) in **64 MB arenas** with a first-fit free list (fewer than 60 ranges looked at per upload).
- **Culling:** frustum, plus connectivity ("cave") culling (`render/visibility.ts`, face pairs flooded in the mesh job). It draws 0.84× the frustum's quads and runs one search per section crossing.
- **LOD:** leaf LOD only. No far terrain or horizon LOD; view distance is 8, 12 or 16 chunks.
- **Fluids:** a water surface with sky and sun reflection, wind ripples and rain rings. No terrain reflections (no SSR or planar).
- **Falling trees** are meshed on the main thread into one rigid piece.
- **Entities:**
  - The part-model interpreter (`render/models.ts`) turns content's part trees (boxes, cylinders, gears, rings, prisms, frustums, wedges; grouped, turned, repeated; motion bound to state) into packed meshes. It is a pure function of content, with one draw per unit.
  - Actors are content JSON: rigid parts on at most 16 bones, posed by a GPU compute pass with a CPU mirror within 0.01 blocks. 14 draws constant from 1 to 200 actors, with a near and a far mesh.
  - Item entities are instanced boxes, plus their own forms near the eye.
  - Particles are on the CPU: 480 chips, dust and leaves drawn as boxes.
  - Rain and snow are procedural on the GPU (caps of 16k drops, 12k flakes, 2k splashes, 3k motes).
  - First-person hand: hidden it costs 0 calls; shown, 1 draw and 1 uniform.
- **Lighting:**
  - Lambert sun or moon, hemispheric fill, baked AO, sky and block light, and up to 8 point lights for models and actors.
  - **No shadow maps:** shade falls straight down from a height map, plus a cloud shadow from the weather map. Contact discs under actors.
  - **No PBR, no normal maps, no SSAO, no GI, no volumetrics.**
- **Sky:**
  - A procedural sky from the inverse view-projection (per view).
  - Day and night keyframes from the server's clock.
  - Weather fronts sampled from a port of forge-core's climate, 4 times a second.
- **Quality and load:**
  - Tiers Low, Medium and High change only distance, resolution (70/85/100%) and extras.
  - A 5-rung governor (`render/governor.ts`): precipitation halved, then splashes and life, then cloud shadows and wet sheen, then near-leaf radius, then 85% scale. Hysteresis and stickiness are unit-tested on synthetic traces.
  - Auto adjust only steps the tier down.
- **The multi-view seam:** `render/view.ts`. `frame()` is `prepare(views)` (one cull, one pose, one uniform slot per view), then `draw(view)` for each, then one submit. WebXR feeds two eyes through `XRGPUBinding`, with a forward-shaded eye path (`render/forward.ts`, `renderer/eyes.ts`).
- **Cost on the iPad:** terrain fragment shading is about 6 to 7 ms of about 8 ms a frame, and fill-bound. The target is GPU p95 ≤ 10 ms. The page measures 7.1 to 9.5 ms.

## 3. Frame loop, threading, net → render (detail: Appendix C)

- **The frame:** `boot/frame.ts:182–565`, about 24 steps in a fixed order:
  - camera;
  - walker pump (prediction);
  - interest;
  - visibility;
  - WorldView flush (4 ms budget);
  - aim, fight, Spire;
  - entity boxes (SnapshotBuffer, about 100 ms behind);
  - actors, life, painter, sky and weather, falls;
  - `renderer.frame` (prepare → draw per view → submit);
  - DOM marks, stats, governor, tier step-down.
- **The loop driver:** `tick` (:569) runs on rAF, or `xrSession.requestAnimationFrame` in VR, with a frame cap.
  - The clock is read twice a frame and passed down. The renderer, painter and view read it 0 times (tested).
  - Timers: walker 25 ms, weather and life 250 ms, liveness 1 s.
- **Workers:**
  - mesh pool (1 to 8);
  - section summarizer;
  - deflate-raw inflate;
  - spike terrain (bench only).
  - All use postMessage with transferred buffers and a main-thread fallback. **No SharedArrayBuffer** (tailscale serve sends no COOP/COEP headers).
- **Prediction:**
  - The SDK gives PlayerBody, Predictor, SnapshotBuffer, ChunkStore and the softLock model.
  - apps/web adds:
    - the 50 ms input tick and the feet ease;
    - edit prediction and rollback (`net/session.ts`);
    - fight soft lock;
    - ports of the forge-core sky and weather;
    - section timelines;
    - deterministic life.
  - The client never simulates rules.
- **Net → renderer has no scene graph;** game code pushes data in:
  - Terrain: ChunkStore → `state/store.ts` → `mesh/view.ts` WorldView (readiness, priority) → MeshPool → `renderer.addSection` / `dropSection`.
  - Entities: SnapshotBuffer → `boxes.build` → `setBoxes`, one Float32Array a frame.
  - Machines: watches → painter → `setForces`, `setClimate`, telegraphs, piles, actor kits.
- **Per message:** 0 sections decoded on the main thread; at most 3 map entries visited per Section message; the inflate happens off the main thread.

## 4. UI and input (detail: Appendix B)

- **The UI is plain DOM over the one WebGPU canvas.** Canvas2D is used only for icons, text measuring and the compass tape.
- **"Described once as data":** `ui/spec/words.ts` (`PanelSpec` :420, `HudItem` :550) is a tree of words bound to keys with `b("key")`.
  - The layout is pure, over typed arrays, and allocates nothing once warm. The HUD's boxes are sums, so placing reads no layout.
  - The model marks the keys that changed.
  - Presenters (`ui/spec/present.ts:84-106`):
    - the HTML presenter writes only the bound nodes that changed;
    - the world presenter (`xr/ui/spec/present-world*.ts`) repaints the same specs into Canvas2D → a GPU texture for the headset. It gets the look by parsing the page's own CSS with a hand-written resolver (`xr/ui/spec/look.ts`, 1,027 lines).
  - A test fails if either presenter skips a word.
- **Ratchet:** `test/ui-ratchet.test.ts` allows 12 hand-built element sites in 4 files (compass 9, icons, panels, film). `ui/panels.ts frame()` still hand-builds the chrome of 6 cold panels.
- **ActionSink** (`play/actions.ts:63-101`) has `primaryStart`/`Aim`/`End`, `secondary`, `pick`, `selectSlot` and `cycleSlot`. Aim is a `Ray`, or null for the crosshair. The ray seam is bit-identical over 10k cameras. The schemes:
  - keys and mouse: `input/look.ts`, pointer lock or a free pointer;
  - touch: `ui/touch.ts` plus the pure `play/gestures.ts`, a Bedrock-style stick;
  - XR controllers: `xr/input.ts`, `xr/scheme.ts`, `play/xr-bindings.ts`.
  - **No flat-screen gamepad support; no general key rebinding.**
- **One HUD in VR:** the same HUD spec on a virtual screen 48° wide at 1.5 m (`xr/ui/world-hud.ts:65`) that follows the head. Quad layers switch themselves off on failure.
- **Audio:** fully procedural WebAudio, no samples: event voices, noise beds and the ambience graph with a 112-node cap (`ui/ambience/graph.ts:27`). It sits under ui/, but mesh/, play/, stats/ and life/ use it as a low-level service.

## 5. Guard rails and what an engine swap does to them (detail: Appendix C §6)

| Rail | Counts / limit | Under an engine swap |
|---|---|---|
| Frame call trace golden (`test/client-budget-frame.test.ts`, `fixtures/frame-trace.json`) | 46 clear, 58 storm, 48 Spire, same order, sha256 of names and arguments. 0 Float32Array and 0 clock reads a frame. A frame's work is the same at 1.5k and 6k sections | **Re-record.** The fake GPU device harness has to accept the engine's calls. Zero-alloc and zero-clock **at risk** if the engine allocates or reads its own clock |
| Weather frame | ≤46+12 calls in a storm, map ≤2 dispatches/s, uniform written only on change | Re-record |
| Actors, hand, fireflies budgets | 14 calls constant for actors; hand hidden = 0 calls | Re-record, or rework if the engine owns skinning |
| Stereo (`test/stereo.test.ts`) | 1 cull, 1 pose, 1 uniform build for 2 eyes; union frustum ≤1.15× | Re-record; needs the engine to have a multi-view prepare/draw split |
| Culling-frame, culling correctness | 0.86 quads vs frustum, 1 search per crossing, 0 alloc | Unaffected if visibility.ts stays ours; lost if the engine culls |
| Stream/mesh/arena budgets | 0 sections decoded on main, ≤3 entries/msg, ≤4.5 KB/job, <60 free ranges | Unaffected (ours) unless the engine owns buffers |
| Shaders (`test/shaders.test.ts`) | no WGSL `override`; ≤6 texture reads in fs_terrain | **Invalid if the engine generates WGSL**. The no-override rule has to hold for engine shaders too (iPad WebKit) |
| UI budgets (DOM writes, nodes, 0 idle) | many, Appendix B | Unaffected if the UI stays DOM/spec |
| Governor | synthetic traces | Unaffected; the engine needs knobs the rungs can turn |
| Layers (`scripts/check-layers.ts`, allow-list 78 entries, only shrinks) | rank table | The engine needs a rank; unaffected otherwise |
| Bundle budget (`scripts/bundle-budget.ts`) | index ≤500 kB gz (472.6 today), total ≤670 kB (640.5) | **Biggest practical risk:** about 27 kB and 30 kB of headroom. An engine has to tree-shake to near zero net, or replace an equal amount |
| e2e smoke in local-ci (WebKit iPad profile; the gate's only real-GPU check) | full view, no errors, a screenshot | Unaffected in kind; must pass |
| Hand-run e2e (flood 240 draws / 80k triangles, foliage, weather, sky, light, actors, hand, long-session) | counts and screenshots | Re-baseline the screenshots and counts |

Test exposure to a renderer swap: 15 fake-GPU and harness files (4.4k lines), and 48 test files that import src/render (12k lines).

## 6. Pain points, debt, where an engine would help vs where ours is better

**Hand-rolled and weak, or never built** (a mature engine could genuinely add these):
1. **Anti-aliasing: none.** No MSAA, FXAA or TAA on a 16-float HDR target. This is the most visible gap.
2. **Sun shadows: none.** Shade is straight down from column tops. VISUALS lists "sun shadows cast at the sun's angle" as not built. A cascaded shadow map tuned for the iPad would be a real win, if it fits the fill budget.
3. **Reflections and GI and volumetrics** (the VISUALS "High preset": GI, god rays, terrain reflections) are unbuilt. The baseline is all there is.
4. **Particles are CPU boxes** (480). Smoke and steam are listed as not built. A GPU particle system would help the "draw the forces" art pillar.
5. **Device-loss recovery: none.** The page shows a notice.
6. **No far-terrain LOD** past 16 chunks, and no multi-draw.
7. **Post is minimal:** bloom, ACES, grade, vignette. No SSAO, DOF or color LUTs.
8. **XR plumbing is large and bespoke** (16.9k lines):
   - its own emulator (no IWER);
   - its own GLB reader (no skins or animation);
   - a CSS resolver for the headset UI;
   - quad layers unverified on a real Quest.
   An engine with mature WebXR would shrink this, but VR is shelved.
9. **Gamepad on flat screens and key rebinding are missing.** Input plumbing that engines commonly have.
10. **Structural debt:**
    - The renderer facade grows a setter, a pass and new golden calls for every visual.
    - render ↔ actors import each other (13 allow-list entries go render → actors).
    - `play/spire.ts` imports 11 ui/ files; `settings/bind.ts` has 13 upward imports; `controller.ts` mixes input, render and UI.
    - Audio lives in ui/ but is used from below.
    - camera.ts reads the window's size; `Renderer.create` takes a canvas and calls navigator.gpu; `render/icons.ts` uses a DOM canvas; painter and renderer depend on `net/watch.ts` (README risks).
11. **README risks:**
    - light seams for sky light (a flood within a 1-block border);
    - one block-light color per cell (8 light colors total);
    - moving models clip into terrain;
    - decoded sections cost 16 KiB;
    - bundle rebuilds cost about one frame of CPU.

**Purpose-built and better than a general engine would be** (keep these):
- **The 8-byte voxel vertex, worker greedy mesher with baked AO and light, 64 MB arenas, and GPU cull into indirect render bundles.** The project rejected scene graphs over exactly this.
- **Connectivity culling** (0.84× quads, measured pixel-exact) and **frame work proportional to change** (the same 46 calls at 1.5k and 6k sections, 0 sections walked).
- **The iPad-tuned fs_terrain:** procedural painting, exact-zero gates that save 0.8 ms, ≤6 texture reads, no `override`.
- **The part-model interpreter and the GPU actor pose pass** (14 calls constant, CPU mirror). These are content-driven and match the binding call of "no texture/model asset pipeline".
- **Counted-work CI rails on a fake GPU,** a bit-identical call trace and a governor with tested hysteresis. A general engine would have to be held to these, not the reverse.
- **The UI framework:** data specs, an allocation-free layout, two presenters, idle frames that write nothing. One HUD everywhere, as the binding call requires.
- **Off-main-thread streaming:** 0 decodes and 0 inflates on the main thread, a batched join (62 ms instead of 406 on WebKit), resume (2.4 KiB instead of 2 MB).

## 7. Seams: where a replacement could slot in incrementally

Clean seams, in order of how clean they are:
1. **The multi-view render seam** (`render/view.ts`: `prepare(views)` / `draw(view)` / one submit). It is already the boundary between "the frame's world state" and "drawing a view to a target", and an engine's renderer could sit behind it. But `Renderer` exposes about 30 push-style setters (`addSection`, `setBoxes`, `setForces`, `setClimate`, `setOutline`, actor kits ...). That facade is the real interface, and it is wide.
2. **Post and the composite** (`shaders/composite.ts`, bloom; the 20 of the 46 calls that are post): self-contained, reading the HDR target and writing the swap chain. This is the easiest place to try engine AA, tonemapping or post without touching the world.
3. **Isolated passes:** sky, weather and precipitation, and particles each have their own pass or shader and a setter. Shadows would be a new depth-only pass over the same arenas and bundles; the engine could supply the technique while the buffers stay ours.
4. **Input → `ActionSink`:** every scheme already speaks intents. A gamepad or engine input layer is one more scheme. Clean.
5. **UI:** `ui/spec/present.ts` is a presenter interface. The engine could be a third presenter (for example a GPU UI) without touching panels. The DOM presenter is strong; nothing forces a change.
6. **Audio** is a service with a node cap. It could swap behind `ui/sound.ts` and `ui/ambience.ts` (it should move out of ui/ first).
7. **XR:** `xr/` is quarantined (only boot/ reaches it, by `import()`), and is a lazy chunk. It could be replaced wholesale by an engine's XR layer, at the cost of the views seam.

Tangled:
- **render ↔ actors ↔ play ↔ ui** (50 of the 78 allow-list entries involve render, mesh or actors).
- **Game visuals registered inside the renderer:** Spire, rune glow, telegraphs, piles, dryad land, drops. These are 1.6k F lines inside render/ that a swap would have to port pass by pass.
- **The `live` bag** in boot/ (about 70 fields).
- **The 24-step frame order** in boot/frame.ts, which the counted rails pin.
- **WGSL as one concatenated scene module** with shared `common.ts` (706 lines). Any engine material system must accept hand-written WGSL modules, or every visual is a rewrite.
- **The bundle budget's roughly 30 kB of headroom** caps how much engine code can come in.

---

# Appendix A: render (B-sub-render.md)
# B-sub: Forge Wilds render side inventory (apps/web)

This was read-only research. Paths are relative to apps/web/src unless they say otherwise.

## Size

- render/ + mesh/ + actors/ come to 26,928 lines of non-test TypeScript.
- WGSL lives in 31 files that hold `/* wgsl */` literals. Together those files are 10,797 lines, TypeScript included.
- xr/ is 8,725 lines.
- The scene shader is ONE concatenated module of 20 pieces (render/shaders.ts:54): common, terrain, foliage, parts, water, sky, boxes, models, streaks, weather, interact, falls, actors, hand, drops, glb, life motes, tells, spire and runes.
- The composite and cull shaders are modules of their own.
- About 38 createRender/ComputePipeline sites exist, 20 of them in renderer/setup.ts.
- No WGSL `override` is allowed, because iPadOS 18 Safari fails to build any vertex shader whose module declares one. PRESET is baked into the source as a constant, and test/shaders.test.ts guards this.
- The largest files are parts-shader 765, model-scene 738, shaders/common 726, drops 679, creatures 663, players 658, actor-light 652, husks/pose 627, falls 605, renderer.ts 598 and visibility 582.
- renderer.ts was split by feature into render/renderer/*.ts on 2026-10-26 (#400): setup 442, state 361, draw 338, common 267, frame 265, sections 227, uploads 192, eyes 177 and targets 116.

## 1. Frame passes and draw structure

### Formats

- HDR is rgba16float and depth is depth32float (renderer/common.ts:65-66).
- Depth is reversed-Z with an infinite far plane: it is cleared to 0 and compared with `greater`.
- **There is no MSAA (no sampleCount anywhere) and no AA of any kind** (no FXAA, TAA or SMAA).
- Bloom targets are at half resolution, in rgba16float (renderer/targets.ts:60-64).
- The canvas uses getPreferredCanvasFormat with alphaMode "opaque" (setup.ts:30-31).
- Size = css × dpr (capped at 2) × quality scale × governor scale (targets.ts:22-28).

### Baseline frame, in order (renderer/frame.ts, renderer/draw.ts)

| # | Pass | Contents |
|---|------|----------|
| 0 | writeBuffer ×4 | model frame, frame uniform, cull uniform, post params |
| 1 | compute: weather map | `cs_weather_map`, a 64×64 rgba8 map, run at most twice a second (render/weather-pass.ts:232) |
| 2 | compute: cull | `cs_cull` (shaders/cull.ts, 43 lines, workgroup 64). It tests 5 planes plus a hidden bitset from connectivity culling and writes 3 DrawIndexedIndirect args a slot (opaque, water, foliage), with firstInstance = slot. It runs only when the camera, the slots or the hidden bits change (frame.ts:222-229). |
| 3 | compute: actors' pose | actors/actor-draw.ts:398, dispatchWorkgroups(highWater), workgroup SLOT_BONES=16 |
| 4 | scene pass (hdr + depth clear) | executeBundles(opaque, foliage), falling-tree pieces, block models (one non-indexed instanced draw per unit), entity boxes (draw 36×n), actors, piles, drops, target outline, first-person hand, controllers, sky (fullscreen triangle with depth `equal`), boss tells, Spire |
| 5 | water pass (depth read-only, also sampled for thickness) | water bundle, wind streaks (draw 72×640), weather (precipitation, splashes, motes, bolt), life motes, rune glow, interact cracks |
| 6-8 | bloom | bright, blur h, blur v (half resolution) |
| 9 | composite → swap chain | heat shimmer, exposure + bloom, ACES, night desaturation, shadow lift, grade, saturation 1.12, land mood, vignette, gamma 2.2 (shaders/composite.ts:66-118) |
| 10 | world panels | |

With the "off" preset, the scene is drawn straight to the canvas.

### The 46-call golden

The golden is test/fixtures/frame-trace.json, frame "clear", checked in test/client-budget-frame.test.ts:145,159,229-231. Its 46 calls are:

1. 4 writeBuffer calls and createCommandEncoder (5).
2. The cull compute pass: begin, setPipeline, setBindGroup, dispatch(24), end (5).
3. getCurrentTexture's createTexture and createView (2).
4. The scene pass: begin, executeBundles([2]), sky setPipeline, setBindGroup, draw(3), end (6).
5. The water pass: begin, executeBundles([1]), streaks setPipeline, setBindGroup, draw(72,640), end (6).
6. Four post passes of 5 calls each (20).
7. finish and submit (2).

Budgets:
- The trace is hashed with sha256 per frame, so the call order is held bit-identical.
- The storm budget is ≤58 calls (55-66 observed). The Spire adds 2, for 48.
- The fight budget is in test/client-budget-fight.test.ts.

### Draw modes

- **Indirect (default, params.ts:152):** needs `indirect-first-instance` and falls back to direct without it (renderer.ts:138-143).
  - The render bundles hold **one drawIndexedIndirect per section per class**. There is no multi-draw-indirect, and setVertexBuffer is called on each arena change (renderer/sections.ts:168-210).
  - Bundles are rebuilt at most every 250 ms when dirty (frame.ts:166-173).
  - Sections are sorted front to back when the camera moves 8 blocks, or when the order is dirty after 250 ms.
- **Direct:** the CPU does the frustum cull and issues one drawIndexed per section (draw.ts:57-74). XR sessions use direct (renderer.ts:236-249).
- There is a pass timer of 24 timestamp pairs; one frame in 8 is timed (render/pass-timer.ts).

## 2. Chunk meshing

### Worker pool and jobs

- **Pool (mesh/pool.ts):**
  - Workers = min(8, hardwareConcurrency − 2) (params.ts:153), with 2 jobs in flight per worker.
  - A priority queue serves the nearest sections first.
  - Failed workers are replaced.
- **Job (mesh/protocol.ts):** a MeshRequest is `{input: MeshSources (the 27 sections as received, about 2 KB), greedy, leafLod, table}`.
- **Result:** opaque, water and foliage Uint32Arrays (transferred), quad counts, 15 connectivity bits (one per face pair), openCells, dark, and ms.

### Mesher (mesh/mesher.ts, mesh/faces.ts)

- It works on an 18³ padded volume with face culling and per-vertex AO.
- Smooth sky light is flood-filled in the worker.
- Block light comes from mesh/light.ts: Dial's buckets over a 48³ volume, built when a glowing block is near.
- Greedy merging is optional (faces.ts:233):
  - It gives 32% fewer quads.
  - A section takes 0.12 ms.
  - 8 workers mesh a 16-chunk radius in 175 ms.

### Vertex format (mesh/vertex.ts; docs/client/web/web-streaming.md:27-33)

The vertex is **8 bytes**, two u32 words:

- **word0:** xyz 5 bits each, face 3 (6 = plant quad, 7 = plant part), AO 2, smooth sky light 6, worked 1, block light 5.
- **word1:** block id 12, inset 5, corner sides 3, facing 3, ripeness 3, plant quad 3, light hue 3.

The palette is a uniform of 1,024 entries. **There are no textures**: every surface is painted procedurally in WGSL from world position and material code.

### Transparency classes

| Class | Contents |
|-------|----------|
| opaque | solid blocks |
| water | liquid |
| cutout | inset cubes and glass |
| leaves | foliage mesh, alpha-cut, two-sided |
| plants | crossed quads, plus 3D "parts" (up to 60 quads a plant within 24 blocks, with a dithered crossfade) |
| model blocks | emit no faces |

These classes go into 3 GPU buffers: opaque, water and foliage.

### Buffers (render/arena.ts, 183 lines)

- An ArenaPool of 64 MB arenas (ARENA_BYTES, renderer/common.ts:64), first fit, with size-class skip indexes.
- trim() destroys empty arenas past the first, only at bundle rebuild.
- MAX_SLOTS is 32768.
- One shared u32 quad index buffer covers MAX_QUADS = 4096×6 quads (setup.ts:100).
- Uploads go through queue.writeBuffer, three allocations a section (sections.ts:19-70).
- The per-slot origin and info buffers are flushed as dirty ranges.

### Culling

- **Frustum:** on the GPU in indirect mode, on the CPU in direct mode.
- **Connectivity culling (render/visibility.ts 582, mesh/connectivity.ts):** after Checchi 2014, "advanced cave culling".
  - A main-thread BFS walks the 15 face-pair bits a section and writes the hidden bitset that cs_cull reads.
  - It draws 0.84× the quads on the ground and costs about 0.16 ms a search; DARK_STEPS is 6.

### LOD

- Leaf LOD only, by Chebyshev chunk distance: 0 is near (2 chunks), 1 solid (8), 2 far.
- There is **no far-terrain LOD**: the world simply ends at the render distance (16/12/8 chunks by tier).

### Fluids

- Water is drawn as flat quads.
- Normals are procedural: 4 Gerstner-like sines plus noise.
- Streams show flow lines along their facing (MAT_FLOW) and are drawn as shallow sheets.
- Colour comes from depth, using the sampled scene depth.
- Refraction and reflection use **the sky only**: there is no SSR and no planar reflection.
- Basin levels follow timelines.
- Wind is constant; there is no per-cell flow.

### Falling trees

- mesh/falls.ts (605 lines) meshes the piece **on the main thread** with a new Mesher and greedy off (falls.ts:365-389).
- render/fall-shader.ts rotates the piece about its hinge.
- falls.ts imports render/ and ui/sound (see §6).

## 3. Entities and models

| Part | What it does |
|------|--------------|
| render/models.ts (496) | A part-based JSON model interpreter. Shapes are box, cylinder, gear, ring, prism, frustum and wedge. Vertices are 12 floats and materials are 15 procedural codes (MM). Static parts are baked into one unit and moving parts get units of their own. |
| render/model-scene.ts (738) | Instances live in a GPU buffer and are written only on change. The shader computes spin from world time (turnAngle). MAX_MODEL_INSTANCES is 4096, with one draw per unit in view. A glb-shader also exists. |
| actors/ (actor-draw, layout, pose, actor-shader) | 768 slots (256 players) of 96-byte records. One compute pass copies updates, culls, picks the near or far mesh (24 or 48 blocks) and poses up to 16 bones. Skinning is rigid, bones are 3 vec4s, and VERTEX_CAP is 450,000 (actors/layout.ts:135). Draws are one drawIndexedIndirect per model and LOD, plus held icons, plus one shadow drawIndirect: **14 calls whatever the actor count**. actors/pose-cpu.ts is a CPU mirror held within 0.01 blocks. |
| actors/actor-light.ts (652) | The CPU samples the baked light from 8 cells, with zero allocation. |
| particles (state/particles.ts) | CPU particles, 480 at most, drawn as instanced entity boxes (MAX_BOXES 2048). |
| weather precipitation | GPU-procedural from the instance index: up to 16k drops and 12k flakes. |
| life motes, rune glow | Vertex-shader quads driven by uniforms. |
| render/drops.ts (679) | Shapes are made once. Records are 64 bytes, with one instanced draw per shape and pipeline (25 draws for 18 kinds). |
| piles | 16-byte instances in one draw. |
| actors/hand.ts (547) + hand-shader | A fixed 35° FOV. Depth is squeezed into the nearest tenth, there is a 544-byte uniform, and it takes 1-8 draws. |
| render/icons.ts | Icons are rendered once per content load by the game's own renderer into an atlas. |
| creatures, players, husks, fox | Game-specific actor logic: rigs, animation states and boss feedback. These are the highest-churn actor files. |

## 4. Sky, lighting, post, quality

### Sky (shaders/sky.ts)

- A fullscreen triangle that draws only where depth is still at the clear value.
- It paints a gradient from the keyframes, painted clouds (common.ts:445, drawn from the weather map's fronts), distant rain shafts (sky.ts:54), a rainbow (:78), a star field (:96) and a moon disc (:117).
- Fog is applyFog (common.ts:515).

### Day and night (state/sky.ts)

- SKY_KEYS keyframes set the sun colour, zenith, horizon, glow, fog, ambient, night, stars and exposure.

### Weather (render/weather-pass.ts, weather-shader)

- A GPU weather map feeds the cloud shadow, the sky's fronts and the precipitation.
- The governor can drop the wet sheen.

### Lighting model

- A Lambert sun or moon key light, a hemispheric sky fill, bounce light and a cool tint in shadow.
- Baked AO, sky light and block light come from the vertex.
- There are up to 8 point lights (MAX_LIGHTS, shaders/layout.ts:64), including the held light (render/painter.ts:302).
- **There are no shadow maps.**
  - Sun shadow comes from a surface-height map (sunCover, common.ts:386-405, which assumes an overhead sun).
  - Cloud shadow comes from the weather map.
  - Actors get contact-shadow discs.
- **There is no PBR and there are no normal maps.**

### Post

- Bloom (bright, two blur passes) and the composite described in §1.
- Tone mapping is ACES with exposure. The rest is a painterly grade: shadows lifted, cool shadows and warm highlights, saturation 1.12, land mood (blight or grove) and a vignette.
- There is **no AA** at all.

### Quality tiers (settings/registry.ts:187-275)

| Tier | View distance | Resolution | Streaks | Weather | Effects |
|------|---------------|------------|---------|---------|---------|
| low | 8 | 70% | off | 25% | light |
| medium | 12 | 85% | on | 50% | full |
| high | 16 | 100% | on | 100% | full |

The "light" effects setting drops bloom and halves particles. The starting tier is picked automatically from device.ts, and adjust.ts steps it down.

### Governor (render/governor.ts, 253 lines)

It has 5 rungs:

1. Precipitation halved and Spire threads off.
2. Splashes and motes off, life halved.
3. Cloud shadow and wet sheen off.
4. The near leaf radius pulled in.
5. Render scale to 85%.

Its hysteresis is asymmetric and sticky, and it is tested on synthetic traces.

### Look parameters

- The SKY_KEYS keyframes, the grade constants (composite.ts), the land mood and the blight, and the palette.
- The docs list shadows, PBR, SSAO, SSR and volumetrics as "high preset" goals that are not built.

### Cost

- Terrain fragment shading is the biggest cost: 6-7 ms of about 8 ms on the iPad (web-perf docs).

## 5. The multi-view seam and XR

- **The seam (render/view.ts):** a `View` is a camera-relative, reversed-Z, possibly asymmetric projection plus a viewport, and a `RenderTarget` is what it draws into.
- **The frame:** the renderer's frame() calls `prepare(views)` once, then `draw(view)` per eye, then submit (renderer/frame.ts:14-29). prepare runs one cull over the union frustum and one actor pose pass, and puts the frame uniforms in a slot per eye, copied with copyBufferToBuffer.
- **XR (xr/stereo.ts):**
  - It sets `renderer.xrViews` (renderer/state.ts:305; stereo.ts:351-365).
  - It renders through XRGPUBinding into the layers of a projection-layer texture array.
  - `?xr=emulate` fakes the XR APIs on desktop.
  - XR uses direct draws.
- **Forward eye (render/forward.ts):** wraps the 22 fragment entries with inline tone mapping, so no HDR target is needed. It is built only when xrCompatible is set (setup.ts:185).
- **Fused eye pass (eye-pass.ts):** composite, depth and panels in one pass.
- VR is shelved as of 2026-10-24, but the seam is in place and tested with the emulator.

## 6. Page coupling and layering

### Page coupling

| What | Where |
|------|-------|
| navigator.gpu | renderer.ts:134, setup.ts:30 |
| ResizeObserver | setup.ts:37 |
| devicePixelRatio | targets.ts:22, renderer.ts:199 |
| window.innerWidth | camera.ts:229 |
| document.createElement | capture.ts:56, icons.ts:357 |

render/camera.ts is also the fly and player camera controller, and it imports play/actions and play/gestures.

### Layer ranks (docs/client/web/web-layers.md, scripts/layers-allow.txt)

The ranks are state 1, mesh 2, net/stats/settings 3, play 4, input 5, render 6, actors 7, ui 10, xr 11 and boot 12.

layers-allow.txt has **81 upward imports, 50 of which involve render/, mesh/ or actors/**:

- **mesh → render:** falls.ts → render/renderer, fall-shader and math; mesh/view.ts → render/renderer and visibility.
- **state → mesh/actors:** blocks.ts and store.ts → mesh/input; entities.ts → actors/players.
- **render → actors (render 6 is below actors 7):** renderer.ts, renderer/kits, renderer/state and shaders.ts → actors/actor-draw, hand, actor-shader and hand-shader; drops.ts → actors/hand and layout.
- **play → render/actors:**
  - controller.ts → render/renderer, render/camera and actors/creatures.
  - escort-actor.ts → 6 actors/ files.
  - fight.ts → actors/husks.
- **settings, stats → render:** settings/bind.ts → render/renderer, camera and actors/hand; stats/stats.ts → render/renderer, camera and visibility.
- **Also seen:** actors/husks → ui/boss-bar and ui/boss-moment, and mesh/falls → ui/sound. These are upward edges too; check whether they are listed.
- **Downward:** net/watch.ts reaches into 7 render files (renderer.ts, renderer/state, uploads, eyes, common, painter and model-scene).

Takeaway: render, actors and mesh are not one clean leaf layer. The renderer and the actors are mutually entangled, and game code (play, settings, stats, state) reaches into renderer internals.

## 7. Weaknesses and strengths

### Weaknesses

- There are no TODO, FIXME or HACK markers in render, mesh, actors or xr.
- **Never built:**
  - Shadow maps, PBR, normal maps, MSAA, FXAA, TAA and SMAA.
  - SSAO, SSR or planar reflections, GI and volumetrics.
  - Far-terrain LOD.
  - GPU particles for chips (they are CPU, 480 at most).
  - Device-loss recovery ("not built yet", rendering.md).
  - Multi-draw-indirect.
  - Per-cell wind or flow.
- **Thin or hand-rolled parts:**
  - Sun shadow from a height map that assumes an overhead sun.
  - Sky-only reflections.
  - Main-thread meshing for falling trees.
  - camera.ts mixes the camera with input.
  - One giant concatenated scene module of 20 pieces (a compile cost, with a ?diag=1 piecewise path).
  - Layer violations (§6).
- **Hot spot:** terrain fragment shading is 6-7 ms of about 8 ms on the iPad.

### Strong and purpose-built

- The 8-byte packed vertex.
- Worker meshing with greedy merging, AO, smooth light and Dial block light.
- Connectivity culling.
- GPU cull into indirect render bundles: a terrain frame is about 2 bundle executes.
- Arena skip lists.
- GPU-posed actors at a constant 14 calls, with a CPU mirror.
- Zero-allocation frames.
- Counted budgets on a fake GPU device, plus the sha256 call-trace golden.
- The governor.
- The multi-view seam with a forward XR eye.
- The no-override rule for iPad WebKit.
- Fully procedural painting, with no texture assets.

VISUALS.md and DEPENDENCIES.md#rejected already rejected scene-graph engines, because voxel meshing needs direct control of the buffers.

## 8. Git churn, last 30 days

The repo had 606 commits in 30 days, 97 of which touched render, mesh or actors.

| Commits | File | Lines |
|---------|------|-------|
| 33 | render/renderer.ts | 598 |
| 23 | render/shaders.ts | 56 (the index that assembles the scene module) |
| 22 | actors/husks.ts | 537 |
| 13 | actors/hand.ts | 547 |
| 12 | render/painter.ts | 420 |
| 12 | actors/creatures.ts | 663 |
| 11 | render/telegraphs.ts | 438 |
| 10 | actors/players.ts | 658 |
| 9 | actors/fox.ts | 364 |
| 8 | render/camera.ts | 307 |
| 8 | mesh/mesher.ts | 351 |
| 8 | actors/actors.ts | 132 |
| 7 | render/shaders/common.ts, models.ts, model-scene.ts, actors/actor-light.ts | |
| 4-6 | renderer/state, renderer/common (6), shaders/terrain (5), water, uploads (4) | |

Churn sits in renderer.ts and shaders.ts (every new feature registers in them) and in game-specific actors (husks, creatures, hand, fox, telegraphs). That is gameplay-facing work, not engine plumbing. The engine core changes little: arena, cull, visibility and the mesher's workers.

# Appendix B: UI, input, XR (B-sub-ui.md)
# Forge Wilds web client: UI, input, settings, XR inventory (2026-11-14)

Read-only survey of `apps/web/src` at `d38b72ad`. Paths are under `apps/web/src/` unless they start with `docs/` or `test/` (= `apps/web/test/`). Line counts are non-test `.ts`/`.css`.

| Dir | Lines |
|---|---|
| ui/ (all) | 34,808 (ui/spec 6,568) |
| xr/ | 16,896 (xr/ui 6,300, of which present-world/ 3,105) |
| settings/ | 1,570 |
| input/ | 348 (look.ts only) |
| play/actions.ts + gestures.ts | 117 + 479 |
| styles/ (CSS) | 1,828 |
| render/governor.ts | 253 |

## 1. The HUD/UI framework

**DOM, over a single WebGPU canvas.** Every panel and HUD item is absolutely positioned HTML nodes (`ui/spec/present-html.ts:89 HtmlPresenter`). Canvas2D appears only for item icons (`ui/icons.ts:77-91`, a stand-in until the renderer's own block icon atlas arrives from `render/icons.ts`), text measuring (`ui/spec/measure.ts:74`, OffscreenCanvas), one presenter helper (`present-html/write.ts:364`) and the compass tape (`ui/compass.ts`). In a headset the same specs are **re-presented, not rasterized from DOM**: the world presenter paints each panel into a Canvas2D page from spec + model + boxes, using the page's own CSS parsed into a rule table (`xr/ui/spec/look.ts`, 1,027 lines). It uploads that page to a GPU texture and draws it as quads (`xr/render/panel-pass.ts`).

**Pipeline ("UI described once as data"; docs/client/web/web-panels.md):**
- **words** (`ui/spec/words.ts`, 554). A node tree: `col/row` (StackNode), grid, list, text, slot, meter, icon, button, field, tabs, range (`words.ts:417 Node`). `PanelSpec` is at :420, `HudItem` at :550 with `HudPlace` = screen|controller|world|view (:490). Values bind to model keys with `b("key")` (:29). Text has a fixed line count, so its height never waits on the DOM.
- **layout** (`ui/spec/layout.ts` 345 + `layout/units.ts` 158 + `layout/boxes.ts` 496). Pure TS over flat typed arrays (`Compiled` :33, `Boxes`). It compiles once and allocates nothing when warm. A list row is laid out once and stepped by its height; lists scroll natively, so a scroll lays out nothing.
- **model** (`ui/spec/model.ts` 318: `Model` :183, `ListState` :66, `Row` :19). State goes in and events come out. `set` compares old and new, so only changed keys dirty. List rows are keyed, with scroll modes keep/top/slide.
- **panel** (`ui/spec/panel.ts:47 Panel`). Spec + model + boxes. `frame(w,h,text)` relays out only on a size or text-scale change; `apply()` is a no-op when nothing is dirty.
- **presenters**:
  - HTML: `present-html.ts` 501 + `present-html/` 1,918 (setup, build, write, lists, input, hud, common). It writes only bound nodes, pools list rows, does FLIP slides from the layout boxes (no DOM reads), and windows lists.
  - World: `xr/ui/spec/present-world.ts` 1,028 + `present-world/` 3,105.
  - The one seam is `ui/spec/present.ts` (157): `present` :84, `presentHud` :89, `presentItem` :106. `test/ui-world-seam.test.ts` checks that no view imports a presenter.
- **HUD layout**: `ui/spec/hud-layout.ts` 636, `hud-frame.ts` 169, `place-html.ts` 435, `prompt-place.ts` 58. This is arithmetic for every HUD box (hotbar, compass, stick, corners, touch buttons) worked out from `HudFrame` (size, safe area, visual viewport, media queries, read once per change). Panels are placed from these sums and never read page layout.
- **Other spec parts**: `press.ts` (tap/hold/right-click + `Boxes.hit`), `settle.ts` (deferred resort that never moves a row under a finger), `aims.ts`, `measure.ts` (shared line wrapping for both presenters), `motion.ts`, `art.ts`.

**Coverage.** 41 of the 78 top-level `ui/*.ts` files reference PanelSpec/HudItem/HudSpec, with about 55 spec constants declared outside `ui/spec`.

**Ratchet.** `test/ui-ratchet.test.ts:28-37`: only 4 files may still build elements by hand, 12 sites in all:
- `icons.ts` 1
- `panels.ts` 1 (the `element()`/`frame()` helper, `ui/panels.ts:153-176`)
- `compass.ts` 9 (tape, centre mark, label, markers)
- `film.ts` 1 (bars, shade, lids, caption, Skip)

25 files are listed as DONE (:42). One remainder the count hides: `frame()` builds the header chrome (title, key note, × close) for 6 cold panels: altar, charm, field-guide, kin, rune-book, runeforge. Their bodies are specs, but the chrome is hand-built DOM.

**Counted budgets** (docs/client/web/web-perf-budgets.md:17-26, enforced in node tests):
- **Idle panel frame:** 0 DOM writes, 0 reads, 0 boxes visited. Warm layout allocates 0 B; a layout takes ≤64 µs (about 0.5–1.1 µs typical).
- **Make panel:** ≤500 nodes at 90 rows. One inventory change writes only the rows whose match changed. A resort does 0 `getBoundingClientRect`.
- **Storage:** a changed slot is ≤2 DOM writes and 0 new nodes. Inventory opens with 272 nodes; the info card with 19.
- **Chat:** a new line is ≤10 writes (7 today), ≤200 lines kept.
- **Menu node gates:** graphics 135/139, controls 164/175, audio 64/65, a11y 66/71, HUD 83/96, How to play 101/108 of 155/168, ? overlay 75/80 of 125/136, report 14/14.
- **HUD:** an idle frame writes, reads and builds nothing. 32 name tags cost ≤0.1 ms/frame. Placing a panel reads 0 layout.
- **Screens pay 0 GPU calls for UI.** The frame call trace is a golden (46/58/48 calls).
- **World panels:** ≤3 extra draws for 3 panels in 2 eyes (`test/client-budget-ui.test.ts:171-173`). At most 1 upload/frame. ≤0.1 ms GPU, ≤16 MB texture (`docs/client/vr/vr.md`).
- **Bundle:** the world presenter is never in the screen bundle (`client-budget-ui.test.ts:126-129`).

**ui/ lines by group** (sums to 34,808):

| Group | Lines | Files |
|---|---|---|
| Framework (`ui/spec/`) | 6,568 | words, layout, model, panel, presenters, HUD layout sums |
| HUD, generic-ish | 4,929 | hud 886, compass 892, touch 701, kit 376, vitals 352, hints 417, tags 245, inspector 277, compass-place 211, recall 183, notice 153, watching 85, bracket 67, hit-cue 84 |
| HUD, game marks/cues | 3,301 | boss-bar, boss-moment, weak/escort/find/stone marks, party-chips, path-lead, raid-roles, first-tips, tool-hints, together, fire-out, shelter, frame-lines |
| Panels: making | 3,425 | make.ts 1,061 + make/ 2,142 + stations 222 |
| Panels: storage | 1,986 | inventory, chest, home, info, stacks |
| Panels: Spire/fight | 1,496 | door-panel 936, floor-panel, charm-panel, charm-choice |
| Panels: dryad/runes | 3,798 | heart, heart-why, pool, runeforge, relic, altar, rune-book, rune-words, seers-lens, scroll |
| Panels: kin | 1,236 | kin-panel/words/names/news, field-guide, known/found words |
| Panels: menu/social/start | 2,992 | menu 808, help 691, chat 546, join 596, report 209, help-load, test-modes |
| Panel plumbing | 631 | panels.ts 181, registry.ts 332 (one row per panel: ctor, key, menu row, block action, cold chunk), cold-load, cold-panels, panel-looks |
| Sound/ambience (WebAudio) | 2,363 | sound.ts 488, sound/voices.ts 533, ambience.ts 506, ambience/ 836 |
| Film/opening | 1,061 | film.ts 607, story.ts 454 |
| Other | 1,022 | icons 396, problems 363, webapp 103, vr-prompt 102, leave-guard 58 |

## 2. Input

**ActionSink** (`play/actions.ts:63-101`) is the seam between input schemes and the world. Its methods:
- `primaryStart(aim, pressedAt?)` / `primaryAim(aim)` / `primaryEnd()` (hold to break)
- `secondary(aim, sneak, said?)` (place/use/open) and `secondaryButton?(down)` (hold to repeat a place)
- `gathers?(aim)` (touch: gather at the stick's edge)
- `pick(aim)`, `selectSlot(n)`, `cycleSlot(delta)`

`Aim = Ray | null` (:61; null = the crosshair centre). A `Ray` is {origin, dir, screen?} (:35). A screen ray is re-cast through its screen point each frame; a controller ray is kept as given. `XR_POINTER = 1<<20` separates headset pointer ids. The verbs are voxel-sandbox verbs (pick, hotbar slots, gather), not generic.

**Schemes:**
- **Keys/mouse.** `input/look.ts` (348; `LookInput` :83, `attachLook` :343) owns every camera DOM listener: pointer lock (`requestPointerLock` :322, `pointerlockchange`/`error` :139-162), mouse look, wheel, and keys written into `FlyCamera.keys` by `KeyboardEvent.code`. It falls back to a "free pointer" when lock is missing (iPad WKWebView): drag looks, click acts at the pointer's ray. Pointer modes are `lock | free` (:34). `render/camera.ts` keeps state and math and adds no listeners (layer rule 5). Panel and game hotkeys are scattered `keydown` handlers in `boot/` (play-session, play-fight, play-hooks, menu, join, play-world) plus a few panels.
  - Rebinding exists only for sprint and the fight keys (`settings/registry.ts` FIGHT_KEYS/SPRINT_KEYS, `controls.key.*`). There is no general action map.
  - Key names follow the keyboard layout (`state/key-names.ts`, `navigator.keyboard.getLayoutMap`).
- **Touch.** `ui/touch.ts` (701): a Bedrock-style floating stick in the left 40% of the screen. Elsewhere a finger drag looks, a tap places, a hold breaks. Right-side buttons, multi-finger tracking by pointer id. The pure logic is in `play/gestures.ts` (479, DOM-free: `WheelSteps`, the stick's math, tap/hold/drag classification, `InputMode`) and is tested in Node. Touch writes `camera.touch`, which the walker reads.
- **Gamepad.** There is no general flat-screen gamepad scheme. `navigator.getGamepads()` is read only on a headset's flat page (`xr/play/flat-pads.ts`, 175; `boot/frame.ts:196`), mapped through the XR bindings table.
- **XR controllers.** `xr/input.ts` (550): `xr-standard` gamepads go into `xr/scheme.ts` (318), which reads the bindings table `play/xr-bindings.ts` (150). The stick walks relative to the head, with snap or smooth turn, jump/sneak/sprint, hotbar step, bag and menu. There is one beam pointer (`xr/pointer.ts` 179) on the non-move hand; hands and transient pointers get their own pointer ids. select/squeeze go to a panel first, otherwise to the world via ActionSink. Haptic ticks. `xr/keyboard.ts` (141) is the headset or ray keyboard.

**Aim by ray.** Every scheme aims through `FlyCamera.setAim`/`rayAt`. Bit-identity with the pre-ray picks is tested over 10,000 seeded cameras (`test/aim-ray.test.ts`).

## 3. XR (WebXR + WebGPU)

**Status.** Shelved 2026-10-24 (docs/client/vr/vr.md, README). It is built, unit-tested, and still loadable from the home's "Play in VR" and test modes (`&xr=`). Code is quarantined under `xr/` and loaded only by `import()` from main.ts/boot; layer rule 3 and the bundle budget keep it out of the flat page.
- 26 commits touched `xr/` in the last 30 days, 7 in the last 21, all moves, doc repoints or small fixes after the shelving.
- `test/xr/` has 24 files and 4,977 lines, run in the normal `node --test` glob.
- The XR e2e (`e2e/xr-session|xr-speed|xr-hud|xr-input|xr-comfort|ui-world.ts`) run only by hand ("none in CI", docs/client/web/web-e2e-scenes.md:3,46).
- Quest needs a browser flag for `XRGPUBinding`; Vision Pro has shipped it.

**Renderer plug-in.** `xr/stereo.ts` (844):
- `requestSession("immersive-vr", {requiredFeatures:["webgpu"], optional local-floor, hand-tracking})` at :370-371, then `new XRGPUBinding(session, device)` and `createProjectionLayer` (:373-381).
- Each XR frame, `getViewerPose` views become the renderer's `View`s (`render/view.ts:47`: basis, offset, proj, viewProj, invViewProj, planes, target) and draw into `getViewSubImage` per eye (:601).
- The renderer prepares once for both eyes: one cull with a union frustum (≤1.15× an eye's sections), one actor pose pass, and a uniform slot per eye.
- Each eye is a single pass into its layer (`render/renderer/eyes.ts:49 eyePassInto`): composite, layer depth and world panels together.
- Screens pay nothing: a golden mono call trace, bit-equal frustum planes.

**Session.** `xr/session.ts` (1,385):
- enter/exit, hiding the page HTML while immersive;
- blur/visibility handling (what is held lets go);
- device-lost recovery (auto reload, at most twice a minute);
- the device report (`xr/report.ts` 239) as telemetry;
- height (`xr/height.ts`), pivot, and a lobby while the world joins.

**One HUD on a virtual screen.** `xr/ui/world-hud.ts` (417; `WorldHud` :222):
- The page's HUD is laid out by the page's own rules for a fixed iPad-landscape-shaped window (HEADSET_VIEW), shown 48° wide at 1.5 m (`SCREEN_DEG`/`SCREEN_M` :65-66).
- Each HUD item and open panel is drawn by the world presenter from its own spec. There is no second HUD.
- Open panels are mirrored every 250 ms (`xr/ui/world-ui.ts:53`), at most 3 (`WORLD_PANELS`), within 8 texture slots (`PANEL_SLOTS`).
- Pages are Canvas2D at 2 texels per CSS px, ≤8 MB each. Only dirty rects are uploaded, at most one upload per frame. The upload route (copyExternalImageToTexture or getImageData + writeTexture) is picked by a start-up timing.
- A compute pass builds mips over the dirty region.
- Scrolled lists are ring strips. Animations are quantized.
- The look comes from `look.ts`, which parses `index.html`'s `<style>`: selectors, specificity, inheritance, var/calc, @media. Known gaps: shadows except an inset ring, gradients, transforms except translate, filters, dashed borders, :has, SVG fills, overflow-x, and the compass tape canvas (not drawn in the world).
- Parity is enforced: `test/xr/ui-world-words.test.ts` fails if either presenter skips a word. `?uisheet=` shows HTML and the world page side by side.

**Quad layers** (`xr/quad-panels.ts` 567, docs/client/vr/vr-quads.md):
- One `XRQuadLayer` per panel, plus one for the HUD screen (all its items on one plane), with 4 mips.
- They are redrawn only when the look changes. The projection layer gets alpha holes where panels are.
- The fail-safe turns quads off for the session on any error, or when a quad is not live 30 frames after it is listed.
- On by default where supported (`&xrquad=0` turns it off).
- Unverified on a real Quest: whether the compositor honours the projection layer's alpha.

**Comfort** (`xr/comfort.ts` 169): `ViewEase` eases server corrections out over about 0.1 s. `Vignette` darkens the view's edges during stick motion, blinks on a snap turn, and fades on a teleport. Camera shake and kick are off in a session.

**Speed** (`xr/speed.ts` 958 + `ladder.ts` 490 + `budget.ts` 198 + `bench-cases.ts` 212; docs vr-speed.md, vr-frame.md):
- The headset preset sheds every governor rung, turns bloom off, caps the radius, uses CPU-culled direct draws, and limits the foliage radius.
- A ladder replaces the governor. It steps through layer depth, then preset level, then radius, then viewport scale (floor 0.8), and moves up in frame rate when there is headroom.
- The budget is p95 GPU ≤0.81 of the period, with missed and repeat frames <2%.
- Per-pass GPU timestamps come from `render/pass-timer.ts`.

**Emulation.** `xr/emulate.ts` (1,144, `&xr=emulate`, no IWER): fake `navigator.xr` and `XRGPUBinding`, a 2-layer texture-array projection layer at Quest-3 eye size, both eyes copied side by side to a canvas. Head and controllers are scriptable through `__forgeXR`, including fake quad-layer compositing (`&xrquadok=`).

**Controller models.** `xr/controller-models.ts` (599) loads the WebXR input-profiles assets (bundled in `public/xr/profiles/`) and animates button visual responses. Both hands are one draw per eye (`render/glb-shader.ts`). `xr/render/glb.ts` (255) is a minimal GLB reader: nodes with TRS or matrix, positions, normals, UVs, one base-colour image. No skins, morphs, animations or extensions; a file that needs them is refused.

## 4. Settings and quality

**Registry.** `settings/registry.ts` (720) declares every setting once as data: id, category (graphics/controls/audio/accessibility/hud), type (toggle/range/choice), default (fixed or a function of the device), optional `tiers` map, `apply: live|reload`, URL `param` override, help text, and a live `detail` line.
- `settings/settings.ts` (420) is the per-device store with `num/bool/str/watch`.
- `ui/menu.ts` draws every entry automatically.
- `settings/bind.ts` (150) wires the values into the renderer, camera, touch, sound and CSS variables.
- About 33 settings.
- Graphics: quality (Auto/Low/Med/High), autoAdjust, renderDistance (tiers 8/12/16 chunks), resolution (70/85/100%), streaks (off/on/on), weather (25/50/100%), effects (light/full/full), frameCap, wakeLock, workers.
- Controls: lookTouch, stickSize, stickSide, holdMs, mouse, invertY, camera, sprint/fight keys, xr.turn/snap/vignette/moveHand/height.
- Audio: master, effects, ambient.
- A11y: reducedMotion, reducedFlashing, uiScale, textSize.
- HUD: crosshair, coords, compass, stats, tips, chat, telemetry.

**Device tiers.** `settings/device.ts` (152): `Tier = low|medium|high` (:47). `autoTier` (:127) is a pure function with a human-readable reason:
- a software GPU, a headset or an Adreno GPU gives Low;
- maxTexture <8192, or ≤2 cores outside WebKit, gives Medium;
- anything else gives High.

`defaultWorkers` = cores−2, clamped to 1..8.

**Auto adjust.** `settings/adjust.ts` (128) steps the tier down only, after 3 slow windows that were slow because of work (main-thread or GPU time). It ignores capped frame rates (iOS Low Power Mode), then cools down.

**Governor.** `render/governor.ts` (253) is separate and finer grained. Its rungs, in shed order:
1. precipitation halved;
2. splashes and motes off, ambient life halved;
3. cloud shadows and wet sheen off;
4. near-leaf radius pulled in;
5. render scale.

It sheds a rung when >10% of a 2 s window missed for GPU reasons (it uses `onSubmittedWorkDone` latency because the iPad has no GPU timestamps). It restores one after 20 s clean, is sticky after flapping, and makes at most one change every 2 s.

## 5. Audio

Everything is procedural WebAudio; there are no sample files (`ui/sound.ts:1-15`, `ui/ambience.ts:1-3`, `ui/ambience/buffers.ts`).
- **The mix.** Buses go into a master gain: `effects`, `ambient` and others. Audio is unlocked on the first gesture (iOS) and plays through the silent switch (`navigator.audioSession.type="playback"`).
- **`sound.ts` + `sound/voices.ts`.** Per-event synthesized voices with priorities: break ticks and pops, place thunk, refusal buzz, tree chop/crack/creak/crash, pickup blip, chat chime, hurt thud, recall hum and bell, the opening ship's streak and boom. Nodes are built per sound, never per frame.
- **Ambience** (`ambience.ts` + `ambience/graph.ts` 451, `beds.ts` 131, `kinds.ts` 145, `buffers.ts` 84, `room.ts` 25):
  - beds of filtered noise (wind, leaves, rain by surface, water, surf, underground rumble and drips) driven by surroundings sampling, server weather, time of day and wind;
  - an outside muffle and an echo;
  - positional voices (≤4 places plus 2 choruses plus 3 calls);
  - a graph cap of 112 nodes (`ambience/graph.ts:27`);
  - parameters written only when they moved.

## 6. Generic (engine-ish) vs game-specific

Rough, by file:

**Generic or engine-ish, about 27k lines:**
- `ui/spec/` 6,568. The words, layout, model and presenters are fully generic. The HUD sums (about 1,300 in hud-layout, place-html, prompt-place, hud-frame) are generic in mechanism but name this HUD's items (hotbar, compass, stick, corners).
- `xr/` about 15.5k: session, stereo, emulate, comfort, input, scheme, pointer, keyboard, ladder, budget, report, quad-panels, panel-pass, glb, controller-models, the world presenter, the CSS look resolver, world-hud. Game-tied pieces: bench-cases 212, part of speed.ts's preset (names game features: foliage, spire threads), status-panel and tip.
- `input/look.ts` 348, `play/gestures.ts` 479, `play/actions.ts` 117. The shape of ActionSink is generic; its verbs belong to a voxel sandbox.
- `ui/touch.ts` 701 (a generic Bedrock-style scheme with game buttons).
- Settings mechanism: about 700 (settings.ts, device, adjust, and the registry's types). The registry's entries and `bind.ts` are game wiring.
- `render/governor.ts` 253.
- Panel plumbing (`ui/panels.ts`, `registry.ts` mechanism) about 400.
- Audio bus/mix/unlock and the ambience graph skeleton: about 600.
- `ui/icons.ts`, `problems.ts`, `webapp.ts`, `leave-guard.ts`: about 900.

**Game-specific (Forge Wilds rules and content display), about 22k lines of ui/:**
- every panel group above except menu/help/report/chat/join mechanics (about 12k);
- the game HUD marks and cues (3.3k);
- the HUD parts kit, compass, vitals, recall, inspector, tags and hints (about 3.5k: game rules wired into generic HUD items);
- film and story (1.1k);
- the synthesized sound recipes and ambience bed logic (about 1.8k);
- all of `styles/` CSS (1,828).

## 7. Weaknesses / debt, and strengths

**TODO/FIXME/XXX/HACK:** zero matches in ui/, input/, settings/, xr/, styles/, play/actions.ts and play/gestures.ts. Debt is tracked in docs (vr-decisions "Shelved with VR", the world presenter's "Not drawn yet" list), not in code comments.

**Ratchet remainder:** 12 hand-built element sites in 4 files: compass 9, icons 1, panels 1, film 1. The `panels.ts frame()` chrome is still used by 6 cold panels (altar, charm, field-guide, kin, rune-book, runeforge).

**layers-allow.txt** (`apps/web/scripts/layers-allow.txt`, 78 upward lines, list only shrinks): 32 lines involve ui/ or settings/, none involve input/ or xr/.
- `settings/bind.ts` has **13** upward imports: actors/hand, play/controller, play/glide, render/camera, render/renderer, ui/chat, compass, hints, hud, sound, spec/hud-frame, touch, webapp. It is a god wiring file sitting at layer 3.
- `play/spire.ts` has **11** upward imports into ui/ and ui/spec/ (chat, door-panel, floor-panel, vitals, hud-frame, hud-layout, measure, panel, present, words): game logic driving UI directly.
- `ui/sound.ts` is imported from below by mesh/falls, play/controller, play/fight, stats/stats and settings/bind; `ui/ambience.ts` from life/life and life/sounds. Audio is placed in ui/ but used as a low-level service.
- Also: play/controller → ui/hud, play/projector → ui/rune-words, stats → ui/problems.

**Heavy or brittle:**
- Large files: xr/session.ts 1,385; xr/emulate.ts 1,144; xr/render/panel-pass.ts 1,136; ui/make.ts 1,061; present-world.ts 1,028; xr/ui/spec/look.ts 1,027; door-panel 936; compass 892; hud 886; menu 808.
- `look.ts` is a hand-written CSS cascade resolver. Any new CSS feature a panel uses can silently miss in the headset; a large gap list is documented.
- XR e2e is not in CI. Quest needs a flag for WebGPU in WebXR. Quad-layer alpha holes, and memory on the device, are unverified on hardware.
- No general key-rebinding or action-map layer: hotkeys are scattered across boot/. No flat gamepad support.
- WebGPU-only: no WebGL fallback, by decision.

**Purpose-built and strong:**
- A zero-cost idle UI with counted DOM-write and node budgets in tests.
- An allocation-free typed-array layout.
- Two presenters with an enforced parity test and a side-by-side sheet.
- A ray-based aim seam proven bit-identical.
- A pure, Node-tested gesture, governor, adjust and autoTier logic.
- Auto-tier reasons shown to the player.
- A golden frame call trace (screens pay 0 for UI and XR seams).
- One-pass-per-eye XR rendering with a union cull.
- A quad-layer path with a thorough fail-safe.
- A self-contained XR emulator.
- Procedural audio with node caps.
- A lazy-chunked XR and cold panels, held by the bundle budget.

## 8. Churn, last 30 days (`git log --since=30.days --format=%h -- f | wc -l`)

| Commits | File | Lines |
|---|---|---|
| 35 | ui/make.ts | 1,061 |
| 35 | ui/help.ts | 691 |
| 33 | ui/door-panel.ts | 936 |
| 26 | ui/compass.ts | 892 |
| 25 | ui/heart.ts | 624 |
| 24 | ui/chest.ts | 459 |
| 23 | ui/hud.ts | 886 |
| 21 | settings/registry.ts | 720 |
| 20 | ui/touch.ts | 701 |
| 19 | ui/floor-panel.ts | 271 |
| 18 | ui/rune-book.ts | 432 |
| 17 | xr/session.ts | 1,385 |
| 17 | ui/runeforge-panel.ts | 696 |
| 17 | ui/kin-panel.ts | 339 |
| 16 | ui/story.ts / ui/seers-lens.ts | 454 / 504 |
| 15 | ui/kit.ts, styles/panels.css, styles/hud.css | |
| 14 | xr/stereo.ts | 844 |

**By directory (30d / 21d):**

| Dir | 30 days | 21 days |
|---|---|---|
| ui/spec | 42 | 26 |
| settings | 28 | 13 |
| xr | 26 | 7 (moves and doc repoints since the shelving) |
| input | 4 | 4 |
| ui/sound | 2 | 2 |
| ui/ambience | 2 | 2 |

Churn concentrates in the game-specific panels and HUD (make, help, door, compass, heart). The framework (`ui/spec`) keeps changing steadily but at moderate volume. XR is effectively frozen.

# Appendix C: frame loop, net, guard rails (B-sub-loop.md)
# B-sub: apps/web frame loop, threading, net-to-render, game logic, guard rails

Read-only inventory as of main d38b72ad (2026-11-14). All paths are under apps/web unless they say otherwise.

## 0. Sizes (lines of src)
- ui 34,808; xr 16,896; render 15,862; actors 7,963; play 6,171; boot 4,864; state 4,798; mesh 3,103; net 2,993; life 1,984; scene 1,860; settings 1,570; stats 839; spike 503; input 348; interact 189. Plus main.ts 601, params.ts 214 and build.ts 11.
- Hot files: net/session.ts 1040, play/spire.ts 1067, play/controller.ts 851, state/store.ts 760, life/life.ts 760, boot/frame.ts 593, render/renderer.ts 598 (a facade over render/renderer/*.ts, 14 part files), boot/play-session.ts 576, boot/join.ts 439, mesh/view.ts 387, mesh/pool.ts 301.
- Dependencies: only @forgewilds/protocol and @forgewilds/sdk; dev dependencies @webgpu/types and vite 8.
- SDK (packages/sdk): connection 817, content 913, entity-stream 581, snapshots 411, prediction 670, movement 683.

## 1. What runs per frame and per message

### Per frame: boot/frame.ts `frameLoop` (:130), `frame(now)` (:182–565), in order
1. Clock and timing:
   - The clock is read once, t0 = performance.now() (:183); `&freeze` gives drawNow and drawClock (:181, :185).
   - filmGiveBack and chaseGiveBack (:188–189); dt is capped at 0.1 s (:190).
2. Input:
   - XR controls and flat pads (:194–197).
   - `walker.pump(now)` (:198); then `camera.update(dt)` (:199).
   - XR eye ease (:201); glide FOV and HUD cues (:202–206).
3. World:
   - `steerWind` (:209).
   - `session.follow()` sends SetInterest when the chunk changes (:210).
   - The crash film overrides the camera (:213–228).
4. Visibility and meshing:
   - `visibility.update` (:231).
   - `v.tickTimed` every 250 ms (:232). This is WorldView's timeline check.
   - `v.setCamera`, then `v.flush(FLUSH_BUDGET_MS=4)` (:237–238). This uploads finished meshes within 4 ms.
   - The pool reprioritizes and pumps every 500 ms (:239–243).
5. Aim: session.aim, interaction.update, poseSender.update, inspector, lens and projector (:245–257).
6. Fight, when connected (:266–287): boss, husks, zones, the boss bar, foxes, escort and fightPlay.
7. Telegraphs: `renderer.telegraphs` (:289–291).
8. Spire, party and floor:
   - spirePlay.frame, party chips and ring (:293–306).
   - floorLook (:307).
9. Camera extras: the chase camera (:309–323); the kit bracket (:325–328).
10. Entity boxes:
    - `boxes.build(conn.entities…)` (:344).
    - Then particles, wreck, film, gift and veins append boxes (:345–355).
    - `renderer.setBoxes` and `setGrow` (:356–357).
11. Actors and props:
    - Remote cracks (:367); hand (:370–383); drops (:385).
    - `life.frame` (:386); creatures (:389); `actors.frame` (:393); compass (:396).
12. Painter: held, extra and flares, then `painter.update(camera.pos, now, renderer.frustum(camera), drawClock)` (:399–402).
13. Sky and environment:
    - `sky.update(worldNow…)` (:405).
    - Underwater, clearWater, and cave darkness from roofedOver (:409–447); `stormSky` (:448).
    - Sound listener and ambience (:452–454).
    - Falls: shake, kick and boss beat (:456–482).
14. `worldUi.frame` (:484).
15. **`renderer.frame(camera, (drawNow-start)/1000, sampleVis, t0)` (:485)**, in try/finally, which restores the camera (:486–492).
    - renderer.ts:497 → renderer/frame.ts:14.
    - `prepare(camera, views…)` (frame.ts:31) does the uniforms, GPU cull and pose pass.
    - `draw(view)` (renderer.ts:513) and `submit()` (frame.ts:244).
    - XR uses prepare and draw once for each eye (the UI2 seam).
16. After the draw:
    - Capture (:494); name tags `tags.show` (:495).
    - DOM overlay marks: weak, escort, find and role (:496–534).
    - `stats.frame` (:536); xrPlay.frame (:537); `governor.frame` (:539). The governor is the dynamic quality tier.
    - GPU latency through onSubmittedWorkDone every 8 frames (:542–549).
    - Auto tier step-down (:555–562); checkComplete and publish (:563–564).

### The loop driver: `tick` (:569–587)
- In XR it calls `xr.requestFrame(tick)`, otherwise `requestAnimationFrame(tick)`.
- A frame cap skips a frame if `now - last < capMs*0.9`; the cap is off in XR (:580).
- `problems.frameOk` or `frameThrew` records each frame's result. `live.loopTick = tick` (:589).

### Clock reads and shared state
- The loop reads the clock twice a frame. A test asserts that the renderer, painter and view read it 0 times.
- Shared mutable state is the `live` object in boot/live.ts (128 lines, about 70 fields).

### Timers off the frame
| Timer | Interval | Where |
|---|---|---|
| Walker pump | 25 ms | play-world.ts:369 |
| Weather | 250 ms | scene.ts:120 |
| Ambience and life | 250 ms | life-scene.ts:113, :246 |
| Liveness and reporter | 1 s | join.ts:243, :247 |
| Toast | 100 ms | play-session.ts:179 |
| Stats publisher | — | stats.ts:271 |

Several UI panel intervals also run off the frame.

### Per message (SDK Connection events → apps/web)
- **Sections.**
  - state/store.ts:85–87 handles section, sectionEdit and sectionUnload. Sections arrive and leave, then go to the summarizer queue.
  - `flushSummaries` (:193) sends one batch to the section worker per frame, with the buffers transferred (:225).
  - `replied` (:229) calls the listeners (:280), which lead to WorldView.
- **Meshing.**
  - mesh/view.ts:142 handles sectionTimelines.
  - The view's mesh result goes to `renderer.addSection(r)` (:373); `renderer.dropSection` is at :236 and :315.
- **Prediction.** net/session.ts:276–282 handles sectionEdit, section and sectionKept: an edit is confirmed or rolled back. The inventory watch is at :295.
- **Entities.**
  - boot/join.ts:417: `entities` goes to `b.frame(e, now)`, which is EntityBoxes with an SDK SnapshotBuffer.
  - Also handled there: vitals, downed, hunt, chat, and disconnect, reconnect, close and control (:251–342).
- **Scene.** boot/scene.ts handles:
  - weather (:88)
  - `climate` → renderer.setClimate (:132)
  - trees (:152)
  - reconnect (:145)
- **Play session.** play-session.ts handles:
  - treeFall (:108, :203)
  - outline and floor (:119–120)
  - sectionPiles, section and sectionUnload → PileHeaps (:190–192)
  - learned, helped, given and trusted (:310–318)
  - content reload (:467)
- **Fight and world.**
  - play-fight.ts handles `fight` (:253, :287, :328).
  - play-world.ts handles recall, knowledge, story, run, playerState, downed, trees and disconnect (:126–362).
  - play-guide.ts and net/actions.ts:372–414 handle recipes, knowledge, guide and trees.
- **The documented flow** (docs/client/web/web-architecture.md:14–17): forge → SDK ChunkStore → events → WorldView → MeshPool → workers → vertices → Renderer. ServerSession owns interest, raycast and predicted place/break.

## 2. Workers (boot/workers.ts, 79 lines)
No SharedArrayBuffer, Atomics or crossOriginIsolated appears anywhere in src. All workers use postMessage with transferables.

- **Mesh workers.**
  - `meshWorker(i)` (:12) loads mesh/mesh-worker.ts (18 lines: meshReply and transferList).
  - Count: `params.workers = clamp(hardwareConcurrency-2, 1..8)` (params.ts:153). The pool is created at main.ts:355 with 2 jobs in flight per worker, and a dead worker is replaced.
  - A job carries its 27 sections, as received, in one transferred buffer of about 2 KB (the budget is 4.5 KB). The vertices are transferred back.
- **Section worker.**
  - `sectionWorker()` (:35) loads state/section-worker.ts (27 lines). It builds the table, summarizes, and transfers the summaries back (`summaryTransfers`). It is set up at scene.ts:73.
  - If it dies, the main thread summarizes instead.
- **Inflate worker.**
  - `inflateWorker()` (:57) loads net/inflate-worker.ts (20 lines), which runs DecompressionStream("deflate-raw").
  - The main thread copies the data with data.slice() and transfers the copy. The reply is transferred back.
  - It is wired to the SDK `inflate` option (deflateOptions) and created at join.ts:117. It falls back to the main thread.
- **Spike terrain.** spike/terrain-source.ts:31 starts 2 terrain-worker.ts workers, only with `?source=spike` (main.ts:566).
- **OffscreenCanvas** is used only for UI icons and measuring text.

## 3. Prediction and timelines: the SDK vs apps/web
- **From the SDK** (packages/sdk):
  - prediction.ts: Predictor :343, renderFeet :499, PlayerBody :516, Interpolator :652.
  - movement.ts: `step` :315, the movement physics shared with the server.
  - snapshots.ts: SnapshotBuffer :104, with a 100–300 ms delay (:42–43).
  - Connection and ChunkStore (deferDecode and events); softLock and FightMirror.
  - The models for sky keyframes, weather, falls and the spire.
- **From apps/web:**
  - **Walker** (play/walker.ts, 209 lines):
    - It feeds PlayerBody one input every TICK_MS = 50 ms (pump :146–162, at most 3 catch-up ticks).
    - The camera sits at `predictor.renderFeet(now)` plus StepEase (:180–192).
  - **Remote entities.** state/entities.ts (EntityBoxes) and actors/players drive SnapshotBuffer.
  - **Edits.** net/session.ts predicts with ChunkStore.setCell, keeping shadows and waiting maps. The server's SectionEdit replaces the prediction, and a rejection rolls it back.
  - **Fight.** play/fight.ts works out the soft lock and predicted contact on the client.
  - **Client-side timelines:**
    - Spin and basins: state/forces.ts (127) and net/watch.ts ModelWatch and BasinWatch (356). These are live queries; turning parts turn in the shader.
    - Sky: state/sky.ts (340), driven by `conn.sky` keyframes, with no allocation.
    - Weather: state/weather.ts (530), float ports of forge-core Front::at and sample.
    - Growing blocks: SectionTimelines, checked 4 times a second by WorldView.
    - Falling trees: mesh/falls.ts. Creature courses: actors/creatures.
  - **Life** (life/, 1,984 lines; life.ts 760):
    - Deterministic, hashed from the land and the world clock.
    - The same on every client; nothing is sent.

## 4. Net → renderer
- **Terrain:**
  - SDK ChunkStore events → state/store.ts (summaries through the worker) → listeners → mesh/view.ts WorldView.
  - WorldView → MeshPool workers → `renderer.addSection` and `dropSection`. Uploads are paced by `v.flush(4 ms)` in the frame.
- **Entities:** the `entities` event → EntityBoxes, with an SDK SnapshotBuffer per entity.
  - Each frame `boxes.build` interpolates them, and `renderer.setBoxes` sends one Float32Array.
  - Actors, creatures, drops and the hand use their own GPU pose and indirect paths (render/renderer/kits.ts, actors/*).
- **Lights, models and basins:** live watches (net/watch.ts) → render/painter.ts (420) → `renderer.setForces` (renderer.ts:366).
- **Climate, weather and sky:** scene.ts → `renderer.setClimate`; sky.update and stormSky each frame. Telegraphs, piles and falls each have their own renderer setters.
- The renderer API is imperative and push-based. Game code calls the setters, then `frame()`. There is no scene graph; it is section arenas plus boxes plus actor kits.

## 5. Game-specific client logic, and what an engine could absorb
- **Logic:**
  - play/ (6,171): spire 1067, controller 851, interact 543 (a pure break timer), gestures 479, fight 389, tools 347 (pure), projector 222, finds 219, walker 209, escort-actor 194.
  - life/ (1,984). scene/ (1,860): opening 618, crash-film 566, surroundings 527, veins 149. Everything in scene/ draws as entity boxes and has no pass of its own.
  - play/, life/ and scene/ together are about 10k lines. boot/ (4,864) is the wiring.
- **An engine could absorb:**
  - Device and swapchain setup (renderer.ts:134–144).
  - Render targets, bloom and post, generic culling and indirect draws.
  - The camera and frustum math (render/math, camera).
  - The rAF/XR loop driver, GLB/model drawing, and particles.
- **An engine could not absorb:**
  - The voxel mesher and its 8-byte vertex format, the connectivity culling, the section arenas and the 1,024-entry palette uniform.
  - fs_terrain's custom shading (the weather map and block light).
  - The weather and sky ports of forge-core, and SDK prediction and snapshots (these are network code, not rendering).
  - All of play/, life/ and scene/, and the WGSL tuned for the iPad (no `override`, and the texture-read budget).
- **Coupling that resists a swap:**
  - play/controller imports render/renderer and render/camera; play/fight and play/walker import render/camera; play/floor-look imports render/renderer.
  - mesh/view and mesh/falls import render/renderer; stats imports renderer and visibility.
  - render/* imports actors/* (layout, hand, actor-draw and the shaders), so the actor system is welded into the renderer.

## 6. Guard rails, and what a renderer swap does to each
Source: docs/client/web/web-perf-budgets.md (table :79–106). Budgets count work (GPU calls, map and set visits, Float32Array allocations, clock reads); they do not time it.

### The machinery
- **Fake GPU:** test/helpers.ts:159 `fakeGpu(trace?)`.
  - It is built from recursive Proxies and counts every call (`calls.n++`).
  - It labels results from descriptor labels. Bind groups are labeled by their resources, views as `<tex>.view`, and passes by their attachment labels.
  - With a trace it records `name(args)`.
- **Fake renderer:** `fakeRenderer` (:218) uses an iPad canvas of 1194×834, the "baseline" preset and "indirect" draws.
- **Harness:** test/client-budget-harness.ts (513). It wraps the global Float32Array constructor (:69–79) and wraps Map, Set and SectionGrid iteration (:81–118). It provides an inline section worker and `frames()` (:251).

### The rails
| Guard rail | What it checks | Effect of an engine swap |
|---|---|---|
| **Golden frame trace**: client-budget-frame.test.ts:173–247 with fixtures/frame-trace.json (256 lines) | SHA-256 over 120 frames of GPU calls for the clear, storm and spire runs. Clear = 46 calls, storm 47–58, spire 48. Frustum planes bit-equal. 0 Float32Array allocations a frame. Rewrite with FORGE_FRAME_TRACE=write. The fixture changed once in 30 days. | **Invalidated; must be re-recorded.** Every count and hash changes. |
| client-budget-frame (261 lines): exact call counts | piles ≤+4 calls; wreck ≤+2 draws; veins +0; 1,500 vs 6,000 sections give the same calls (≤46); weather dispatch ≤20 in 10 s | **Re-baseline.** The same-calls-at-any-scale property stays meaningful. |
| client-budget-fight (270) | ≤49/52/50/53 calls (65 in a storm); lock scoring ≤32 of 40; 0 allocations | **Re-baseline the counts.** Lock scoring is unaffected. |
| hand-budget (288), actors-budget (203), stereo (285), xr/ui-world-budgets (235), xr/xr-frame (214), client-budget-ui XR (+1 draw), life (fireflies, 1 draw) | GPU call counts tied to this renderer's structure | **Invalidated, or rewritten against the engine's API.** |
| 0 Float32Array allocations, 0 clock reads in the renderer, painter and view | — | **At risk** if the engine allocates per frame or reads its own clock. The wrappers still detect it. |
| shaders.test (92) | no WGSL `override` (iPad WebKit); ≤6 texture reads reachable from fs_terrain | **Invalidated if the engine generates the WGSL.** The no-override rule is a hard iPad requirement the engine must meet. |
| Bundle budget (scripts/bundle-budget.ts and its test, 156) | index ≤500 kB gzip (472.6 today); total ≤670 kB (640.5 today); LATE modules kept out of the index | **Directly at risk.** About 27 kB of index headroom and about 30 kB in total, so most engines will not fit. |
| layers (scripts/check-layers.ts 263, layers.test 166, layers-allow.txt) | the RANKS order | **Needs a new rank for the engine** (likely next to build/packages). The allow-list only shrinks. |
| **Unaffected:** stream (172: 0 decoded on main, ≤3 visits a message, inflate off the main thread); mesh-budget (299: ≤4.5 KB a job, ≤6 remeshes an edit); arena (233); culling-frame (346, the search logic); model-budget (327, mostly); governor (136, synthetic); life placement (575); ui-ratchet (83); ambience; UI DOM tests | — | Stay valid **if the engine keeps these subsystems**. If it replaces culling or arenas, they go. |
| Smoke (local-ci lanes.sh:95–113 → smoke-local.sh → e2e/smoke.ts 114) | WebKit with the iPad Pro 11 profile: full view in ≤30 s, no WebGPU or page errors, reports fps | **Unaffected as a behavior test.** It is the only real-GPU check in the gate. |
| Outside the gate: wgsl-check.ts (compiles every WGSL in real WebKit), bench/* (mesh, creatures, foliage, light, culling-fixture), the other 46 e2e scripts | manual only | — |

The gate's web lane runs check-layers, typecheck, `node --test test/**/*.test.ts`, then build, the bundle budget and smoke.

## 7. Test lines per area
- Totals: 198 .ts files under test/ (185 .test.ts), 44,011 lines.
- By area:
  - ui 20,180 (76 files)
  - xr 4,977 (24)
  - budgets 4,059 (17)
  - play 2,907 (21)
  - state 2,402 (12)
  - actors 2,298 (8)
  - mesh 2,022 (9)
  - render 1,652 (10)
  - settings 875; e2e/eval harness 655; life 575; net 571; helpers 432; static guards 406
- Renderer-coupled tests:
  - Files using fakeGpu, fakeRenderer or the harness: 15 files, 4,362 lines.
  - Files importing src/render/: 48 files, 11,989 lines.
  - Together these are the rough exposure to a renderer swap.

## 8. Debt
- **Markers.** TODO, FIXME, XXX and HACK: **0 in all of src**. Softer phrases give 3 benign "for now" comments (xr-lobby.ts:191, play/actions.ts:12, play/gestures.ts:156).
- **Layers.** `node scripts/check-layers.ts` passes: "359 files, 78 allowed exceptions". All 78 are upward imports.
  - By importing dir: play 32, settings 13, render 13, state 6, mesh 6, stats 5, life 2, net 1.
  - play (32):
    - spire.ts → 11 ui files (chat, door-panel, floor-panel, vitals, ui/spec/*)
    - controller.ts → 6 (actors/creatures, render/camera, math, renderer, ui/hud, ui/sound)
    - escort-actor.ts → 6 (actors/*)
    - fight.ts → 3 (actors/husks, render/camera, ui/sound)
    - walker.ts → 2 (render/camera, math)
    - actions.ts, chase.ts → render/math
    - echo.ts → render/rune-glow
    - floor-look.ts → render/renderer
    - projector.ts → ui/rune-words
  - render (13): renderer, renderer/kits, renderer/state, shaders, drops, glb-shader and diag → actors/* (actor-draw, hand, layout and the shaders).
  - state (6):
    - blocks and store → mesh/input
    - entities → actors/players and render/math
    - rune-match and rune-sight → render/rune-glow
  - mesh (6): view → render/renderer and visibility; falls → render/fall-shader, math, renderer and ui/sound.
  - stats (5): stats.ts → render/camera, renderer, visibility, ui/problems and ui/sound.
  - life (2): life.ts and sounds.ts → ui/ambience.
  - net (1): session.ts → play/tools.
- **Churn, 30 days** (commits touching the file; 606 commits in the repo over the same period):
  - main.ts 100
  - play/spire.ts 49
  - play/controller.ts 39
  - net/session.ts 38
  - ui/make.ts 35, ui/help.ts 35
  - ui/door-panel.ts 33, render/renderer.ts 33
  - boot/play-fight.ts 31, boot/play-session.ts 30
  - ui/compass.ts 26
  - test/client-budget.test.ts 25
  - (also ui/tutorial 25, ui/heart 25, play/tools 24, render/shaders 23, play-world 21, params 19)
- **Churn of quieter files:** boot/frame.ts 18, play/fight.ts 11, net/actions.ts 11, boot/join.ts 9, life/life.ts 8, scene/opening.ts 5, state/store.ts 3. boot/ as a whole has 76 commits.
- main.ts churn is concentrated before and around the boot/ split (CX1, #387, 2026-10-25: 10 commits that day), then falls to 3–6 a day.
- **Pain points:**
  - main.ts and play/spire.ts are hotspots.
  - spire.ts is the worst layer offender and the largest play file.
  - controller.ts mixes input, render and UI.
  - The renderer.ts facade and render/shaders churn (33 and 23 commits) with every feature: each new visual adds a setter, a pass and calls to the golden trace.

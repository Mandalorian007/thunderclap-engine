# Decisions: thunderclap-engine

Decisions made in this repo. Numbers are `E-0xx`; `D-0xx` refers to [The Last Rune](https://github.com/Mandalorian007/last-rune/blob/main/docs/DECISIONS.md), where the engine was built. The PM logs each entry when the decision is made, with who made it.

## E-001: This repo is the engine's source of truth; vision, proof and process (2026-11-05, user + PM)
- **Vision** is [VISION.md](VISION.md): a game every two to four weeks, nearly all of it game logic. Rendering support over game mechanics; The Last Rune and Forgewilds are the two candidate styles the engine must span.
- **Source of truth.** Engine development happens here, now. The Last Rune stays on its in-repo copy (D-051) until a later workstream switches it to a git dependency; Phase 3 is not hand-synced back. The gate for engine work is this repo's unit tests, harness e2e matrix and demo scenes.
- **3D ahead of a game: seams plus demos.** Phase 3 lands as planned (camera, transforms, render call) with engine-owned demo scenes as the proof (`?demo=mesh`: perspective camera, depth, a lit mesh, orbit). Lighting block, shadows and glTF wait for a game that needs them (VISION rule 6).
- **Process.** Each workstream runs on `ws/<name>` in its own worktree; `pnpm check` and the e2e matrix green, `ARCHITECTURE.md` and `CHANGELOG.md` updated in the branch. The PM merges to `main` and logs here and in [STATUS.md](STATUS.md). Nothing is pushed without the user.
- **Agents.** Up to 10 top-level agents; the PM stages waves by dependency and runs each wave in parallel.

## E-002: Analytics is an engine subpath with a pluggable sink; the engine still makes no network call (2026-11-05, PM)
- The architecture doc proposed a sibling package. A second package would make this repo a workspace before `host-electron` forces that shape, so analytics ships as `@thunderclap/engine/analytics` instead.
- `createAnalytics({ sink, ... })` emits typed events (`game_start`, `session_end` with duration, form factor and preset, plus game events) to a sink the **game** supplies. The engine ships no network sink; a `sendBeacon`/`fetch` sink is a template concern. Flush rides the page lifecycle the save store already uses.
- It attaches to an existing ctx (`analytics.attach(ctx)`) through `ctx.hooks` and `ctx.host`, so it needs no change to `createGame`.

## E-003: Camera and transforms run in parallel with file ownership (2026-11-05, PM)
- ws/camera owns `render/camera.ts`, `core/math.ts`, the camera uniform block in `render/wgsl.ts`, and the camera-related code in `render/renderer.ts`.
- ws/transforms owns `render/material.ts` (instance format), `render/mesh.ts` (vertex layouts), `render/frame.ts` and the instance side of the WGSL prelude, plus the instance and sort code in `render/renderer.ts`.
- Both keep the 2D path pixel-identical; the harness e2e matrix is the regression suite. The PM resolves the `renderer.ts` seam at merge, camera first.
- Shape asks adopted from the architecture doc (2026-11-05): 28-float instance with a 3×4 world matrix; camera block carries `view`, `proj`, `view_proj`, `camera_pos`, `view_index`, `viewport`; `layers: u32` **mask** for membership *and* a separate sort `order` (the plan's `layer` number); vertex layout per `Mesh`, pipelines keyed by (material, layout).
- **Addendum (merge, 2026-11-05, PM).** Failed batches are dropped, not buffered: analytics is best-effort and the engine persists nothing of it. One session per page load; a bfcache restore continues the session. `attach` wants `GameHooks.hide(reason)` and a form factor on `EngineCtx` when `chrome` is null; ws/one-overlay and ws/client-mode pick those up.

## E-004: Agent worktrees live under `.claude/worktrees/` and are ignored (2026-11-05, PM)
- Workstream worktrees sit inside the repo, so `.gitignore` and `biome.json` exclude `.claude/worktrees` / `**/.claude`; otherwise Biome sees nested root configs. The boundaries script scans only `src/`, `harness/`, `e2e/`, `examples/`, `templates/`.

## E-005: Process adopted from Forgewilds, without PRs (2026-11-05, user + PM)
- The user asked for Forgewilds' working knowledge of the PM-and-agents workflow; an Explore agent distilled `forgewilds/docs/PM.md`, `docs/briefs/*` and its lessons. What transfers is in [PM.md](PM.md), [briefs/common.md](briefs/common.md), [briefs/integrate.md](briefs/integrate.md) and the root `CLAUDE.md` routing.
- Differences from Forgewilds: no PRs, so an **integrator agent** does what `merge-pr.sh` did (gate on the exact head, gate again on merged `main`); no machine-wide gate lock, no port ranges, no codegen regimen. The PM never writes or merges code (user instruction, 2026-11-05).
- Kept: PM-only ownership of VISION/DECISIONS/STATUS; every other doc changes in the branch with the code; disjoint file ownership per wave; 1–3 h steps, batch under ~500 lines; no flake retries; refactors bit-identical; an append-only `docs/archive/`.

## E-006: Camera shape as landed; D-044's device/setFill deletion moves to ws/render-call (2026-11-05, PM)
- ws/camera landed `Camera` as a class (`ortho2d`, `perspective`, `fitRect`, `worldToScreen`/`screenToWorld`, `depthTest`/`depthWrite`/`layers`) with `mat4` in `core/`, bit-identical 2D output verified by byte-equal PNGs on main and branch. The WGSL camera block uses snake_case (`view_proj`, `camera_pos`, `view_index`) as the architecture doc named them; `EngineGlobals` stays camelCase. Accepted; game shaders reference the doc's names.
- D-044 had ws/camera delete `device`/`setFill` and the fill bands in favour of `layout.freeRect` + `Camera.fitRect`. The brief deferred it; it is now part of **ws/render-call**, which already opens the fixed pipeline in `core/game.ts`. `depthTest`/`depthWrite`/`layers` are read by ws/transforms (sort, skip) and ws/render-call (depth attachment).

## E-007: Client mode: `save` and `sim` opt-in; lifecycle hooks carry reasons (2026-11-05, PM)
- `createGame({ save?, sim? })`: `save` optional, `ctx.save` typed `null` when absent (`S extends FlushableSave | null`, `NoInfer` on the return); `sim: { step? } | false`, where `false` runs `hooks.frame(dt)` and scenes at render rate with no `hooks.update`. Without a save (and without `mixerKey`) `Host.storage` is never read; `e2e/client.spec.ts` proves it on the matrix.
- `GameHooks.hide(reason)`, `show(reason)` (new, added so analytics can restart a session after the page returns) and `GameLoopOptions.fixed`. Analytics now wraps `hide`/`show`/`deviceLost` instead of its own lifecycle listener.
- Worktrees created by the Agent tool start from the repo's base commit, not `main`; every brief says to reset onto `main` (or the branch it stacks on) first.

## E-008: "Pixel-identical" tolerates ≤1/255 on rotated sprites; transforms shape as landed (2026-11-05, PM)
- ws/transforms moved sprite rotation from the shader to the CPU-built 3×4 matrix; a 40-sprite probe differs on 5 of ~786k channels by at most 1/255, and only for rotated sprites. Accepted: that is float-precision noise, not a layout change. The 2D invariant is: exact at rotation 0, ≤1/255 otherwise, harness e2e green.
- Landed shapes: 28-float instance (`m0–m2` rows 0–11, `uvRect` 12–15, `tint` 16–19, `params` 20–23, `misc` 24–27 = emissive, flags, size.xy); `Transform` with parent and cached world 3×4; `DrawParams.layers`/`order`; `VERTEX_LAYOUT_2D`/`_3D` with `materialPrelude(layout)`; `material.pipelineFor(layout, depth)`; depth attachment allocated only when a camera asks; `VSOut` gains `normal` and `worldPos`.
- Known follow-ups for ws/render-call: drawables (`ParticleSystem`) need a `depthStencil` state when a depth camera exists (`frame.depthFormat`); the camera's clip line should use the instance's world z.

## E-009: Wave 1 complete (Gate A); depth sort and ortho depth range; pointer router shapes (2026-11-05, PM)
- `main` at `e340ed7` holds all six wave-1 workstreams: 414 engine tests, 24 host-electron, e2e 299 passed / 31 skipped. Gate A met: 2D harness unchanged within E-008.
- **Depth sort key is view-space depth** (`-(view row 2 · world origin)`), the same quantity the depth buffer compares, for ortho and perspective alike. `depthWrite`/`depthTest` defaults come from the `Camera` preset (`ortho2d` off/off, `perspective` on/on).
- **Ortho depth range.** `Camera.ortho2d` currently maps world z ∈ [-1, 0] into the depth buffer, so a 2D `Transform` with z outside that is clipped. ws/render-call widens the preset (near/far symmetric, on the order of ±1024 design units) so `Transform.z` is a usable 2D stacking axis; x/y output is unaffected.
- **Pointer router (ws/input-rays) decisions accepted:** a bound `select` action selects the hit under the primary pointer; touch stays a pointer one tick after lift so tap-bound select sees the hit; `blocked()` ends every hit; ortho rays run along +z from z = 0. `PadCursor` joins `input/` (the engine had none). The `createGame` wiring (`ctx.pointers = createPointerRouter({ camera: () => renderer.camera })`, `input.setPointers`) lands in ws/render-call. XR implements `PointerSource.poll(camera): PointerSample[]` later; no WebXR code yet.
- **Drawables and depth:** `ParticleSystem` and other drawables need a `depthStencil` state when a depth camera exists (`frame.depthFormat`); ws/render-call.

## E-010: Wave 2 complete (Gate B); render call as landed (2026-11-05, PM)
- `main` at `2b89c82`: 466 engine, 24 host-electron, 14 template tests; e2e 366 passed / 36 skipped. Gate B met: the mesh page runs on the matrix (`2b1032e`), the template booted from zero to green in 17 minutes (`a266b04`), client mode runs the harness without a save store (`1b09225`).
- Render call as landed: `Renderer.render(frame, camera, target = renderer.target)`, `SceneTarget` (the brief's `RenderTarget` name clashed with `createRenderTarget(): Texture`), `createSceneTarget`, `endFrame()` renders `renderer.camera` only when nothing was rendered. `Camera.ortho2d` spans world z ±`ORTHO2D_HALF_DEPTH` (1024), +z farther (matches E-009's ortho rays along +z; supersedes the [-1, 0] range). `FrameSource { requestFrame, cancelFrame }`; `Host extends FrameSource`; `GameLoopOptions.frames` replaces `raf`/`caf`. `EngineCtx.pointers` wired in `createGame`. `EngineCtx.device` and `setFill` are gone.
- Leftovers, assigned to wave 3 `ws/plumbing`: `Surface.setFill`, `computeFillWidth`, `FillWidthOptions` in `src/platform` have no engine caller and are deleted; `platform/device-mode.ts` (`data-phone`/`data-touch`) stays as interim API because `rotate-card.ts` and the harness use it, and its e2e test stays. The stale Layout *Planned* sentence about ws/camera deleting `device`/`setFill` goes to `ws/doc-sweep`. `Scene.render(frame, camera, alpha)` so scenes stop reading `renderer.camera` joins `ws/plumbing`.

## E-011: Wave 3 landings so far; e2e determinism; 3D/XR principle reworded (2026-11-05, PM)
- Merged: ws/doc-sweep `7b1c054` (docs only; `pnpm check:docs` added, not chained: 132 undocumented exports remain in core, input, render, testing → a second sweep after wave 3), ws/two-views `749b992` (`Camera.viewIndex` is the source of `view_index`; call order no longer is).
- **e2e determinism.** Two branches (lights, mesh-stream) each saw one failure of `gestures.spec.ts` "tap versus pan" on `phone-promax` under matrix load, and the matrix's passed/skipped split moves between runs because `mesh.spec.ts` and `gestures.spec.ts` read a module-level `touch` flag before the page sets it. Both are bugs under the no-retry rule; `ws/flake-gestures` fixes them and merges before lights, mesh-stream and plumbing. Integrators do not rerun the matrix to "see if it passes"; one diagnostic rerun to localise is fine, say so in the report.
- ARCHITECTURE principle 4 ("3D content and XR are out of scope until after Gate 5") is stale on the 3D half: perspective, depth, meshes and lights are *Today*. Reword to: "XR is out of scope until after Gate 5; 3D arrives capability by capability with the game that needs it (VISION rule 6)." The doc-sweep-2 step makes the edit.
- `Mesh.update(MeshUpdate)` replaces the positional `update(...)` (breaking, no callers); accepted. Renderer should skip an indexed draw with `indexCount === 0` (ws/lights owns the line; integrator of mesh-stream adds it if lights did not).

## E-012: Wave 3 complete; Gate C (2026-11-05, PM)
- Merged in order: flake-gestures `7c528e2`, plumbing `8f3cb9d`, lights `af36d1c`, mesh-stream `bde5299`. `main` at `bde5299`: 480 engine / 24 host-electron / 17 template tests; e2e 406 passed / 36 skipped; skip count constant across all four gate runs, so the matrix is deterministic again.
- Gate C met for its four code clauses; the docs clause closes with ws/doc-sweep-2, which also chains `check:docs` into `check`.
- Landed APIs: `Lights` at group 0 binding 2 with `engine_lambert`; `Mesh.update(MeshUpdate)` with capacity and growth count; `Camera.viewIndex`; `Camera.fitFreeRect`; `EngineCtx.gestures/camera/stack`; `Scene.render(frame, camera, alpha)`; `Surface.setFill` and the fill-width helpers deleted. Renderer skips indexed draws with `indexCount === 0`.
- Next fork for the user (unchanged): WebXR on the two-view seam now, or hold. Recommendation: hold until a game needs it (VISION rule 6).

## E-013: Wave 4: build out Forgewilds' named needs in parallel, WebXR included (2026-11-05, user + PM)
- The user granted a six-hour window of maximum agent capacity ("build as far as you can as fast as you can") and standing permission to push `main`. The PM pushes after every landing from now on.
- The WebXR fork is resolved by the user's direction and VISION rule 6: Forgewilds names stereo cameras and headset controllers, so `ws/xr` builds on the two-view seam now (WebGPU-only through `XRGPUBinding`; no WebGL fallback). Post stack per eye is deferred to wave 5.
- Nine parallel workstreams with disjoint ownership: prune, shadows (sun shadow map + distance fog in the lighting block), cull (bounds + frustum), look (pointer lock, touch zones, sticks), anchors (world-anchored DOM), particles-3d (world-space billboards, weather), texture-array (arrays + GPU mips), spatial-audio (listener + panner), xr. Briefs in `docs/briefs/`.
- Shared hot spots and their order at merge: `render/index.ts` and `input/index.ts` (prune removes first; others append), `renderer.ts` (shadows owns the shadow pass and bind layout; cull owns record/sort/cull; xr only `endFrame`'s present flag), `camera.ts` (cull appends `frustum`/`cull`; xr appends `setProjection`/`setViewMatrix`), `core/game.ts` (anchors one line; xr the `xr` option), `scene-target.ts` (xr owns; particles-3d may append a depth getter), `harness/stream.*` (cull and texture-array by function). Merge order: prune, spatial-audio, texture-array, shadows, cull, look, anchors, particles-3d, xr.
- Gate D is defined in STATUS. Invariant unchanged: 2D harness pixel-identical (E-008).

## E-014: wave 4 integration notes (2026-11-05)

- Merged in three batches: `b983019` flake-client, `394e07c` prune, `6c96af8` spatial-audio, `26cc2f8` look; `b95e43c` anchors, `e96a9e8` texture-array; `767228f` particles-3d, `ed4a628` cull. Shadows and xr follow. Main at `ed4a628`: 551 engine tests, e2e 478/52/0.
- `BindingDesc` is internal since prune, so `viewDimension` is documented on `MaterialDesc`/`FullscreenPassDesc`. The texture-array CHANGELOG line still says `BindingDesc`; doc-sweep-3 fixes it.
- Perspective cameras cull by default (`Camera.perspective` sets `cull = true`). The look harness lost two cubes to culling; its spec now asserts `instances + culled`. Any 3D harness that counts instances does the same.
- Soft particles read the previous frame's depth (a copy of `SceneTarget.depth`). Same-frame depth needs a renderer hook after the opaque pass; backlog.
- Process: worktrees start without `node_modules` (`pnpm install --frozen-lockfile --offline`); the hashed e2e port can collide with other services (`E2E_PORT_OFFSET`). Integrators merge in brief order and keep every CHANGELOG/README/ARCHITECTURE entry from both sides.
- Wave 5 starts before wave 4 closes where it can: ws/gltf (new `src/assets`, no render files) branched from `767228f`. template-first-person and doc-sweep-3 wait for shadows and xr.

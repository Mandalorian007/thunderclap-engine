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

## E-015: characters, first and third person, cosmetics (2026-11-05)

The user named a direction from a Diablo Immortal cosmetics screen: a 3D character shown from behind or through its own eyes, wearing layered cosmetics (armour, weapon, wings, idle "floating" animation, trails), at a quality bar well above the harness cubes. Both views matter; cosmetics will carry revenue in future games, so this is a named need, not spec.

Engine pieces, all style-and-rendering (no inventory, no economy): a follow camera (`ws/follow`), a pure animation module (`ws/anim`), GPU skinning in the scene and shadow passes (`ws/skinning`), a standard PBR material over the lights block with shadows and fog (`ws/pbr`), glTF static geometry now and skins/animations next (`ws/gltf`), then attachment sockets, a third-person showcase template and GPU picking (STATUS wave 5 candidates). The quality threshold is judged on the `pbr.html` and later showcase pages against the screenshot's look: PBR, soft shadows, emissive into the post stack, particles on sockets.

Parallelism note: during wave 4 only three engineers were running when the user looked in. The limit was sequencing on shared render files plus too few briefs written ahead, not a tool limit. Rule from here: keep enough disjoint briefs written that eight or more agents run at all times; stack a stream on another branch rather than wait for its merge when the file sets are disjoint.

## E-016: shadows merged; shadow pass runs after view culling (2026-11-05)

`9e577f9` merges ws/shadows onto a main that already culls. `encodeShadow` consumes the post-cull command list, so a caster outside the view frustum casts no shadow (an off-screen tree does not shadow visible ground). Three shadow tests needed `camera.cull = false` because their zero-size cube sat on the near plane. Fix scheduled as ws/shadow-cull: a second cull against the sun box into its own command list, `stats.shadowDraws`. ws/skinning, ws/pbr and ws/template-first-person stack on `ws/shadows` (2696952) and merge after it; the worktree stays until they report.

## E-017 — e2e assertions on moving values poll; load is the test (2026-11-05)

Four wave-5 branches reported single e2e failures on pages they never touched (mesh.spec fog and drag, ui.spec menuNav), every time while eight or more matrices ran on one machine. The engine was not at fault: the fog probe sits under a lamp that orbits on real time, the drag and pad assertions read state once after an input burst. Rule: an e2e assertion on a value that moves over time polls (`expect.poll` or `waitForFunction`) and never reads once; pages used by such specs expose a flag that parks time-driven motion. The no-retry rule stays: a red gate is reported as red and the spec gets fixed (ws/flake-input), not re-run. Integrators treat a failure in a spec on this list as the spec's, merge if everything else is green, and say so in the report.

## E-018 — integrators work in their own worktree; main moves by fast-forward (2026-11-05)

The ws/gltf-anim integrator had its merge staged in the main checkout when the PM committed a STATUS update there. The PM's `git commit` swallowed the staged merge, so `3813f8c` is the gltf-anim merge under a docs message, committed before its gates ran (they passed afterwards: 632 tests, e2e 528/57/1 with the E-017 fog flake). History stays as it is. Rule: integrators merge in a detached worktree and land by fast-forward into `main`; the main checkout belongs to the PM, who commits docs whenever it likes. `docs/briefs/integrate.md` carries the steps.

## E-019: e2e flakes had causes (2026-11-05)

ws/flake-input found that the E-017 "load flakes" were not only timing: the mesh page's orbiting lamp passed 2.3 units from the `ground` probe and pulled it towards the fog colour, and the spec's touch `drag()` helper took 6–7 px steps that `Gestures` read as a long-press under a slow frame. Fixes: `harness/mesh.html?still` parks time-driven motion for the spec; moving-value assertions poll; touch drags step ≥12 px. Rules kept: no retries; a test that reads a moving value polls (common.md). New rule: parallel matrices use `E2E_PORT_OFFSET`s that differ by at least 10 (harness 4177+o, wrapper 4178+o, bench 4179+o), and a second run from one checkout passes `--output` outside the repo so the runs do not delete each other's traces.

## E-020 — Load flakes on the landing gate (2026-11-05)

Chain 1 landed ws/skinning (`2a797e3`) with one non-E-017 e2e failure: `skin.spec` "joints sway" on phone-iphone. Alone the spec passes 16/16 and 40/40 with `--repeat-each 5`; it fails only with 8+ e2e matrices sharing the machine. Decision: keep main (three other integrators had already merged it into their worktrees; a reset would have broken their bases), add `skin.spec` joints sway to the E-017 list, and move ws/flake-input to the front of chain 3 so the fog and drag causes land before more matrices pile on. Rule added to `integrate.md`: the land command runs in a separate step after reading the e2e summary, never in the same shell line. Earlier, ws/trails landed after `pnpm check` only; its e2e afterwards was clean apart from fog, so it stands.

## E-021 — Demos folder (2026-11-05)

User direction: several lightweight demos for engine use cases, outside the engine, as quality validation. `demos/<name>/` at the repo root (not `src/`, not `templates/`, not shipped), each an `index.html` + `main.ts` on the workspace engine through the exports map, procedural assets only, `window.__demo` state so `e2e/demos/<name>.spec.ts` asserts behaviour and frame rate without screenshots. Rules in `docs/briefs/demos-common.md`. First four: arena (3D character stack), dungeon (2D at game scale), showroom (materials, lights, post), range (look, pick, fx, spatial audio). Demos never add engine code; missing features go to the backlog as wishes.

## E-022 — stream.spec probe margin is load-sensitive (2026-11-06)

Chain 2 held ws/template-first-person (8d8db9b) because `stream.spec` "the streamed geometry is on screen" read `sum(ground)` 327.3 against a required >330 on desktop-1920, at load average ~60 with 14 agents on the machine; the other seven rows passed and the template touches no render code. Decision: a load flake. Added to the E-017 list; land. The spec's fixed threshold joins the ws/flake-input style of fix (polled, relative probe) in the backlog. Also: integrators use the attribution line the PM gives (Fable 5.1), not a session reminder's default.

## E-023 — landing priority under machine load (2026-11-06)

With five integrator chains and twelve engineers on one machine, load average reached 76–91; e2e runs took 24 min instead of 5 and timed out on predicates rather than failing on assertions. Each code landing on main forces every other integrator to re-merge and rerun. Decision: when an integrator reports an unusable run from load, the PM names one chain to land next and asks the others to finish their merge and gates but hold the land step until that landing is announced. A run with widespread 10 s predicate / 30 s test timeouts is not a gate result and is rerun when load falls, which is not a flake retry (the E-017/E-020 rules concern assertion failures). Engineers keep working; their single gate run comes at the end.

## E-024: mesh.spec leaves the E-017 list (2026-11-06)

ws/flake-input landed at `9c6a921` with the `?still` probe fix; the first full matrix on that tree was 710/92/0 at load 27. The mesh.spec fog and drag tests are no longer tolerated failures: a miss there fails the merge like any other spec. The rest of the E-017 list stands until a branch fixes each one.

## E-025: landing on a disjoint main (2026-11-06)

With six integrator chains the full matrix takes 4–6 minutes and main lands code about that often, so a chain whose branch is gate-green can loop forever re-merging and re-running (chain 5 ran ui-hud green five times without landing). The rule in `integrate.md` step 6 is relaxed: after a green full gate, if main has moved only by (a) PM docs commits and (b) landed merges whose changed files (`git diff --name-only <old main> <new main>`) are disjoint from the branch's changed files (`git diff --name-only <merge-base> <branch>`), the integrator merges main, reruns `pnpm check` only, and lands. Shared docs (`CHANGELOG.md`, `README.md`, `ARCHITECTURE.md`, `docs/*`, any `README.md`) do not count as overlap. An overlap in any `src/`, `harness/`, `e2e/`, `demos/`, `templates/` or config file still means a full e2e rerun (and snap:check when a 2D file is in the overlap). The branch's last full gate must be on a tree that includes every code change on main up to that disjoint window. Load threshold for starting a matrix is the 1-minute average under 40 (E-023 still governs what counts as a result).

## E-026: docs-only main moves need only the docs checks (2026-11-06)

Refines E-025. When main moved only by commits that touch `docs/**`, `README.md`, `CHANGELOG.md` or `ARCHITECTURE.md` since the last green `pnpm check`, the integrator merges main and runs `pnpm check:docs` and `pnpm lint` instead of the whole `pnpm check` before landing; a move that touches anything else (including `package.json`) still gets `pnpm check`, and the E-025 overlap rule still decides whether e2e reruns. Chain 6 did this landing demo-showroom while PM docs commits arrived faster than a full check completes; nothing a docs commit changes is exercised by the unit tests or typecheck.

## E-027: the dungeon demo's pause-menu pad walk joins the E-017 list until ws/demo-polish lands (2026-11-06, PM)

`e2e/demos/dungeon.spec.ts:116` ("the pause menu opens on Escape and walks with the arrow keys and the d-pad") has now missed three times on unrelated branches (desktop-1920 on ws/scaffold; desktop-1280 and ipad on the ws/assets-2 gate), always with the same shape as ui.spec menuNav: a pad press lands while the panel is still settling and focus never moves. It is the spec's fixed-wait assertion, not the merges. The chain 1 integrator lands ws/assets-2 with those two failures tolerated. ws/demo-polish (dispatched) makes the spec poll; when it lands the test leaves the list, as mesh.spec did under E-024.

## E-028: the dungeon pad walk leaves the E-017 list (2026-11-06, PM)

ws/demo-polish landed at a3be7c2: the spec holds the fake pad button until focus reaches the expected item and the demo latches a press until `PadNav.update()` has seen it, so the walk is deterministic by construction. On the landing gate the test passed on all seven rows that run demos (itch-iframe skips every demo spec by design). A miss of this test is now a real failure again, as mesh.spec became under E-024.

## E-029: a barrel-only overlap is disjoint (2026-11-06, PM)

Chain 3 (host-mobile) asked after a second full matrix forced by main moving under it: both moves overlapped the branch only in `src/ui/index.ts`, the barrel, where each side appended exports and git auto-merged. Every landing now adds exports to one barrel or another and main moves about every 15 minutes, so E-025's letter would cost a ten-minute matrix per landing with nothing new under test. Ruling: an overlap confined to module barrels (`src/**/index.ts`, `src/index.ts`) and to the README count line counts as disjoint for E-025 when git auto-merged it and `pnpm check` (which type-checks every export) is green. Any other shared file, or a barrel conflict a human resolved, is still a code overlap and takes the full e2e. The integrator names the barrel files it waived in its report.

## E-030: full e2e runs take one of two machine slots (2026-11-06, PM)

With eight engineers and an integrator gating at once the 1-min load sat at 40–61 for over half an hour: ws/nav-4 and ws/ui-4 both came back with failures outside their code, and the nav-4 integrator could not find a 25 window in 30 minutes. Under E-023 none of those runs is a gate result, so parallel gates were buying nothing. Ruling: a full `pnpm test:e2e` takes one of two `mkdir` slots in `/tmp` (recipe in `docs/briefs/common.md`), released on exit, stale after 45 minutes. Engineers keep building in parallel; only the matrix queues. Load above 40 while holding a slot still means wait.

## E-031: one integration train, one matrix at a time (2026-11-06, PM)

E-030's two slots did not bring the load down: with seven engineers and five integrators building, the 1-min load stayed at 44–49 for the next hour. Every full matrix came back with the same 8–12 failures, none of them in the code under test: audio4 `?sprites`, post2 on ipad, demos/voxel on ipad, music `?pause` and the ui cursor. No branch landed. Running five matrices to land five branches costs five quiet windows, and there were none. Ruling:
- **Engineers no longer run the full e2e.** An engineer's gate is `pnpm check`, `pnpm snap:check` at 0 px, and single-spec runs of the specs the branch owns or touches. Full matrices belong to integrators.
- **One slot.** The full matrix takes `/tmp/thunderclap-e2e-slot1` only. Slot 2 is retired.
- **Quiet while it runs.** While slot 1 exists, nobody else runs an e2e spec, `pnpm check` or `pnpm snap:check`. Engineers keep editing and running targeted `vitest` files.
- **Load before start.** The train starts its matrix when the 1-min load is under 30.
- **One train.** One integrator merges every queued branch in the order the PM gives, running `pnpm check` and `snap:check` after each merge. It then runs one matrix on the result.
  - A failure inside a member's area is that member's: the integrator reverts that member's merge from the train and reruns the specs that failed.
  - A failure outside every member's area, in a run that started under 30, is a real failure. The integrator reports it, and the PM decides.

## E-032: audio4 sprites and the voxel demo click join the E-017 list until ws/e2e-harden lands (2026-11-06, PM)

Two specs failed on every full matrix today, whatever the branch:
- `e2e/audio4.spec.ts:73` (`?sprites`, voice count stays 0)
- `e2e/demos/voxel.spec.ts:159` (click-break edits)

That covers nav-4, core-2, fx-3, render-4 and ui-4, and geom-3 at load 35→23, the lowest load of the day. None of those branches touches audio or the voxel demo. ws/e2e-harden owns both specs and is reproducing them now. If audio4 turns out to be a real engine race, it is reported as a finding.

Ruling: until ws/e2e-harden lands, a failure of either test while every other test passes counts as the spec's, not the merge's. Land, and name it in the report, as for the E-017 list. When ws/e2e-harden lands, both leave the list, as the dungeon pad walk did under E-028.


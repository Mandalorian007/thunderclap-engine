# Status: thunderclap-engine

The PM keeps this current. Workstreams run on `ws/<name>` branches in their own worktrees and merge to `main` when green (E-001).

## Waves

| Wave | Workstream | Branch | Scope | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | One overlay | ws/one-overlay | Port last-rune's `ws/one-overlay`: `ctx.ui` in CSS px on every form factor; delete `legacyScale`, `createCssChrome`, `avoid()`, `ctx.chrome` (D-044 Phase 3 entry condition) | — | ✅ merged `a15652b` (357 tests; e2e 283 passed / 31 skipped) |
| 1 | Camera | ws/camera | Matrix `Camera`, `mat4`, camera uniform block, `ortho2d`, `perspective`, `fitRect`, `worldToScreen`/`screenToWorld` | — | ✅ merged `a5d95a7` (381 tests, e2e 283/31; byte-identical PNGs main vs branch) |
| 1 | Transforms | ws/transforms | `Transform`, 28-float instance (3×4 matrix), `layers` mask + sort `order`, vertex layout per `Mesh`, depth-sorted lists | — | ✅ merged `e340ed7` (414 tests, e2e 299/31; depth sort = view-space depth, E-009) |
| 1 | Electron host | ws/host-electron | Bring `@thunderclap/host-electron` from last-rune into `packages/host-electron`; repo becomes a pnpm workspace with the engine at the root | — | ✅ merged `dae37e8` (24 unit tests, Electron smoke 5/5; desktop CI job unverified on runners) |
| 1 | Analytics | ws/analytics | `@thunderclap/engine/analytics`: typed events, pluggable sink, lifecycle flush (E-002) | — | ✅ merged `0eb151e` (356 engine tests) |
| 1 | Foundation | ws/foundation | `scripts/check-boundaries.mjs` + `pnpm check:boundaries`; e2e in CI; stale `packages/`/`check-boundaries` refs; README links VISION | — | ✅ merged (24 relative `../src` imports in harness/e2e/examples rewritten to the public map; `scripts/release.mjs`) |
| 2 | Render call | ws/render-call | `Renderer.render(frame, camera, target)`; `Host.requestFrame`; `GameLoop` takes its frame source from the host; deletes `device`/`setFill`/fill bands for `layout.freeRect` + `Camera.fitRect` (E-006); widens `ortho2d` depth range, drawable `depthStencil`, `ctx.pointers` wiring (E-009) | camera, transforms, one-overlay | ✅ merged `2b89c82` (466 tests, e2e 366/36; E-010) |
| 2 | Demo mesh | ws/demo-mesh | `?demo=mesh` harness page: perspective camera, depth, lit mesh, orbit by pointer and pad; e2e on the matrix | camera, transforms | ✅ merged `2b1032e` (454 tests, e2e 366/36; `harness/mesh.html`, 4 e2e tests) |
| 2 | Input rays | ws/input-rays | Pointer router (mouse, touch, pen, pad cursor → rays), `Hit` events, `{ xr }` binding kinds | camera | ✅ merged `cd27ff1` (454 tests, e2e 339/31; `ctx.pointers` wiring → render-call) |
| 2 | Client mode | ws/client-mode | `createGame` with opt-in fixed-step sim and save store, for server-authoritative clients | one-overlay | ✅ merged `ccdf598` (385 tests, e2e 299/31) |
| 2 | Puzzle template | ws/template-puzzle | `templates/puzzle`: `createGame`, a scene, `rules/`, save schema, layout spec, `CLAUDE.md` naming the engine concepts | camera, transforms, client-mode | ✅ merged `a266b04` (14 template tests; 17 min empty→green) |
| 3 | Lighting block | ws/lights | `EngineLights` uniform at `@group(0) @binding(2)`: ambient, one directional, N point lights (position, colour, radius), read by game WGSL through `materialPrelude`; harness mesh page lit by it; Last Rune candles and Forgewilds sun are the named needs | render-call | ✅ merged `af36d1c` (472 tests, e2e 390/36) |
| 3 | Dynamic meshes | ws/mesh-stream | `Mesh` with updatable vertex/index ranges and a capacity, fed from a Worker-built `ArrayBuffer` without a copy on the main thread; a harness page streaming chunk-like meshes; Forgewilds chunk meshes are the named need | transforms | ✅ merged `bde5299` (480 tests, e2e 406/36; renderer skips `indexCount === 0`) |
| 3 | Two views | ws/two-views | `render(frame, camera, target)` called twice per frame into two viewports of one surface (`view_index` 0/1); harness page; proves the stereo seam without WebXR (ARCHITECTURE: XR after Gate 5) | render-call | ✅ merged `749b992` (468 tests; `Camera.viewIndex`) |
| 3 | Game plumbing | ws/plumbing | `createGame` wires gestures and pointers; `layout.freeRect` → design px helper for `Camera.fitRect`; `Gestures.pan` ignores multi-pointer; template `sendBeacon` sink + `level_start`/`level_complete`; layout README rows note; delete `Surface.setFill`/`computeFillWidth`; `Scene.render(frame, camera, alpha)` (E-010) | render-call, template-puzzle | ✅ merged `8f3cb9d` (465 engine, 17 template; e2e 390/36) |
| 3 | e2e determinism | ws/flake-gestures | `gestures.spec` tap/pan timing; `touch` flag read before `open()` in mesh and gestures specs (E-011) | — | ✅ merged `7c528e2` (e2e 390/36; skip count stable at 36 across four runs) |
| 4 | Doc sweep 2 | ws/doc-sweep-2 | 132 undocumented exports in core/input/render/testing READMEs; ARCHITECTURE principle 4 reword, stale *Planned* lines; chain `check:docs` into `check` | wave 3 | ✅ merged `1ebca03` (134 names documented; `check:docs` in `check`) |
| 4 | Prune | ws/prune | Leaked internals from the doc-sweep-2 list un-exported or kept with a reason; `mesh.ts` doc comment fixed; harness reads depth state without `renderer.camera` | doc-sweep-2 | ✅ green at `9e56a36` (check green; e2e 405/36/1, the failure is client.spec's race → ws/flake-client); awaiting merge |
| 4 | e2e client race | ws/flake-client | client spec waits for the condition it asserts (poll `updates > 0`, or the fixture waits for one update), no other spec reads a loop counter once without polling; matrix green | — | 🔧 in progress |
| 4 | Shadows + fog | ws/shadows | Sun shadow map rendered by the engine and sampled through `engine_shadow(world_pos)`; `engine_fog(color, world_pos)` with distance fog from the block; mesh page shows both; 2D harness pixel-identical | lights | 🔧 in progress |
| 4 | Frustum cull | ws/cull | `Mesh.bounds`, per-draw frustum cull against the camera's six planes, `renderer.stats.culled`, stream page culls and the e2e asserts it; 2D harness pixel-identical | mesh-stream | 🔧 in progress |
| 4 | Look controls | ws/look | `Look` linked through `input.setLook` reports `look`/`move` from pointer lock, touch zones and sticks; pointer lock requested and released through it; harness `look.html` on the matrix | plumbing | 🔧 in progress |
| 4 | World anchors | ws/anchors | `overlay.anchors` places DOM nodes at world points through a camera each frame with clamping, occlusion-by-frustum and optional distance scale; harness `anchors.html` on the matrix | two-views | 🔧 in progress |
| 4 | 3D particles | ws/particles-3d | `ParticleSystem` in world space with camera billboarding, depth, soft fade and lit/emissive modes; `EmitParams` gains 3D position, velocity, gravity, wind; weather page on the matrix; 2D particles pixel-identical | lights | 🔧 in progress |
| 4 | Texture arrays | ws/texture-array | `createTextureArray`/`loadTextureArray` with GPU mip generation, `Texture.mipLevels`, a sampler kind for it, stream page textures its chunks; documented | mesh-stream | 🔧 in progress |
| 4 | Spatial audio | ws/spatial-audio | `audio.listener` (position, orientation) and `PlayOptions.at` / `Voice.setPosition` through a `PannerNode` per spatial voice, with a 2D stereo-pan shorthand; unit tests on a fake `AudioContext`; documented | — | 🔧 in progress |
| 4 | WebXR | ws/xr | `createXrHost(session)` as a `FrameSource`; `XrSurface` giving a `SceneTarget` per eye per frame; per-eye `Camera`s from `XRView`; `XrPointerSource` for controllers/hands; `createGame({ xr })` + `ctx.xr.enter()/exit()`; unit tests on a fake XR system; harness `xr.html` boots on the matrix | two-views, input-rays | 🔧 in progress |
| 3 | Doc sweep | ws/doc-sweep | ARCHITECTURE *Planned* lines that are now *Today*; module READMEs vs code; root README table; CHANGELOG grouping; superseded plans to `docs/archive/` | render-call | ✅ merged `7b1c054` (`check:docs` added, 132 names left for sweep 2) |

## Gates

- **Gate A (after wave 1), met 2026-11-05 at `e340ed7`:** `pnpm check` and the e2e matrix green on `main`; 2D harness pages pixel-identical before and after camera + transforms; `ARCHITECTURE.md` *Today* text matches the code.
- **Gate C (after wave 3), met 2026-11-05, closed at `1ebca03`:** mesh page lit by the lighting block (`af36d1c`); streamed mesh updates without a main-thread copy (`bde5299`); two views per frame (`749b992`); template boots with gestures and pointers from `createGame` (`8f3cb9d`). ARCHITECTURE *Planned* lines current and principle 4 reworded (`1ebca03`).
- **Gate B (after wave 2):** mesh demo met at `2b1032e`; template timed at 17 min (`a266b04`); client mode met at `1b09225`. Gate B met at `2b89c82` (E-010). `?demo=mesh` runs on the matrix; a template game boots from zero in under a day of agent time (timed); client mode runs the harness without a save store.

- **Gate D (after wave 4):** mesh page shadowed and fogged; stream page culls and samples a texture array; look, anchors, weather and xr pages boot on the matrix; spatial voices tested; every XR *Planned* line in ARCHITECTURE is *Today*; 2D harness pixel-identical throughout.

## Wave 5 candidates (after wave 4 merges)

- `templates/first-person`: a copyable 3D game on look controls, culled chunk meshes, shadows, anchors and weather (stacks on wave 4).
- Doc sweep 3; a Last Rune and Forgewilds "what the engine now offers" note for their PMs.
- Post stack per eye in XR; spot lights and per-light layer masks; glTF loader (secondary per VISION).

## Backlog (from engineer reports, unscheduled)

- Scheduled in ws/prune (wave 4): depth-state read in the harness; export pruning: doc-sweep-2 flagged exports that look like leaked internals (render: `BindingSet`/`BindingDesc`/`BindingSetOptions`, `blendState`, `createSamplers`, `CAMERA_BLOCK_FLOATS`, `MATRIX3X4_FLOATS`, `multiplyMatrix3x4`, `writeMatrix2d`, `WGSL_MATERIAL_PRELUDE`, `INSTANCE_BUFFER_LAYOUT`, `DepthMode`, `GpuTimer`; input: `PointerActions`, `createSample`, `loupeSpot`, `loupeClear`, `magnifySize`). An engineer decides per name; `materialPrelude` stays public.
- `src/render/mesh.ts` doc comment (~L149) still says an empty indexed mesh "falls back" to a non-indexed draw; the renderer skips it.

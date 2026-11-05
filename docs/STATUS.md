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
| 3 | Doc sweep | ws/doc-sweep | ARCHITECTURE *Planned* lines that are now *Today*; module READMEs vs code; root README table; CHANGELOG grouping; superseded plans to `docs/archive/` | render-call | ✅ merged `7b1c054` (`check:docs` added, 132 names left for sweep 2) |

## Gates

- **Gate A (after wave 1), met 2026-11-05 at `e340ed7`:** `pnpm check` and the e2e matrix green on `main`; 2D harness pages pixel-identical before and after camera + transforms; `ARCHITECTURE.md` *Today* text matches the code.
- **Gate C (after wave 3), met 2026-11-05, closed at `1ebca03`:** mesh page lit by the lighting block (`af36d1c`); streamed mesh updates without a main-thread copy (`bde5299`); two views per frame (`749b992`); template boots with gestures and pointers from `createGame` (`8f3cb9d`). ARCHITECTURE *Planned* lines current and principle 4 reworded (`1ebca03`).
- **Gate B (after wave 2):** mesh demo met at `2b1032e`; template timed at 17 min (`a266b04`); client mode met at `1b09225`. Gate B met at `2b89c82` (E-010). `?demo=mesh` runs on the matrix; a template game boots from zero in under a day of agent time (timed); client mode runs the harness without a save store.

## Backlog (from engineer reports, unscheduled)

- `Gestures.pan` that ignores multi-pointer input so pinch does not also pan (demo-mesh).
- `createGame` wires gestures as it will pointers; a CSS-px → design-px helper for fitting a camera to `layout.freeRect` (template-puzzle). Layout README: `top`/`bottom` regions are rows (template-puzzle).
- Read a camera's depth state in the harness without going through `renderer.camera` (demo-mesh; may fall out of `render(frame, camera, target)`).
- Export pruning: doc-sweep-2 flagged exports that look like leaked internals (render: `BindingSet`/`BindingDesc`/`BindingSetOptions`, `blendState`, `createSamplers`, `CAMERA_BLOCK_FLOATS`, `MATRIX3X4_FLOATS`, `multiplyMatrix3x4`, `writeMatrix2d`, `WGSL_MATERIAL_PRELUDE`, `INSTANCE_BUFFER_LAYOUT`, `DepthMode`, `GpuTimer`; input: `PointerActions`, `createSample`, `loupeSpot`, `loupeClear`, `magnifySize`). An engineer decides per name; `materialPrelude` stays public.
- `src/render/mesh.ts` doc comment (~L149) still says an empty indexed mesh "falls back" to a non-indexed draw; the renderer skips it.

# Brief: ws/prune

Read `docs/briefs/common.md` first, then DECISIONS E-012, E-013; STATUS *Backlog*; `src/render/README.md`, `src/input/README.md`; `scripts/check-docs.mjs`.

## Goal

The public surface of `render` and `input` is what a game needs and nothing a game should not reach for; the two small backlog items from wave 3 are closed.

STATUS row, *done when*: leaked internals from the doc-sweep-2 list un-exported or kept with a reason; `mesh.ts` doc comment fixed; harness reads depth state without `renderer.camera`.

## Scope

1. **Export pruning.** For each name in the STATUS backlog list (render: `BindingSet`/`BindingDesc`/`BindingSetOptions`, `blendState`, `createSamplers`, `CAMERA_BLOCK_FLOATS`, `MATRIX3X4_FLOATS`, `multiplyMatrix3x4`, `writeMatrix2d`, `WGSL_MATERIAL_PRELUDE`, `INSTANCE_BUFFER_LAYOUT`, `DepthMode`, `GpuTimer`; input: `PointerActions`, `createSample`, `loupeSpot`, `loupeClear`, `magnifySize`) decide: a game or a drawable author plausibly needs it → keep and make sure its README line says when; otherwise remove it from the module `index.ts` and its README line. `grep` the harness, e2e, examples and templates before removing: anything they import stays (or they switch to the public path if one exists). `materialPrelude` and `WGSL_LIGHTS` stay public. List every removal in `CHANGELOG.md` under a "Removed" heading.
2. **`src/render/mesh.ts`** doc comment near L149 says an empty indexed mesh "falls back" to a non-indexed draw; the renderer skips it. Fix the comment.
3. **Depth state in the harness.** `harness/mesh.ts` (or whichever page) reads the camera's depth flags through `renderer.camera`; expose what the test needs on the page's state object from the camera the page owns instead. No `src/` change should be needed; if it is, say so and stop at the comment.

## Files owned

`src/render/index.ts`, `src/input/index.ts`, `src/render/README.md`, `src/input/README.md`, `src/render/mesh.ts` (comments only), `harness/mesh.ts`, `harness/mesh-state.ts`, `e2e/mesh.spec.ts` (the depth assertion only), `CHANGELOG.md` (Removed section).

Running alongside, all in `src/`: ws/shadows (material.ts, lights.ts, wgsl.ts, shadow.ts, renderer.ts shadow pass; also `harness/mesh.ts` for a shadow toggle: coordinate by keeping your edit to the state object and the depth read, nothing else in that file), ws/cull (frame.ts, camera.ts frustum, renderer.ts cull), ws/texture-array (texture.ts, `render/index.ts` additions), ws/look and ws/xr (`input/index.ts` additions). You are merged first; others append to `index.ts`, you only remove lines.

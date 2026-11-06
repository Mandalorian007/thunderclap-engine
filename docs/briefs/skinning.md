# Brief: ws/skinning

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `ARCHITECTURE.md` *Transforms*, *Materials*, *Lighting*; `src/render/README.md` (vertex layouts, materials, bindings, textures, shadows once ws/shadows is in); `src/render/mesh.ts` (`VertexLayout`, `VERTEX_LAYOUT_3D`), `src/render/bindings.ts` (`BindingDesc`: what a material can bind today), `src/render/material.ts`, `src/render/wgsl.ts` (`materialPrelude(layout)`), `src/render/shadow.ts` and the shadow pass in `renderer.ts` on the `ws/shadows` branch (you stack on it), `docs/briefs/anim.md` (the joint-matrix layout you consume: 12 floats per joint, 3×4 rows).

## Goal

Skinned meshes: a vertex layout with joints and weights, a per-instance joint palette the vertex shader reads, in both the scene pass and the sun shadow pass. Characters and their cosmetics deform on the GPU (E-015).

STATUS row, *done when*: `VERTEX_LAYOUT_SKINNED` (3D layout + joints `uint8x4` + weights `unorm8x4`), `SkinPalette` (joint matrices for N instances uploaded once per frame without allocation), `WGSL_SKIN` vertex helper used by `materialPrelude` when the layout is skinned, shadow pass skins too, harness `skin.html` on the matrix with a procedural tube rigged to three joints waving; documented.

## Scope

- `mesh.ts` (append): `VERTEX_SKINNED_FLOATS`, `VERTEX_LAYOUT_SKINNED`, buffer layout; `Mesh` accepts it like the others.
- `src/render/skin.ts`: `SkinPalette(device, { joints, instances })` holding a storage buffer (if `BindingDesc` can bind a buffer; if it cannot, add buffer slots to `bindings.ts` as an append: `buffers?: GPUBuffer[]` with `storage` read-only visibility in the vertex stage, and name the lines) of `instances × joints` 3×4 matrices; `palette.set(instance, matrices: Float32Array)`, `palette.flush()` once per frame; the instance's palette index travels in an existing per-instance float (the 28-float instance has `misc`; pick a free component and document it; ws/shadows uses `misc.y` for flags: do not reuse it).
- `wgsl.ts`: `materialPrelude(VERTEX_LAYOUT_SKINNED)` emits `@location` inputs for joints/weights, the palette binding and a `engine_skin(position, normal) ` that applies the four weighted joint matrices before the model matrix. Keep the 2D prelude text byte-identical (the particles test hashes shader text; E-008).
- Shadow pass: `ShadowMap.pipelineFor(layout)` (ws/shadows) builds from the prelude `vs_main`, so a skinned layout should skin in the shadow pass through the same prelude. Verify with a fake-GPU test that a skinned caster's shadow pipeline binds the palette.
- Harness `skin.html` + `skin.ts` + `skin-state.ts`: procedural tube (24 rings, 3 joints with linear weights), joints animated in the page with a hand-written sine (do not import `src/anim`, it is being written alongside: duplicate ten lines), lit, shadowed if `sun.shadow` is on main by then; state exposes a probe at the tube tip that moves. `e2e/skin.spec.ts`: boots; tip probe colour changes between two frames one second apart.
- Tests: layout strides, palette write offsets, prelude emits the helper for skinned and not for 3D/2D, shadow pipeline binding.
- Docs: render README *Skinning* section incl. the 12-float joint layout shared with `anim`; ARCHITECTURE *Transforms* one sentence; CHANGELOG.

## Files owned

`src/render/skin.ts`, `src/render/skin.test.ts`, `src/render/mesh.ts` (append), `src/render/bindings.ts` (append, if needed), `src/render/wgsl.ts` (`materialPrelude` branch for the skinned layout; nothing else), `src/render/index.ts` (append), `src/render/README.md` (one section), `harness/skin.*`, root `README.md` (harness list item), `e2e/skin.spec.ts`, `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`.

Not yours: `renderer.ts`, `material.ts`, `shadow.ts`, `lights.ts`, `frame.ts`. If the renderer must bind the palette per draw rather than per material, write the exact change in your report instead of making it, and ship the per-material binding (one palette per material) as the working version.

Stack on `ws/shadows` (head `2696952`): `git reset --hard ws/shadows` then `git checkout -b ws/skinning`. Running alongside: ws/pbr (also on ws/shadows; owns `standard.ts`, `pbr-wgsl.ts`, `harness/pbr.*`), ws/anim, ws/gltf, ws/follow, ws/xr, ws/template-first-person.

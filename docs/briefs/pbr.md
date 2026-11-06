# Brief: ws/pbr

Read `docs/briefs/common.md` first, then `docs/VISION.md` pillar 4, DECISIONS E-013, E-015; `ARCHITECTURE.md` *Materials*, *Lighting*, *Post*; `src/render/README.md` (Materials, Lighting incl. shadows and fog on `ws/shadows`, Textures, texture arrays, mipmaps), `src/render/material.ts`, `src/render/wgsl.ts` (`WGSL_LIGHTS`, `materialPrelude`, `engine_lambert`, `engine_shadow`, `engine_fog`), `src/render/lights.ts`, `src/post/README.md` (HDR and tone mapping: what exists), `harness/mesh.ts`.

## Goal

A standard physically based material a game uses without writing WGSL: base colour, metallic-roughness, normal, occlusion and emissive maps, GGX specular, the engine's sun + point lights, shadows and fog, emissive into the HDR target. The quality bar for characters and cosmetics (E-015) starts here.

STATUS row, *done when*: `createStandardMaterial(renderer, desc)` with `StandardMaterialDesc { baseColor?: Texture; baseColorFactor?; metallicRoughness?: Texture; metallic?; roughness?; normal?: Texture; normalScale?; occlusion?: Texture; emissive?: Texture; emissiveFactor?; alphaMode?: 'opaque' | 'mask' | 'blend'; alphaCutoff?; doubleSided? }` and per-instance tint; `WGSL_PBR` helpers (`engine_pbr(...)`) exported for custom shaders; harness `pbr.html` renders a metal/rough sphere grid and a normal-mapped tile on the matrix; documented.

## Scope

- `src/render/pbr-wgsl.ts`: `WGSL_PBR` (GGX NDF, Smith-GGX visibility, Schlick Fresnel, Lambert diffuse, `engine_pbr(base, metallic, roughness, N, V, world_pos, ao, emissive) -> vec3f` over the sun (× `engine_shadow`) and point lights from `EngineLights`, then `engine_fog`). Tangent frame from screen-space derivatives (`dpdx`/`dpdy`) so meshes need no tangents; if `VERTEX_LAYOUT_3D` has no tangent slot say so and keep derivatives.
- `src/render/standard.ts`: `createStandardMaterial(renderer, desc): Material` built on `createMaterial` with a packed factor uniform (if `BindingDesc` can bind a uniform; else encode factors into a 1×1 texture row and document it), the five texture slots with sensible 1×1 defaults (white, white, flat normal, white, black) so any subset works, `viewDimension` 2D, mips sampled through `'linear-mip-repeat'`. Alpha mask through `discard`; blend through the renderer's blended path.
- Harness `pbr.html` + `pbr.ts` + `pbr-state.ts`: 5×5 spheres (metallic across, roughness down), one normal-mapped tile from a procedural height map, orbit camera as `mesh.html`, sun with shadow + fog if on main; state probes: a rough dielectric sphere centre vs a smooth metal sphere highlight, tile lit side vs unlit. `e2e/pbr.spec.ts`: boots on the matrix; the highlight probe is brighter than the rough probe; the normal-mapped tile shows a luminance difference across the bump.
- Tests: shader text compiles on the fake GPU; default textures created once; factor packing.
- Docs: render README *Standard material* section; ARCHITECTURE *Materials* one sentence; CHANGELOG.

## Files owned

`src/render/pbr-wgsl.ts`, `src/render/standard.ts`, `src/render/standard.test.ts`, `src/render/index.ts` (append), `src/render/README.md` (one section), `harness/pbr.*`, root `README.md` (harness list item), `e2e/pbr.spec.ts`, `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`. Nothing in `wgsl.ts`, `material.ts`, `bindings.ts`, `renderer.ts`, `lights.ts`. If `BindingDesc` lacks a uniform slot, report the exact append you want in `bindings.ts` and ship the texture-row workaround.

Stack on `ws/shadows` (head `2696952`): `git reset --hard ws/shadows` then `git checkout -b ws/pbr`. Running alongside: ws/skinning (also on ws/shadows; owns `skin.ts`, `mesh.ts` append, a `wgsl.ts` prelude branch), ws/gltf (will adopt your material for glTF PBR later), ws/anim, ws/follow, ws/xr, ws/template-first-person.

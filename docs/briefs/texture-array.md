# Brief: ws/texture-array

Read `docs/briefs/common.md` first, then `docs/VISION.md` (pillar 3; Forgewilds: chunk meshes; a block atlas is the named need), DECISIONS E-013; `ARCHITECTURE.md` *Materials*/*Renderer*; `src/render/README.md`; `src/render/texture.ts`, `src/render/bindings.ts`, `src/render/material.ts` (how a material binds textures: read only), `harness/stream.ts`.

## Goal

A voxel or tile game binds one `texture_2d_array` of block faces with mipmaps and samples it by layer index, instead of an atlas with bleeding edges. Loading from images, mip generation on the GPU, and a material that uses it.

STATUS row, *done when*: `createTextureArray`/`loadTextureArray` with GPU mip generation, `Texture.mipLevels`, a sampler kind for it, stream page textures its chunks; documented.

## Scope

1. **Arrays.** `TextureDesc.layers?: number` → `GPUTextureViewDimension '2d-array'`; `Texture.layers`, `Texture.mipLevels`. `loadTextureArray(device, sources: TextureSource[], opts?: { mips?: boolean; format?; label? })` uploads each source to a layer (all sources must share a size; throw otherwise) via `copyExternalImageToTexture` (images) or `writeTexture` (pixel data).
2. **Mipmaps.** `render/mipmap.ts`: a `generateMipmaps(device, texture)` that renders each level from the previous with a tiny blit pipeline (one per format, cached per device; nearest-or-linear by a flag) and handles arrays by layer. Also applied to 2D textures when `mips: true`. Add `SamplerKind` entries `'linear-mip-repeat'` and `'nearest-mip-clamp'` (mipmap filter linear).
3. **Material use.** No change to `material.ts` (ws/shadows owns it): verify a material can declare a `texture_2d_array<f32>` binding through today's `BindingDesc`; if the binding path assumes `texture_2d`, add the `viewDimension` option in `bindings.ts` (which you own) and name it.
4. **Harness.** `harness/stream.ts` samples a 4-layer procedurally generated array (generated pixel data, no asset files) by a per-vertex layer index stored in the 3D layout's `uv.z`-equivalent: the 3D layout has `uv` only, so pack the layer in the vertex colour's alpha and document that convention for games. `e2e/stream.spec.ts`: one assertion that two chunk faces show two different layer colours.

## Files owned

`src/render/texture.ts`, `src/render/mipmap.ts` (new), `src/render/mipmap.test.ts`, `src/render/texture.test.ts` (new), `src/render/bindings.ts`, `src/render/index.ts` (append), `src/render/README.md` (Textures section), `harness/stream.ts` (texturing only; ws/cull edits the same file for bounds and culled stats: keep to your own functions and name them), `harness/stream-worker.ts` (vertex colour alpha only), `e2e/stream.spec.ts` (append one test), `ARCHITECTURE.md` (one sentence in the materials paragraph), `CHANGELOG.md`.

Running alongside: ws/cull (bounds in `stream.ts`/`stream-worker.ts`, `renderer.ts`, `mesh.ts`), ws/shadows (`material.ts`, `wgsl.ts`), ws/prune (removes `createSamplers` from `render/index.ts` if it decides so; if you need it public, say so in your report rather than fighting the removal).

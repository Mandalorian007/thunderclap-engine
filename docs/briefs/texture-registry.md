# Brief: ws/texture-registry

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `src/render/texture.ts` whole (`Texture`, `TextureDesc.mips`, `mipLevelCount`, `SamplerKind`, `createSamplers`, `TextureSource`, `PixelSource`, `loadTextureArray` with its `mips` default), `src/render/mipmap.ts` (`generateMipmaps`, `MipFilter`), `src/render/bindings.ts` (texture slots, what a material binds when a slot is unset), `src/render/README.md` *Textures* and *Materials*, ws/pbr's report in STATUS (`STANDARD_TEXTURE_SLOTS`: albedo, normal, metal-rough, emissive; its wish for default textures and a mip sampler), `harness/mesh.ts`.

## Goal

A material with four texture slots should work with none of them set. A single 2D texture loaded from an image should get mips the way texture arrays do. Both are plumbing the PBR material now needs and every game would otherwise write.

STATUS row, *done when*: `loadTexture(device, source: TextureLayerSource, opts?: { mips?: boolean (default true); format?; filter?: MipFilter; label? }): Texture` (one call: create, write level 0, `generateMipmaps`), `defaultTextures(device): DefaultTextures` cached per device (WeakMap) with `white` (1×1 255), `black`, `flatNormal` (128,128,255), `metalRough` (0 metal, 1 rough: whatever ws/pbr's channel convention is; read its WGSL), `checker` (8×8 two-tone, for "texture missing" visibility), each a `Texture`; `BindingSet` fills unset texture slots with `defaultTextures(device).white` instead of throwing or leaving the binding dangling (or whatever it does today; name the change); `Texture.destroy()` if missing; documented; tested on the fake GPU.

## Scope

- `texture.ts`: `loadTexture`, `defaultTextures`, `DefaultTextures` type; `PixelSource` accepted so tests need no `ImageBitmap`. Mips use `generateMipmaps` with `filter` default `'linear'`; a non-power-of-two source still gets `mipLevelCount` levels (the generator handles odd sizes; verify with a 5×3 fake).
- `bindings.ts`: unset slots resolve to `white` at bind-group build time; a slot set later still rebuilds the bind group as today. Keep the 2D path pixel-identical (sprites set their one slot; nothing changes for them). If `bindings.ts` is too entangled with ws/skinning's `buffers` addition (its `BUFFER_BINDING_BASE` 16 lands in chain 1), do the default fill in the one place where the layout is built and keep the diff to that function.
- Tests `texture.test.ts`, `bindings.test.ts`: `loadTexture` creates the right level count and calls the generator; defaults are cached per device and have the documented bytes; unset slot binds `white`.
- Harness: `harness/mesh.ts` gains nothing; instead add one case to `harness/pbr.ts` only if ws/pbr has landed on main when you start (check `git log main -- harness/pbr.ts`); otherwise skip the harness and say so. No new e2e spec.
- Docs: render README *Textures* (`loadTexture`, defaults, which slot gets which default), CHANGELOG.

## Files owned

`src/render/texture.ts`, `src/render/texture.test.ts`, `src/render/bindings.ts` (default-fill only), `src/render/bindings.test.ts`, `src/render/index.ts` (append), `src/render/README.md` (*Textures*), `CHANGELOG.md`.

Branch from `main` (b9ec1c0 or later). Running alongside: chain 1 landing pbr (`material.ts`, `wgsl.ts`), skinning (`bindings.ts` `buffers`: expect a conflict in the same file, keep both) and spot-lights (`lights.ts`, `renderer.ts`); ws/sky (`src/fx`), ws/bench, ws/pick, ws/sockets, ws/flake-input. Do not touch `material.ts`, `wgsl.ts`, `renderer.ts`.

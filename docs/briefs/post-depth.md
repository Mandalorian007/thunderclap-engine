# Brief: ws/post-depth

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `src/post/README.md` whole; `src/post/post-stack.ts` (`PostStack.encode`, `bindInputs`, pass order, intermediate textures, `resize`), `src/post/shaders.ts`, `src/post/settings.ts` (`PostSettings`, defaults, the blend/ease path in `blend.ts` and what it does with booleans), `src/post/quality.ts`, `src/render/renderer.ts` (`PostInputs`, where `post.encode` is called, `SceneTarget.depth` and how `fx/particles.ts` samples it: `scene-target.ts`), `src/render/camera.ts` (`proj`, near/far, `depthTest`), `harness/mesh.ts` (a lit 3D page to copy).

## Goal

A 3D scene reads as solid: contact shadows in the creases (ambient occlusion from depth) and a focus plane that softens the far ground (depth of field). Both are post passes over the scene depth the renderer already keeps; both are off by default so every current page stays pixel-identical.

STATUS row, *done when*: `PostInputs.depth: TextureLike | null` and `PostInputs.projection: { near: number; far: number; proj: Float32Array } | null` (null on frames without depth, the 2D path); `PostSettings.ao: AoSettings { enabled: false; radius (world units, 0.5); intensity (1); bias (0.02); power (1.5) }` as a half-res pass over depth with normals reconstructed from depth derivatives, 12 spiral samples with a per-pixel rotation from interleaved-gradient noise, a 4×4 depth-aware blur, multiplied into the composite's scene colour before bloom is added; `PostSettings.dof: DofSettings { enabled: false; focusDistance (10); focusRange (6); maxBlur (px at output res, 8); nearBlur (true) }` as a circle-of-confusion from linear depth, a half-res gather (hexagonal or disc, 24 taps weighted by CoC) and a full-res composite blending sharp and blurred by CoC; both blend through `blendTo` like the other settings; `PostQuality` gains `aoSamples` (12) and `dofTaps` (24); a frame without depth (2D) skips both passes and the composite is unchanged (goldens delta 0); harness `depth-post.html`; documented.

## Scope

- `renderer.ts`: fill `depth` and `projection` in the `PostInputs` it builds (the smallest edit: two fields where the inputs object is assembled; `SceneTarget.depth` is already sampleable). `PostInputs` type extended in `renderer.ts`. Nothing else in render.
- `post/ao.ts` and `post/dof.ts` (or a section each in `shaders.ts` + `post-stack.ts`): passes, textures allocated on `resize` only when enabled (allocate lazily on first enabled frame), bind groups rebuilt when inputs change size. Composite shader gains two optional inputs behind a flag uniform so the shader compiles once.
- `settings.ts`/`blend.ts`: the two settings blocks, defaults off, numeric keys blend, `enabled` switches at blend end like the others.
- Tests: settings defaults and blend of the new blocks; `post-stack.test.ts` with the fake GPU: encode with `depth: null` records the same pass count as before; with depth and `ao.enabled` adds the AO passes; `dof.enabled` adds the DOF passes; resize reallocates only when enabled.
- Harness `harness/depth-post.html|ts|-state.ts`: the mesh page's scene with AO and DOF on, `?ao=0`/`?dof=0` to switch each, state `aoEnabled`, `dofEnabled`, `passes`. `e2e/depth-post.spec.ts`: a crease probe is darker with AO on than off; a far-ground probe's local contrast (two adjacent pixels) is lower with DOF on; `?ao=0&dof=0` matches `mesh.html`'s probes within tolerance. Run `pnpm snap:check`: all 2D goldens delta 0 (the passes are off and depth is null there).
- Docs: `src/post/README.md` (pass table rows for AO and DOF, settings, quality keys), ARCHITECTURE *UI, Audio, Save, FX, Post, Platform* one clause and *Renderer* one clause for the depth input, CHANGELOG, root README harness item.

## Files owned

`src/post/*` (additive; `post-stack.ts`, `shaders.ts`, `settings.ts`, `blend.ts`, `quality.ts`, new `ao.ts`/`dof.ts`, tests, `index.ts` append, README), `src/render/renderer.ts` (`PostInputs` type + the two assigned fields only), `harness/depth-post.*`, `e2e/depth-post.spec.ts`, `ARCHITECTURE.md` (two clauses), `CHANGELOG.md`, root `README.md` (harness item).

Branch from `main` (cf05d1e or later). Running alongside: chain 1 is landing skinning, spot-lights and texture-registry, which edit `renderer.ts` elsewhere (instance write, bindings), so keep your renderer edit to the lines named and expect the integrator to merge both; ws/sky landing writes the emissive target (post reads it, no file overlap). Use `E2E_PORT_OFFSET=130`.

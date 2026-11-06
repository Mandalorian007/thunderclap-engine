# Brief: ws/xr-post

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `docs/briefs/xr.md`; on `ws/xr`: `src/core/game.ts` (the per-eye render step and the XR section), `src/platform/xr-surface.ts` (`XrEyeView`, the shared external target), `src/render/scene-target.ts` (`external`, `adopt`, `viewport`), `src/render/renderer.ts` (`endFrame({ present })`, how the post stack and present run today), `src/post/README.md`, `src/post/post-stack.ts` (`PostStack`, `PostProcessor`), `src/post/blend.ts`.

## Goal

The post stack (bloom, tone map, colour grade, whatever `PostStack` does today) runs in VR, once per eye, into the projection layer's sub-image, so a game looks the same in the headset as on screen. The XR report left this as a documented limitation.

STATUS row, *done when*: `PostStack` (or the renderer's post path) can take an explicit output target + viewport instead of the swap chain; the XR render step in `core/game.ts` renders each eye's scene into the engine's HDR scene target and then runs post into that eye's external target; `renderer.endFrame({ present: false })` still skips the swap chain; fake-XR test asserts two post passes with the right viewports; non-XR path byte-identical (the post tests and 2D e2e pixels unchanged); documented, the XR limitation line removed.

## Scope

- Find the smallest seam: likely `Renderer.render(frame, camera, target)` already renders into a `SceneTarget`, and post runs in `endFrame` from the scene target to the swap chain. Add `renderer.resolve(target: SceneTarget, out: { texture: GPUTexture | GPUTextureView; viewport? })` or an `endFrame({ present: false, to: [...] })` form; prefer the one that keeps the existing present path untouched.
- Per-eye scene targets: the XR surface today shares one external target for both eyes side-by-side; post per eye can run on that single target with two viewports (one pass each, scissor+viewport), which avoids a second HDR allocation. Choose that unless `PostStack` can't take a viewport; then one HDR target per eye, allocated once, resized on layer change.
- Tests on the fake GPU / fake XR: two post invocations per frame with viewports matching `XrEyeView.viewport`; post settings honoured; zero allocations per frame after warm-up.
- Docs: `src/post/README.md` XR section; `src/core/README.md` XR line; ARCHITECTURE *Post* paragraph and the XR limitation line in *Renderer*/*Scene and Ctx*; CHANGELOG.

## Files owned

`src/post/**`, `src/core/game.ts` (the XR render step only), `src/render/renderer.ts` (only the post/present seam in `endFrame`, name lines), `src/platform/xr-surface.ts` (if per-eye targets are needed), `src/platform/xr-fake.ts`, tests beside them, `src/post/README.md`, `src/core/README.md` (one line), `ARCHITECTURE.md` (*Post* paragraph + the limitation line), `CHANGELOG.md`.

Stack on `ws/xr` (head `fdd4127`): `git reset --hard ws/xr` then `git checkout -b ws/xr-post`. Do not rebase onto main (an integrator merges ws/xr soon, then you). Running alongside: ws/shadow-cull (`renderer.ts` cull/shadow lists; stay out of them), ws/pbr, ws/skinning, ws/anim, ws/follow, ws/trails, ws/gltf-anim, ws/template-first-person.

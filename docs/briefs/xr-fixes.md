# Brief: ws/xr-fixes

Read `docs/briefs/common.md`, E-013 and E-038 in `docs/DECISIONS.md`, the ARCHITECTURE sections **Surface** (the `XrSurface` part), **Renderer**, **Frame loop** and the post part of **UI, Audio, Save, FX, Post, Platform**, the README of each module you touch, and the "VR performance without quality cuts" and "XR rough edges" entries in `docs/IDEAS.md` (their line citations are as of `fce9288`; re-find them).

## Goal

Fix the VR correctness bugs found in review. The user's rule holds: VR must look and feel the same as the flat game, so nothing here lowers quality. No real headset is available; prove each fix on the fake XR system (`platform/xr-fake.ts`) and the fake GPU.

STATUS row, *done when*, each with a unit test that fails before the fix:

1. **A throwing frame no longer stops the loop.** In `GameLoop.frame` (`core/loop.ts`) the next frame is requested even when `runFrame` throws, and `inFrame` / the renderer's in-frame state are cleared so the next frame can begin. The error still surfaces (rethrown after scheduling, or reported through a hook; say which). In XR a failed or viewless frame clears the layer rather than leaving it stale, if that can be done without new API.
2. **No frame cap in XR.** The `minFrameMs` skip does not apply while frames come from an XR session.
3. **Auto exposure adapts once per frame.** In XR, `adaptExposure` runs once per frame with the frame's `dt`, and both eyes use the same exposure (`post/post-stack.ts`). The flat path is unchanged (one eye = one adaptation already).
4. **The head frustum covers both eyes.** `XrSurface.head` gets a projection that contains both eyes' frusta (the union), so scene-level culling against `head` (voxel chunks) never drops what only the right eye sees.
5. **XR culls.** The eye cameras cull (`cull = true`), so XR draws no more than the flat path does. Sharing one cull and one sort across both eyes is *not* in scope (a later performance stream).
6. **No wasted page render in XR.** A frame with no views does not fall back to rendering the page target while a session runs.
7. **Head-locked world panels follow the drawing camera.** A head-locked panel `attach`ed without an explicit `update(camera)` sits in front of the head in VR, not the page camera (`ui/world-panel/`). If anchors or floats have the same default and the fix is small and in files you own, include it; otherwise list it in the report.
8. Allocations: hoist the per-frame `{ present: false }` literal in `core/game.ts` (the only line you may change there; ws/surface-fill owns the file) and cache `SceneTarget.adopt`'s wrapper per texture if it allocates per frame.

The 2D harness stays pixel-identical (`pnpm snap:check` at 0 px). ARCHITECTURE *Today* lines, the module READMEs and CHANGELOG `## Unreleased` *Fixed* lines describe each fix. No public API change is expected; if one is needed, keep it additive and run `pnpm api:update`.

## Files owned

`src/core/loop.ts` (+ tests), `src/platform/xr-surface.ts`, `src/platform/xr-fake.ts`, `src/post/post-stack.ts`, `src/post/exposure.ts`, `src/render/renderer.ts` (the XR/viewless paths only), `src/render/scene-target.ts`, `src/ui/world-panel/**`, `src/ui/anchor.ts` (only for item 7), their READMEs, `harness/xr.html` / `e2e/xr.spec.ts` if needed, ARCHITECTURE lines for those, CHANGELOG. One line of `src/core/game.ts` (item 8).

Running alongside: ws/surface-fill (`platform/surface.ts`, `letterbox.ts`, `core/game.ts`, `ui/styles.ts`, `ui/layout.ts`) and ws/publish-3 (`packages/host-electron`, `scripts/pack-smoke.mjs`). Don't edit their files.

## Gate

`pnpm check`, `pnpm snap:check` at 0 px, and `e2e/xr.spec.ts`, `e2e/post3.spec.ts`, `e2e/post4.spec.ts`, `e2e/world-panel.spec.ts` (whichever exist) each green on their own.

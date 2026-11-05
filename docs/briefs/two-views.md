# Brief: ws/two-views

Read `docs/briefs/common.md`, then `docs/VISION.md` pillar 1 (headset from one bundle), `ARCHITECTURE.md` *Surface*, *Camera*, *Renderer*, *Frame loop*, principle 4 (seams, not features; XR after Gate 5); DECISIONS E-010; `src/render/README.md`; `harness/mesh.ts` as the pattern.

## Goal

Prove the stereo seam without WebXR: two cameras render the same frame into two halves of one surface in one frame, each with its own view block and `view_index`.

STATUS row: `render(frame, camera, target)` called twice per frame into two viewports of one surface (`view_index` 0/1); harness page.

## Scope

- `harness/views.html` + `harness/views.ts`: the mesh demo's scene (copy the geometry builders, do not import `harness/mesh.ts`), two `Camera.perspective` eyes offset ±0.032 m on the camera's right axis, `camera.screen` set to the left and right halves in the unit-square convention `render()` accepts, `view_index` 0 and 1, one `beginFrame`/record/`render()`×2/`endFrame`. Page state on `window.__harnessViews` (frames, both eyes' positions, draw calls per view).
- `e2e/views.spec.ts`: boots; pixel samples prove both halves render the scene and the halves differ (parallax); no GPU errors; the depth attachment is cleared per view (a near object in one eye does not leak). Matrix-wide.
- If `render()` is wrong for the second view (clear vs load, scissor, uniform offsets, `view_index` not settable), fix the smallest thing inside `Renderer.render()`'s viewport/scissor/`view_index` lines and `Camera` (a `viewIndex` field if none exists), and list the change precisely in your report for the integrator; `ws/lights` owns the rest of `renderer.ts`.

## Files owned

`harness/views.html`, `harness/views.ts`, `harness/views-state.ts`, `e2e/views.spec.ts`, `CHANGELOG.md`, `ARCHITECTURE.md` *Renderer* paragraph (one sentence); edit scope only (not ownership) in `src/render/renderer.ts` `render()` viewport/scissor/`view_index` lines and `src/render/camera.ts` for `viewIndex`.

Alongside: `ws/lights` (renderer, wgsl, `harness/mesh*`), `ws/mesh-stream` (`mesh.ts`, `harness/stream*`), `ws/plumbing` (`camera.ts` fitRect helper only).

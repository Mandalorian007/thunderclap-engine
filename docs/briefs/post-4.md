# Brief: ws/post-4

Read `docs/briefs/common.md` first. Then read `docs/VISION.md` pillar 4 and the E-015 quality bar, and these rows in `docs/STATUS.md`: ws/post-depth, ws/post-2, ws/post-3 and ws/render-4. Also read the backlog lines this brief closes:
- the ws/post-3 wishes, all four
- the ws/render-4 line *switching TAA/SSR/motion blur onto the new inputs is ws/post-4*
- the ws/post-2 `SNAP_KEYS` / `lut.texture` wish
- the ws/post-depth *AO projected radius assumes perspective* note
- the ws/demo-polish-2 `clonePostSettings` wish

Then read these files:
- `src/post/README.md` end to end, plus `src/post/{post-stack,taa,ssr,motion-blur,ao,blend,settings,shaders}.ts`
- `src/render/README.md`, sections *Camera jitter and history* and *Aux targets* (from ws/render-4)
- `src/render/{camera,renderer,scene-target}.ts`, read only: what `PostInputs.view`, `roughMetal`, `velocity` and `wantsJitter` carry
- `harness/post3*`, `e2e/post3.spec.ts` and `harness/render4*`

## Goal

The post stack stops guessing what the renderer now tells it. TAA jitters the projection rather than the sample. SSR fades per surface. Motion blur follows moving and skinned objects, not only the camera. AO is right under an orthographic camera. Two small debts are paid. Every new input is optional: a frame without aux targets renders exactly as today, and the 2D goldens stay pixel-identical.

STATUS row, *done when*:

- **TAA on camera jitter.** The stack sets `wantsJitter` while TAA is enabled and drives the Halton (2, 3) sequence through `Camera.setJitter`. Reprojection reads `PostInputs.view.previousViewProj`, and the resolve un-jitters by `view.jitter`. The old sample-UV jitter path is deleted, not kept behind a flag. Say in the README if any caller depended on it.
  - Test: a static scene under TAA converges to within 1/255 of the no-TAA frame after 16 frames.
  - Test: a moving edge shows no more ghosting than today, measured as a harness state value.
- **Inputs, not the renderer.** Every pass reads `PostInputs.view`, and nothing in `src/post` reads `renderer.camera` (a grep test).
- **SSR per surface.** When `PostInputs.roughMetal` is present, SSR fades by the sampled roughness against `roughnessCutoff` and weights by metalness. Without it, today's constant path runs.
  - Test: a rough/smooth split floor reflects only on the smooth half.
- **Object motion blur.** When `PostInputs.velocity` is present, the gather uses the per-pixel velocity target, and camera-only reprojection fills pixels with no velocity. Add `motionBlur.mode: 'camera' | 'object'` (default `'object'` when the target exists).
  - Test: a cube moving under a still camera blurs along its motion, and the static background does not.
- **AO orthographic.** The projected radius is correct for orthographic projections, read from `PostInputs.projection`.
  - Test: the AO term under an ortho camera is radius-stable across zoom.
- **Debts.**
  - `blend.ts` `SNAP_KEYS` names `lut.texture`.
  - `clonePostSettings(s)` gives a deep copy and is exported.
  - The XR per-eye path still works: run the fake-XR test.
- **Harness**: new pages only. Add `harness/post4.html`, `post4.ts` and `post4-state.ts`, with these variants:
  - `?taa`: a static plus moving-edge scene. State `convergedDelta`, `ghost`.
  - `?ssr`: the split floor. State `smoothReflect`, `roughReflect`.
  - `?blur`: a moving cube. State `cubeBlurPx`, `backgroundBlurPx`.
  - `?ortho`: AO under ortho at two zooms. State `aoDelta`.
  - `?still`: parks motion.

  Add `e2e/post4.spec.ts` (E-017 polling). `e2e/post3.spec.ts` and `e2e/depth-post.spec.ts` stay green, and `pnpm snap:check` stays at 0 px.
- **Docs**:
  - Update the post README *Passes* table rows for TAA, SSR, motion blur and AO.
  - Rewrite the render-4 pointer paragraph to describe what is now wired.
  - Update the types list.
  - Add a CHANGELOG block.
  - Add one sentence to the ARCHITECTURE post clause.
  - Add the post4 page to the root README harness list and update the count line.

## Files owned

- `src/post/**` (all of it)
- new `harness/post4*`
- `e2e/post4.spec.ts`
- `ARCHITECTURE.md` (one sentence)
- `CHANGELOG.md`
- root `README.md` (harness list and count line)

Do not edit:
- `src/render/**`: ws/render-4 is landing. A renderer gap is a wish for ws/render-5.
- `harness/post2*` and `e2e/post2.spec.ts` (ws/e2e-harden owns them)
- `harness/post3*`
- `harness/depth-post*`
- `demos/**`
- `templates/**`

**Branch** from `ws/render-4` at 9254884, not from main. render-4 is queued for integration. Once it lands on main, merge main into your branch before your final gate. Your integrator lands you only after render-4 is on main. Running alongside: ws/fx-3, ws/ui-4, ws/core-2, ws/assets-3, ws/demo-arpg and ws/e2e-harden. Use `E2E_PORT_OFFSET=780`.

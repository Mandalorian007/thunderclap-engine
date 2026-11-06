# Brief: ws/shadow-cull

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-014, E-016; `src/render/README.md` (Shadows, bounds and culling), `src/render/renderer.ts` (`buildDraws`, `encodeShadow`, `DrawRec.bx/by/bz/br`, `castShadow`), `src/render/shadow.ts` (`place`, `sunCamera`), `src/render/camera.ts` (`frustum`, `seesSphere`), `src/render/renderer.test.ts` (the shadow-pass describe and the cull tests).

## Goal

A caster outside the view frustum still casts into the visible scene. Today `encodeShadow` draws the list left after view culling (E-016), so an off-screen tree shadows nothing.

STATUS row, *done when*: the shadow pass draws every opaque caster whose bounding sphere intersects the sun's shadow box, independent of the view frustum; view culling unchanged for the scene pass; `renderer.stats.shadowDraws`; a fake-GPU test with a caster behind the camera that still shadows; `mesh.html` unchanged; 2D pixel-identical.

## Scope

- In `buildDraws` (or a sibling), keep the pre-cull record list and cull it a second time against the sun camera's frustum (`shadow.sunCamera.frustum` via `Camera.seesSphere`, or the orthographic box directly) into a separate command list the shadow pass encodes. No per-frame allocation: a second preallocated index array sized like the first.
- Sort shadow commands by material/mesh like the scene list; keep the batch key logic shared.
- `RenderStats.shadowDraws` (instances drawn in the shadow pass).
- Tests: caster behind camera shadows the receiver (bind groups/draw count assertions as the existing shadow tests do); culled count for the scene pass unchanged; allocation test still passes; remove the three `camera.cull = false` fixture lines the integrator added only if the new path makes them unnecessary.
- Render README Shadows paragraph: one sentence; CHANGELOG one line.

## Files owned

`src/render/renderer.ts` (the cull/shadow list code only), `src/render/renderer.test.ts`, `src/render/shadow.ts` (if a frustum helper belongs there), `src/render/README.md` (one sentence), `CHANGELOG.md`.

Branch from `main` (9e577f9 or later). Running alongside: ws/skinning and ws/pbr (stacked on ws/shadows, no `renderer.ts` edits), ws/xr (`renderer.ts` `endFrame` present flag only), ws/trails, ws/follow, ws/anim, ws/gltf-anim, ws/template-first-person.

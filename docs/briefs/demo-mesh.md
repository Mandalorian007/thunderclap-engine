# Brief: ws/demo-mesh

Read `docs/briefs/common.md` first, then `docs/VISION.md` (the 3D proof is "seams + demos"), DECISIONS E-001, E-003, E-006, E-008, E-009; `ARCHITECTURE.md` *Renderer*, *Camera*, *Transforms*; `src/render/README.md`; `harness/README.md` or an existing harness page and its e2e spec as the pattern.

## Goal

A harness page that proves the Phase 3 seams work together: a perspective `Camera`, a depth buffer, a lit 3D `Mesh` drawn through `Transform`s, orbiting under pointer and gamepad input, on the whole e2e matrix.

STATUS row, *done when*: `?demo=mesh` harness page: perspective camera, depth, lit mesh, orbit by pointer and pad; e2e on the matrix.

## Scope

- Page `harness/mesh.html` + `harness/mesh.ts` (follow the one-page-per-capability pattern the harness already uses; the `?demo=mesh` wording in STATUS means "the mesh demo page", not a router you must build).
- Geometry built in the page with `VERTEX_LAYOUT_3D`: a cube or icosphere plus a ground quad, several instances at different depths so the depth test is visibly exercised (an instance drawn later but farther must be occluded).
- A material with a fragment shader written in the page (Lambert + ambient from `engine_world_position`/the normal in `VSOut`); the engine has no lighting and you add none to `src/`.
- `Camera.perspective` with `lookAt`, orbit driven by drag (any pointer) and the right stick; zoom by wheel/pinch/triggers via the existing `Input` bindings.
- An e2e spec `e2e/mesh.spec.ts` on the matrix: page boots, no console errors, a screenshot assertion that a near object occludes a far one (sample pixels, no golden PNG), orbit input moves the camera.
- Use the renderer as it is on `main` today (`beginFrame`/`endFrame` with `renderer.camera = cam`). `ws/render-call` is adding `renderer.render(frame, camera, target)` in parallel; do not wait for it and do not edit `src/`.

## Files owned

`harness/mesh.html`, `harness/mesh.ts`, `harness/` index/link list (one line), `e2e/mesh.spec.ts`, `examples/` if you want a copyable example, `CHANGELOG.md` (one line under "Next (unreleased)"), `ARCHITECTURE.md` only if a *Planned* line about the mesh demo becomes *Today*.

Nothing under `src/`. If the engine lacks something you need, build the page around it and list it in your report, item 5.

Running alongside: `ws/render-call` (owns `src/render`, `src/host`, `src/core`, `src/fx`, the 2D harness pages), `ws/template-puzzle` (owns `templates/`).

# Brief: ws/camera-ergo

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `src/render/camera.ts` whole (`Camera.perspective`, `setPerspective`, `setProjection`, `setView`, `lookAt`, `worldToScreen`, `screenToWorld`, `writeBlock`, `seesSphere`, the frustum planes), `src/render/camera.test.ts`, `src/render/README.md` *Camera*, `harness/follow.ts` and `harness/billboards.ts` if present (how games project points per frame today).

## Goal

Camera helpers that four engineers wished for in the same week: a view-space depth, a public inverse view-projection, a retained projection of many points, and `setPerspective` behaving like `Camera.perspective`. `camera.ts` only; nothing in the renderer.

STATUS row, *done when*: `Camera.viewZ(x, y, z): number` (view-space depth, positive in front); `Camera.invViewProj: Float32Array` (cached, recomputed lazily when view or projection change, column-major like `viewProj`); `Camera.projectMany(points: Float32Array, out: Float32Array, count?, stride = 3): number` writes screen x, y, depth per point (3 floats out) and returns how many landed inside the viewport, zero allocations; `Camera.frustumCorners(out: Float32Array)` (8 world-space corners from `invViewProj`); `setPerspective(fovY, aspect, near, far)` sets the depth mode and cull face the same way `Camera.perspective` does (document which fields; keep `setProjection` raw); `worldToScreen` and `screenToWorld` unchanged in result; tests; harness `follow.html` or `billboards.html` state exposes one `projectMany` result for an e2e check; documented.

## Scope

- `camera.ts`: a dirty flag on view/projection setters (`setView`, `setViewMatrix`, `lookAt`, `setPerspective`, `setProjection`, `fitRect`, `fitFreeRect`, orthographic setters) invalidates `invViewProj`; 4×4 inverse in a private helper (no `mat4` library). `viewZ` reads the view matrix's third row. `projectMany` reuses `worldToScreen`'s arithmetic without the object allocation.
- `setPerspective`: read how `Camera.perspective(...)` configures the camera (depth/cull/handedness flags) and make `setPerspective` do the same, so `cam.setPerspective(...)` on a default camera renders like `Camera.perspective(...)`. If a 2D camera path shares the field, prove with `pnpm snap:check` that the 2D harness is pixel-identical.
- Tests in `camera.test.ts`: `invViewProj × viewProj = I` within 1e-5 after each setter; `viewZ` of a point on the view axis equals its distance; `projectMany` matches `worldToScreen` for 100 random points and counts inside; `frustumCorners` of a perspective camera has near corners at `near` and far at `far` along the view axis; `setPerspective` vs `Camera.perspective` field equality.
- Harness: in `harness/follow.ts` (or `billboards.ts`, whichever exists on your base; do not add a page), expose `projected: number` (count inside) and `nearCornerZ` in state, no visual change; one e2e assertion in that page's spec.
- Docs: render README *Camera* (the four helpers), CHANGELOG one line, ARCHITECTURE *Camera* one clause.

## Files owned

`src/render/camera.ts`, `src/render/camera.test.ts`, `src/render/README.md` (*Camera*), one harness `*.ts` + its `*-state.ts` and spec (state field only), `CHANGELOG.md`, `ARCHITECTURE.md` (one clause).

Branch from `main` (638ebbf or later). Running alongside: ws/geom-2 (`src/geom`, `mesh.ts` layout line), ws/input-replay (`src/input`, `core/game.ts`), landing chains in `renderer.ts`, `frame.ts`, `wgsl.ts`, `standard.ts`: do not edit those. Harness pages other chains edit (`mesh.ts`, `lights.ts`, `pbr.ts`): leave alone.

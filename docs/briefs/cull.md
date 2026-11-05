# Brief: ws/cull

Read `docs/briefs/common.md` first, then `docs/VISION.md` (Forgewilds: chunk meshes from Workers), DECISIONS E-008, E-009, E-012, E-013; `ARCHITECTURE.md` *Camera*, *Transforms*, *Renderer*; `src/render/README.md`; `src/render/camera.ts`, `src/render/frame.ts`, `src/render/renderer.ts` (record, sort, draw loop), `harness/stream.ts`.

## Goal

A world of hundreds of chunk meshes costs only the draws the camera can see. Frustum culling per draw, bounds on meshes, and the stats to prove it; nothing a 2D game notices.

STATUS row, *done when*: `Mesh.bounds`, per-draw frustum cull against the camera's six planes, `renderer.stats.culled`, stream page culls and the e2e asserts it; 2D harness pixel-identical.

## Scope

1. **Bounds.** `MeshDesc.bounds?: { center: [x,y,z]; radius: number }` and `mesh.bounds` (computed from positions when not given; `update()` recomputes only when `bounds` is passed or vertex data changes and `autoBounds` is on, default on for meshes under `capacity` 65k vertices, off otherwise so chunk pipelines pass bounds themselves). `frame.mesh(...)` transforms the bounding sphere by the instance matrix (scale by the max axis scale) into a per-draw world sphere; sprites get none and are never culled.
2. **Frustum.** `Camera.frustum` (six planes from `viewProjection`, cached like the matrices; `camera.cull: boolean`, default true for `perspective`, false for `ortho2d` so 2D is bit-identical). The renderer skips draws whose sphere is outside any plane, before sorting; `renderer.stats.culled` counts them per `render` call, summed over views like the other stats.
3. **Fast path.** No allocation per draw or per frame in steady state; plane tests on flat `Float32Array`s. A unit test on the fake GPU draws 1000 spheres around the camera and asserts roughly half are culled and `stats.drawCalls` falls accordingly.
4. **Harness.** `harness/stream.ts` passes bounds for each streamed chunk (its Worker knows them) and exposes `stats.culled` on the state object; `e2e/stream.spec.ts` asserts `culled > 0` when the camera looks away from half the chunks.

## Files owned

`src/render/camera.ts` (`frustum`, `cull`; append-only), `src/render/mesh.ts` (`bounds`), `src/render/frame.ts` (draw record bounds; not `DrawParams.castShadow`), `src/render/renderer.ts` (record/sort/cull and stats; not the shadow pass or bind layouts), `src/render/index.ts` (append), `src/render/README.md` (Transforms/Renderer sections), `harness/stream.ts`, `harness/stream-worker.ts`, `harness/stream-state.ts`, `e2e/stream.spec.ts`, `ARCHITECTURE.md` *Transforms*/*Renderer* (one sentence each), `CHANGELOG.md`.

Running alongside: ws/shadows owns the shadow pass in `renderer.ts`, `material.ts`, `lights.ts`, `wgsl.ts`; ws/xr adds `Camera.setProjection`/`setViewMatrix` to `camera.ts` (append-only on both sides; integrator order: prune, shadows, cull, xr). ws/prune removes a few exports from `render/index.ts`. Name your `renderer.ts` line ranges in the report.

# Brief: ws/batch-submit

Read `docs/briefs/common.md` first, then DECISIONS E-013; `docs/BENCH.md` (10k culled cubes 3.6 ms CPU; 50k cubes 29–38 ms CPU with the GPU idle: the per-call `frame.mesh` push is the ceiling); `src/render/frame.ts` (`frame.mesh` overloads, `DrawParams`, `InstanceParams`, draw list layout), `src/render/renderer.ts` (how the draw list becomes instance buffers and draw calls; sort keys; culling in `cull.ts` if separate), `src/render/transform.ts` (3×4 world matrices), `src/render/shadow.ts` (the shadow list consumes the same draws), `harness/bench.ts` (ws/bench on chain 3: read `git show ws/bench:harness/bench.ts` if not on main), `src/render/README.md` *Frame*.

## Goal

Fifty thousand instances in a few milliseconds of CPU. Two paths: a bulk submit that takes typed arrays of matrices and params for one mesh+material pair and copies straight into the instance buffer, and a retained instance list a game fills once and mutates by index so nothing is re-pushed per frame. Both go through the same culling and sorting as `frame.mesh` so shadows, layers and stats stay right.

STATUS row, *done when*: `frame.meshes(mesh, material, batch: InstanceBatch)` where `InstanceBatch {count, matrices: Float32Array (12 floats each, 3×4), params?: Float32Array (INSTANCE_PARAM_FLOATS each) | null, bounds?: MeshBounds | null (batch-level bounds for one cull test; per-instance culling off when given), layerBits?}`; `renderer.createInstanceList(mesh, material, capacity)` → `InstanceList {count, set(i, transform | matrix, params?), remove(i) (swap-remove, returns moved index), matrices, params, bounds (auto from the mesh bounds + per-instance translation unless `setBounds`), dirty tracking so an unchanged list uploads nothing}` and `frame.list(list)`; the renderer sorts batches as one unit (one sort key per batch, not per instance), culls per instance when no batch bounds are given using the existing cull code over the typed array without allocating; shadows draw the batch; `RenderStats.instances`, `batches` added; `harness/bench.html` gains a `?mode=batch` and `?mode=list` and `docs/BENCH.md` gets the numbers for 10k/50k in all three modes on the same machine; `e2e/bench.spec.ts` asserts the three modes draw the same `instances` count and the same pixel at the centre (`?still`); 2D goldens delta 0; documented.

## Scope

- `frame.ts`: new draw-list entry kind for batches; `frame.mesh` unchanged.
- `renderer.ts`: upload path for batch entries (one `writeBuffer` per batch, or a slice of the shared instance buffer), draw with `instanceCount`, shadow pass support, stats.
- Keep `frame.mesh` performance unchanged (bench it: before/after numbers in the report).
- Tests: fake-GPU tests for buffer writes per batch, culling with/without batch bounds, swap-remove, dirty tracking, stats; e2e as above.
- Docs: render README *Frame* (three ways to draw many things and when to use each), `ARCHITECTURE.md` *Renderer* one sentence, `CHANGELOG.md`, `docs/BENCH.md`.

## Files owned

`src/render/frame.ts`, `src/render/renderer.ts` (submission path; not `PostInputs`, not the `white` getter, not the light block), `src/render/instance-list.ts` (new), `src/render/index.ts` (append exports), tests, `harness/bench.*` (coordinate: ws/bench is landing on chain 3; if it is not on main when you branch, base on main and copy its harness files from the branch; the integrator keeps both), `e2e/bench.spec.ts`, `docs/BENCH.md`, `src/render/README.md` (*Frame*), `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`.

Branch from `main` (42969a8 or later). Running alongside: ws/pbr-lights (`wgsl.ts`, `standard.ts`, `renderer.white`), ws/post-depth (`PostInputs` in `renderer.ts`). Use `E2E_PORT_OFFSET=240`.

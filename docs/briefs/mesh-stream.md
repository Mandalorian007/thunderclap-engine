# Brief: ws/mesh-stream

Read `docs/briefs/common.md`, then `docs/VISION.md` (Forgewilds: chunk meshes from Workers; rule 5), DECISIONS E-003, E-008, E-010; `ARCHITECTURE.md` *Transforms*, *Renderer*; `src/render/README.md`, `src/render/mesh.ts`.

## Goal

A `Mesh` whose geometry a game can rebuild every frame from a Worker without copying on the main thread. The mesher is the game's; the engine owns the buffers.

STATUS row: `Mesh` with updatable vertex/index ranges and a capacity, fed from a Worker-built `ArrayBuffer` without a copy on the main thread; a harness page streaming chunk-like meshes.

## Scope

- `Mesh` gains `capacity` (vertices, indices) and `update({ vertices?: ArrayBufferView, indices?, vertexCount?, indexCount? })` writing with `queue.writeBuffer` from the view's own buffer (a transferred `ArrayBuffer` from a Worker lands here untouched), growing only when capacity is exceeded (and reporting it). `indexCount` drives the draw, so a chunk can shrink without reallocating.
- `createMesh` accepts `VERTEX_LAYOUT_3D` data or just a capacity.
- `harness/stream.html` + `harness/stream.ts`: a Worker (inline blob or a sibling module) builds a few "chunk" meshes (heightfield columns are enough; no voxel code in `src/`) and re-meshes one per frame, transferring buffers; the page shows the count of vertices uploaded per frame and renders with the perspective camera.
- `e2e/stream.spec.ts`: boots, meshes update (vertex counts change), no GPU errors, pixel sample shows geometry; stays green on the matrix (Workers exist everywhere Chromium runs).
- Fake-GPU tests: update within capacity does not recreate buffers; growth does; `indexCount` respected.

## Files owned

`src/render/mesh.ts` (+ test), `src/render/frame.ts` only if `frame.mesh` must read `indexCount` (one small change; say so in the report), `harness/stream.html`, `harness/stream.ts`, `harness/stream-worker.ts`, `e2e/stream.spec.ts`, `CHANGELOG.md`, `ARCHITECTURE.md` *Transforms* paragraph (one sentence under *Today*).

Alongside: `ws/lights` owns `renderer.ts`, `wgsl.ts`, `lights.ts`, `harness/mesh*`; `ws/two-views` owns `harness/views*`; do not touch them. If the renderer must change for you, write it down.

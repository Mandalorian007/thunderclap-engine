# Track C: ThunderClap spike (measured)

Throwaway. Spike source: `tc/C/spike-src/` (copied from the worktree's `apps/web/spike-tc/`; not committed). Raw runs: `tc/C/results.jsonl`; table: `tc/C/table.md`; harness: `tc/C/measure.mjs`, `tc/C/runs.sh`. Screenshots: `tc/C/shots/<run>-<browser>-<which>.png` (scratchpad root `/private/tmp/claude-501/-Users-matthewfontana-repos-forgewilds/6d3a6356-a211-48af-8136-2d85d4d7fe56/scratchpad/`).

Setup: scratch `forge dev` (seed 42, port 11500, warm after first run), current client `dist` on 11501, spike on 11502. The same camera (8,110,8, yaw 45, pitch -20), radius 16 / radiusV 8, 2360x1640 backbuffer. Engine @thunderclap-engine/engine 1.3.0 from npm. Each run waits for full view, then 4 s, then 3 samples 2.5 s apart. Runs were interleaved: forge, tc-b, forge preset=off, tc-a, ×3.

## What was built
- **Route b (our mesher → TC renderer):** forge's WorldStore, section summarizer, MeshPool workers and WorldView priorities stay unchanged. Each meshed section becomes one TC `Mesh` with a custom `VertexLayout` over our packed 8 B vertex (2×u32) and a custom WGSL material: a palette storage buffer, lambert × sky light + block light, AO and fog. It also has TC Sky, TC Lights (sun plus a 2048 shadow map, extent 96), TC fog, an optional TC post (tablet tier) and a fly camera via TC `Look`. It works, and the terrain matches today's view (`r1-webkit-tc-b.png` vs `r1-off-webkit-forge.png`).
- **Route a (TC voxel module):** one bounded `createVoxelGrid` (33×17×33 sections = 76 MB u8) at connect time. Streamed sections are copied straight into `grid.data`, and chunk+6 neighbours are marked dirty. Ids are remapped to u8 (53 used), and only OPAQUE and LEAVES are drawn. `createVoxelChunks` does the meshing in-thread. It works (`r1-webkit-tc-a.png`) but loses water, plants, models, insets, light and textures.

## Numbers (WebKit iPad Pro 11 profile, headless; 3 interleaved runs, avg)
| | cpu/frame avg (p95) | GPU ms avg (p95) | draws | tris drawn | full view (nav→) | GPU mesh mem | long frames / worst |
|---|---|---|---|---|---|---|---|
| forge today (full preset) | 1.01 (1–2) | 9.36 (12.1) | 2851 | 836k vis / 2.6M | ~1020 ms | 172 MB total, vtx 39.6 used / 64 alloc | – |
| forge `preset=off governor=0` | 1.01 (1) | **2.87** (6.7) | 2850 | 836k / 2.6M | 1046–3798 ms | 128 MB total | – |
| TC route b (shadow, no post) | **2.48** (4–5) | 6.25 (7.3) | 869 | 791k | ~925 ms | 60.7 MB (34.7 vtx + 26 idx) | 2 / 82 ms |
| TC route b, no shadow | 2.64 | 5.08 | 869 | 791k | 977 | 60.7 | 3 / 66 |
| TC route b + post (tablet) | 2.67 | 4.73 (?) | 869 | 791k | 945 | 60.7 | 2 / 77 |
| TC route a (voxel module) | 2.37 (4) | 6.28 (7.4) | 1351 | 819k | **~4580 ms** | **307 MB** (281 vtx@48 B + 76 grid) | 9 / **~920 ms** |

All of these ran at 60 fps in WebKit. Chromium (headless, Metal ANGLE, DPR 2) gives the same picture: forge GPU 10.9 ms vs TC-b 7.1 ms, CPU 1.0 vs 2.7 ms, and TC-a full view 8.1 s with a 1.47 s hitch. Headless Chromium fps (17–39) is a presentation artifact, so don't trust it. The first forge Chromium run took 7.3 s to full view (cold cache).

Bundle size: the spike's main chunk is 812.5 kB (248.6 kB gzip) plus the 78.5 kB forge mesh worker. The TC-only imports (createGame, Look, Lights, Sky, post, voxel) are **539.5 kB / 171.3 kB gzip**, because the subpath entries still pull most of the engine. Today's client main chunk is 1095.6 kB / 383 kB gzip. Adopting TC adds about +170 kB gzip unless it becomes tree-shakeable or we drop the matching forge render code.

### How to read these numbers
- **GPU.** Route b vs forge's full preset (6.2 vs 9.4 ms) is NOT a fair comparison. Forge draws leaf cutouts, foliage, water, models, clouds, weather and detail, and it draws to the horizon without TC's fog cutoff. The fair row is **forge preset=off: 2.9 ms vs TC-b no-shadow 5.1 ms on similar triangle counts**. So drawing the same terrain through TC's pipeline cost about 1.8× the GPU in this spike. Likely causes:
  - TC's opaque pass writes an MRT `FragOut` (color + emissive), which costs bandwidth at 2360x1640.
  - TC's Sky pass.
  - Fog/lambert per pixel.
  - Possibly no depth prepass or front-to-back ordering.

  This was not profiled further.
- **post=1 lowered GPU time.** This is unexplained. Probably the tablet tier renders the scene below full resolution; check `postQualityFor('tablet')` before trusting it.
- **CPU per frame is about 2.5× today's (2.5 vs 1.0 ms).** That is on the iPad budget rule. TC's frame walks every mesh: per-object Transform → world matrix, frustum test, a uniform/instance write and a draw call. Forge does its own culling with fewer state changes. Even with fewer draws (869 vs 2851 issued), the CPU cost is higher.
- **Full view** is the same for route b (it is our pipeline). Route a is about 4.5× slower and hitches about 0.9 s. `chunks.update()` remeshes every dirty chunk at once, with no budget, and runs in-thread.
- **Remesh latency on edit** was not measured separately (time-box). Route b uses forge's mesher unchanged, so it is today's latency plus a TC `mesh.update` (about 0.005 ms CPU per section). Route a's remesh of one chunk is cheap, but the bulk-load hitch shows the lack of a budget.

## Friction
1. **VertexLayout requires `v.uv` and `v.color` fields.** `engine_vertex` in the prelude reads them unconditionally. A packed layout has to alias fake attributes over its own bytes (locations 1 and 2 over offsets 0 and 4). Fix: optional `wgslUv`/`wgslColor` (patch below).
2. **`MeshDesc.vertices` is typed `Float32Array`.** Packed u32 data has to be cast (bit-identical, but a lie in the types). This needs an `ArrayBufferView`/`Uint32Array` overload.
3. **Every Mesh owns its own index buffer.** There is no shared quad-index buffer, which costs about 26 MB extra (+75% over vertex data) and an index upload per section. Forge shares one.
4. **One draw call per mesh**, with no multi-draw or indirect path, and a per-object CPU walk. This is the main reason for the higher CPU per frame. Forge's culled draw list would need a TC "batch of sub-ranges in one buffer" primitive (a big pooled vertex buffer plus firstVertex/indirect).
5. **`MeshBounds` is in mesh space, combined with a Transform.** I passed world-space centers first and frustum culling silently dropped near terrain. Easy to get wrong; this needs a docs line and a debug assert.
6. **World matrices are float32 world positions.** There is no camera-relative path. Forge's worlds are large, so precision far from the origin needs a camera-relative origin or rebasing.
7. **Voxel module (route a) does not fit:**
   - ids are u8, but we have 12-bit+ ids and 181+ blocks in use;
   - one bounded, non-streaming grid (76 MB for radius 16, and no recentering);
   - the worker mirror posts one message per `grid.set`, and a full sync serializes the whole grid (I used the in-thread mesher to avoid this);
   - `update()` has no remesh/upload budget (about 920 ms hitch);
   - the mesher knows only opaque cubes: no liquid, cutout, plants, models, insets or facing;
   - no sky/block light;
   - 48 B vertices vs our 8 B, which is 6× the memory (281 MB);
   - the `layerOf` default is `block-1`.
8. **The engine root and subpaths pull most of the engine** (about 171 kB gzip for a small import set).
9. **API gotchas:**
   - `renderer.onGpuTime(cb)` is a subscribe method, not a property;
   - storage buffers bind at `@group(1) @binding(16+i)`, which is only discoverable from the source;
   - `createMaterial` types required `as never` for `buffers`.
10. **WebKit:** no WebKit-specific breakage. Timestamp queries worked in Playwright WebKit (`gpuSource: timestamp`). The real iPad was not tested; it was out of scope for this spike.

## Engine patches (proposed; scratchpad copy only, never applied to the checkout)
Diff: `tc/C/engine-patch.diff` (copies in `tc/C/engine-patch/{a,b}`). It is unbuilt and untested; it is a sketch for the size/shape of the change.
- `render/mesh.ts` + `render/wgsl.ts`: optional `VertexLayout.wgslUv` / `wgslColor`, used by `engine_vertex` in place of `v.uv`/`v.color`. Fixes friction 1, about 8 lines.
- `voxel/chunks.ts`: `maxRequestsPerUpdate` / `maxAppliesPerUpdate` budgets (chunks over budget stay dirty). Fixes the route-a hitch, about 15 lines.

Not patched, but needed for route b to match today's CPU and memory:
- a shared index buffer option on `Mesh`;
- a pooled vertex buffer with sub-range draws (multi-draw/indirect);
- camera-relative transforms;
- typed-array-agnostic `MeshDesc`;
- better tree-shaking.

## Gut read
**Route b is technically viable:** our streaming, summaries, worker mesher and priorities drop in unchanged, and TC gives sky, shadows, post and lights almost for free. But as built it **fails the "never cost frame time on iPad" rule on CPU** (+1.5 ms/frame) and on bare-terrain GPU (about 1.8×). It would need engine work first: pooled/indirect draws, a shared index buffer and a lighter opaque pass (no MRT when emissive is unused). The visual features we already have would all have to be re-ported as TC materials.

**Route a is not viable** without rewriting the voxel module into what our mesher already is: streaming, wide ids, block kinds, light and 8 B vertices.

**Recommendation:** neither route as a client swap now. The cheapest real win is selective borrowing: TC's Sky, shadow and post passes adapted into forge's renderer. A route-b migration only makes sense after the engine patches above land and a re-measure shows CPU ≤ today's.

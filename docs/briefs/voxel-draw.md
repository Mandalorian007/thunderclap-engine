# Brief: ws/voxel-draw (C2)

Read `common.md`, `wave-2.0-1.md`, `wave-2.0-2.md` (start point: you need both B1 a237c57 and C1 cd4fb11. Branch from main if it has both; otherwise branch from main and `git merge ws/core-retained ws/voxel-data`, then merge main again once they land), E-041, `docs/design/2.0/architecture.md` **P10, §2.8, §3.2–3.3**, `docs/design/2.0/bar.md` (S4 and the voxel gates), C1's `src/voxel/` (store, schema, mesher, pool, connectivity) and B1's `src/render/core/`. Forge source (read only): `FW:render/visibility.ts`, `FW:render/arena.ts`, `FW:render/renderer/sections.ts`, `FW:render/renderer/draw.ts`.

## Goal

Streamed voxel worlds drawn on the retained core, for any block game. ROADMAP *done when*: "Voxel scene S4 at radius 16 draws flat GPU calls; streaming adds no hitch over 50 ms; the old demo voxel API replaced."

1. `createVoxelWorld(renderer, { format, workers, materials, … })` (D1 §2.8): sections from C1's store mesh in the worker pool and upload straight into core arenas as static, GPU-culled DrawSets (opaque, cutout/foliage and liquid sets, liquid sorted or blended as D1 says).
2. Connectivity (cave) culling from C1's bits, plus streaming budgets: uploads per frame are capped, and nearest sections come first.
3. Materials: the terrain/liquid/foliage shaders include C1's generated `decode_voxel_vertex`. The game supplies the fragment (painting). The engine ships a plain default look.
4. Replace today's demo `voxel` module (`chunks.ts` and its one-mesh-per-chunk path) in place. The old dense grid becomes `createVoxelGrid`, a *source* feeding the same world (D1 §2.8 "Keeps"). Breaking changes are listed in CHANGELOG *Breaking* with migration notes. Move the existing voxel harness/demo pages onto it.
5. A counted budget test: flat GPU calls as radius grows (`expectProportional`), and 0 allocations in a held frame. The S4 page (A4's `harness/ref-*` if it is on main, otherwise the voxel demo page) at radius 16.

## Files owned

`src/voxel/**` except C1's data files (which you may extend), voxel harness/demo pages and their specs.

## Size

L. If long, land world plus upload plus cull first, then replace the old module.

## Gate

common.md. The voxel specs green on Chromium and WebKit; snap 0 px.

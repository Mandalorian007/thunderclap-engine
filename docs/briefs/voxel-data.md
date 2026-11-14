# Brief: ws/voxel-data (C1)

Read `common.md`, `wave-2.0-1.md`, E-041, `docs/design/2.0/architecture.md` P6, P10 and **§2.8**, `src/voxel/README.md`. Forge source to generalize (read only): `FW:mesh/` (mesher.ts, faces.ts, vertex.ts, input.ts, light.ts, connectivity.ts, pool.ts, view.ts, falls.ts), `FW:interact/raycast.ts`, and their tests under `FW:../test/` (find them with grep).

## Goal

The CPU and Worker half of streamed voxel worlds, for any block game. STATUS *done when*: "Forge's mesher's tests ported and green on the generalized code; schema-generated decode matches a hand-written one; a non-Forge block table meshes."

1. **Section store.** Sparse, keyed sections (16³ default, configurable), kept encoded with a pluggable codec (the game supplies decode), readiness and nearest-first priority, `putSection`/`dropSection`/`edit(key, cells)` returning the remesh set.
2. **BlockTable and face classes** as declared data (opaque, liquid, cutout, foliage, cross-plant, no-face; opacity, light-blocking, emission, game bits).
3. **VertexSchema.** A declared bitfield over 2×u32 (defaults as D1 §2.8) with game fields; generates both the CPU packer and a WGSL `decode_voxel_vertex` include (no `override`).
4. **Mesher pool.** Self-contained Worker jobs (a section plus its 26 neighbours), greedy merging, AO, sky and block light floods, connectivity bits; output buffers transferable straight into an arena (B1 will provide arenas; output plain packed `ArrayBuffer`s + counts + bounds now).
5. **Raycast** (DDA) over the store, and `meshPiece(cells)` for small loose pieces.
6. Port Forge's mesher/light/connectivity tests to the generalized API; add a test with a non-Forge table (two materials, an emissive block).
7. The existing demo grid (`chunks.ts` etc.) stays untouched this wave; C2 replaces it. Put new code in new files.

## Files owned

New files under `src/voxel/` (store, schema, mesher, light, connectivity, pool, raycast), `src/voxel/index.ts` (additive exports), README.

## Size

L. If it runs long, land store + schema + mesher (no light) first and list the rest.

## Gate

common.md.

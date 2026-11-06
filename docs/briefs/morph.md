# Brief: ws/morph

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `ARCHITECTURE.md` *Assets*, *Animation*; `src/assets/README.md`; `src/assets/gltf.ts` (`GltfPrimitive`, accessor readers, `parsePrimitive` around l.840, the `weights` animation path), `src/assets/gltf.test.ts` (how documents are built in tests), `src/assets/gltf-load.ts` (`loadGltf`, how a primitive becomes a `Mesh` and whether it keeps CPU positions), `src/render/mesh.ts` (`Mesh.update({ vertices })`, `VertexLayout`), `src/anim/clip.ts` (`weights` channel sampling into a pose: see what `sampleClip` does with `path: 'weights'` today).

## Goal

Faces talk and bodies squash: glTF morph targets parse, a `weights` clip drives them, and a CPU blend writes the result into the mesh's vertex buffer through `Mesh.update`. GPU morphing waits for the batch-submit stream; this makes the data and the arithmetic right first.

STATUS row, *done when*: `GltfPrimitive.targets: GltfMorphTarget[]` (`{ position: Float32Array | null; normal: Float32Array | null }`, per-target deltas, `vertexCount` × 3 each) and `GltfMesh.weights: Float32Array | null` (default weights) parse from `.glb`/`.gltf`, with sparse-accessor targets supported for this path only (deltas are usually sparse) or a clear `GltfError` naming the limit; `MorphBlender` in `anim/morph.ts`: `createMorphBlender(base: Float32Array, targets: GltfMorphTarget[], layout: VertexLayout)` → `{ weights: Float32Array; apply(out: Float32Array): boolean }` writes base + Σ weight × delta into the interleaved buffer's position and normal lanes (normals renormalised), skipping when no weight changed since the last apply, zero allocation; `sampleClip` on a `weights` channel writes into a weights array the game names (define the API in `clip.ts` with the smallest change: a `MorphTarget`-shaped sink, or document how a node's weight channel is read with `sampleWeights(clip, node, t, out)` if the pose cannot hold them); `GltfScene` keeps the base buffer for primitives with targets and exposes `scene.morph(nodeIndex): MorphBlender | null`, uploading through `mesh.update` after `apply` returns true; harness `morph.html`; documented.

## Scope

- `assets/gltf.ts`: parse `primitive.targets` (POSITION, NORMAL; others ignored and listed in the primitive's `ignoredTargetAttributes`), `mesh.weights`, sparse accessors for target attributes (indices + values over a zero or dense base).
- `anim/morph.ts`: the blender, pure, tested against a hand-built two-target quad.
- `anim/clip.ts`: `sampleWeights(clip, node, t, out, cursor?)` (same interpolation rules as `sampleClip`, including cubic spline), no change to `sampleClip`'s contract; or, if the pose can carry weights cheaply, say so in the report and do that instead.
- `assets/gltf-load.ts`: keep the base interleaved buffer only for primitives that have targets; `scene.morph(node)`; `scene.update(dt)`-style hook is not required: the game calls `apply` and the scene uploads in `draw` when dirty.
- Tests: parse (dense and sparse targets, default weights, error path), blender arithmetic and skip rule, `sampleWeights` step/linear/cubic, loader keeps base only when needed (fake GPU).
- Harness `harness/morph.html|ts|-state.ts`: a procedural `.gltf` built in code (a sphere with two targets: squash and bulge) animated by a generated `weights` clip, lit, with state `weights`, `applied` (count), `bounds`. `e2e/morph.spec.ts`: weights change over time (poll), `applied` grows, a pixel probe at the silhouette edge changes between squash and bulge phases.
- Docs: `src/assets/README.md` (targets, sparse limits), `src/anim/README.md` *Morph targets*, ARCHITECTURE *Assets* and *Animation* (move the two *Planned* morph clauses to *Today*), CHANGELOG, root README harness item.

## Files owned

`src/assets/gltf.ts`, `src/assets/gltf.test.ts`, `src/assets/gltf-load.ts`, `src/assets/gltf-load.test.ts`, `src/assets/index.ts` (append), `src/assets/README.md`, `src/anim/morph.ts`, `src/anim/morph.test.ts`, `src/anim/clip.ts` (additive), `src/anim/clip.test.ts`, `src/anim/index.ts` (append), `src/anim/README.md` (*Morph targets*), `harness/morph.*`, `e2e/morph.spec.ts`, `ARCHITECTURE.md` (two clauses), `CHANGELOG.md`, root `README.md` (harness item).

Nothing under `src/render/`. Branch from `main` (d5e888a or later). Running alongside: ws/retarget (`anim/retarget.ts`), ws/anim-graph (`anim/graph.ts`), ws/ik landing (`anim/ik.ts`, `root-motion.ts`): all share `anim/index.ts`, README and the ARCHITECTURE *Animation* paragraph, so keep your edits to appended lines; chain 1 is landing skinning and texture-registry, which touch `gltf-skin.ts` only through imports. Use `E2E_PORT_OFFSET=120`.

# Brief: ws/gltf-anim

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `docs/briefs/gltf.md`, `docs/briefs/anim.md` (the `AnimationClip`, `AnimationChannel`, `Skeleton` shapes you must produce, structurally; `src/anim` is being written alongside and may not exist on your branch: do not import it, define matching local types and say so), `docs/briefs/skinning.md` (`VERTEX_LAYOUT_SKINNED`: 3D floats + joints `uint8x4` + weights `unorm8x4`); `src/assets/gltf.ts`, `gltf-load.ts`, `gltf.test.ts` and `README.md` on `ws/gltf` (you stack on it).

## Goal

glTF skins and animations parse into the engine's animation shapes and skinned vertex data, so a rigged character from a DCC tool runs on `anim` + `skinning` without a converter (E-015).

STATUS row, *done when*: `GltfDocument.skins: GltfSkin[]` (joints, inverse bind matrices as 3×4 rows 12 floats per joint, skeleton root), `GltfDocument.animations: GltfAnimation[]` in `AnimationClip` shape (channels with node index, path, interpolation, times, values; cubic-spline tangents preserved), `GltfPrimitive.joints`/`weights` (JOINTS_0 any integer type → Uint8Array ×4 when ≤255 joints else Uint16Array, WEIGHTS_0 normalised floats), `interleaveSkinned(primitive): { vertices: ArrayBuffer; layout: 'skinned' }` packing the skinned layout, `skeletonFromSkin(doc, skinIndex)` producing `{ parents, rest, inverseBind, joints }` per `anim`'s `Skeleton`; unit tests on a generated GLB with a two-bone skin and a three-channel animation; documented.

## Scope

- Parser only (`src/assets/gltf.ts` additions + a new `src/assets/gltf-skin.ts`), no GPU. `loadGltf` gains `GltfScene.skins` and `GltfScene.animations` passthrough and, for skinned primitives, builds the mesh with the skinned layout if `VERTEX_LAYOUT_SKINNED` exists on your branch; if not (ws/skinning is alongside), build the 3D layout and keep the skinned data on the node (`node.skin`, `primitive.joints`) and name the one-line change for the integrator.
- Extend the test GLB writer for skins and animations. Golden assertions: inverse bind row-major conversion from glTF column-major, quaternion channel values untouched, cubic-spline triplets kept, `rest` pose from node TRS.
- `src/assets/README.md` *Skins and animations* section, CHANGELOG one line, ARCHITECTURE *Assets* paragraph: one sentence.

## Files owned

`src/assets/**`, `src/assets/README.md`, `ARCHITECTURE.md` (*Assets* sentence), `CHANGELOG.md`.

Stack on `ws/gltf` (head `8812877`): `git reset --hard ws/gltf` then `git checkout -b ws/gltf-anim`. Running alongside: ws/anim, ws/skinning, ws/pbr, ws/follow, ws/xr, ws/template-first-person; an integrator merging ws/shadows then ws/gltf into main.

# engine/assets

Asset formats the engine turns into its own objects. Today: glTF 2.0 geometry, skins and
animations. No dependencies, no network: the game fetches the bytes, the engine parses and
uploads them.

## glTF in one call

```ts
import { loadGltf, parseGltf } from '@thunderclap/engine/assets';

const bytes = await (await fetch('scene.glb')).arrayBuffer(); // the game's fetch, not ours
const doc = parseGltf(bytes);                                  // engine-free document
const scene = await loadGltf(renderer, doc);                   // meshes, transforms, textures, materials

// each frame, inside render:
frame.lights = lights;
scene.draw(frame);          // one frame.mesh(...) per node × primitive, no allocation
```

`parseGltf(source: ArrayBuffer | GltfJsonSource): GltfDocument` reads a `.glb` (GLB container,
JSON + BIN chunk) or a `.gltf` (UTF-8 JSON bytes, or `{ json, buffers? }` where `buffers[i]` is the
`ArrayBuffer` for `buffers[i].uri`). `data:` URIs decode in place (`decodeDataUri(uri)` is the
helper, returning `{ bytes, mimeType }`). Anything still external is listed in
`doc.externalUris`; a buffer that is external and not supplied throws naming the uri, an image
that is external is left for the loader.

`loadGltf(renderer: Renderer, doc: GltfDocument, opts?: LoadGltfOptions): Promise<GltfScene>` builds
one `Mesh` per primitive in `VERTEX_LAYOUT_3D` (`interleave3d(primitive)` makes the float
buffer: `x y z nx ny nz u v r g b a`), one `Transform` per node (parented like the file), one
`Texture` per image a texture uses (`rgba8unorm-srgb`, full mip chain through `generateMipmaps`
unless `mips: false`), and one lit `Material` per glTF material (`GLTF_LIT_WGSL`: base colour
texture × vertex colour × base colour factor as the instance tint, `engine_lambert` plus a touch of
sky, `MASK` cutoff in `params.x`, `BLEND` as alpha blend). Options:

| `LoadGltfOptions` | |
| --- | --- |
| `resources` | `Record<uri, ArrayBuffer | GltfImageSource>` for `doc.externalUris`; a missing image uri throws `image i: missing external resource "uri"` |
| `material` | one `Material` for every draw; `scene.materials` stays empty and the file's materials are only read for tint and cutoff |
| `label` | prefix for GPU labels (default `gltf`) |
| `mips` | mip chains on (default true) |
| `decodeImage` | `(bytes, mimeType) => Promise<GltfImageSource>`; default `createImageBitmap` on a `Blob`, so Workers and tests can supply their own |

`GltfImageSource` is `ImageBitmap | HTMLCanvasElement | OffscreenCanvas`.

`GltfScene` owns what it made: `meshes`, `textures`, `materials`, `transforms` (one per node,
file order), `nodes: GltfSceneNode[]` (the draw list: `{ node, transform, mesh, material, params,
skin }` with `params` an `InstanceParams` built once and `skin` the node's skin index or null),
`skins` and `animations` (the document's, passed through), `bounds: { center, radius }` in world
space, `draw(frame)` and `destroy()` (meshes, textures, its own materials; not `opts.material`).

## The document

`GltfDocument` is plain data, usable without a GPU (a Worker can parse and post it):

- `version`, `scene` (root node indices), `sceneNodes` (every node in the scene, parents first),
  `warnings` (`extension ignored: X` for each `extensionsUsed`), `externalUris`, `bounds`
  (`GltfBounds`: `min`, `max`, `center`, `radius`, in world space).
- `nodes: GltfNode[]`: `name`, `parent`, `children`, `mesh`, `skin`, `translation`, `rotation`,
  `scale` (`Vec3`/`Vec4`; a `matrix` node is decomposed), `local` and `world` as the engine's 3×4
  row-major `Float32Array` (`composeTrs(t, q, s, out)` builds one the way `Transform` does).
- `meshes: GltfMesh[]`: `name`, `primitives: GltfPrimitive[]` with `vertexCount`, `position`,
  `normal` (flat normals computed when the file has none: `hadNormals` false, the primitive
  unwelded), `uv0` (zeros when missing), `color0` (ones when missing, `VEC3` padded), `indices`
  (`Uint16Array` or `Uint32Array`, generated when missing), `material`, `bounds`, and for skinned
  primitives `joints` and `weights` (below). Triangles only.
- `skins: GltfSkin[]` and `animations: GltfAnimation[]`: see *Skins and animations*.
- `materials: GltfMaterial[]`: `name`, `baseColorFactor`, `baseColorTexture` (texture index),
  `texCoord`, `doubleSided`, `alphaMode: GltfAlphaMode` (`'OPAQUE' | 'MASK' | 'BLEND'`),
  `alphaCutoff`. The engine's 3D pipelines cull nothing, so `doubleSided` is informational.
- `textures: GltfTexture[]`: `name`, `source` (image index), `wrapS`, `wrapT`, `magFilter`;
  `images: GltfImage[]`: `name`, `bytes` (embedded or `data:`), `mimeType`, `uri` (external).

Accessors: every `GltfComponentType` (5120–5126), every `GltfAccessorType`, `byteStride`,
`normalized` integers. Sparse accessors, non-triangle modes, `extensionsRequired`, a missing
`POSITION`, a buffer too short for its view, a node with two parents or in a cycle, and anything
else the parser cannot honour throw `GltfError` (message prefixed `gltf: `).

The JSON shapes the parser reads are exported for writers and tests: `GltfJson`,
`GltfJsonAccessor`, `GltfJsonBufferView`, `GltfJsonPrimitive`, `GltfJsonNode`,
`GltfJsonMaterial`, `GltfJsonSkin`, `GltfJsonAnimation`, `GltfJsonAnimationChannel`,
`GltfJsonAnimationSampler`, `GltfJsonInterpolation`, `GltfJsonSource`.

## Skins and animations

A rigged character from a DCC tool parses straight into the shapes `@thunderclap/engine/anim`
samples and `VERTEX_LAYOUT_SKINNED` draws, with no converter. `assets` does not import `anim`:
the types below restate `AnimationClip`, `AnimationChannel` and `Skeleton` structurally, so a
`GltfAnimation` is an `AnimationClip` and a `GltfSkeleton` is a `Skeleton`.

- `GltfSkin` (`doc.skins[i]`, `node.skin`): `name`, `joints` (node index per joint), `skeleton`
  (the root node the file named, or null) and `inverseBind`: 12 floats per joint, the engine's
  3×4 row-major layout (`anim`'s `skinMatrices` and `render/skin.ts` read it), converted from the
  file's column-major `MAT4`; identity when the file has none.
- `GltfAnimation` (`doc.animations[i]`): `name` (the file's, or `animation<i>`), `duration` (the
  last keyframe over every channel) and `channels: GltfAnimationChannel[]`, each `{ node, path,
  interpolation, times, values }` with `path: GltfAnimationPath` (`'translation' | 'rotation' |
  'scale' | 'weights'`), `interpolation: GltfInterpolation` (`'STEP' | 'LINEAR' | 'CUBICSPLINE'`),
  `times` ascending seconds and `values` 3, 4 or `k` floats per key (quaternions exactly as
  stored, xyzw), or in-tangent, value, out-tangent triplets per key for `CUBICSPLINE`, glTF
  sampler semantics throughout. A channel without a target node is skipped with a warning.
- `GltfPrimitive.joints`: `JOINTS_0` from any unsigned integer type, 4 per vertex, a
  `Uint8Array` when every index fits a byte, else a `Uint16Array`; `GltfPrimitive.weights`:
  `WEIGHTS_0` as 4 floats per vertex (normalised integers divided). Both or neither, else
  `GltfError`; both follow the unwelding when flat normals are generated.
- `interleaveSkinned(primitive): SkinnedVertices` (`{ vertices: ArrayBuffer; layout: 'skinned' }`)
  packs `SKINNED_VERTEX_STRIDE` (56) bytes per vertex: the 12 `VERTEX_LAYOUT_3D` floats, the four
  joint bytes at `SKINNED_JOINTS_OFFSET` (48), the four weights as `unorm8` at
  `SKINNED_WEIGHTS_OFFSET` (52), renormalised and rounded so they sum to exactly 255. Throws for
  an unskinned primitive or joint indices above 255.
- `skeletonFromSkin(doc, skinIndex): GltfSkeleton` spans every node of the document, so a
  channel's `node` indexes the pose directly: `parents: Int16Array` (-1 for a root), `rest`
  (10 floats per node from its TRS: `tx ty tz qx qy qz qw sx sy sz`), `inverseBind` (the skin's
  array, shared) and `joints: Uint16Array` (node per joint).

`loadGltf` passes `skins` and `animations` through on the `GltfScene` and sets `skin` on each
draw. A skinned primitive is built in the skinned layout once `VERTEX_LAYOUT_SKINNED` exists in
`render/mesh.ts`; until then it is built in `VERTEX_LAYOUT_3D` and the joints and weights stay on
the document.

## Not yet

Morph targets (the `weights` channel parses; nothing consumes it), cameras, lights, `KHR_*`
extensions (`KHR_texture_transform`, `KHR_materials_*`, Draco, meshopt). `extensionsUsed` is
tolerated and warned about; `extensionsRequired` throws.

## Demo

`harness/gltf.html` builds a GLB in the page (`harness/gltf-writer.ts`: a textured cube placed by
a `matrix` node, an unlit-looking mossy plane with no normals placed by TRS) and draws it through
the two calls above; `e2e/gltf.spec.ts` checks the counts and the rendered pixels on the matrix.

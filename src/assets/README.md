# engine/assets

Asset formats the engine turns into its own objects. Today: glTF 2.0 static geometry. No
dependencies, no network: the game fetches the bytes, the engine parses and uploads them.

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
file order), `nodes: GltfSceneNode[]` (the draw list: `{ node, transform, mesh, material, params }`
with `params` an `InstanceParams` built once), `bounds: { center, radius }` in world space,
`draw(frame)` and `destroy()` (meshes, textures, its own materials; not `opts.material`).

## The document

`GltfDocument` is plain data, usable without a GPU (a Worker can parse and post it):

- `version`, `scene` (root node indices), `sceneNodes` (every node in the scene, parents first),
  `warnings` (`extension ignored: X` for each `extensionsUsed`), `externalUris`, `bounds`
  (`GltfBounds`: `min`, `max`, `center`, `radius`, in world space).
- `nodes: GltfNode[]`: `name`, `parent`, `children`, `mesh`, `translation`, `rotation`, `scale`
  (`Vec3`/`Vec4`; a `matrix` node is decomposed), `local` and `world` as the engine's 3×4 row-major
  `Float32Array` (`composeTrs(t, q, s, out)` builds one the way `Transform` does).
- `meshes: GltfMesh[]`: `name`, `primitives: GltfPrimitive[]` with `vertexCount`, `position`,
  `normal` (flat normals computed when the file has none: `hadNormals` false, the primitive
  unwelded), `uv0` (zeros when missing), `color0` (ones when missing, `VEC3` padded), `indices`
  (`Uint16Array` or `Uint32Array`, generated when missing), `material`, `bounds`. Triangles only.
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
`GltfJsonMaterial`, `GltfJsonSource`.

## Not yet

Skins, morph targets, animation, cameras, lights, `KHR_*` extensions (`KHR_texture_transform`,
`KHR_materials_*`, Draco, meshopt). `extensionsUsed` is tolerated and warned about;
`extensionsRequired` throws.

## Demo

`harness/gltf.html` builds a GLB in the page (`harness/gltf-writer.ts`: a textured cube placed by
a `matrix` node, an unlit-looking mossy plane with no normals placed by TRS) and draws it through
the two calls above; `e2e/gltf.spec.ts` checks the counts and the rendered pixels on the matrix.

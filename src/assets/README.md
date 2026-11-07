# engine/assets

Turns asset bytes into engine objects: glTF 2.0 (meshes, skins, animations, lights, cameras, variants, quantized and meshopt data), KTX2, atlases, bundles and a reference-counted cache. The game fetches the bytes and decides what to load when; the engine parses and uploads them. No dependencies and no network.

## Quick use

<!-- snippet:check -->
```ts
import { loadGltf, parseGltf } from '@thunderclap/engine/assets';
import type { Frame, Renderer } from '@thunderclap/engine/render';

declare const renderer: Renderer;
declare const frame: Frame;

const bytes = await (await fetch('scene.glb')).arrayBuffer(); // the game's fetch, not ours
const scene = await loadGltf(renderer, parseGltf(bytes));      // meshes, transforms, textures, materials
scene.draw(frame);                                             // each frame, inside render
```

## Entry points

| Name | What it is for |
| --- | --- |
| `parseGltf(bytes)` | `.glb` or `.gltf` into an engine-free `GltfDocument` |
| `loadGltf(renderer, doc, opts?)` | upload a document into a drawable `GltfScene` |
| `skeletonFromSkin(...)` | an `anim` skeleton from a glTF skin |
| `parseKtx2(bytes)` | a KTX2 container and its levels |
| `createAssetCache(opts?)` | reference-counted loads, shared between scenes |
| `defineManifest / createBundle` | a typed list of assets, loaded with progress |
| `packAtlas / createAtlasTexture` | pack images into one atlas texture |

## Contents

- [Overview](#overview)
- [glTF in one call](#gltf-in-one-call)
- [The document](#the-document)
- [Materials](#materials)
- [Morph targets](#morph-targets)
- [Skins and animations](#skins-and-animations)
- [Quantized meshes](#quantized-meshes)
- [Meshopt](#meshopt)
- [Lights and cameras](#lights-and-cameras)
- [Material variants (cosmetics)](#material-variants-cosmetics)
- [KTX2](#ktx2)
- [Asset cache](#asset-cache)
- [Bundles](#bundles)
- [Baked bytes](#baked-bytes)
- [Atlas](#atlas)
- [Not yet](#not-yet)
- [Demo](#demo)

## Overview

Asset formats the engine turns into its own objects. Today: glTF 2.0 geometry, skins,
animations, lights, cameras and material variants (quantized and meshopt-compressed meshes
included), KTX2 containers, and a reference-counted asset cache. No dependencies, no network: the game fetches the bytes, the engine parses and
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
one `Mesh` per primitive (`VERTEX_LAYOUT_3D` through `interleave3d(primitive)`: `x y z nx ny nz u
v r g b a`; `VERTEX_LAYOUT_3D_TANGENT` through `interleave3dTangent` when the primitive has
`TANGENT`; `VERTEX_LAYOUT_SKINNED` through `interleaveSkinned` when it is skinned and a `palette`
is given), one `Transform` per node (parented like the file), one `Texture` per (image, colour
space) a material reads (full mip chain through `generateMipmaps` unless `mips: false`), and one
standard PBR `Material` per glTF material (`createStandardMaterial` with every map, factor,
sampler, alpha mode and texture transform the file gives: see *Materials*). `lit: 'lit'` keeps
the older base-colour-only material instead (`GLTF_LIT_WGSL`: base colour texture × vertex
colour × base colour factor as the instance tint, `engine_lambert` plus a touch of sky, `MASK`
cutoff in `params.x`, `BLEND` as alpha blend). Options:

| `LoadGltfOptions` | |
| --- | --- |
| `resources` | `Record<uri, ArrayBuffer | GltfImageSource>` for `doc.externalUris`; a missing image uri throws `image i: missing external resource "uri"` |
| `material` | one `Material` for every draw; `scene.materials` stays empty, the textures are still made (`scene.textures`) for the game to bind, and the file's materials are only read for tint and cutoff |
| `lit` | `GltfLitMode`: `'standard'` (default, `createStandardMaterial`) or `'lit'` (`GLTF_LIT_WGSL`) |
| `palette` | a `SkinPalette`: skinned primitives are built in `VERTEX_LAYOUT_SKINNED` and every material binds it (`skin`); without one they are built in `VERTEX_LAYOUT_3D` with the joints and weights left on the document |
| `label` | prefix for GPU labels (default `gltf`) |
| `mips` | mip chains on (default true) |
| `decodeImage` | `(bytes, mimeType) => Promise<GltfImageSource>`; default `createImageBitmap` on a `Blob`, so Workers and tests can supply their own |

`GltfImageSource` is `ImageBitmap | HTMLCanvasElement | OffscreenCanvas`.

`GltfScene` owns what it made: `meshes`, `textures`, `materials` (file order; `materialNames`
holds each one's `GltfMaterial.name`, and a trailing default material for primitives without one
is named `null`), `palette` (the one passed, or null), `transforms` (one per node, file order),
`nodes: GltfSceneNode[]` (the draw list: `{ node, transform, mesh, material, params, skin }` with
`params` an `InstanceParams` built once, `params[3]` the palette slot 0 on skinned draws, and
`skin` the node's skin index or null), `skins` and `animations` (the document's, passed through),
`bounds: { center, radius }` in world space, `morphs` and `morph(nodeIndex)` (below),
`draw(frame)` and `destroy()` (meshes, textures, its own materials; not `opts.material` or the
palette).

## The document

`GltfDocument` is plain data, usable without a GPU (a Worker can parse and post it):

- `version`, `scene` (root node indices), `sceneNodes` (every node in the scene, parents first),
  `warnings` (`extension ignored: X` for each `extensionsUsed` the parser does not read),
  `unsupportedExtensions` (read into the document, not rendered yet: *Materials*),
  `externalUris`, `bounds` (`GltfBounds`: `min`, `max`, `center`, `radius`, in world space).
- `lights: GltfLight[]`, `cameras: GltfCamera[]` and `variants: string[]`: see *Lights and
  cameras* and *Material variants (cosmetics)*.
- `nodes: GltfNode[]`: `name`, `parent`, `children`, `mesh`, `skin`, `translation`, `rotation`,
  `scale` (`Vec3`/`Vec4`; a `matrix` node is decomposed), `local` and `world` as the engine's 3×4
  row-major `Float32Array` (`composeTrs(t, q, s, out)` builds one the way `Transform` does).
- `meshes: GltfMesh[]`: `name`, `primitives: GltfPrimitive[]` with `vertexCount`, `position`,
  `normal` (flat normals computed when the file has none: `hadNormals` false, the primitive
  unwelded), `uv0` (zeros when missing), `color0` (ones when missing, `VEC3` padded), `indices`
  (`Uint16Array` or `Uint32Array`, generated when missing), `material`, `bounds`, `uv1`
  (`TEXCOORD_1`, or null), `tangent` (`TANGENT` as 4 floats per vertex, w snapped to ±1, or
  null), for skinned primitives `joints` and `weights` (below), and `targets` and
  `ignoredTargetAttributes` for morph targets (below). `GltfMesh.weights` holds the file's
  default morph weights or null. Triangles only.
- `skins: GltfSkin[]` and `animations: GltfAnimation[]`: see *Skins and animations*.
- `materials: GltfMaterial[]`: see *Materials*. The engine's 3D pipelines cull nothing, so
  `doubleSided` only flips the normal on back faces.
- `textures: GltfTexture[]`: `name`, `source` (image index), `sampler: GltfSampler`
  (`magFilter` / `minFilter: GltfFilter` `'nearest' | 'linear'`, `mipmapFilter` the same or null
  when the file's `minFilter` has no mip mode, `wrapS` / `wrapT: GltfWrap` `'repeat' |
  'clamp-to-edge' | 'mirror-repeat'`; glTF defaults: linear, linear mips, repeat), and the older `wrapS`,
  `wrapT`, `magFilter` numbers; `images: GltfImage[]`: `name`, `bytes` (embedded or `data:`),
  `mimeType`, `uri` (external).

Accessors: every `GltfComponentType` (5120–5126), every `GltfAccessorType`, `byteStride`,
`normalized` integers. Sparse accessors (`GltfJsonSparse`) are read for morph target attributes
only (below); sparse elsewhere, non-triangle modes, `extensionsRequired`, a missing `POSITION`,
a buffer too short for its view, a node with two parents or in a cycle, and anything else the
parser cannot honour throw `GltfError` (message prefixed `gltf: `).

The JSON shapes the parser reads are exported for writers and tests: `GltfJson`,
`GltfJsonAccessor`, `GltfJsonSparse`, `GltfJsonBufferView`, `GltfJsonMesh`, `GltfJsonPrimitive`,
`GltfJsonNode`, `GltfJsonMaterial`, `GltfJsonTextureInfo`, `GltfJsonTextureTransform`, `GltfJsonSkin`, `GltfJsonAnimation`,
`GltfJsonAnimationChannel`, `GltfJsonAnimationSampler`, `GltfJsonInterpolation`,
`GltfJsonSource`, and for the extensions below `GltfJsonMeshoptView`, `GltfJsonLight`,
`GltfJsonCamera` and `GltfJsonVariantMapping`.

## Materials

Each glTF material loads as one `createStandardMaterial` (`render/standard.ts`); the loader
reads the whole metallic-roughness model and the two extensions below and hands it over as a
`StandardMaterialDesc`. Nothing in the file is reinterpreted: factors multiply maps as the
specification says, and the engine's material has the same slots.

| `GltfMaterial` | glTF | `StandardMaterialDesc` |
| --- | --- | --- |
| `name` | `name` | the material's `label` is `<label>:material<i>`; the name is on `scene.materialNames[i]` |
| `baseColorFactor: Vec4`, `baseColor: TextureRef \| null` | `pbrMetallicRoughness.baseColorFactor`, `baseColorTexture` | `baseColorFactor`, `baseColor` (sRGB) |
| `metallicFactor`, `roughnessFactor`, `metallicRoughness` | `metallicFactor`, `roughnessFactor`, `metallicRoughnessTexture` | `metallic`, `roughness`, `metallicRoughness` (linear; G roughness, B metallic) |
| `normal`, `normalScale` | `normalTexture`, `.scale` | `normal` (linear), `normalScale` |
| `occlusion`, `occlusionStrength` | `occlusionTexture`, `.strength` | `occlusion` (linear, R); `occlusionStrength` is parsed but not yet applied (the material reads the map at full strength) |
| `emissive`, `emissiveFactor: Vec3` | `emissiveTexture`, `emissiveFactor` × `KHR_materials_emissive_strength.emissiveStrength` | `emissive` (sRGB), `emissiveFactor` |
| `alphaMode: GltfAlphaMode` (`'OPAQUE' \| 'MASK' \| 'BLEND'`), `alphaCutoff`, `doubleSided` | the same | `alphaMode` (`'opaque' \| 'mask' \| 'blend'`), `alphaCutoff`, `doubleSided` |
| every `TextureRef.transform` | `KHR_texture_transform` (`offset`, `rotation`, `scale`, `texCoord`) | `uvTransform: [sx, sy, ox, oy, rot]` |
| the texture's `sampler` | `samplers[i]` | `sampler` through `gltfSamplerKind(sampler, mips)` |

- `TextureRef` is `{ index, texCoord, transform }` on every slot: `index` into `doc.textures`,
  `texCoord` the `TEXCOORD_n` set (the extension's `texCoord` wins), `transform` a
  `GltfTextureTransform` (`offset`, `rotation` in radians, `scale`) or null. `transformUv(t, u,
  v, out?)` applies one on the CPU the way the shader does: `uv' = offset + R(rot) · (scale ⊙
  uv)`. The older `baseColorTexture` (index or null) and `texCoord` stay on `GltfMaterial` for
  one release.
- A texture referenced by any slot does not exist → `GltfError` naming the slot. A material
  the file leaves out gets a default standard material (white, metallic 1, roughness 1, i.e. the
  glTF defaults with no maps).
- **sRGB and linear.** One engine `Texture` per (image, colour space): base colour and emissive
  maps upload as `rgba8unorm-srgb`, metallic-roughness, normal and occlusion maps as
  `rgba8unorm` (labelled `<label>:image<i>:linear`). An image used both ways is uploaded
  twice; `scene.textures` lists them in image order, sRGB before linear. `lit: 'lit'` uploads
  base colour and emissive maps only.
- **Samplers.** The standard material has one sampler for its five maps, so the loader takes
  the base colour texture's (else the first slot with a texture) and maps it to the engine's set:
  nearest → `'nearest-mip-clamp'` / `'nearest-clamp'`, both wraps clamp → `'linear-clamp'`,
  else `'linear-mip-repeat'` / `'linear-repeat'` (the mip variants when the file's `minFilter`
  has a mip mode and `mips` is on). Mirror wraps repeat.
- **Transforms.** One `KHR_texture_transform` per material, likewise from the base colour slot
  first: the standard material applies one `uvTransform` to every map. A second slot with a
  different transform, and `texCoord: 1` on any slot (the material samples `uv0`), are not yet
  honoured; `TEXCOORD_1` is parsed into `GltfPrimitive.uv1` for a custom material.
- **Tangents.** A primitive with `TANGENT` is built in `VERTEX_LAYOUT_3D_TANGENT`
  (`interleave3dTangent`: the 12 floats of `interleave3d` then `tangent.xyzw`, `(1, 0, 0, 1)`
  for a primitive without), so the file's frame reaches the GPU; the standard material shades
  through `engine_perturb_normal` (screen-space derivatives) on every 3D layout, so the attribute
  waits for a tangent-frame variant of the material (see `render/README.md`).
- **Skinned.** With `opts.palette`, a skinned primitive is built in `VERTEX_LAYOUT_SKINNED` and
  its material takes `skin: palette`: see *Skins and animations*. A skinned primitive's
  `TANGENT` is dropped (the skinned layout has no tangent slot).
- **Parsed, not rendered.** `KHR_materials_clearcoat`, `_sheen`, `_transmission`, `_volume`,
  `_ior` and `_specular` are read into `GltfMaterial.extensions` (`GltfMaterialExtensions`:
  `clearcoat: GltfClearcoat`, `sheen: GltfSheen`, `transmission: GltfTransmission`, `volume:
  GltfVolume`, `ior: GltfIor`, `specular: GltfSpecular`, each null when absent, spec defaults
  filled) for a custom material; the standard material does not draw them yet. Each one used is
  listed once in `doc.unsupportedExtensions`, as is `KHR_texture_basisu` (*KTX2*).
- `extensionsUsed` is tolerated. Handled: `KHR_texture_transform`,
  `KHR_materials_emissive_strength`, `KHR_mesh_quantization`, `EXT_meshopt_compression`,
  `KHR_lights_punctual`, `KHR_materials_variants`; parsed into the document: the six above and
  `KHR_texture_basisu`. Every other one is listed in `doc.warnings` as `extension ignored: X`;
  `extensionsRequired` throws for anything outside those thirteen.

## Morph targets

`primitive.targets: GltfMorphTarget[]` holds one `{ position, normal }` per target in file order:
per-vertex deltas, `vertexCount × 3` floats each, or null when the target lacks that attribute.
`POSITION` and `NORMAL` are read; every other target attribute (`TANGENT`, `TEXCOORD_n`,
`COLOR_n`) is skipped and named once in `primitive.ignoredTargetAttributes`. Target accessors
may be sparse, the usual encoding for deltas: `sparse.count` values at `sparse.indices`
(unsigned 8/16/32-bit) overlay the dense data, or zeros when the accessor has no `bufferView`.
Sparse base attributes still throw. Every primitive of a mesh must carry the same number of
targets, and `mesh.weights` (→ `GltfMesh.weights`, null when absent) must have one entry per
target; a wrong count, a non-`VEC3` target or a target whose count differs from the primitive's
vertex count throw `GltfError`. When flat normals are generated the targets are unwelded with
the vertices, so they always line up with `position`.

The blend is CPU arithmetic in `@thunderclap/engine/anim` (`createMorphBlender`, `sampleWeights`);
the loader wires it: for a mesh with targets `loadGltf` keeps each primitive's interleaved base
buffer, builds one `MorphBlender` per primitive over one shared weights array (starting at the
file's `mesh.weights`, else zeros) and exposes them as `GltfMorph` on `scene.morphs` and
`scene.morph(nodeIndex)` (null for a node without a mesh or a mesh without targets; nodes sharing
a mesh share the object). `GltfMorph { mesh; weights; targetCount; blenders; apply() }`: write
`weights` (by hand, or `sampleWeights(clip, node, t, morph.weights)` with a clip from
`scene.animations`), call `apply()` (true when any primitive changed), and the next
`scene.draw(frame)` uploads the changed primitives through `Mesh.update` (bounds recomputed).
Nothing is kept on the CPU for meshes without targets, and nothing allocates per frame. The
parser (`gltf.ts`) still imports nothing from `anim`; the loader (`gltf-load.ts`) imports
`anim/morph` only.

## Skins and animations

A rigged character from a DCC tool parses straight into the shapes `@thunderclap/engine/anim`
samples and `VERTEX_LAYOUT_SKINNED` draws, with no converter. The parser does not import `anim`:
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
  packs render's `VERTEX_SKINNED_STRIDE` (56) bytes per vertex: the 12 `VERTEX_LAYOUT_3D` floats,
  the four joint bytes at `SKIN_JOINTS_BYTE_OFFSET` (48), the four weights as `unorm8` at
  `SKIN_WEIGHTS_BYTE_OFFSET` (52), renormalised and rounded so they sum to exactly 255. Throws for
  an unskinned primitive or joint indices above 255.
- Deprecated aliases (ws/harden-api, removed next minor): `SKINNED_VERTEX_STRIDE`,
  `SKINNED_JOINTS_OFFSET` and `SKINNED_WEIGHTS_OFFSET` are the render constants above under
  their old `assets` names; import `VERTEX_SKINNED_STRIDE`, `SKIN_JOINTS_BYTE_OFFSET` and
  `SKIN_WEIGHTS_BYTE_OFFSET` from `@thunderclap/engine/render` instead.
- `skeletonFromSkin(doc, skinIndex): GltfSkeleton` spans every node of the document, so a
  channel's `node` indexes the pose directly: `parents: Int16Array` (-1 for a root), `rest`
  (10 floats per node from its TRS: `tx ty tz qx qy qz qw sx sy sz`), `inverseBind` (the skin's
  array, shared), `joints: Uint16Array` (node per joint) and `names` (one per node, the file's
  `node.name` or `node<i>`, so `createSocket(skeleton, 'hand_r')` resolves by name).

`loadGltf` passes `skins` and `animations` through on the `GltfScene` and sets `skin` on each
draw. With `opts.palette` (a `SkinPalette` the game sized for the skin's joints) a skinned
primitive is built in `VERTEX_LAYOUT_SKINNED` and every material of the scene binds the palette,
so the game's frame is `sampleClip` → `poseToWorld` → `skinMatrices` → `palette.set(0, m)` →
`palette.flush()` → `scene.draw(frame)` (the draw's `params[3]` is slot 0; set it for another
instance). Without a palette the primitive is built in `VERTEX_LAYOUT_3D` and the joints and
weights stay on the document; a material cannot take a palette later (`setBuffer` needs a slot
declared at creation), so pass it to `loadGltf`.

## Quantized meshes

`KHR_mesh_quantization` needs nothing from the game: `POSITION`, `NORMAL`, `TANGENT` and
`TEXCOORD_n` may be `BYTE` / `SHORT` (normalized or not) and are dequantized to floats at parse
time; the node's transform carries the file's scale and offset as usual. Normals and tangents
read from integers are renormalized. A normalized position accessor's `min` / `max` hold raw
integers, so the parser measures such a primitive's bounds instead of trusting them.

## Meshopt

`EXT_meshopt_compression` buffer views are decoded in `parseGltf` (sync, no WASM) before
anything reads them, so the rest of the document is the uncompressed one. A fallback buffer
(`extensions.EXT_meshopt_compression.fallback`) may have no data. The decoder is public for
other containers:

```ts
decodeMeshopt(target: Uint8Array, count: number, stride: number, source: Uint8Array,
  mode: MeshoptMode, filter?: MeshoptFilter): void
```

`MeshoptMode` is `'ATTRIBUTES' | 'TRIANGLES' | 'INDICES'` (vertex codec v0, index codecs v0 and
v1), `MeshoptFilter` is `'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL'`. A bad stream
throws `MeshoptError`. The triangle codec keeps every triangle and its winding but may start it at
another corner.

## Lights and cameras

`doc.lights: GltfLight[]` holds each `KHR_lights_punctual` light placed by a node of the default
scene, in glTF units (`type`, `color`, `intensity`, `range`, cone angles, world `position` and
`direction`, the node's -Z). `loadGltf` converts them to the render module's records on
`scene.lights: GltfSceneLights` (`directional`, `points`, `spots`): `color` is `color ×
intensity × lightScale` (`LoadGltfOptions.lightScale`, default 1), `radius` is `range` or
`16·√(intensity × lightScale)`. The game decides what to light with:

```ts
lights.points.push(...scene.lights.points);
lights.spots.push(...scene.lights.spots);
const sun = scene.lights.directional[0];
if (sun) { lights.sun.dir = sun.dir; lights.sun.color = sun.color; } // lights: the game's Lights
```

`doc.cameras: GltfCamera[]` (perspective `yfov` / `aspectRatio` / `znear` / `zfar`, orthographic
`xmag` / `ymag`, plus the node's `world` and the `view` matrix) are passed through as
`scene.cameras`. `applyGltfCamera(camera, c, aspect): Camera` sets an engine `Camera` to one
(projection and view, no allocation).

## Material variants (cosmetics)

`KHR_materials_variants` is the cosmetic path: one mesh, several looks, no new materials at
switch time. `doc.variants` holds the names, each primitive's `variants: GltfVariantMapping[]`
the mappings (`{ material, variants }`). `loadGltf` builds every mapped material up front:

```ts
const scene = await loadGltf(renderer, parseGltf(bytes));
scene.setVariant('moss');   // every mapped draw swaps material in place
scene.setVariant(null);     // back to each primitive's own material
```

`scene.variants` lists the names, `scene.variant` is the active one, and each `GltfSceneNode`'s
`materialIndex` follows the switch. An unknown name throws `GltfError` listing the file's
variants.

## KTX2

`parseKtx2(bytes: Uint8Array): Ktx2Texture` reads a KTX2 container: `vkFormat`, size, layers,
faces, `levels: Ktx2Level[]` (`bytes`, `width`, `height`, views into the file, largest first),
`dataFormat: Ktx2DataFormat` (colour model, primaries, transfer) and `supercompression:
Ktx2Supercompression` (`'none' | 'basislz' | 'zstd' | 'zlib'`; levels are empty unless
`'none'`). `isKtx2(bytes)` checks the identifier; a bad file throws `Ktx2Error`.
`ktx2ToWebGpuFormat(vkFormat)` names the `GPUTextureFormat` (BC, ETC2, ASTC, plain) or null.
`KHR_texture_basisu` textures parse with `GltfTexture.basisuSource` (the KTX2 image) and load
the file's PNG / JPEG fallback. Uploading a KTX2 file waits on the render module: a
compressed-format `createTexture` with per-level `writeTexture`, behind the device features
`texture-compression-bc` / `-etc2` / `-astc` (ws/render-5).

## Asset cache

`createAssetCache<T>(opts: AssetCacheOptions<T>): AssetCache<T>` keeps loaded assets by key under
a byte budget (`budgetBytes`), least recently used first out:

```ts
const cache = createAssetCache<GltfScene>({ budgetBytes: 64 << 20, onEvict: (_k, s) => s.destroy() });
const scene = await cache.acquire('rock.glb', async () => loadGltf(renderer, parseGltf(await read('rock.glb'))), () => bytes);
cache.release('rock.glb'); // evictable once nothing holds it
```

`acquire(key, load, size)` returns the cached value or runs `load` once, however many callers ask
at the same time; every call holds a reference until `release(key)`. Held and `pin(key)`-ned
entries are never evicted (`unpin` undoes it). `has`, `refs`, `dispose(key)` (free an
unreferenced entry now) and `stats(): AssetCacheStats` (`bytes`, `entries`, `hits`, `misses`,
`evictions`) complete it. `onEvict` is the free hook; a failed load leaves nothing behind.

## Bundles

A manifest is a typed map of keys to entries, and a bundle loads it from bytes the game supplies.
The engine never fetches: the only I/O is the game's `read(uri)` (VISION rule 4), so a bundle works
the same over `fetch`, a zip in memory, IndexedDB, or an Electron file read.

```ts
import { createBundle, defineManifest } from '@thunderclap/engine/assets';

const manifest = defineManifest({
  hero: { kind: 'texture', uri: 'hero.png', options: { mips: false } },
  tiles: { kind: 'texture-array', uris: ['grass.png', 'stone.png'] },
  level: { kind: 'gltf', uri: 'level.gltf', resources: { 'level.bin': 'bin/level.bin' } },
  jump: { kind: 'audio', uri: 'jump.wav' },
  config: { kind: 'json', uri: 'config.json' },
  credits: { kind: 'text', uri: 'credits.txt' },
  raw: { kind: 'bytes', uri: 'table.bin' },
  icon: { kind: 'image', uri: 'icon.png' },
  sprites: { kind: 'atlas', uris: { coin: 'coin.png', gem: 'gem.png' }, options: { padding: 2 } },
});

const bundle = createBundle(manifest, {
  read: async (uri) => (await fetch(`assets/${uri}`)).arrayBuffer(),
  renderer,
  audio: audioEngine, // or an OfflineAudioContext, to decode before the first gesture
});
bundle.on('progress', (p) => bar.set(p.fraction));
await bundle.load();
const hero = bundle.get('hero'); // Texture
const sprites = bundle.get('sprites'); // AtlasAsset<'coin' | 'gem'>
```

**Manifest.** `defineManifest(entries)` is an identity function that keeps the literal types, so
`bundle.get(key)` returns the right asset type (`AssetOf<Entry>`). `ManifestEntry` is one of
`TextureEntry` (`Texture`), `TextureArrayEntry` (`Texture` with layers, every uri the same size),
`GltfEntry` (`GltfScene`; `.gltf` buffers and images listed in `externalUris` are read through
`read` too, with `resources` mapping a relative uri to the one to read), `AudioEntry`
(`AudioBuffer`), `JsonEntry` (`unknown`), `TextEntry` (`string`), `BytesEntry` (`ArrayBuffer`),
`ImageEntry` (`ImageBitmap`) and `AtlasEntry` (`AtlasAsset`: `texture`, `rects`, `layout`, see
*Atlas*). `AssetKind` is the union of their `kind`s and `Manifest` the map type. A texture entry's
`options` are `LoadTextureOptions`; a gltf entry's are `LoadGltfOptions`.

A particle effect descriptor (`EffectDesc`, `@thunderclap/engine/fx`) is JSON, so it loads as
`{ kind: 'json', uri: 'hit.json' }`: run `bundle.get('hit')` through `validateEffectDesc` and
hand it to `createEffect(renderer, desc, { textures })`, resolving the descriptor's texture names
from the bundle's texture entries.

**The `read` contract.** `AssetReader = (uri: string) => Promise<ReadResult>`, where `ReadResult`
is an `ArrayBuffer`, a `Blob`, an `ImageBitmap` (for the image kinds), or `{ data, total? }` with
`total` the size in bytes, so `progress.bytes` and `bytesTotal` can be reported. A thrown or
rejected `read` fails that key (after `retries` more attempts); the bundle never retries a decode.
One uri shared by several entries is read once per `load`, and its bytes are counted once.

**Options** (`BundleOptions`): `read` (required), `renderer` (needed by texture, texture-array,
gltf and atlas entries; without it those keys fail with a message naming the option), `audio`
(`AudioDecoder`: an `AudioEngine`, whose `context` is null before the first gesture, or any object
with `decodeAudioData` such as an `OfflineAudioContext`), `concurrency` (reads in flight, default
4), `retries` (default 0), `priority(key)` (higher first among queued reads), `strict` (reject
`load` on the first failure and cancel the rest), `decodeImage(blob)` (default
`createImageBitmap`).

**Bundle** (`Bundle<M>`): `load(keys?)` loads everything or the listed keys and resolves when they
have settled; `progress: BundleProgress` (`loaded`, `failed`, `total`, `bytes`, `bytesTotal`, which
is null until every read has reported a total, and `fraction = (loaded + failed) / total`);
`errors: BundleError[]` (`key`, `uri`, `message`, `cause`); `get`, `has`; `on(event, fn)` for
`BundleEvents` `progress`, `asset` (`{ key, asset }`), `error` and `done` (fired once per `load`
that was not cancelled); `cancel()` stops queued reads, lets in-flight ones finish and keeps the
cancelled keys in `total` so `fraction` stays below 1 until a later `load` resumes them;
`release(key?)` destroys a texture or scene, closes a bitmap and forgets the key; `dispose()` is
cancel, release all and drop listeners. Failed assets count toward `fraction` so a bar still
reaches 1; a failed key loads again on the next `load`.

**Audio sprite sidecars.** A sprite packer's JSON (`{ src, sprites, loopPoints? }`, the audio module's `SpriteSidecar`) needs no loader kind of its own: load it as a `json` entry and its `src` as an `audio` entry, then `spriteSheetFrom(sidecar, buffer)` from `@thunderclap/engine/audio` builds the sheet for `audio.defineSprites`.

## Baked bytes

A navmesh or collider baked at build time (`pnpm bake <config>`, `scripts/bake.mjs`, see the
root README's *Baking*) ships as a file the game fetches like any other: a `bytes` manifest entry
(`{ kind: 'bytes', uri: 'baked/level.navm' }`) loads it as an `ArrayBuffer` through the bundle,
or a bare `fetch(url).then((r) => r.arrayBuffer())` does; then `importNavMesh` (`nav`) or
`importCollider` (`geom`) rebuilds it. Nothing in this module parses those formats.

- `readBakeManifest(json: string | unknown): BakeManifest` parses the script's
  `bake-manifest.json` (a string or already-parsed JSON) and throws on another `version`
  (`BAKE_MANIFEST_VERSION`, 1), a missing `entries` array or an entry without a `name` or with an
  unknown `kind`. `BakeManifest { version; bakedAt; entries: BakeManifestEntry[] }`,
  `BakeManifestEntry { name; kind: BakeKind; sources; sha256; bytes; ms }`, `BakeKind` is
  `'nav' | 'collider'`. A game that wants to know what was baked, or to key a cache on `sha256`,
  reads it; the baked files themselves need no manifest.

## Atlas

`packAtlas(images, options?)` packs named images into one sheet with shelf packing and returns an
`AtlasLayout`: `width`, `height`, `rects: Record<name, AtlasRect>` (`x`, `y`, `w`, `h` in pixels
and `u0`, `v0`, `u1`, `v1` normalised) and `draw(ctx)`, which draws every image into a 2D context
(`AtlasDrawContext`: `drawImage`, `createImageData`, `putImageData`). An `AtlasSource` is an
`ImageBitmap`, a canvas, or `AtlasPixels` (`width`, `height`, RGBA `data`). `AtlasOptions`:
`padding` (gap between sprites, default 1), `extrude` (edge pixels repeated around each sprite so
bilinear sampling and mips do not bleed, default 1; `extrudePixels` does it for raw pixels),
`maxSize` (default 4096; packing throws naming the image that does not fit), `powerOfTwo`
(default true) and `sort` (tallest first, default true; `false` keeps input order). The sheet is
never taller than wide. Packing is deterministic for the same inputs.

`createAtlasTexture(device, layout, images, options?)` draws the layout into an `OffscreenCanvas`
and uploads it with `loadTexture`, returning an `AtlasTexture` (`texture`, `rects`);
`AtlasTextureOptions` are `LoadTextureOptions` plus `canvas` to supply the canvas. An `atlas`
manifest entry does all of this from the uris; draw a sprite from it with
`frame.sprite(material, { x, y, w, h, uv: [r.u0, r.v0, r.u1, r.v1] })`.

## Not yet

Draco (`KHR_draco_mesh_compression`); KTX2 upload and Basis transcoding (the container parses,
the render module cannot upload a compressed texture yet, and BasisLZ / UASTC need a
transcoder); drawing the parsed `KHR_materials_*` records; `occlusionStrength`; a second texture
coordinate set or transform per material; morph targets on the GPU (the blend is CPU-side; a
mesh with many targets and many vertices pays for it every frame its weights change), `TANGENT`
and texture-coordinate morph deltas. Other `extensionsUsed` are warned about;
`extensionsRequired` throws.

## Demo

`harness/gltf.html` builds a GLB in the page (`harness/gltf-writer.ts`: a textured cube placed by
a `matrix` node, an unlit-looking mossy plane with no normals placed by TRS) and draws it through
the two calls above; `e2e/gltf.spec.ts` checks the counts and the rendered pixels on the matrix.
`harness/gltf.html?pbr` builds the PBR scene instead (`buildPbrGlb`: a 3×3 metallic × roughness
sphere grid from one map, a normal-mapped tile with `TANGENT` and `TEXCOORD_1`, an emissive strip
with `KHR_materials_emissive_strength`, a `KHR_texture_transform` quad, a two-bone skinned
cylinder with stripes and an occlusion map animated through `skeletonFromSkin` and a
`SkinPalette`); the spec checks five materials over six maps, the skinned and tangent layouts,
no warnings, the strip glowing and a metal sphere shading unlike a matte one.
`harness/assets.html` loads a 12-entry manifest of every kind from an in-memory map through
`createBundle` (`?slow` delays reads, `?fail=one` fails one, `?cancel` cancels after the first
asset) and draws the packed atlas as sprites; `e2e/assets.spec.ts` checks progress, the error
path, cancel and a sprite's colour.

`harness/gltf3.html` builds a GLB per mode: `?quant` a quantized cube beside its float twin
(state `maxError`), `?meshopt` a meshopt rock checked against its uncompressed twin (`triangles`,
`match`), `?lights` a scene lit only by its own lights through its own camera (`lights`),
`?variants` a figure cycling three variants each second (`variant`, `materialId`; `?still` parks
on one), `?cache` ten assets through a four-asset budget (`stats`); `e2e/gltf3.spec.ts` checks
the state and probe pixels.

`harness/morph.html` builds a `.gltf` sphere with two morph targets (squash, bulge) and a
`weights` clip, samples it with `sampleWeights`, applies and draws; `e2e/morph.spec.ts` polls the
weights, the upload count, the bounds and a pixel at the silhouette through both phases.
